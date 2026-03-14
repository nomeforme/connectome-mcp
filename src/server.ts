#!/usr/bin/env node
/**
 * Connectome MCP Server
 *
 * stdio-based MCP server that exposes Connectome VEIL state
 * to Claude Code (or any MCP-compatible client).
 *
 * Connects to the Connectome gRPC server and translates
 * MCP tool calls into gRPC RPCs.
 *
 * Usage:
 *   node dist/server.js
 *   # or via Claude Code:
 *   claude mcp add connectome -- node /opt/connectome/connectome-mcp/dist/server.js
 *
 * Environment:
 *   CONNECTOME_HOST  (default: localhost)
 *   CONNECTOME_PORT  (default: 50051)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

async function main() {
  const backend = new ConnectomeBackend();
  const workspace = new WorkspaceBackend();
  const snapshot = new SnapshotBackend();
  const docker = new DockerBackend();

  // Connect to Connectome server
  try {
    await backend.connect();
    process.stderr.write('[connectome-mcp] Connected to Connectome server\n');
  } catch (err: any) {
    process.stderr.write(`[connectome-mcp] Warning: ${err.message} — tools will retry on first call\n`);
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
        // Workspace tools — local filesystem, no gRPC needed
        result = await workspace.callTool(name, args || {});
      } else if (SNAPSHOT_TOOLS.has(name)) {
        // Snapshot tools — read persisted state from disk, no gRPC needed
        result = await snapshot.callTool(name, args || {});
      } else if (DOCKER_TOOLS.has(name)) {
        // Docker tools — shell out to docker CLI, no gRPC needed
        result = await docker.callTool(name, args || {});
      } else {
        // Connectome tools — lazy reconnect if needed
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

  // Graceful shutdown
  const shutdown = () => {
    process.stderr.write('[connectome-mcp] Shutting down\n');
    backend.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[connectome-mcp] MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[connectome-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
