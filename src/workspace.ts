/**
 * Shared Workspace Backend
 *
 * Provides filesystem access to the shared workspace Docker volume.
 * Path is resolved from WORKSPACE_PATH env var, defaulting to the
 * Docker volume mount at /var/lib/docker/volumes/connectome_shared-workspace/_data.
 *
 * All paths are sandboxed — traversal outside the workspace root is rejected.
 */

import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { join, resolve, relative, extname } from 'path';

const DEFAULT_WORKSPACE_PATH = '/var/lib/docker/volumes/connectome_shared-workspace/_data';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.py', '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml',
  '.html', '.css', '.sh', '.csv', '.xml', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.sql', '.r', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.pl', '.lua', '.vim', '.dockerfile', '.env', '.gitignore',
]);

const MAX_READ_SIZE = 100 * 1024; // 100KB

export class WorkspaceBackend {
  private root: string;

  constructor() {
    this.root = process.env.WORKSPACE_PATH || DEFAULT_WORKSPACE_PATH;
  }

  /** Resolve and validate a path is within the workspace */
  private safePath(relPath: string): string {
    const resolved = resolve(this.root, relPath);
    if (!resolved.startsWith(this.root)) {
      throw new Error(`Path traversal rejected: ${relPath}`);
    }
    return resolved;
  }

  async list(params: { path?: string }): Promise<string> {
    const dir = this.safePath(params.path || '.');

    const entries = await readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        const fullPath = join(dir, e.name);
        try {
          const s = await stat(fullPath);
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: e.isFile() ? s.size : undefined,
            modified: s.mtime.toISOString(),
          };
        } catch {
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
        }
      }),
    );

    // Sort: dirs first, then by name
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return JSON.stringify({
      workspace: this.root,
      path: params.path || '.',
      count: items.length,
      entries: items,
    }, null, 2);
  }

  async read(params: { path: string }): Promise<string> {
    const filePath = this.safePath(params.path);
    const s = await stat(filePath);

    if (s.isDirectory()) {
      throw new Error(`${params.path} is a directory — use workspace_list instead`);
    }

    const ext = extname(filePath).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext) || ext === '';

    if (!isText) {
      return JSON.stringify({
        path: params.path,
        type: 'binary',
        extension: ext,
        size: s.size,
        modified: s.mtime.toISOString(),
        note: 'Binary file — cannot display contents. Use workspace_list to see metadata.',
      }, null, 2);
    }

    if (s.size > MAX_READ_SIZE) {
      const content = await readFile(filePath, 'utf-8');
      const truncated = content.slice(0, MAX_READ_SIZE);
      return JSON.stringify({
        path: params.path,
        size: s.size,
        truncated: true,
        truncatedAt: MAX_READ_SIZE,
        content: truncated,
      }, null, 2);
    }

    const content = await readFile(filePath, 'utf-8');
    return JSON.stringify({
      path: params.path,
      size: s.size,
      content,
    }, null, 2);
  }

  async search(params: { glob?: string; content_pattern?: string; max_results?: number }): Promise<string> {
    const maxResults = params.max_results || 20;
    const globPattern = params.glob || '*';
    const contentRegex = params.content_pattern ? new RegExp(params.content_pattern, 'i') : null;

    // Recursive file listing
    const allFiles = await this.walkDir(this.root);

    // Filter by glob (simple matching)
    const matched = allFiles.filter((f) => matchGlob(f.relative, globPattern));

    const results: any[] = [];
    for (const file of matched) {
      if (results.length >= maxResults) break;

      if (contentRegex) {
        const ext = extname(file.full).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext) && ext !== '') continue;

        try {
          const s = await stat(file.full);
          if (s.size > MAX_READ_SIZE) continue;
          const content = await readFile(file.full, 'utf-8');
          if (contentRegex.test(content)) {
            // Find matching lines
            const lines = content.split('\n');
            const matchingLines = lines
              .map((line, i) => ({ line: i + 1, text: line.trim() }))
              .filter((l) => contentRegex.test(l.text))
              .slice(0, 5);
            results.push({
              path: file.relative,
              size: s.size,
              matches: matchingLines,
            });
          }
        } catch { /* skip unreadable */ }
      } else {
        try {
          const s = await stat(file.full);
          results.push({
            path: file.relative,
            type: s.isDirectory() ? 'dir' : 'file',
            size: s.isFile() ? s.size : undefined,
            modified: s.mtime.toISOString(),
          });
        } catch {
          results.push({ path: file.relative });
        }
      }
    }

    return JSON.stringify({
      glob: globPattern,
      contentPattern: params.content_pattern || undefined,
      count: results.length,
      results,
    }, null, 2);
  }

  async write(params: { path: string; content: string; append?: boolean }): Promise<string> {
    const filePath = this.safePath(params.path);

    // Ensure parent directory exists
    const parentDir = join(filePath, '..');
    await mkdir(parentDir, { recursive: true });

    if (params.append) {
      const existing = await readFile(filePath, 'utf-8').catch(() => '');
      await writeFile(filePath, existing + params.content, 'utf-8');
    } else {
      await writeFile(filePath, params.content, 'utf-8');
    }

    const s = await stat(filePath);
    return JSON.stringify({
      success: true,
      path: params.path,
      size: s.size,
      modified: s.mtime.toISOString(),
    }, null, 2);
  }

  async delete(params: { path: string }): Promise<string> {
    const filePath = this.safePath(params.path);
    const s = await stat(filePath);

    if (s.isDirectory()) {
      throw new Error(`Cannot delete directory: ${params.path} — only files can be deleted`);
    }

    await unlink(filePath);
    return JSON.stringify({
      success: true,
      deleted: params.path,
    }, null, 2);
  }

  async callTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'workspace_list': return this.list(args || {});
      case 'workspace_read': return this.read(args);
      case 'workspace_search': return this.search(args || {});
      case 'workspace_write': return this.write(args);
      case 'workspace_delete': return this.delete(args);
      default: throw new Error(`Unknown workspace tool: ${name}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private async walkDir(dir: string): Promise<Array<{ full: string; relative: string }>> {
    const results: Array<{ full: string; relative: string }> = [];
    const walk = async (current: string) => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        const rel = relative(this.root, full);
        if (entry.isDirectory()) {
          results.push({ full, relative: rel + '/' });
          await walk(full);
        } else {
          results.push({ full, relative: rel });
        }
      }
    };
    await walk(dir);
    return results;
  }
}

/** Simple glob matching supporting * and ** */
function matchGlob(path: string, pattern: string): boolean {
  // **/*.ext should also match root-level files (no directory prefix)
  if (pattern.startsWith('**/')) {
    const sub = pattern.slice(3);
    if (matchGlob(path, sub)) return true;
  }

  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*')
    .replace(/\?/g, '[^/]');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(path);
}
