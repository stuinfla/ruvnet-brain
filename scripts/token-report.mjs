#!/usr/bin/env node
// scripts/token-report.mjs — the read side of the token meter (ADR-0011 token_cost_efficiency).
//
// The brain injects context via hooks (ground-ruvnet.sh / session-start.sh) and serves retrieval
// via MCP (forge-mcp-all.mjs); each of those appends one JSON line per fire to
// .ruvnet-brain/token-ledger.jsonl with the REAL measured size of what it emitted. This script
// aggregates that ledger into a plain-text table: per class, the fire count and the p50/p95 byte
// sizes plus an estimated token total — HONESTLY labeled an estimate (tokens ≈ bytes/4; we measure
// bytes exactly, we do not run a tokenizer). Zero dependencies, Node built-ins only.
//
//   node scripts/token-report.mjs                       # reads ./.ruvnet-brain/token-ledger.jsonl
//   node scripts/token-report.mjs --ledger <path>       # explicit ledger (tests use this)
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const ledgerIdx = argv.indexOf('--ledger');
const LEDGER =
  ledgerIdx !== -1 && argv[ledgerIdx + 1]
    ? argv[ledgerIdx + 1]
    : path.join(process.cwd(), '.ruvnet-brain', 'token-ledger.jsonl');

// Nearest-rank percentile on a pre-sorted ascending array — the standard textbook definition,
// chosen because it always returns a value that actually occurred (no interpolation to invent one).
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAsc.length));
  return sortedAsc[rank - 1];
}

const estTokens = (bytes) => Math.round(bytes / 4);

if (!fs.existsSync(LEDGER)) {
  console.log(`meter: no data yet (${LEDGER} not found — it appears after the first hook/MCP fire)`);
  process.exit(0);
}

// One group per class: hook lines group by their prompt-class, MCP lines by tool name — the label
// says which side of the brain spent the bytes.
const groups = new Map();
let skipped = 0;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { skipped++; continue; }
  const bytes = Number(e?.bytes);
  if (!e || !e.source || !Number.isFinite(bytes)) { skipped++; continue; }
  const label = e.source === 'mcp' ? `mcp:${e.tool || 'unknown'}` : `hook:${e.class || 'unknown'}`;
  if (!groups.has(label)) groups.set(label, []);
  groups.get(label).push(bytes);
}

if (groups.size === 0) {
  console.log(`meter: no data yet (${LEDGER} has no valid entries)`);
  process.exit(0);
}

const rows = [...groups.entries()]
  .map(([label, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const total = sorted.reduce((s, b) => s + b, 0);
    return {
      label,
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      total,
      tokens: estTokens(total),
    };
  })
  .sort((a, b) => b.total - a.total);

const grandBytes = rows.reduce((s, r) => s + r.total, 0);
const grandCount = rows.reduce((s, r) => s + r.count, 0);

// Plain fixed-width table — no dependencies, pipes cleanly.
const cols = [
  ['class', (r) => r.label],
  ['count', (r) => String(r.count)],
  ['p50 bytes', (r) => String(r.p50)],
  ['p95 bytes', (r) => String(r.p95)],
  ['total bytes', (r) => String(r.total)],
  ['~tokens (bytes/4)', (r) => String(r.tokens)],
];
const widths = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => f(r).length)));
const fmt = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');

console.log(`token meter — ${LEDGER}`);
console.log(fmt(cols.map(([h]) => h)));
console.log(fmt(widths.map((w) => '-'.repeat(w))));
for (const r of rows) console.log(fmt(cols.map(([, f]) => f(r))));
console.log('');
console.log(
  `session total: ${grandCount} injections, ${grandBytes} bytes ≈ ${estTokens(grandBytes)} tokens (estimate: bytes/4)`,
);
if (skipped > 0) console.log(`(${skipped} malformed line(s) skipped)`);
