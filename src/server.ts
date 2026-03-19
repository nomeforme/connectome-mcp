#!/usr/bin/env node
/**
 * Connectome MCP Server — stdio transport
 *
 * For Claude Code / local MCP clients that spawn a child process.
 *
 * Usage:
 *   node dist/server.js
 *   claude mcp add connectome -- node /opt/connectome/connectome-mcp/dist/server.js
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.js';

async function main() {
  const { server, shutdown } = await createMcpServer();

  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[connectome-mcp] MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[connectome-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
