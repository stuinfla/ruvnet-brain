// Dynamic tool manifest — loaded fresh on each tools/list call.
// This file updates with each release; the server loads it dynamically without restart.
//
// Rationale: MCP servers are frozen at session start. By exporting tools from a manifest
// that changes with updates, we let the server reload them on-the-fly without restarting
// Claude Code. Each tools/list or tools/call checks if this file changed and serves new schema.

export const TOOLS = [
  {
    name: 'search_ruvnet',
    description: 'Source-grounded knowledge base for the RuvNet ecosystem. The first call may wait while the local search worker becomes ready.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or keywords about any part of RuvNet.' },
        k: { type: 'integer', description: 'Number of documents to return (default 6).', default: 6 },
      },
      required: ['query'],
    },
  },
];

// Manifest version — bump this when tools change (schema, name, description).
// The server compares this to detect updates without checking file mtimes.
export const MANIFEST_VERSION = '4.3.21';
