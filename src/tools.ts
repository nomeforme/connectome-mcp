/**
 * Connectome MCP Tool Definitions
 *
 * Tools map to ConnectomeService gRPC RPCs and shared workspace filesystem operations.
 * Schemas define the JSON Schema for MCP parameter validation.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export const CONNECTOME_TOOLS: ToolDefinition[] = [
  {
    name: 'health',
    description:
      'Check Connectome server health. Returns current VEIL sequence number, active stream/agent counts, and uptime. Use this first to verify the server is reachable.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_streams',
    description:
      'List all registered streams with metadata. Streams map to platform channels (e.g. "discord:guildId:channelId"). Returns stream IDs, names, metadata, and parent relationships.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_agents',
    description:
      'List all registered agents with their type, capabilities, and last-active timestamps.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_speech',
    description:
      'Get recent speech facets (agent responses). Filter by stream or agent to see what a specific bot said in a specific channel. Returns content, agent info, timestamps, and whether the cycle was still pending.',
    inputSchema: {
      type: 'object',
      properties: {
        stream_id: {
          type: 'string',
          description: 'Filter by stream ID (e.g. "discord:123:456")',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID',
        },
        limit: {
          type: 'number',
          description: 'Max speech facets to return (default: 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'get_events',
    description:
      'Get recent event facets (incoming messages from platforms). Filter by stream to see messages in a specific channel. Returns content, author info, timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        stream_id: {
          type: 'string',
          description: 'Filter by stream ID',
        },
        limit: {
          type: 'number',
          description: 'Max event facets to return (default: 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'get_facets',
    description:
      'Query facets by type, stream, or agent. Facet types include: event, speech, thought, action, state, config, agent-command, agent-typing-stop. Use this for flexible queries across all facet types.',
    inputSchema: {
      type: 'object',
      properties: {
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Facet types to include (e.g. ["speech", "event"])',
        },
        stream_id: {
          type: 'string',
          description: 'Filter by stream ID',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID',
        },
        limit: {
          type: 'number',
          description: 'Max facets to return (default: 50)',
          default: 50,
        },
      },
    },
  },
  {
    name: 'get_context',
    description:
      'Get the rendered conversation context for a specific agent on a specific stream. This is exactly what the agent sees when processing — conversation history with roles, timestamps, and state. Requires both agent_id and stream_id.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Agent ID',
        },
        stream_id: {
          type: 'string',
          description: 'Stream ID',
        },
        max_frames: {
          type: 'number',
          description: 'Max frames to include (default: 100)',
          default: 100,
        },
        max_tokens: {
          type: 'number',
          description: 'Max token budget (default: 100000)',
          default: 100000,
        },
      },
      required: ['agent_id', 'stream_id'],
    },
  },
  {
    name: 'get_frames',
    description:
      'Get VEIL frame history — the immutable event log. Each frame has a sequence number, timestamp, events that triggered it, and VEIL deltas (facet add/rewrite/remove). Use for debugging event ordering and state mutations.',
    inputSchema: {
      type: 'object',
      properties: {
        from_sequence: {
          type: 'number',
          description: 'Start sequence (default: 0 = earliest available)',
          default: 0,
        },
        to_sequence: {
          type: 'number',
          description: 'End sequence (default: 0 = current)',
          default: 0,
        },
        stream_id: {
          type: 'string',
          description: 'Filter frames by stream ID',
        },
        limit: {
          type: 'number',
          description: 'Max frames to return (default: 50)',
          default: 50,
        },
      },
    },
  },
  {
    name: 'emit_event',
    description:
      'Emit an event into the Connectome space. Use for agent commands (!stop, !steer), typing indicators, or custom events. Common topics: "agent:command" (with payload {type: "stop", targetAgent: "..."}), "agent:typing-stop".',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Event topic (e.g. "agent:command", "agent:typing-stop")',
        },
        payload: {
          type: 'object',
          description: 'Event payload (JSON object)',
        },
      },
      required: ['topic', 'payload'],
    },
  },

  // ── Shared Workspace Tools ──────────────────────────────────
  {
    name: 'workspace_list',
    description:
      'List files and directories in the shared workspace. The shared workspace is a persistent volume where bots save artifacts (documents, images, code, PDFs). Returns file names, sizes, and modification times. Use path to list subdirectories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within the workspace to list (default: root ".")',
          default: '.',
        },
      },
    },
  },
  {
    name: 'workspace_read',
    description:
      'Read the contents of a file from the shared workspace. Supports text files (md, txt, py, js, ts, json, yaml, html, css, sh, csv). For binary files, returns metadata only. Max 100KB per read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file within the workspace',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_search',
    description:
      'Search for files in the shared workspace by name pattern or content. Finds files matching a glob pattern and optionally searches within their contents using a regex pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description: 'Glob pattern for file names (e.g. "*.md", "**/*.py", "nousnet/**")',
          default: '*',
        },
        content_pattern: {
          type: 'string',
          description: 'Optional regex to search within matching files',
        },
        max_results: {
          type: 'number',
          description: 'Max results to return (default: 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'workspace_write',
    description:
      'Write or update a file in the shared workspace. Creates parent directories as needed. Use for saving artifacts, documents, or data that should persist across bot sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path for the file within the workspace',
        },
        content: {
          type: 'string',
          description: 'File content to write',
        },
        append: {
          type: 'boolean',
          description: 'Append to existing file instead of overwriting (default: false)',
          default: false,
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'workspace_delete',
    description:
      'Delete a file from the shared workspace. Cannot delete directories — only individual files. Returns confirmation or error.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path of the file to delete',
        },
      },
      required: ['path'],
    },
  },
];
