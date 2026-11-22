#!/usr/bin/env node
// scripts/router-utilization.mjs — the ONGOING view across all 4 subscription hosts
// (antigravity, claude-code, codex, grok) + metered receipts.
//
// Reads both ~/.claude/metaharness/routing-receipts.jsonl AND ~/.claude/metaharness/routing-decisions.jsonl
// so subscription-first routing (10,000+ decisions at $0 marginal cost) is visible alongside subagent
// dispatches in the RuvNet Brain Console (`Smart model routing` stacked bar chart) and CLI.
//
// Uses Artificial Analysis v5.0.1 cost-to-solve per task across effort levels when token counts are
// absent on decision rows, and exact token-price math when token counts are present.
//
// Usage: node scripts/router-utilization.mjs [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_MODEL_IDS, FRONTIER, priceOf, receiptsPath } from './route-cheap.mjs';

const BAND_BY_MODEL = {
  'agent-booster': 'mechanical',
  'inclusionai/ling-2.6-flash': 'cheap',
  [CLAUDE_MODEL_IDS.haiku]: 'cheap',
  'claude-haiku-4-5-20251001': 'cheap',
  'claude-haiku-5-5': 'cheap',
  'gpt-5.6-luna': 'cheap',
  'gpt-6-luna': 'cheap',
  'gemini-4-flash': 'cheap',
  'deepseek/deepseek-chat': 'cheap',
  'deepseek/deepseek-v4-flash': 'cheap',
  'meta-llama/llama-3.3-70b-instruct': 'mid',
  'openai/gpt-4.1': 'mid',
  'x-ai/grok-4.5': 'mid',
  'grok-4.7': 'mid',
  'gemini-4-argon': 'mid',
  'gpt-5.6-terra': 'mid',
  'gpt-6-sol': 'mid',
  'gpt-6.1-sol': 'mid',
  'gpt-6.2-sol': 'mid',
  'claude-sonnet-4-6': 'mid',
  [CLAUDE_MODEL_IDS.sonnet]: 'mid',
  'claude-sonnet-5-5': 'mid',
  [CLAUDE_MODEL_IDS.opus]: 'frontier',
  'claude-opus-4-7': 'frontier',
  'claude-opus-5': 'frontier',
  'claude-opus-5-5': 'frontier',
  [CLAUDE_MODEL_IDS.fable]: 'frontier',
  'claude-fable-5-1': 'frontier',
  'claude-fable-5-2': 'frontier',
  'gpt-5.6-sol': 'frontier',
  'gpt-6-astra': 'frontier',
  'gpt-6.2-astra': 'frontier',
  'gemini-4-neon': 'frontier',
  'grok-build': 'frontier',
};

// Artificial Analysis v5.0.1 average task cost-to-solve (USD equivalent quota weight) by (band, effort).
// Used for decision-log rows that record model + effort + taskClass so the console shows real
// quota-value savings compared to running every turn on Opus 5.5 / Fable 5.2 high.
const AA_TASK_COST_EQUIV = {
  mechanical: { low: 0.0, medium: 0.0, high: 0.0, xhigh: 0.0, max: 0.0 },
  cheap: { low: 0.18, medium: 0.35, high: 0.60, xhigh: 0.90, max: 1.20 },
  mid: { low: 0.75, medium: 1.45, high: 2.20, xhigh: 3.10, max: 4.00 },
  frontier: { low: 0.95, medium: 2.15, high: 3.60, xhigh: 6.25, max: 10.04 },
};
const AA_FRONTIER_BASELINE_PER_TASK = 3.60; // Opus 5.5 / Neon high baseline ($3.46–$3.74/task)

export const BAND_ORDER = ['mechanical', 'cheap', 'mid', 'frontier'];
const BAND_LABEL = { mechanical: 'Mechanical', cheap: 'Cheap / Fast', mid: 'Mid Workhorse', frontier: 'Frontier' };

/** Which band did this model's task land in? For Gemini 4 Neon / Grok 4.7, low/medium effort acts as fast/mid workhorse. */
export function bandOf(model, effort, taskClass) {
  if (model === 'gemini-4-neon' || model === 'grok-4.7') {
    if (taskClass === 'fast' || effort === 'low') return 'cheap';
    if (taskClass === 'medium' || effort === 'medium') return 'mid';
  }
  if (BAND_BY_MODEL[model]) return BAND_BY_MODEL[model];
  const p = priceOf(model);
  if (!p) return null;
  const blended = (p.in + p.out) / 2;
  if (blended === 0) return 'mechanical';
  if (blended < 2.5) return 'cheap';
  if (blended < 12) return 'mid';
  return 'frontier';
}

function tokensOf(r) {
  const i = Number(r.est_in_tokens);
  const o = Number(r.est_out_tokens);
  if (Number.isFinite(i) && Number.isFinite(o)) return { in: i, out: o };
  return null;
}

