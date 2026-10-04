#!/usr/bin/env node
// scripts/metaharness-router.mjs — routing through rUv's REAL router: @metaharness/router.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS (2026-07-13). I hand-rolled scripts/model-router-engine.mjs — 216 lines of my
// own heuristic with a "documented placeholder policy" — and called it "the MetaHarness router
// engine" in SKILL.md. rUv had ALREADY built and shipped the real thing:
//
//   @metaharness/router@0.3.2  (ruvnet/agent-harness-generator, packages/router)
//   ADR-040 (DRACO Phase-2) + ADR-043 (KRR training pipeline) — status ACCEPTED / IMPLEMENTED.
//   "Cost-optimal model router — route each query to the cheapest model that's good enough
//    (k-NN over labelled embeddings). The productized DRACO Phase-2 finding."
//
// Building a Claude fake and giving it rUv's name is the single behaviour the brain's own playbook
// forbids ("NEVER quietly build a Claude fake, call it by the real tool's name, and hide that it's a
// hand-roll"). This file is the correction: the ROUTING DECISION now comes from rUv's code.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// WHAT COMPOSES, AND WHY IT IS NOT DUPLICATE WORK.
// @metaharness/router minimises COST subject to predicted QUALITY. It has no concept of "this model
// is already paid for by THIS user's subscription" — nor should it; that is deployment truth, not
// routing math. So the local piece collapses to exactly one honest job: a PRICE TRANSFORM.
//
//     a model covered by this user's subscription  →  costPerMTok = 0
//
// Feed that price table to Router.fromExamples() and its cost-optimal logic does the rest, natively:
// a $0 model that clears the quality bar IS the cheapest candidate. The subscription overlay stops
// being a competing engine and becomes four lines of price arithmetic. That is the whole fix.
//
// THE HONEST CONSTRAINT (stated, not buried): Router predicts quality by k-NN over LABELLED examples
// (query embedding → the quality that candidate achieved). Those labels come from real routed
// outcomes. Until enough accumulate, k-NN has nothing to average and its prediction is not
// meaningful — the ADR-040/043 learning curve starts at the bottom. So:
//   • labels < MIN_LABELS  → we say COLD-START out loud and fall back, rather than dressing up a
//                            guess as a learned prediction. That dressing-up is the original sin.
//   • labels >= MIN_LABELS → rUv's Router makes the call, and we report predictedQuality/metBar.
// Every routed task appends a label, so this improves with use rather than with my opinions.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// k-NN needs neighbours to average. Below this, a "prediction" is noise wearing a lab coat.
export const MIN_LABELS = 5;

export const OUTCOMES = process.env.MODEL_ROUTER_DECISIONS
  || path.join(os.homedir(), '.claude', 'metaharness', 'routing-outcomes.jsonl');

/** Load rUv's router. Returns null (never a fake) if the real package isn't installed. */
export async function loadRealRouter() {
  try {
    return await import('@metaharness/router');
  } catch {
    return null; // caller MUST say so out loud — never silently substitute a hand-roll
  }
}

/**
 * Effective price table for THIS user. The ONLY thing the local layer legitimately contributes:
 * a model the user's subscription already pays for costs $0 at the margin, so the cost-optimal
 * router should treat it as free. Everything else keeps its real blended price.
 */
export function effectivePrices(candidates, profile) {
  const prices = {};
  for (const c of candidates) {
    const covered = (c.subscription || []).some((h) => profile?.harnesses?.[h]?.subscription === true);
    // Blended $/Mtok — the axis Router minimises. The catalog stores prices as costPerMTok:{in,out}
    // (see ~/.claude/model-router/catalog.json); this function originally only understood a bare
    // number or costIn/costOut, so every {in,out}-priced metered model blended to $0 and the
    // cost-optimal router was choosing over all-zero prices (found 2026-07-16 when the console
    // panel showed DeepSeek as "$0 · yours"). All three shapes are handled now; an unpriced
    // candidate is Infinity, never a fake $0 — a missing price must not read as free.
    const p = c.costPerMTok;
    const blended =
      typeof p === 'number' ? p
      : p && typeof p.in === 'number' && typeof p.out === 'number' ? (p.in + p.out) / 2
      : typeof c.costIn === 'number' && typeof c.costOut === 'number' ? (c.costIn + c.costOut) / 2
      : Infinity;
    prices[c.id] = covered ? 0 : blended;
  }
  return prices;
}

