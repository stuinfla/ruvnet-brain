#!/usr/bin/env node
// scripts/router-utilization.mjs — the ONGOING view. router-optimizer.mjs answers "what SHOULD each
// bucket route to"; this answers "once you've actually been using it, how many tasks landed in each
// bucket, and what did you save versus sending every one to the frontier model?"
//
// It implements the shape rUv specifies in ruflo ADR-149 §6 (Observability, Proposed):
//   • modelDistribution   — per-model/per-band task counts ("how many are going to each bucket")
//   • costOptimalitySaved — USD vs always paying the frontier ("what the savings are off the frontier")
//
// Pure/deterministic: it reads the real receipts ledger (route-cheap.mjs + subagent dispatch write it)
// and makes NO model or network call. Every number is grounded:
//   • realized cost      = the receipt's own recorded est_cost (what the routed model actually cost).
//   • frontier baseline  = RECOMPUTED for every receipt against the CURRENT frontier model
//     (route-cheap FRONTIER — now Fable 5) from that receipt's own est token counts. Recomputing (rather
//     than trusting each receipt's stored est_frontier_cost) means switching the frontier re-prices the
//     whole history consistently, so the "vs Fable 5" figure is never a stale Opus-era number.
//   • a receipt whose model has no verified price is counted under `unpriced` and left OUT of the $ math
//     — never assigned an invented cost.
//
// Usage: node scripts/router-utilization.mjs [--json]

import fs from 'node:fs';
import { CLAUDE_MODEL_IDS, FRONTIER, priceOf, receiptsPath } from './route-cheap.mjs';

// Band = a human-legible grouping over the continuous complexity/cost axis (ADR-149: "tier_label is
// metadata, not control flow"). The four bands mirror router-optimizer.mjs. Known models are mapped
// explicitly; anything unknown is bucketed by its blended $/Mtok via bandOf()'s fallback.
const BAND_BY_MODEL = {
  'agent-booster': 'mechanical',
  'inclusionai/ling-2.6-flash': 'cheap',
  [CLAUDE_MODEL_IDS.haiku]: 'cheap',
  'deepseek/deepseek-chat': 'cheap',
  'deepseek/deepseek-v4-flash': 'cheap',
  'meta-llama/llama-3.3-70b-instruct': 'mid',
  'openai/gpt-4.1': 'mid',
  'x-ai/grok-4.5': 'mid',
  [CLAUDE_MODEL_IDS.sonnet]: 'mid',
  [CLAUDE_MODEL_IDS.opus]: 'frontier',
  [CLAUDE_MODEL_IDS.fable]: 'frontier',
};
export const BAND_ORDER = ['mechanical', 'cheap', 'mid', 'frontier'];
const BAND_LABEL = { mechanical: 'Mechanical', cheap: 'Cheap', mid: 'Mid', frontier: 'Frontier' };

/** Which band did this model's task land in? Known → explicit map; unknown → blended-price fallback. */
export function bandOf(model) {
  if (BAND_BY_MODEL[model]) return BAND_BY_MODEL[model];
  const p = priceOf(model);
  if (!p) return null; // unpriced → caller records it under `unpriced`, never invents a cost
  const blended = (p.in + p.out) / 2;
  if (blended === 0) return 'mechanical';
  if (blended < 2) return 'cheap';
  if (blended < 15) return 'mid';
  return 'frontier';
}

function tokensOf(r) {
  const i = Number(r.est_in_tokens);
  const o = Number(r.est_out_tokens);
  if (Number.isFinite(i) && Number.isFinite(o)) return { in: i, out: o };
  return null;
}

/**
 * Summarize the receipts ledger into a per-band distribution + realized-vs-frontier savings.
 * @param {{ receiptsFile?: string }} [opts]
 */
