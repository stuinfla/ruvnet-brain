#!/usr/bin/env node
// scripts/metaharness-receipts.mjs — plain-language routing receipts: what MetaHarness cheap-routing
// actually did and what it saved. Reads the REAL log written by scripts/route-cheap.mjs at
// ~/.claude/metaharness/routing-receipts.jsonl (override: METAHARNESS_RECEIPTS env, used by tests).
// No data → says so plainly. Never invents numbers (all costs are estimates from verified
// OpenRouter pricing + chars/4 token estimates, and are labeled "est.").
//
// Usage: node scripts/metaharness-receipts.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export function receiptsPath() {
  return (
    process.env.METAHARNESS_RECEIPTS ||
    path.join(os.homedir(), '.claude', 'metaharness', 'routing-receipts.jsonl')
  );
}

// Parse the JSONL log. Corrupt lines are skipped (counted), never guessed at.
export function loadReceipts(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], skipped: 0 };
  }
  const rows = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.saved === 'number' && r.model) rows.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

const fmt$ = (n) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;
// Measured wall-clock, human-readable. '-' when the receipt has no duration — never invented.
const fmtT = (ms) => {
  if (typeof ms !== 'number' || !(ms > 0)) return '-';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
};

export function formatTable(rows) {
  if (!rows.length) return 'No routing receipts yet.\nRoute something cheap first:  node scripts/route-cheap.mjs --task "<text>"';

  // `channel` + `instead of` (2026-07-13): subagent receipts arrived with a per-row baseline — the
  // model that agent WOULD have inherited — so a single global "frontier" column would misreport them.
  const header = ['date', 'channel', 'task class', 'model used', 'instead of', 'est. cost', 'est. baseline', 'saved', 'time'];
  const body = rows.map((r) => [
    (r.ts || '').replace('T', ' ').slice(0, 16),
    r.source === 'claude-subagent' ? 'subagent' : r.source === 'calibration' ? 'calibrate' : 'openrouter',
    r.task_class || '?',
    r.model,
    r.frontier_ref || 'claude-opus-4.8',
    fmt$(r.est_cost ?? 0),
    fmt$(r.est_frontier_cost ?? 0),
    fmt$(r.saved),
    fmtT(r.duration_ms), // measured, never estimated — '-' when absent
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');

  const totalCost = rows.reduce((s, r) => s + (r.est_cost || 0), 0);
  const totalFrontier = rows.reduce((s, r) => s + (r.est_frontier_cost || 0), 0);
  const totalSaved = rows.reduce((s, r) => s + r.saved, 0);
  const ratio = totalCost > 0 ? (totalFrontier / totalCost).toFixed(1) : '?';
  // Lead with the PERCENTAGE — "$1.83" reads as pocket change; "68% cheaper" is the actual
  // message (Stuart, 2026-07-13). Dollars stay for auditability; percent carries the story.
  const pct = totalFrontier > 0 ? Math.round((totalSaved / totalFrontier) * 100) : 0;

  // Baselines now vary per row; name them all rather than picking one and implying it covers everything.
  const baselines = [...new Set(rows.map((r) => r.frontier_ref || 'claude-opus-4.8'))].join(', ');
  const timedTotal = rows.reduce((s, r) => s + (typeof r.duration_ms === 'number' && r.duration_ms > 0 ? r.duration_ms : 0), 0);
  const timedRows = rows.filter((r) => typeof r.duration_ms === 'number' && r.duration_ms > 0).length;
  // TIME as a percentage, like cost — "20 seconds" is trivia; "~40% faster" is the message
  // (Stuart, 2026-07-13: cheaper AND faster = fundamentally more efficient). Only rows carrying a
  // MEASURED baseline_duration_ms (written by the calibration harness) enter this comparison.
  const paired = rows.filter((r) => r.duration_ms > 0 && r.baseline_duration_ms > 0);
  const pairedRouted = paired.reduce((s, r) => s + r.duration_ms, 0);
  const pairedBase = paired.reduce((s, r) => s + r.baseline_duration_ms, 0);
  const fasterPct = pairedBase > 0 ? Math.round((1 - pairedRouted / pairedBase) * 100) : null;
  // Say what the measurement actually says — FASTER, SLOWER, or parity. The 2026-07-13
  // calibration measured cheap tiers at speed PARITY on micro-tasks (startup dominates);
  // a card that only knows how to say "faster" would have lied.
  const speedBadge = fasterPct === null ? ''
    : fasterPct >= 5 ? `  ·  ⚡ ~${fasterPct}% FASTER (measured, n=${paired.length})`
    : fasterPct <= -5 ? `  ·  ⏱ ~${-fasterPct}% slower on routed tier (measured, n=${paired.length})`
    : `  ·  ⚡ speed parity (measured, n=${paired.length})`;
  const subagents = rows.filter((r) => r.source === 'claude-subagent').length;

  // The card leads with the PERCENTAGE and a spent-vs-unrouted bar — "$1.83" reads as pocket
  // change; "68% cheaper", drawn, is the message (Stuart, 2026-07-13). The dollar table stays
  // below for auditability; every number still traces to a receipt row.
  const BAR = 30;
  const withBar = totalFrontier > 0 ? Math.min(BAR, Math.max(1, Math.round(BAR * (totalCost / totalFrontier)))) : BAR;
  const drawBar = (n) => '█'.repeat(n) + '░'.repeat(BAR - n);
  const rule = '─'.repeat(70);
  // ── IS THIS STILL HAPPENING, OR IS IT A SOUVENIR? (added 2026-08-08) ──────────────────────────
  //
  // This card reported "SAVED ~61% · 43 routed tasks" for FOURTEEN DAYS after routing had entirely
  // stopped. Every number was true and every number was history: the newest receipt was 2026-07-24,
  // and in the fortnight since — including three days of heavy work — not one task was routed. The
  // card looked like a live dashboard and was actually a museum plaque.
  //
  // SKILL.md already records this exact failure once ("after two days, the receipts log held 3
  // entries, all test pings, $0.018 saved — while real work was done inline in the most expensive
  // model") and answered it by making the routing rule a floor rather than advice. That did not
  // help, because nothing MEASURED whether the floor was being honoured. A silent zero reads
  // identically to a healthy system, which is the same disease as every other defect fixed this
  // week: a surface reporting something other than what it measured.
  //
  // So the card now leads with recency. Savings you earned last month are not savings you are
  // earning, and a stale ledger must say so before it says anything else.
  const newest = rows.map((r) => Date.parse(r.ts || r.date || r.at || 0)).filter(Boolean).sort().at(-1);
  const idleDays = newest ? (Date.now() - newest) / 86_400_000 : Infinity;
  const staleness = !Number.isFinite(idleDays)
    ? '  ⚠ NO ROUTING RECEIPTS AT ALL — these numbers describe nothing that has happened.'
    : idleDays >= 3
      ? `  ⚠ STALE: nothing has been routed in ${Math.floor(idleDays)} days (newest receipt ${new Date(newest).toISOString().slice(0, 10)}).\n`
        + '     The figures below are HISTORY, not current performance — mechanical work is running unrouted.'
      : null;

  return [
    rule,
    ...(staleness ? [staleness, ''] : []),
    `  💰 SAVED ~${pct}%${speedBadge}  ·  ~${ratio}× cheaper  ·  ${rows.length} routed task(s) (${subagents} subagent, ${rows.length - subagents} openrouter/calibration)`,
    '',
    `  without routing    ${drawBar(BAR)}  ${fmt$(totalFrontier)}`,
    `  with MetaHarness   ${drawBar(withBar)}  ${fmt$(totalCost)}   → ~${fmt$(totalSaved)} kept`,
    rule,
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
    '',
    `Baselines: ${baselines} — the model each task would have run on if it had not been routed.`,
    'Pricing is live-verified. Token counts are measured OR estimated per row (each row records which, in token_source).',
    // Time honesty: durations are MEASURED wall-clock of the routed run. A "time saved vs baseline"
    // number requires a measured per-tier speed baseline (the calibration batch) — until that exists
    // we state the gap instead of inventing the comparison.
    fasterPct !== null
      ? `Time, measured: routed ${fmtT(pairedRouted)} vs baseline ${fmtT(pairedBase)} on ${paired.length} calibrated task(s) → ${fasterPct >= 5 ? `~${fasterPct}% faster` : fasterPct <= -5 ? `~${-fasterPct}% slower (startup-dominated micro-tasks — speed wins come from parallel fan-out and long generations, measured from real dispatches)` : 'speed parity'}. Uncalibrated rows show routed time only.`
      : timedTotal > 0
        ? `Measured time on routed models: ${fmtT(timedTotal)} across ${timedRows} timed task(s). Time-SAVED vs baseline: not yet measured — appears after the per-tier calibration run.`
        : 'No measured durations in these receipts yet. Time-saved reporting activates after the per-tier calibration run.',
  ].join('\n');
}

function main() {
  const file = receiptsPath();
  const { rows, skipped } = loadReceipts(file);
  console.log(`MetaHarness routing receipts — ${file}`);
  console.log('');
  console.log(formatTable(rows));
  if (skipped) console.log(`(${skipped} corrupt line(s) skipped)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
