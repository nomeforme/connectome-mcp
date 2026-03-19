/**
 * Shared MCP Server factory
 *
 * Creates and configures the MCP Server instance with all tool handlers.
 * Used by both stdio (server.ts) and HTTP (http-server.ts) entrypoints.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CONNECTOME_TOOLS } from './tools.js';
import { ConnectomeBackend } from './backend.js';
import { WorkspaceBackend } from './workspace.js';
import { SnapshotBackend } from './snapshot.js';
import { DockerBackend } from './docker.js';

const WORKSPACE_TOOLS = new Set([
  'workspace_list', 'workspace_read', 'workspace_search', 'workspace_write', 'workspace_delete',
]);

const SNAPSHOT_TOOLS = new Set([
  'snapshot_list', 'snapshot_inspect', 'snapshot_events', 'snapshot_frames', 'snapshot_search',
]);

const DOCKER_TOOLS = new Set([
  'docker_status', 'docker_logs', 'docker_restart', 'docker_rebuild_all', 'docker_stop_bots', 'docker_diagnose',
]);

export interface McpServerContext {
  server: Server;
  backend: ConnectomeBackend;
  shutdown: () => void;
}

export async function createMcpServer(): Promise<McpServerContext> {
  const backend = new ConnectomeBackend();
  const workspace = new WorkspaceBackend();
  const snapshot = new SnapshotBackend();
  const docker = new DockerBackend();

  // Connect to Connectome server
  try {
    await backend.connect();
    console.log('[connectome-mcp] Connected to Connectome server');
  } catch (err: any) {
    console.warn(`[connectome-mcp] Warning: ${err.message} — tools will retry on first call`);
  }

  const server = new Server(
    {
      name: 'connectome',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CONNECTOME_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      if (WORKSPACE_TOOLS.has(name)) {
        result = await workspace.callTool(name, args || {});
      } else if (SNAPSHOT_TOOLS.has(name)) {
        result = await snapshot.callTool(name, args || {});
      } else if (DOCKER_TOOLS.has(name)) {
        result = await docker.callTool(name, args || {});
      } else {
        if (!(backend as any).connected) {
          await backend.connect();
        }
        result = await backend.callTool(name, args || {});
      }

      return {
        content: [{ type: 'text', text: result }],
        isError: false,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const shutdown = () => {
    console.log('[connectome-mcp] Shutting down');
    backend.disconnect();
  };

  return { server, backend, shutdown };
}