export function utilization({ receiptsFile, frontier } = {}) {
  const file = receiptsFile || receiptsPath();
  // Frontier = the user's OWN house flagship (passed in by the console from the live-verified catalog);
  // falls back to route-cheap's default. The counterfactual is recomputed vs THIS, so an OpenAI shop sees
  // "vs GPT-5.6 Sol" and a Claude shop sees "vs Fable 5" — personalized, never one house for everyone.
  const frModel = frontier?.model || FRONTIER.name;
  const fr = (frontier && Number.isFinite(frontier.in) && Number.isFinite(frontier.out))
    ? { in: frontier.in, out: frontier.out }
    : priceOf(FRONTIER.name);

  const bands = Object.fromEntries(
    BAND_ORDER.map((b) => [b, { band: b, label: BAND_LABEL[b], tasks: 0, realizedUsd: 0, frontierUsd: 0, models: {} }])
  );
  let tasks = 0;
  let unpriced = 0;
  let realizedUsd = 0;
  let frontierUsd = 0;
  let since = null;
  let until = null;

  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    /* no receipts yet — return the empty shape below */
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.model) continue;
    tasks++;
    if (r.ts) {
      since = since && since < r.ts ? since : r.ts;
      until = until && until > r.ts ? until : r.ts;
    }
    const band = bandOf(r.model);
    const p = priceOf(r.model);
    const isMech = band === 'mechanical';
    // Mechanical ($0, no LLM — e.g. Agent Booster) has no per-token price but a real realized cost of $0.
    // Everything else needs a verified price AND a priced frontier, or it's excluded (never invented).
    if (!band || (!isMech && (!p || !fr))) { unpriced++; continue; }

    const tok = tokensOf(r);
    const realized = isMech ? 0
      : Number.isFinite(Number(r.est_cost)) ? Number(r.est_cost)
      : tok ? (tok.in * p.in + tok.out * p.out) / 1e6 : 0;
    // Frontier counterfactual — ALWAYS recomputed vs the current frontier from the receipt's tokens.
    const front = (tok && fr) ? (tok.in * fr.in + tok.out * fr.out) / 1e6 : realized;

    const b = bands[band];
    b.tasks++;
    b.realizedUsd += realized;
    b.frontierUsd += front;
    b.models[r.model] = (b.models[r.model] || 0) + 1;
    realizedUsd += realized;
    frontierUsd += front;
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
  return {
    generatedAt: new Date().toISOString(),
    frontierModel: frModel,
    tasks,
    unpriced,
    since,
    until,
    realizedUsd: round(realizedUsd),
    frontierUsd: round(frontierUsd),
    costOptimalitySaved: savedUsd, // ADR-149 name
    pctSaved: frontierUsd > 0 ? Math.round((savedUsd / frontierUsd) * 100) : null,
    distribution, // ADR-149 modelDistribution, grouped into the four legible bands
    note: `Recomputed live from ${tasks} receipt(s) against your frontier (${frModel}); token counts are the receipts’ own est. values, never projected.`,
  };
}

export function printUtil(u) {
  const money = (v) => (v == null ? '—' : v === 0 ? '$0' : '$' + v);
  console.log(`\nRouting utilization — ${u.tasks} task(s), frontier = ${u.frontierModel}`);
  if (u.since) console.log(`  window: ${u.since} → ${u.until}`);
  console.log(`  ${'band'.padEnd(11)} ${'tasks'.padStart(6)} ${'%'.padStart(4)} ${'realized'.padStart(11)} ${'vs frontier'.padStart(12)} ${'saved'.padStart(11)}`);
  for (const d of u.distribution) {
    console.log(`  ${d.label.padEnd(11)} ${String(d.tasks).padStart(6)} ${String(d.pctOfTasks).padStart(3)}% ${money(d.realizedUsd).padStart(11)} ${money(d.frontierUsd).padStart(12)} ${money(d.savedUsd).padStart(11)}`);
  }
  console.log(`  ${'—'.repeat(11)}`);
  console.log(`  TOTAL saved vs all-frontier: ${money(u.costOptimalitySaved)} (${u.pctSaved == null ? '—' : u.pctSaved + '%'}); realized ${money(u.realizedUsd)} vs ${money(u.frontierUsd)} on ${u.frontierModel}.`);
  if (u.unpriced) console.log(`  (${u.unpriced} receipt(s) had an unpriced model and were excluded from the $ math.)`);
}

export function mainUtil() {
  const u = utilization();
  if (process.argv.includes('--json')) console.log(JSON.stringify(u, null, 2));
  else printUtil(u);
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';
if (isDirectInvocation(import.meta.url)) mainUtil();