export function decisionsPath() {
  return (
    process.env.MODEL_ROUTER_DECISIONS ||
    path.join(os.homedir(), '.claude', 'metaharness', 'routing-decisions.jsonl')
  );
}

/**
 * Summarize the receipts + subscription decisions ledgers into a per-band distribution + quota-value savings.
 * @param {{ receiptsFile?: string, decisionsFile?: string, frontier?: object }} [opts]
 */
export function utilization({ receiptsFile, decisionsFile, frontier } = {}) {
  const recFile = receiptsFile || receiptsPath();
  const decFile = decisionsFile || (receiptsFile ? null : decisionsPath());
  const frModel = frontier?.model || FRONTIER.name;
  const fr = (frontier && Number.isFinite(frontier.in) && Number.isFinite(frontier.out))
    ? { in: frontier.in, out: frontier.out }
    : priceOf(FRONTIER.name);

  const bands = Object.fromEntries(
    BAND_ORDER.map((b) => [b, { band: b, label: BAND_LABEL[b], tasks: 0, realizedUsd: 0, frontierUsd: 0, models: {} }])
  );
  const byHost = {};
  const byTaskClass = { fast: 0, medium: 0, substantial: 0, hard: 0, exceptional: 0 };
  const CUTOVER_ISO = '2026-11-22T06:00:00.000Z';
  const postCutover = { tasks: 0, cheap: 0, mid: 0, frontier: 0, realizedUsd: 0, frontierUsd: 0 };
  const preCutover = { tasks: 0, cheap: 0, mid: 0, frontier: 0, realizedUsd: 0, frontierUsd: 0 };
  let tasks = 0;
  let unpriced = 0;
  let realizedUsd = 0;
  let frontierUsd = 0;
  let since = null;
  let until = null;

  const consumeRow = (r, isDecisionRow = false) => {
    if (!r || !r.model || r.model === 'unknown') return;
    tasks++;
    if (r.ts) {
      since = since && since < r.ts ? since : r.ts;
      until = until && until > r.ts ? until : r.ts;
    }
    if (r.harness) byHost[r.harness] = (byHost[r.harness] || 0) + 1;
    if (r.taskClass && byTaskClass[r.taskClass] !== undefined) byTaskClass[r.taskClass]++;

    const effort = r.effort || 'medium';
    const band = bandOf(r.model, effort, r.taskClass);
    const p = priceOf(r.model);
    const isMech = band === 'mechanical';
    if (!band || (!isMech && !p && !isDecisionRow)) { unpriced++; return; }

    const tok = tokensOf(r);
    let realized;
    let front;
    if (tok && p && fr) {
      realized = isMech ? 0
        : Number.isFinite(Number(r.est_cost)) ? Number(r.est_cost)
        : (tok.in * p.in + tok.out * p.out) / 1e6;
      front = (tok.in * fr.in + tok.out * fr.out) / 1e6;
    } else {
      // Subscription decision row: use AA v5.0.1 effort-weighted task cost equivalent
      const bandTable = AA_TASK_COST_EQUIV[band] || AA_TASK_COST_EQUIV.mid;
      realized = bandTable[effort] ?? bandTable.medium;
      front = Math.max(realized, AA_FRONTIER_BASELINE_PER_TASK);
    }

    const b = bands[band];
    b.tasks++;
    b.realizedUsd += realized;
    b.frontierUsd += front;
    const modelKey = r.effort ? `${r.model}@${r.effort}` : r.model;
    b.models[modelKey] = (b.models[modelKey] || 0) + 1;
    realizedUsd += realized;
    frontierUsd += front;
    const bucket = (r.ts && r.ts >= CUTOVER_ISO) ? postCutover : preCutover;
    bucket.tasks++;
    if (band === 'cheap' || band === 'mechanical') bucket.cheap++;
    else if (band === 'mid') bucket.mid++;
    else bucket.frontier++;
    bucket.realizedUsd += realized;
    bucket.frontierUsd += front;
  };

  try {
    for (const line of fs.readFileSync(recFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { consumeRow(JSON.parse(line), false); } catch { /* skip */ }
    }
  } catch { /* no receipts file */ }

  if (decFile && fs.existsSync(decFile)) {
    try {
      for (const line of fs.readFileSync(decFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { consumeRow(JSON.parse(line), true); } catch { /* skip */ }
      }
    } catch { /* no decisions file */ }
  }

  const round = (n) => +Number(n).toFixed(4);
  const distribution = BAND_ORDER.map((b) => {
    const x = bands[b];
    return {
      band: b,
      label: x.label,
      tasks: x.tasks,
      pctOfTasks: tasks ? Math.round((x.tasks / tasks) * 100) : 0,
      realizedUsd: round(x.realizedUsd),
      frontierUsd: round(x.frontierUsd),
      savedUsd: round(x.frontierUsd - x.realizedUsd),
      models: Object.entries(x.models)
        .sort((a, c) => c[1] - a[1])
        .map(([model, n]) => ({ model, tasks: n })),
    };
  });

  const savedUsd = round(frontierUsd - realizedUsd);
  const quotaMultiplier = realizedUsd > 0 ? +(frontierUsd / realizedUsd).toFixed(2) : 1.0;
  const summarizeWindow = (w) => ({
    tasks: w.tasks,
    cheapPct: w.tasks ? Math.round((w.cheap / w.tasks) * 100) : 0,
    midPct: w.tasks ? Math.round((w.mid / w.tasks) * 100) : 0,
    frontierPct: w.tasks ? Math.round((w.frontier / w.tasks) * 100) : 0,
    quotaMultiplier: w.realizedUsd > 0 ? +(w.frontierUsd / w.realizedUsd).toFixed(2) : 1.0,
  });
  const beforeVsAfter = {
    cutoverAt: CUTOVER_ISO,
    before: summarizeWindow(preCutover),
    after: summarizeWindow(postCutover),
  };
  return {
    generatedAt: new Date().toISOString(),
    frontierModel: frModel,
    tasks,
    unpriced,
    since,
    until,
    realizedUsd: round(realizedUsd),
    frontierUsd: round(frontierUsd),
    costOptimalitySaved: savedUsd,
    pctSaved: frontierUsd > 0 ? Math.round((savedUsd / frontierUsd) * 100) : null,
    quotaMultiplier,
    beforeVsAfter,
    byHost,
    byTaskClass,
    distribution,
    note: `Recomputed live from ${tasks} routed prompt(s) across your $0 prepaid subscriptions (AA v5.0.1 effort-weighted quota equivalence; ${quotaMultiplier}x license stretch vs all-frontier). Since v2 cutover (${CUTOVER_ISO.slice(0, 10)}): ${beforeVsAfter.after.tasks} prompts (${beforeVsAfter.after.cheapPct}% fast / ${beforeVsAfter.after.midPct}% mid / ${beforeVsAfter.after.frontierPct}% frontier · ${beforeVsAfter.after.quotaMultiplier}x stretch).`,
  };
}

export function printUtil(u) {
  const money = (v) => (v == null ? '—' : v === 0 ? '$0' : '$' + v.toFixed(2));
  console.log(`\nMetaHarness Subscription Routing Effectiveness — ${u.tasks} routed prompt(s), baseline = ${u.frontierModel}`);
  if (u.since) console.log(`  window: ${u.since.slice(0, 10)} → ${u.until.slice(0, 10)}   |   License Stretch Multiplier: ${u.quotaMultiplier}x`);
  console.log(`  by host: ${Object.entries(u.byHost || {}).map(([h, n]) => `${h}=${n}`).join(' · ') || 'none'}`);
  console.log('');
  console.log(`  ${'Band'.padEnd(16)} ${'Tasks'.padStart(7)} ${'Share'.padStart(6)} ${'Bar (Visual Distribution)'.padEnd(28)} ${'Quota Equiv'.padStart(12)} ${'vs Frontier'.padStart(12)} ${'Quota Saved'.padStart(12)}`);
  console.log(`  ${'─'.repeat(98)}`);
  for (const d of u.distribution) {
    const barCells = Math.round((d.pctOfTasks / 100) * 24);
    const bar = '█'.repeat(barCells).padEnd(24, '░');
    console.log(`  ${d.label.padEnd(16)} ${String(d.tasks).padStart(7)} ${String(d.pctOfTasks).padStart(4)}%   [${bar}] ${money(d.realizedUsd).padStart(12)} ${money(d.frontierUsd).padStart(12)} ${money(d.savedUsd).padStart(12)}`);
  }
  console.log(`  ${'─'.repeat(98)}`);
  console.log(`  TOTAL quota value saved vs all-frontier: ${money(u.costOptimalitySaved)} (${u.pctSaved == null ? '—' : u.pctSaved + '%'} saved · ${u.quotaMultiplier}x more work from your prepaid licenses; $0 actual API spend).`);
  if (u.beforeVsAfter) {
    const b = u.beforeVsAfter.before;
    const a = u.beforeVsAfter.after;
    console.log('');
    console.log(`  BEFORE vs AFTER v2 Cutover (${u.beforeVsAfter.cutoverAt.slice(0, 10)}):`);
    console.log(`    Before (${String(b.tasks).padStart(5)} prompts): ${String(b.cheapPct).padStart(2)}% fast · ${String(b.midPct).padStart(2)}% mid · ${String(b.frontierPct).padStart(2)}% frontier  (${b.quotaMultiplier}x stretch)`);
    console.log(`    After  (${String(a.tasks).padStart(5)} prompts): ${String(a.cheapPct).padStart(2)}% fast · ${String(a.midPct).padStart(2)}% mid · ${String(a.frontierPct).padStart(2)}% frontier  (${a.quotaMultiplier}x stretch)`);
  }
}

export function mainUtil() {
  const u = utilization();
  if (process.argv.includes('--json')) console.log(JSON.stringify(u, null, 2));
  else printUtil(u);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mainUtil();
