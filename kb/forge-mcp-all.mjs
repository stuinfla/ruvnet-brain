#!/usr/bin/env node
// forge-mcp-all.mjs — ONE MCP tool over the WHOLE RuvNet brain (every repo in the bundle).
//
// Where forge-mcp.mjs serves a single KB, this serves the entire bundle as one brain. It exposes:
//   search_ruvnet({ query: string, k?: number = 6 })
// which retrieves candidates from EVERY repo present in the bundle dir (reusing searchKb, which
// auto-selects each repo's sharp `big` variant when present), pools them, re-scores the whole pool
// with one cross-encoder pass so cross-repo hits are comparable, and returns the globally best
// whole DOCUMENTS — each labeled with the repo + path it is grounded in.
//
//   KB_DIR   directory holding the bundle's <repo>.rvf + <repo>.passages.jsonl files (default: cwd)
//   KB_REPOS optional comma-list to restrict which repos are searched (default: all discovered)
//
// Self-contained: needs only @ruvector/rvf, @xenova/transformers, and the bundled per-repo files.
// DO NOT use @ruvector/rvf-mcp-server (a non-functional stub). This server joins passages and
// returns real source text from across the ecosystem.

import fs from 'node:fs';
import path from 'node:path';
import { searchAll, discoverRepos } from './forge-ask-all.mjs';
import { guardPassages } from './forge-guard-injection.mjs';

// ── TOKEN METER (ADR-0011 token_cost_efficiency): one JSON line per search_ruvnet call recording
// the REAL size (chars) of the response text handed back to the model — appended to the SAME
// per-project ledger the plugin hooks write (.ruvnet-brain/token-ledger.jsonl in this process's
// cwd, which the plugin proxy inherits from the Claude Code session; read it with
// scripts/token-report.mjs). RUVNET_BRAIN_METER=0 disables. Fully guarded: metering must NEVER
// break, delay, or surface into a query — any failure here is swallowed silently.
function meterLog(entry) {
  try {
    if (process.env.RUVNET_BRAIN_METER === '0') return;
    const dir = path.join(process.cwd(), '.ruvnet-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'token-ledger.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* never let metering break a query */ }
}

const KB_DIR = process.env.KB_DIR || process.cwd();
const REPOS = (process.env.KB_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
let discovered = [];
try { discovered = discoverRepos(KB_DIR); } catch { /* dir checked at call time */ }
const repoList = (REPOS.length ? REPOS : discovered);

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ruvnet-brain', version: '1.0.0' };
const TOOLS = [
  {
    name: 'search_ruvnet',
    description:
      'THE authoritative, source-grounded knowledge base for the entire RuvNet ecosystem '
      + `(repos: ${repoList.join(', ') || 'auto-discovered'}). Each result is a whole, self-`
      + 'contained DOCUMENT from rUv\'s REAL source — actual code, ADRs (with shipped-vs-proposed '
      + 'status), DDDs, manifests, source bodies and doc-comments — labeled with the repo + file '
      + 'path it came from. ALWAYS call this before answering ANY question about RuvNet, RuVector, '
      + 'ruflo, AgentDB, RuLake, RuView, RVF, or what any of these repos can do — and before '
      + 'writing code that uses them. Do NOT answer about RuvNet from memory and do NOT assume a '
      + 'capability is missing: if a feature exists, this returns the file that implements it. '
      + 'Cite the returned repo/path. If results show an ADR is "Proposed", say so (design intent, '
      + 'not shipped).',
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
      if (name !== 'search_ruvnet') return err(id, -32602, `unknown tool: ${name}`);
      try {
        const query = String(args.query || '').trim();
        const k = Math.max(1, parseInt(args.k ?? 6, 10) || 6);
        if (!query) return err(id, -32602, 'query is required');
        const { results: rawResults, repos } = await searchAll({ dir: KB_DIR, query, k, repos: REPOS.length ? REPOS : undefined });
        // SECURITY FLOOR: scan each retrieved passage for prompt-injection right before it leaves
        // the MCP boundary (the highest-value, lowest-risk choke point). A flagged passage is WRAPPED
        // as inert reference data so an autonomous Claude won't execute an instruction injected into
        // an untrusted ingested repo. Exit-safe: guardPassages never throws into the search path.
        const results = guardPassages(rawResults);
        const text = results.map((r, i) =>
          `#${i + 1}  repo=${r.repo}  (relevance ${r.ceScore == null ? 'n/a' : r.ceScore.toFixed(3)}; vec ${r.bestDistance?.toFixed(4)})\n`
          + `path : ${r.repo}/${r.path}\n`
          + `title: ${r.title}\n`
          + (r.statusLabel ? `${r.statusLabel}\n` : '')
          + (r.designIntentWarning ? `${r.designIntentWarning}\n` : '')
          + `----- full document (${(r.fullText || '').length} chars, ${r.chunksJoined} chunk(s)${r.truncated ? ', truncated' : ''}) -----\n`
          + `${r.fullText || r.text || ''}\n`
        ).join('\n========================================================\n\n');
        const header = `Searched ${repos.length} RuvNet repos (${repos.join(', ')}).\n\n`;
        const body = text ? header + text : '(no results)';
        meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k, bytes: body.length });
        return ok(id, { content: [{ type: 'text', text: body }], isError: false });
      } catch (e) {
        const body = `search_ruvnet error: ${e.message}`;
        // k re-derived: the try-block's `k` is out of scope here, and an error response is still
        // injected context — it counts.
        meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k: Math.max(1, parseInt(args.k ?? 6, 10) || 6), bytes: body.length });
        return ok(id, { content: [{ type: 'text', text: body }], isError: true });
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
// Orphan guard: if the parent (the plugin proxy / Claude Code) is force-quit, our stdin may never
// EOF, leaving this model-laden server (~0.5 GB) resident forever — observed as multi-hour orphans.
// Re-parenting to PID 1 (launchd/init) means the parent is gone, so exit. Unref'd so it never keeps
// the event loop alive on its own (normal stdin-'end' exit still applies).
const orphanGuard = setInterval(() => { if (process.ppid === 1) process.exit(0); }, 30000);
orphanGuard.unref();
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
process.stderr.write(`forge-mcp-all: serving RuvNet brain (${repoList.join(', ') || 'auto'}) from ${path.resolve(KB_DIR)}\n`);
