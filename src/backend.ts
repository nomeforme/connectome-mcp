/**
 * Connectome MCP Backend
 *
 * Thin gRPC client that connects to the Connectome server and
 * implements each MCP tool as a method returning formatted text.
 *
 * Self-contained — does not import from connectome-grpc-common
 * to keep the MCP server dependency-free from the workspace.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Proto path — we reference the proto from connectome-grpc-common
const PROTO_PATH = join(__dirname, '..', '..', 'connectome-grpc-common', 'proto', 'connectome.proto');

interface ConnectomeBackendConfig {
  host: string;
  port: number;
}

export class ConnectomeBackend {
  private client: any = null;
  private config: ConnectomeBackendConfig;
  private connected = false;

  constructor(config?: Partial<ConnectomeBackendConfig>) {
    this.config = {
      host: config?.host || process.env.CONNECTOME_HOST || 'localhost',
      port: config?.port || parseInt(process.env.CONNECTOME_PORT || '50051', 10),
    };
  }

  async connect(): Promise<void> {
    const packageDefinition = await protoLoader.load(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const descriptor = grpc.loadPackageDefinition(packageDefinition);
    const ConnectomeService = (descriptor as any).connectome.ConnectomeService;
    const address = `${this.config.host}:${this.config.port}`;

    this.client = new ConnectomeService(
      address,
      grpc.credentials.createInsecure(),
      {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
        'grpc.max_send_message_length': 64 * 1024 * 1024,
      },
    );

    // Wait for ready with 5s timeout
    await new Promise<void>((resolve, reject) => {
      const deadline = new Date(Date.now() + 5000);
      this.client.waitForReady(deadline, (err: Error | null) => {
        if (err) reject(new Error(`Cannot connect to Connectome at ${address}: ${err.message}`));
        else {
          this.connected = true;
          resolve();
        }
      });
    });
  }

  private rpc<T>(method: string, request: any, timeoutMs = 30000): Promise<T> {
    if (!this.connected) throw new Error('Not connected to Connectome server');
    const deadline = new Date(Date.now() + timeoutMs);
    return new Promise((resolve, reject) => {
      this.client[method](request, { deadline }, (err: any, response: T) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // ── Tool implementations ──────────────────────────────────────

  async health(): Promise<string> {
    const res = await this.rpc<any>('Health', { clientId: 'connectome-mcp' }, 5000);
    return formatYaml({
      healthy: res.healthy,
      currentSequence: res.currentSequence,
      activeStreams: res.activeStreams,
      activeAgents: res.activeAgents,
      uptimeMs: res.uptimeMs,
      uptimeHuman: humanDuration(res.uptimeMs),
    });
  }

  async getStreams(): Promise<string> {
    const res = await this.rpc<any>('GetStateSnapshot', {
      sequence: 0,
      facetTypes: [],
      streamIds: [],
    }, 60000);

    const streams = (res.streams || []).map((s: any) => ({
      id: s.id,
      name: s.name || undefined,
      metadata: Object.keys(s.metadata || {}).length > 0 ? s.metadata : undefined,
      parentId: s.parentId || undefined,
    }));

    return formatYaml({
      sequence: res.sequence,
      streamCount: streams.length,
      streams,
    });
  }

  async getAgents(): Promise<string> {
    const res = await this.rpc<any>('GetStateSnapshot', {
      sequence: 0,
      facetTypes: [],
      streamIds: [],
    }, 60000);

    const agents = (res.agents || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type || undefined,
      capabilities: a.capabilities?.length ? a.capabilities : undefined,
      createdAt: a.createdAt || undefined,
      lastActiveAt: a.lastActiveAt || undefined,
    }));

    return formatYaml({
      sequence: res.sequence,
      agentCount: agents.length,
      agents,
    });
  }

  async getSpeech(params: { stream_id?: string; agent_id?: string; limit?: number }): Promise<string> {
    const limit = params.limit || 20;
    const res = await this.rpc<any>('GetStateSnapshot', {
      sequence: 0,
      facetTypes: ['speech'],
      streamIds: params.stream_id ? [params.stream_id] : [],
    }, 60000);

    let facets = (res.facets || []).map(deserializeFacet);

    // Filter by agent if specified
    if (params.agent_id) {
      facets = facets.filter((f: any) => f.agentId === params.agent_id);
    }

    // Sort by timestamp descending, take limit
    facets.sort((a: any, b: any) => {
      const ta = a.state?.timestamp || 0;
      const tb = b.state?.timestamp || 0;
      return tb - ta;
    });
    facets = facets.slice(0, limit);

    const speech = facets.map((f: any) => ({
      id: f.id,
      agentName: f.agentName || f.agentId,
      streamId: f.streamId,
      content: truncate(f.content, 500),
      timestamp: f.state?.timestamp ? new Date(f.state.timestamp).toISOString() : undefined,
      cyclePending: f.state?.cyclePending || undefined,
      attachments: f.attachments?.length || undefined,
    }));

    return formatYaml({
      sequence: res.sequence,
      count: speech.length,
      speech,
    });
  }

  async getEvents(params: { stream_id?: string; limit?: number }): Promise<string> {
    const limit = params.limit || 20;
    const res = await this.rpc<any>('GetStateSnapshot', {
      sequence: 0,
      facetTypes: ['event'],
      streamIds: params.stream_id ? [params.stream_id] : [],
    }, 60000);

    let facets = (res.facets || []).map(deserializeFacet);

    // Sort by timestamp descending, take limit
    facets.sort((a: any, b: any) => {
      const ta = a.state?.timestamp || 0;
      const tb = b.state?.timestamp || 0;
      return tb - ta;
    });
    facets = facets.slice(0, limit);

    const events = facets.map((f: any) => ({
      id: f.id,
      streamId: f.streamId,
      content: truncate(f.content, 500),
      authorName: f.state?.authorName || f.state?.sender,
      authorId: f.state?.authorId || f.state?.senderUuid,
      timestamp: f.state?.timestamp ? new Date(f.state.timestamp).toISOString() : undefined,
    }));

    return formatYaml({
      sequence: res.sequence,
      count: events.length,
      events,
    });
  }

  async getFacets(params: { types?: string[]; stream_id?: string; agent_id?: string; limit?: number }): Promise<string> {
    const limit = params.limit || 50;
    const res = await this.rpc<any>('GetStateSnapshot', {
      sequence: 0,
      facetTypes: params.types || [],
      streamIds: params.stream_id ? [params.stream_id] : [],
    }, 60000);

    let facets = (res.facets || []).map(deserializeFacet);

    if (params.agent_id) {
      facets = facets.filter((f: any) => f.agentId === params.agent_id);
    }

    facets = facets.slice(-limit);

    const result = facets.map((f: any) => ({
      id: f.id,
      type: f.type,
      streamId: f.streamId || undefined,
      agentName: f.agentName || undefined,
      agentId: f.agentId || undefined,
      content: truncate(f.content, 300),
      state: f.state && Object.keys(f.state).length > 0 ? f.state : undefined,
      tags: f.tags?.length ? f.tags : undefined,
    }));

    return formatYaml({
      sequence: res.sequence,
      count: result.length,
      facets: result,
    });
  }

  async getContext(params: { agent_id: string; stream_id: string; max_frames?: number; max_tokens?: number }): Promise<string> {
    const res = await this.rpc<any>('GetContext', {
      agentId: params.agent_id,
      streamId: params.stream_id,
      maxFrames: params.max_frames || 100,
      maxTokens: params.max_tokens || 100000,
      facetTypes: [],
      includeUnfocused: false,
    }, 60000);

    let context: any = {};
    if (res.contextJson?.length) {
      try {
        const jsonStr = Buffer.from(res.contextJson).toString('utf-8');
        context = JSON.parse(jsonStr);
      } catch {
        context = { error: 'Failed to parse context JSON' };
      }
    }

    return formatYaml({
      agentId: res.agentId,
      streamId: res.streamId,
      tokenCount: res.tokenCount,
      frameCount: res.frameCount,
      context,
    });
  }

  async getFrames(params: { from_sequence?: number; to_sequence?: number; stream_id?: string; limit?: number }): Promise<string> {
    const res = await this.rpc<any>('GetFrames', {
      fromSequence: params.from_sequence || 0,
      toSequence: params.to_sequence || 0,
      limit: params.limit || 50,
      streamIds: params.stream_id ? [params.stream_id] : [],
    }, 60000);

    const frames = (res.frames || []).map((f: any) => {
      const events = (f.events || []).map((e: any) => {
        let payload: any = undefined;
        if (e.payloadJson?.length) {
          try {
            payload = JSON.parse(Buffer.from(e.payloadJson).toString('utf-8'));
          } catch { /* skip */ }
        }
        return {
          topic: e.topic,
          source: e.source?.componentId,
          payload: payload ? summarizePayload(payload) : undefined,
        };
      });

      const deltas = (f.deltas || []).map((d: any) => ({
        type: d.type === 'VEIL_ADD_FACET' ? 'add' :
              d.type === 'VEIL_REWRITE_FACET' ? 'rewrite' : 'remove',
        facetId: d.facetId || d.facet?.id,
        facetType: d.facet?.type,
      }));

      return {
        sequence: f.sequence,
        timestamp: f.timestamp,
        uuid: f.uuid,
        stream: f.activeStream?.streamId,
        eventCount: events.length,
        deltaCount: deltas.length,
        events,
        deltas,
      };
    });

    return formatYaml({
      currentSequence: res.currentSequence,
      frameCount: frames.length,
      frames,
    });
  }

  async emitEvent(params: { topic: string; payload: any }): Promise<string> {
    const payloadJson = Buffer.from(JSON.stringify(params.payload));

    const res = await this.rpc<any>('EmitEvent', {
      event: {
        topic: params.topic,
        source: { componentId: 'connectome-mcp', componentPath: [], componentType: 'mcp' },
        payloadJson,
        timestamp: Date.now(),
        priority: 'PRIORITY_NORMAL',
        metadata: {},
        sync: false,
      },
      waitForFrame: true,
    }, 10000);

    return formatYaml({
      success: res.success,
      sequence: res.sequence,
      frameUuid: res.frameUuid,
      deltaCount: res.deltas?.length || 0,
      error: res.error || undefined,
    });
  }

  // ── Tool dispatch ─────────────────────────────────────────────

  async callTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'health': return this.health();
      case 'get_streams': return this.getStreams();
      case 'get_agents': return this.getAgents();
      case 'get_speech': return this.getSpeech(args || {});
      case 'get_events': return this.getEvents(args || {});
      case 'get_facets': return this.getFacets(args || {});
      case 'get_context': return this.getContext(args);
      case 'get_frames': return this.getFrames(args || {});
      case 'emit_event': return this.emitEvent(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  disconnect(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.connected = false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────

function deserializeFacet(proto: any): any {
  const facet: any = {
    id: proto.id,
    type: proto.type,
    content: proto.content,
    tags: proto.tags,
    agentId: proto.agentId,
    agentName: proto.agentName,
    streamId: proto.streamId,
    streamType: proto.streamType,
    scopes: proto.scopes,
    ephemeral: proto.ephemeral,
    attachments: proto.attachments,
    attributes: proto.attributes,
  };

  // Deserialize stateJson
  if (proto.stateJson?.length) {
    try {
      facet.state = JSON.parse(Buffer.from(proto.stateJson).toString('utf-8'));
    } catch { /* skip */ }
  }

  return facet;
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function summarizePayload(payload: any): any {
  // For large payloads, summarize key fields
  if (typeof payload !== 'object' || !payload) return payload;
  const summary: any = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + '…';
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function formatYaml(obj: any): string {
  // Simple YAML-like formatter for readable MCP output
  return JSON.stringify(obj, null, 2);
}
