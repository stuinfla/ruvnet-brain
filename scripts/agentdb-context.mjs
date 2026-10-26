#!/usr/bin/env node
// scripts/agentdb-context.mjs — AGENTDB IS THE FIRST-PARTY KEEPER OF CONTEXT.
//
//   node scripts/agentdb-context.mjs --session-start   full recent context, for the SessionStart hook
//   node scripts/agentdb-context.mjs --window 48       last N hours, FULL text of every entry
//   node scripts/agentdb-context.mjs --grep "latency"  full text of every entry matching
//   node scripts/agentdb-context.mjs --key <key>       one entry, complete
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS — the owner, 2026-07-27, after the third time in one day:
//
//   "I am tired of you going 'oh, I checked and it was there', but I didn't bother to read it, or I
//    looked at one line even though there were 10,000 words. Whatever you need to do to make AgentDB
//    the first-party keeper of all the knowledge you rely on and you go to all the time, deeply,
//    completely, fully, totally."
//
// THE THREE FAILURES THIS CLOSES, all on 2026-07-27, all the same shape:
//   1. Told him Agentic-QE "did not run today" — from ONE `ls` of .agentic-qe/. It HAD run. AgentDB
//      and the session transcripts both held the record; neither was opened.
//   2. Re-derived the search-latency root cause from scratch at 19:00, having already measured and
//      WRITTEN it at 11:50 (`brain-search-latency-rootcause`). Two hours of duplicated work because
//      a crash ate the context and nothing reloaded it.
//   3. Reported "4 branches unmerged" from a checkpoint, when one had already landed as PR #50.
//
// Every one of those was a SKIM: a directory listing, a key name, a one-line summary — never the
// 1,824-byte entry that held the answer. So the fix is NOT another instruction telling me to read
// carefully. Instructions decay; today proved it three times before dinner. The fix is to put the
// FULL TEXT in the context window automatically, so there is nothing left to skim.
//
// DESIGN LAW (ADR-055): substance, never ceremony. A recall that records "a lookup happened" is the
// grounding-stamp failure in a new costume — "The Brain did its job. I ignored it." This prints the
// CONTENT. The test of success is not that it ran; it is that the answer was already on screen.
//
// NO SILENT CAPS. There is a byte budget, because a context window is finite. When it binds, this
// says SO, out loud, with the exact count of what was withheld and the command to read it. A quiet
// truncation reads as "that's all there is", which is the same lie one layer down.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

// Budget. Generous on purpose: the failure mode being fixed is starvation, not excess. ~48KB is a
// small fraction of the window and buys the entire recent history at FULL fidelity.
const DEFAULT_BUDGET = 48_000;

// Entry classes, most load-bearing first. Ordering matters: when the budget binds, what survives
// should be the findings and the negatives, not the routine checkpoints.
const PRIORITY = [
  { re: /rootcause|root-cause|ROOT-CAUSE/i, label: 'ROOT CAUSE', rank: 0 },
  { re: /^NORTH-STAR|north-star/i, label: 'NORTH STAR', rank: 0 },
  { re: /lesson-/i, label: 'LESSON', rank: 1 },
  { re: /project-state-current/i, label: 'CHECKPOINT', rank: 2 },
  { re: /session-(precompact|sessionend)/i, label: 'SESSION SNAPSHOT', rank: 3 },
];
function classify(key) {
  for (const p of PRIORITY) if (p.re.test(key)) return p;
  return { label: 'NOTE', rank: 1 };
}

export function dbPath(root = REPO_ROOT) { return path.join(root, '.swarm', 'memory.db'); }

// -json, never a delimiter. `content` is multi-line prose containing every punctuation mark there
// is; the first draft framed rows with control characters and returned ZERO rows because they did
// not survive the shell. JSON is the only framing sqlite3 offers that the payload cannot break.
function sqliteJson(db, sql) {
  const r = spawnSync('sqlite3', ['-json', db, sql], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, rows: [], err: (r.stderr || '').trim() || `sqlite3 exit ${r.status}` };
  const out = (r.stdout || '').trim();
  if (!out) return { ok: true, rows: [] };
  try { return { ok: true, rows: JSON.parse(out) }; }
  catch (e) { return { ok: false, rows: [], err: `unparseable sqlite3 -json output: ${e.message}` }; }
}

/**
 * TWO SCHEMA GENERATIONS EXIST IN THE WILD, and a loader that knows only one is a loader that
 * silently returns nothing. Measured across all 54 stores on this machine, 2026-07-28:
 *
 *   LEGACY  payload in `value`; `content` exists but DEFAULTS TO '' and is empty in every row.
 *           created_at = strftime('%s','now')          -> epoch SECONDS
 *   CURRENT payload in `content`.
 *           created_at = strftime('%s','now') * 1000   -> epoch MILLISECONDS
 *
 * The first draft read `content` and assumed millis. Result: 8 projects holding 14,000+ entries —
 * Red Clover Inn (6,358), AI Retirement Analyzer (7,198), XrAy-I, MedReview, partsourcepurchase,
 * stratasocial, Christina Massuh, Fin Decision Website — loaded ABSOLUTELY NOTHING, and did so
 * quietly. Their dates rendered as 1970-01-21, which is what a seconds timestamp looks like after
 * you divide it by 1000 a second time.
 *
 * Both facts are DERIVED per store, never configured: columns from PRAGMA table_info, and the epoch
 * unit from the magnitude of the value itself. Anything below 1e12 cannot be a modern millisecond
 * timestamp (1e12 ms = 2001-09-09), so it is seconds.
 */
