#!/usr/bin/env node
/**
 * Connectome MCP Server — Streamable HTTP transport
 *
 * For bot-runtime containers connecting over the Docker network.
 * Exposes MCP at POST /mcp (JSON-RPC), GET /mcp (SSE), DELETE /mcp (session end).
 *
 * Usage:
 *   node dist/http-server.js
 *
 * Environment:
 *   MCP_PORT (default: 3100)
 *   CONNECTOME_HOST (default: localhost)
 *   CONNECTOME_PORT (default: 50051)
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp-server.js';

const PORT = parseInt(process.env.MCP_PORT || '3100', 10);

// Track sessions for stateful mode
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  const { server, shutdown } = await createMcpServer();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Handle MCP requests
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (isInitializeRequest(body)) {
        // New session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, transport);
            console.log(`[connectome-mcp] Session initialized: ${sid}`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            console.log(`[connectome-mcp] Session closed: ${transport.sessionId}`);
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else if (sessionId && sessions.has(sessionId)) {
        // Existing session
        await sessions.get(sessionId)!.handleRequest(req, res, body);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Request: No valid session. Send initialize first.' }));
      }
    } else if (req.method === 'GET') {
      // SSE stream for notifications
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Request: No valid session ID' }));
      }
    } else if (req.method === 'DELETE') {
      // Session termination
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.writeHead(404);
        res.end('Session not found');
      }
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
    }
  });

  process.on('SIGINT', () => { shutdown(); httpServer.close(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); httpServer.close(); process.exit(0); });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[connectome-mcp] MCP HTTP server listening on 0.0.0.0:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error(`[connectome-mcp] Fatal: ${err.message}`);
  process.exit(1);
});
