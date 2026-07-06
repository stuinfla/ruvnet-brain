#!/usr/bin/env node
// forge-mcp.mjs — self-contained MCP stdio server for an rvf-kb-forge knowledge base.
//
// Exposes ONE tool:
//   search_kb({ query: string, k?: number = 6 })
// It embeds the query locally (MiniLM), queries the .rvf readonly, then loads the FULL
// passage text for each hit from <name>.passages.jsonl and returns it as readable text
// (path + title + full passage).
//
// Which KB to serve is set by env (so one .mcp.json entry per KB):
//   KB_DIR   directory holding <name>.rvf + <name>.passages.jsonl   (default: cwd)
//   KB_NAME  the KB filename prefix                                  (REQUIRED)
//
// Self-contained: needs only @ruvector/rvf, @xenova/transformers, and the bundled .rvf +
// .passages.jsonl. Implements MCP JSON-RPC over stdio directly (no SDK dep) — runs anywhere
// Node 18+ is available.
//
// DO NOT use @ruvector/rvf-mcp-server — it is a non-functional stub (never reads a prebuilt
// .rvf, returns no text). This server actually joins passages and returns content.

import path from 'node:path';
import { searchKb } from './forge-ask.mjs';

const KB_DIR = process.env.KB_DIR || process.cwd();
const KB_NAME = process.env.KB_NAME;
if (!KB_NAME) {
  process.stderr.write('forge-mcp: KB_NAME env is required (the KB filename prefix)\n');
  process.exit(2);
}

// Orphan guard (SEC-0010 #12, ported from forge-mcp-all.mjs): if the parent (Claude Code / the plugin
// proxy) is force-quit, our stdin may never EOF, leaving this model-laden server (~0.5 GB) resident
// forever. Re-parenting to PID 1 means the parent is gone → exit. Unref'd so it never keeps us alive.
const orphanGuard = setInterval(() => { if (process.ppid === 1) process.exit(0); }, 30000);
orphanGuard.unref();

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: `rvf-kb-forge:${KB_NAME}`, version: '1.0.0' };
const TOOLS = [
  {
    name: 'search_kb',
    description:
      `Semantic search over the "${KB_NAME}" RVF knowledge base. Returns up to 5 whole, self-`
      + 'contained matched DOCUMENTS (all chunks of each reassembled in order, de-overlapped — '
      + 'not fragments): docs, ADRs, DDDs, manifests, source doc-comments, tutorials, UI text, '
      + 'each with its repo path and title. Use it to understand the repo, find a specific '
      + 'decision/module, learn how to do something, or mine a subsystem in depth.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or keywords.' },
        k: { type: 'integer', description: 'Number of passages to return (default 6).', default: 6 },
      },
      required: ['query'],
    },
  },
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications
  switch (method) {
    case 'initialize':
      return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== 'search_kb') return err(id, -32602, `unknown tool: ${name}`);
      try {
        const query = String(args.query || '').trim();
        const k = Math.max(1, parseInt(args.k ?? 6, 10) || 6);
        if (!query) return err(id, -32602, 'query is required');
        const results = await searchKb({ dir: KB_DIR, name: KB_NAME, query, k });
        const text = results.map((r, i) =>
          `#${i + 1}  (distance ${r.bestDistance.toFixed(4)})\n`
          + `path : ${r.path}\n`
          + `title: ${r.title}\n`
          + `----- full document (${r.fullText.length} chars, ${r.chunksJoined} chunk(s)${r.truncated ? ', truncated' : ''}) -----\n`
          + `${r.fullText}\n`
        ).join('\n========================================================\n\n');
        return ok(id, { content: [{ type: 'text', text: text || '(no results)' }], isError: false });
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: `search_kb error: ${e.message}` }], isError: true });
      }
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}

let buf = '';
let inFlight = 0;
let ended = false;
function maybeExit() { if (ended && inFlight === 0) process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    inFlight++;
    Promise.resolve(handle(m))
      .catch((e) => { if (m && m.id != null) err(m.id, -32603, e.message); })
      .finally(() => { inFlight--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
process.stderr.write(`forge-mcp: serving "${KB_NAME}" from ${path.resolve(KB_DIR)}\n`);
