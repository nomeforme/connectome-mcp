/**
 * Snapshot Backend for Connectome MCP
 *
 * Reads persisted VEIL snapshots, deltas, and frame buckets directly
 * from the connectome-state volume on disk. This provides access to
 * historical data that may no longer be in live VEIL memory.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

const DEFAULT_STATE_DIR = '/var/lib/docker/volumes/connectome_connectome-state/_data';

export class SnapshotBackend {
  private stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir || process.env.CONNECTOME_STATE_DIR || DEFAULT_STATE_DIR;
  }

  // ── Tool implementations ──────────────────────────────────────

  /**
   * List available snapshots with metadata
   */
  async listSnapshots(params: { limit?: number }): Promise<string> {
    const limit = params.limit || 20;
    const snapshotDir = join(this.stateDir, 'snapshots');

    let files: string[];
    try {
      files = await readdir(snapshotDir);
    } catch {
      return JSON.stringify({ error: `Cannot read snapshot directory: ${snapshotDir}` }, null, 2);
    }

    files = files.filter(f => f.endsWith('.json')).sort();

    // Parse sequence and timestamp from filenames: snapshot-{seq}-{ts}.json
    const snapshots = files.map(f => {
      const match = f.match(/^snapshot-(\d+)-(\d+)\.json$/);
      if (!match) return null;
      return {
        file: f,
        sequence: parseInt(match[1], 10),
        timestamp: parseInt(match[2], 10),
        date: new Date(parseInt(match[2], 10)).toISOString(),
      };
    }).filter(Boolean) as { file: string; sequence: number; timestamp: number; date: string }[];

    // Sort by timestamp descending (newest first), take limit
    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    const selected = snapshots.slice(0, limit);

    // Get file sizes for selected snapshots
    const results = await Promise.all(selected.map(async (s) => {
      try {
        const st = await stat(join(snapshotDir, s.file));
        return { ...s, sizeMB: +(st.size / 1024 / 1024).toFixed(1) };
      } catch {
        return { ...s, sizeMB: 0 };
      }
    }));

    // Also count deltas and frame buckets
    let deltaCount = 0;
    let bucketCount = 0;
    try {
      const deltas = await readdir(join(this.stateDir, 'deltas'));
      deltaCount = deltas.filter(f => f.endsWith('.json')).length;
    } catch { /* skip */ }
    try {
      const prefixes = await readdir(join(this.stateDir, 'frame-buckets'));
      for (const prefix of prefixes) {
        try {
          const buckets = await readdir(join(this.stateDir, 'frame-buckets', prefix));
          bucketCount += buckets.filter(f => f.endsWith('.json')).length;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return JSON.stringify({
      stateDir: this.stateDir,
      totalSnapshots: snapshots.length,
      totalDeltas: deltaCount,
      totalFrameBuckets: bucketCount,
      snapshots: results,
    }, null, 2);
  }

  /**
   * Inspect a snapshot — show facet type counts, streams, agents, frame bucket refs
   */
  async inspectSnapshot(params: { sequence?: number; file?: string }): Promise<string> {
    const snap = await this.loadSnapshot(params.sequence, params.file);
    if (typeof snap === 'string') return snap; // error

    const vs = snap.veilState;
    const facets = this.parseFacetMap(vs.facets || []);

    // Count facets by type
    const typeCounts: Record<string, number> = {};
    for (const f of facets) {
      const t = f.type || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    // Count facets by stream
    const streamCounts: Record<string, number> = {};
    for (const f of facets) {
      const sid = f.streamId || 'global';
      streamCounts[sid] = (streamCounts[sid] || 0) + 1;
    }

    // Parse streams
    const streams = this.parseMapEntries(vs.streams || []).map((s: any) => ({
      id: s.id,
      name: s.name || undefined,
      type: s.metadata?.channelType || undefined,
      platform: s.id?.split(':')[0] || undefined,
      parentId: s.parentId || undefined,
    }));

    // Frame bucket refs
    const bucketRefs = (vs.frameBucketRefs || []).map((r: any) => ({
      startSequence: r.startSequence,
      endSequence: r.endSequence,
      frameCount: r.frameCount,
      hash: r.hash,
    }));

    return JSON.stringify({
      version: snap.version,
      sequence: snap.sequence,
      timestamp: snap.timestamp,
      lifecycleId: snap.lifecycleId,
      metadata: snap.metadata,
      facetTypeCounts: typeCounts,
      facetsByStream: Object.fromEntries(
        Object.entries(streamCounts).sort(([, a], [, b]) => (b as number) - (a as number))
      ),
      streamCount: streams.length,
      streams,
      frameBucketRefs: bucketRefs,
      currentSequence: vs.currentSequence,
    }, null, 2);
  }

  /**
   * Extract events from a snapshot, filterable by stream_id and author
   */
  async snapshotEvents(params: {
    sequence?: number;
    file?: string;
    stream_id?: string;
    author?: string;
    facet_types?: string[];
    limit?: number;
  }): Promise<string> {
    const limit = params.limit || 50;
    const snap = await this.loadSnapshot(params.sequence, params.file);
    if (typeof snap === 'string') return snap;

    const facets = this.parseFacetMap(snap.veilState.facets || []);
    const types = params.facet_types || ['event'];

    let filtered = facets.filter(f => types.includes(f.type));
    if (params.stream_id) {
      filtered = filtered.filter(f => f.streamId === params.stream_id);
    }
    if (params.author) {
      const authorLower = params.author.toLowerCase();
      filtered = filtered.filter(f => {
        const name = (f.state?.authorName || f.state?.sender || f.agentName || '').toLowerCase();
        return name.includes(authorLower);
      });
    }

    // Sort by timestamp
    filtered.sort((a, b) => {
      const ta = a.state?.timestamp || 0;
      const tb = b.state?.timestamp || 0;
      return ta - tb;
    });

    const events = filtered.slice(-limit).map(f => ({
      id: f.id,
      type: f.type,
      streamId: f.streamId,
      agentName: f.agentName || undefined,
      authorName: f.state?.authorName || f.state?.sender || undefined,
      content: truncate(f.content, 500),
      timestamp: f.state?.timestamp ? new Date(f.state.timestamp).toISOString() : undefined,
      rawTimestamp: f.state?.timestamp,
    }));

    return JSON.stringify({
      snapshot: { sequence: snap.sequence, timestamp: snap.timestamp },
      filter: { stream_id: params.stream_id, author: params.author, types },
      count: events.length,
      totalMatching: filtered.length,
      events,
    }, null, 2);
  }

  /**
   * Read frame buckets from a snapshot to get historical conversation data.
   * Frame buckets contain the immutable event log with all events and deltas.
   */
  async snapshotFrames(params: {
    sequence?: number;
    file?: string;
    bucket_index?: number;
    stream_id?: string;
    limit?: number;
    event_topics?: string[];
  }): Promise<string> {
    const limit = params.limit || 50;
    const snap = await this.loadSnapshot(params.sequence, params.file);
    if (typeof snap === 'string') return snap;

    const bucketRefs: any[] = snap.veilState.frameBucketRefs || [];
    if (bucketRefs.length === 0) {
      return JSON.stringify({ error: 'No frame bucket refs in snapshot' }, null, 2);
    }

    // If bucket_index specified, read that one bucket; otherwise read from the end
    let refsToRead: any[];
    if (params.bucket_index !== undefined) {
      if (params.bucket_index < 0 || params.bucket_index >= bucketRefs.length) {
        return JSON.stringify({ error: `bucket_index ${params.bucket_index} out of range [0, ${bucketRefs.length - 1}]` }, null, 2);
      }
      refsToRead = [bucketRefs[params.bucket_index]];
    } else {
      // Read from the most recent bucket backwards until we have enough frames
      refsToRead = [...bucketRefs].reverse().slice(0, 5); // max 5 buckets
    }

    const allFrames: any[] = [];
    for (const ref of refsToRead) {
      const bucket = await this.loadFrameBucket(ref.hash);
      if (!bucket) continue;

      let frames = bucket.frames || [];

      // Filter by stream if specified
      if (params.stream_id) {
        frames = frames.filter((f: any) => f.activeStream?.streamId === params.stream_id);
      }

      // Filter by event topic if specified
      if (params.event_topics?.length) {
        frames = frames.filter((f: any) =>
          (f.events || []).some((e: any) => params.event_topics!.includes(e.topic))
        );
      }

      for (const frame of frames) {
        allFrames.push(this.summarizeFrame(frame));
      }
    }

    // Sort by sequence and take limit from end
    allFrames.sort((a, b) => a.sequence - b.sequence);
    const selected = allFrames.slice(-limit);

    return JSON.stringify({
      snapshot: { sequence: snap.sequence, timestamp: snap.timestamp },
      bucketsRead: refsToRead.length,
      totalBuckets: bucketRefs.length,
      filter: { stream_id: params.stream_id, event_topics: params.event_topics },
      frameCount: selected.length,
      totalMatching: allFrames.length,
      frames: selected,
    }, null, 2);
  }

  /**
   * Search across ALL frame buckets for messages by content, author, stream, or topic.
   * Searches both event payloads AND delta facets (older frames store conversation
   * data as VEIL deltas with facet.content / facet.stateJson rather than events).
   */
  async searchHistory(params: {
    query?: string;
    author?: string;
    stream_id?: string;
    topic?: string;
    facet_types?: string[];
    limit?: number;
    all_buckets?: boolean;
  }): Promise<string> {
    const limit = params.limit || 30;
    const searchTypes = new Set(params.facet_types || ['event', 'speech']);
    const queryLower = params.query?.toLowerCase();
    const authorLower = params.author?.toLowerCase();

    // Determine which buckets to read
    let bucketHashes: { hash: string; start: number; end: number }[];

    if (params.all_buckets) {
      // Scan ALL frame buckets on disk (not just those referenced by a snapshot)
      bucketHashes = await this.getAllBucketHashes();
    } else {
      const snap = await this.loadSnapshot();
      if (typeof snap === 'string') return snap;
      bucketHashes = (snap.veilState.frameBucketRefs || []).map((r: any) => ({
        hash: r.hash, start: r.startSequence, end: r.endSequence,
      }));
    }

    const matches: any[] = [];

    for (const ref of bucketHashes) {
      const bucket = await this.loadFrameBucket(ref.hash);
      if (!bucket) continue;

      for (const frame of (bucket.frames || [])) {
        const streamId = frame.activeStream?.streamId;
        if (params.stream_id && streamId !== params.stream_id) continue;

        // Search event payloads (newer frame format)
        for (const event of (frame.events || [])) {
          if (params.topic && event.topic !== params.topic) continue;
          const payload = decodeJsonField(event.payloadJson);
          if (!payload) continue;

          const content = (payload.content || '').toLowerCase();
          const author = (payload.authorName || payload.sender || '').toLowerCase();
          if (queryLower && !content.includes(queryLower)) continue;
          if (authorLower && !author.includes(authorLower)) continue;

          matches.push({
            sequence: frame.sequence,
            timestamp: frame.timestamp,
            streamId,
            source: 'event',
            topic: event.topic,
            facetType: undefined,
            authorName: payload.authorName || payload.sender,
            content: truncate(payload.content, 300),
          });
        }

        // Search delta facets (older frame format — conversation data is in deltas)
        for (const delta of (frame.deltas || [])) {
          const facet = delta.facet;
          if (!facet) continue;
          if (!searchTypes.has(facet.type)) continue;

          const content = (facet.content || '').toLowerCase();
          const state = decodeJsonField(facet.stateJson);
          const author = (state?.authorName || state?.sender || facet.agentName || '').toLowerCase();

          if (queryLower && !content.includes(queryLower)) continue;
          if (authorLower && !author.includes(authorLower)) continue;

          matches.push({
            sequence: frame.sequence,
            timestamp: frame.timestamp,
            streamId,
            source: 'delta',
            facetType: facet.type,
            authorName: state?.authorName || state?.sender || facet.agentName,
            agentName: facet.agentName || undefined,
            content: truncate(facet.content, 300),
          });
        }
      }
    }

    // Deduplicate — same frame can appear in overlapping buckets
    const seen = new Set<string>();
    const deduped = matches.filter(m => {
      const key = `${m.sequence}:${m.facetType || m.topic}:${(m.content || '').slice(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by sequence
    deduped.sort((a, b) => a.sequence - b.sequence);
    const selected = deduped.slice(-limit);

    return JSON.stringify({
      filter: { query: params.query, author: params.author, stream_id: params.stream_id, topic: params.topic, facet_types: params.facet_types },
      totalMatching: deduped.length,
      count: selected.length,
      bucketsSearched: bucketHashes.length,
      sequenceRange: bucketHashes.length > 0
        ? { from: bucketHashes[0].start, to: bucketHashes[bucketHashes.length - 1].end }
        : null,
      results: selected,
    }, null, 2);
  }

  // ── Tool dispatch ─────────────────────────────────────────────

  async callTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'snapshot_list': return this.listSnapshots(args || {});
      case 'snapshot_inspect': return this.inspectSnapshot(args || {});
      case 'snapshot_events': return this.snapshotEvents(args || {});
      case 'snapshot_frames': return this.snapshotFrames(args || {});
      case 'snapshot_search': return this.searchHistory(args || {});
      default: throw new Error(`Unknown snapshot tool: ${name}`);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────

  private async loadSnapshot(sequence?: number, file?: string): Promise<any> {
    const snapshotDir = join(this.stateDir, 'snapshots');

    let targetFile: string;
    if (file) {
      targetFile = file;
    } else if (sequence !== undefined) {
      // Find snapshot by sequence number
      const files = await readdir(snapshotDir);
      const matching = files.filter(f => f.startsWith(`snapshot-${sequence}-`));
      if (matching.length === 0) {
        return JSON.stringify({ error: `No snapshot found for sequence ${sequence}` }, null, 2);
      }
      // Take the latest one if multiple exist
      matching.sort();
      targetFile = matching[matching.length - 1];
    } else {
      // Find the latest snapshot
      const files = await readdir(snapshotDir);
      const snapFiles = files.filter(f => f.endsWith('.json')).sort();
      if (snapFiles.length === 0) {
        return JSON.stringify({ error: 'No snapshots found' }, null, 2);
      }
      // Latest by name (timestamp is embedded)
      let latest = snapFiles[0];
      let latestTs = 0;
      for (const f of snapFiles) {
        const match = f.match(/^snapshot-\d+-(\d+)\.json$/);
        if (match) {
          const ts = parseInt(match[1], 10);
          if (ts > latestTs) { latestTs = ts; latest = f; }
        }
      }
      targetFile = latest;
    }

    try {
      const raw = await readFile(join(snapshotDir, targetFile), 'utf-8');
      return JSON.parse(raw);
    } catch (err: any) {
      return JSON.stringify({ error: `Failed to read snapshot ${targetFile}: ${err.message}` }, null, 2);
    }
  }

  private async loadFrameBucket(hash: string): Promise<any | null> {
    const prefix = hash.slice(0, 2);
    const suffix = hash.slice(2);
    const path = join(this.stateDir, 'frame-buckets', prefix, `${suffix}.json`);
    try {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private parseFacetMap(entries: any[]): any[] {
    // VEIL serializes Maps as [[key, value], ...] pairs
    if (entries.length === 0) return [];
    if (Array.isArray(entries[0]) && entries[0].length === 2) {
      return entries.map(([, value]: [string, any]) => value);
    }
    // If it's already an array of objects
    return entries;
  }

  private parseMapEntries(entries: any[]): any[] {
    if (entries.length === 0) return [];
    if (Array.isArray(entries[0]) && entries[0].length === 2) {
      return entries.map(([, value]: [string, any]) => value);
    }
    return entries;
  }

  private summarizeFrame(frame: any): any {
    const events = (frame.events || []).map((e: any) => {
      const payload = decodeJsonField(e.payloadJson);
      return {
        topic: e.topic,
        source: e.source?.componentId,
        authorName: payload?.authorName || payload?.sender,
        content: truncate(payload?.content, 200),
        messageId: payload?.messageId,
      };
    });

    // Extract conversation-relevant deltas (event + speech facets) separately
    const conversationDeltas: any[] = [];
    const otherDeltas: any[] = [];
    for (const d of (frame.deltas || [])) {
      const facet = d.facet;
      if (facet && (facet.type === 'event' || facet.type === 'speech')) {
        const state = decodeJsonField(facet.stateJson);
        conversationDeltas.push({
          type: d.type,
          facetType: facet.type,
          agentName: facet.agentName || undefined,
          authorName: state?.authorName || state?.sender || undefined,
          content: truncate(facet.content, 200),
        });
      } else {
        otherDeltas.push({
          type: d.type,
          facetId: d.facetId || facet?.id,
          facetType: facet?.type,
        });
      }
    }

    return {
      sequence: frame.sequence,
      timestamp: frame.timestamp,
      streamId: frame.activeStream?.streamId,
      eventCount: events.length,
      deltaCount: (frame.deltas || []).length,
      events: events.length > 0 ? events : undefined,
      conversation: conversationDeltas.length > 0 ? conversationDeltas : undefined,
      otherDeltas: otherDeltas.length <= 3
        ? (otherDeltas.length > 0 ? otherDeltas : undefined)
        : otherDeltas.slice(0, 3).concat([{ note: `...and ${otherDeltas.length - 3} more` }]),
    };
  }

  /**
   * Scan ALL frame bucket files on disk (not just those referenced by a snapshot).
   */
  private async getAllBucketHashes(): Promise<{ hash: string; start: number; end: number }[]> {
    const bucketDir = join(this.stateDir, 'frame-buckets');
    const results: { hash: string; start: number; end: number }[] = [];

    let prefixes: string[];
    try {
      prefixes = await readdir(bucketDir);
    } catch {
      return [];
    }

    for (const prefix of prefixes) {
      const pdir = join(bucketDir, prefix);
      let files: string[];
      try {
        files = await readdir(pdir);
      } catch { continue; }

      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const hash = prefix + f.replace('.json', '');
        try {
          const raw = await readFile(join(pdir, f), 'utf-8');
          const bucket = JSON.parse(raw);
          results.push({
            hash,
            start: bucket.startSequence || 0,
            end: bucket.endSequence || 0,
          });
        } catch { /* skip */ }
      }
    }

    results.sort((a, b) => a.start - b.start);
    return results;
  }
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Decode a JSON field that may be:
 * - a plain string (JSON)
 * - an object (already parsed)
 * - a Buffer-like {type: "Buffer", data: [...]} (Node.js Buffer serialization)
 * - a Uint8Array-like array of numbers
 */
function decodeJsonField(field: any): any {
  if (!field) return null;
  if (typeof field === 'string') {
    try { return JSON.parse(field); } catch { return null; }
  }
  if (typeof field === 'object') {
    // Buffer-like: {type: "Buffer", data: [number...]}
    if (field.type === 'Buffer' && Array.isArray(field.data)) {
      try {
        const str = Buffer.from(field.data).toString('utf-8');
        return JSON.parse(str);
      } catch { return null; }
    }
    // Already a parsed object (no type/data structure)
    if (!Array.isArray(field)) return field;
  }
  return null;
}