/**
 * Labelled rows in the exact shape Router.fromExamples() consumes — the DRACO row shape:
 *   { embedding: number[], scores: { [modelId]: quality 0..1 } }
 * Rows without an embedding are unusable for k-NN and are dropped (counted, never faked).
 */
export function loadLabelledRows(file = OUTCOMES) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], unusable: 0 }; }
  const rows = [];
  let unusable = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (Array.isArray(o.embedding) && o.embedding.length && o.scores && Object.keys(o.scores).length) {
        rows.push({ embedding: o.embedding, scores: o.scores });
      } else unusable++;
    } catch { unusable++; }
  }
  return { rows, unusable };
}

/** Embed a prompt with the same pinned local MiniLM-384 the brain uses. No network, no API cost. */
export async function embed(text) {
  const { pipeline, env } = await import(path.join(__dirname, '..', 'kb', 'node_modules', '@xenova', 'transformers', 'src', 'transformers.js'));
  if (process.env.KB_MODEL_CACHE) { env.cacheDir = process.env.KB_MODEL_CACHE; env.allowRemoteModels = true; }
  const fe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
    revision: '751bff37182d3f1213fa05d7196b954e230abad9', // pinned — same weights the KB was built with
  });
  const out = await fe(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

/**
 * THE ROUTE CALL. rUv's Router makes the decision; we supply candidates, this user's prices, and the
 * query embedding. We report exactly what it decided — including when it could NOT decide.
 */
export async function route(prompt, candidates, profile, { qualityBar = 0.7, k = 5 } = {}) {
  const mod = await loadRealRouter();
  if (!mod) {
    return { routedBy: 'UNAVAILABLE', reason: '@metaharness/router is not installed — install it rather than hand-rolling a substitute (npm i -g @metaharness/router)' };
  }

  const { rows, unusable } = loadLabelledRows();
  if (rows.length < MIN_LABELS) {
    // Say it plainly. A k-NN with 1 neighbour is not a learned prediction, and pretending otherwise
    // is precisely the failure this whole file exists to correct.
    return {
      routedBy: 'COLD-START',
      labels: rows.length,
      needed: MIN_LABELS,
      unusable,
      reason: `only ${rows.length} labelled example(s); @metaharness/router needs ≥${MIN_LABELS} to predict quality by k-NN. Falling back to the local heuristic — and SAYING SO. Every routed task appends a label; this stops being a fallback with use, not with opinions.`,
    };
  }

  const prices = effectivePrices(candidates, profile);
  const allowed = new Set(candidates.map((m) => m.id));
  const constrainedRows = rows.map((row) => ({ ...row,
    scores: Object.fromEntries(Object.entries(row.scores).filter(([id]) => allowed.has(id))),
  })).filter((row) => Object.keys(row.scores).length);
  if (constrainedRows.length < MIN_LABELS) return { routedBy: 'COLD-START',
    reason: 'Insufficient labels for policy-eligible models', labels: constrainedRows.length };
  const router = mod.Router.fromExamples(constrainedRows, prices, { k, qualityBar });
  const pick = router.route(await embed(prompt));

  return {
    routedBy: '@metaharness/router',   // rUv's code made this call. Not mine.
    version: '0.3.2',
    model: pick.id,
    predictedQuality: pick.predictedQuality,
    metBar: pick.metBar,
    costPerMTok: pick.costPerMTok,
    subscriptionCovered: prices[pick.id] === 0,
    labels: rows.length,
    qualityBar,
  };
}

/** Append a label from a real routed outcome — the fuel k-NN runs on. */
export async function recordOutcome(prompt, scores, file = OUTCOMES) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ts: new Date().toISOString(), embedding: await embed(prompt), scores };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}