export function readEntries(db, { sinceMs, grep, key } = {}) {
  if (!fs.existsSync(db)) return { ok: false, entries: [], err: `no AgentDB at ${db}` };

  const cols = sqliteJson(db, "PRAGMA table_info(memory_entries);");
  if (!cols.ok) return { ok: false, entries: [], err: cols.err };
  const have = new Set(cols.rows.map((c) => String(c.name)));
  if (!have.has('key')) return { ok: false, entries: [], err: 'no memory_entries.key — not an AgentDB store' };

  // Payload: prefer a non-empty `content`, fall back to `value`. COALESCE+NULLIF handles the legacy
  // rows where `content` is present-but-'' rather than NULL.
  const payload = have.has('content') && have.has('value') ? "COALESCE(NULLIF(content,''), value)"
    : have.has('content') ? 'content'
    : have.has('value') ? 'value' : "''";
  const nsCol = have.has('namespace') ? 'namespace' : "'default'";
  const tsCol = have.has('created_at') ? 'created_at' : (have.has('updated_at') ? 'updated_at' : '0');

  let where = `TRIM(${payload}) <> ''`;
  if (key) where += ` AND key = '${String(key).replace(/'/g, "''")}'`;
  if (grep) {
    const g = String(grep).replace(/'/g, "''");
    where += ` AND (lower(${payload}) LIKE lower('%${g}%') OR lower(key) LIKE lower('%${g}%'))`;
  }
  // NOTE: the time window is applied in JS, AFTER normalizing the epoch unit — doing it in SQL would
  // require knowing the unit before reading a single row, which is the bug this function exists to fix.
  const sql = `SELECT key AS k, ${nsCol} AS ns, ${tsCol} AS ts, ${payload} AS body
               FROM memory_entries WHERE ${where} ORDER BY ${tsCol} DESC LIMIT 4000;`;
  const r = sqliteJson(db, sql);
  if (!r.ok) return { ok: false, entries: [], err: r.err };

  const MILLIS_FLOOR = 1e12;   // 1e12 ms = 2001-09-09; anything smaller is seconds
  let entries = r.rows.map((row) => {
    const raw = Number(row.ts ?? 0);
    return {
      key: String(row.k ?? ''),
      namespace: String(row.ns ?? ''),
      at: raw > 0 && raw < MILLIS_FLOOR ? raw * 1000 : raw,
      content: String(row.body ?? ''),
    };
  }).filter((e) => e.key && e.content);

  if (sinceMs) entries = entries.filter((e) => e.at >= sinceMs);
  return { ok: true, entries };
}

const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

export function render(entries, { budget = DEFAULT_BUDGET, header = '' } = {}) {
  const ranked = entries
    .map((e) => ({ ...e, cls: classify(e.key) }))
    .sort((a, b) => (a.cls.rank - b.cls.rank) || (b.at - a.at));

  const lines = [];
  if (header) lines.push(header);
  let used = header.length;
  let shown = 0;
  const withheld = [];

  for (const e of ranked) {
    const block = `\n── [${e.cls.label}] ${e.key}  (${stamp(e.at)}, ${e.content.length}B)\n${e.content}\n`;
    if (used + block.length > budget) { withheld.push(e); continue; }
    lines.push(block);
    used += block.length;
    shown++;
  }

  if (withheld.length) {
    // NO SILENT CAPS. Name the count, the bytes, and exactly how to read them.
    const bytes = withheld.reduce((n, e) => n + e.content.length, 0);
    lines.push(`\n── ⚠ BUDGET BOUND — ${withheld.length} further entr${withheld.length === 1 ? 'y' : 'ies'} `
      + `(${bytes.toLocaleString()} bytes) NOT shown above. This is a cap, not an absence — do not `
      + `read the list above as complete. Read any of them in FULL with:\n`
      + withheld.slice(0, 12).map((e) => `     node scripts/agentdb-context.mjs --key "${e.key}"`).join('\n')
      + (withheld.length > 12 ? `\n     …and ${withheld.length - 12} more (--window <hours> to widen).` : ''));
  }
  return { text: lines.join('\n'), shown, withheld: withheld.length };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const db = arg('--db', dbPath());

  const sessionStart = argv.includes('--session-start');
  const hours = Number(arg('--window', sessionStart ? 36 : 48));
  const grep = arg('--grep', null);
  const key = arg('--key', null);
  const budget = Number(arg('--budget', DEFAULT_BUDGET));

  const sinceMs = key || grep ? null : Date.now() - hours * 3600_000;
  const r = readEntries(db, { sinceMs, grep, key });

  if (!r.ok) {
    // Fail SILENT for the hook (an absent store in another project is normal), loud for a human.
    if (!sessionStart) console.error(`[agentdb-context] ${r.err}`);
    return 0;
  }
  if (!r.entries.length) {
    if (!sessionStart) console.log('[agentdb-context] no entries matched.');
    return 0;
  }

  const header = sessionStart
    ? `[AgentDB — FULL PROJECT CONTEXT, last ${hours}h. THIS IS THE RECORD. Read it before you assert `
      + `anything about what happened, what was measured, what was decided, or what is still open. `
      + `It exists because "I checked and it was there" — after reading one line of a 10,000-word `
      + `entry — cost this project three duplicated investigations in a single day. Do not skim it; `
      + `it is already the summary. Where it disagrees with your memory, IT is right.]`
    : `[AgentDB — ${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'}, full text]`;

  const out = render(r.entries, { budget, header });
  console.log(out.text);
  if (!sessionStart) console.error(`\n[agentdb-context] ${out.shown} shown, ${out.withheld} withheld by budget.`);
  return 0;
}

function isMain() {
  try { return isDirectInvocation(import.meta.url); }
  catch { return false; }
}
if (isMain()) process.exit(main());
