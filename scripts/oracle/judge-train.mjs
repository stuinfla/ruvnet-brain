#!/usr/bin/env node
/**
 * scripts/oracle/judge-train.mjs — fit the learned judge (kb/judge-rank.mjs, ADR-099 arm C) on the
 * need-set TRAIN split and report it on the HELD-OUT split, offline.
 *
 * Input is the scored pool the search already recorded (KB_CE_TRACE: one line per question, every
 * pooled candidate with its cross-encoder logit, dense distance, lane, title, path and length), so
 * training and evaluation replay exactly what the cross-encoder saw; no model is run here.
 *
 * Model: logistic regression over JUDGE_FEATURES, standardised on train, L2 1.0, class-balanced,
 * full-batch gradient descent (deterministic). Positive = the candidate is the gold file or a
 * pre-registered alternative. Operating point: the smallest threshold on the judge's top score at
 * which TRAIN precision of answered questions reaches --precision (default 0.8); it is folded into
 * the bias so the product's existing "score < 0 abstains" rule applies unchanged.
 *
 *   node scripts/oracle/judge-train.mjs --set <need-set.json> --split <split.json> --trace <cetrace.jsonl>
 *     [--precision 0.8] [--weights <out.json>] [--report <out.json>]
 *     [--recall-trace <recall.cetrace.jsonl> --recall-fixture data/retrieval-query-evidence.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wilson } from '../eval-brain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { JUDGE_FEATURES, judgeFeatures, judgeLogit } = await import(pathToFileURL(path.join(ROOT, 'kb/judge-rank.mjs')).href);

const norm = (p) => String(p || '').replace(/^\.\//, '');
export function isTarget(q, cand) {
  const targets = [{ repo: q.repo, path: q.path }, ...(q.alternatives || [])];
  return targets.some((t) => String(t.repo).toLowerCase() === String(cand.repo).toLowerCase() && norm(t.path) === norm(cand.path));
}

/** Map need id -> its last recorded pool, from KB_CE_TRACE lines (unparsable lines are skipped). */
export function poolsByNeed(questions, traceText) {
  const byNeed = new Map(questions.map((q) => [q.need, q.id]));
  const pools = new Map();
  for (const line of traceText.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const id = byNeed.get(row.query);
    if (id && Array.isArray(row.cands) && row.cands.length) pools.set(id, row.cands);
  }
  return pools;
}

export function fitLogistic(X, y, { l2 = 1, iters = 3000, lr = 0.1 } = {}) {
  const d = X[0].length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mean[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const pos = y.filter(Boolean).length;
  const wPos = pos ? (y.length - pos) / pos : 1;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    let gb = 0;
    let W = 0;
    for (let i = 0; i < Z.length; i++) {
      const s = b + Z[i].reduce((a, v, j) => a + v * w[j], 0);
      const p = 1 / (1 + Math.exp(-s));
      const cw = y[i] ? wPos : 1;
      const e = cw * (p - (y[i] ? 1 : 0));
      for (let j = 0; j < d; j++) g[j] += e * Z[i][j];
      gb += e;
      W += cw;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / W + (l2 * w[j]) / Z.length);
    b -= lr * (gb / W);
  }
  return { weights: w, bias: b, mean, std };
}

/** Per question: the top candidate under a scorer, whether a target is in the top 1 / top 5, top score. */
export function decide(questions, pools, score) {
  return questions.filter((q) => pools.has(q.id)).map((q) => {
    const cands = pools.get(q.id);
    const s = score(q, cands);
    const order = s.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    return { id: q.id, top: s[order[0]], at1: isTarget(q, cands[order[0]]),
      within5: order.slice(0, 5).some((i) => isTarget(q, cands[i])) };
  });
}

export function metrics(rows, n, threshold = 0) {
  const r = (k, m) => { const w = wilson(k, m); return { k, n: m, lo: +w.lo.toFixed(4), hi: +w.hi.toFixed(4) }; };
  const answered = rows.filter((x) => x.top >= threshold);
  return {
    traced: rows.length,
    goldWithin5: r(rows.filter((x) => x.within5).length, n),
    goldAt1: r(rows.filter((x) => x.at1).length, n),
    // measure-need-set's definitions (target within 5 AND not abstained), so baselines compare
    confidentHit: r(answered.filter((x) => x.within5).length, n),
    confidentWrong: r(answered.filter((x) => !x.within5).length, n),
    // the stricter reading: the single top answer is the target
    confidentHitTop1: r(answered.filter((x) => x.at1).length, n),
    abstained: r(n - answered.length, n),
    precision: r(answered.filter((x) => x.at1).length, answered.length),
  };
}

export function chooseThreshold(rows, precision) {
  const tops = [...new Set(rows.map((x) => x.top))].sort((a, b) => a - b);
  for (const t of tops) {
    const ans = rows.filter((x) => x.top >= t);
    if (ans.length && ans.filter((x) => x.at1).length / ans.length >= precision) return t;
  }
  return Infinity;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const set = JSON.parse(fs.readFileSync(arg('--set'), 'utf8')).questions;
  const split = JSON.parse(fs.readFileSync(arg('--split'), 'utf8'));
  const pools = poolsByNeed(set, fs.readFileSync(arg('--trace'), 'utf8'));
  const train = set.filter((q) => split.train.includes(q.id));
  const held = set.filter((q) => split.heldout.includes(q.id));
  const X = [];
  const y = [];
  for (const q of train) {
    if (!pools.has(q.id)) continue;
    const cands = pools.get(q.id);
    judgeFeatures(q.need, cands).forEach((x, i) => { X.push(x); y.push(isTarget(q, cands[i])); });
  }
  const fit = fitLogistic(X, y);
  const model0 = { ...fit, features: JUDGE_FEATURES };
  const judgeScore = (m) => (q, cands) => judgeFeatures(q.need, cands).map((x) => judgeLogit(m, x));
  const ceScore = (q, cands) => cands.map((c) => (typeof c.ce === 'number' ? c.ce : -Infinity));
  const precision = Number(arg('--precision', 0.8));
  const tau = chooseThreshold(decide(train, pools, judgeScore(model0)), precision);
  const model = { ...model0, bias: Number.isFinite(tau) ? fit.bias - tau : -1e9, threshold: tau,
    trainedOn: { split: split.salt, trainNeeds: train.length, tracedTrain: train.filter((q) => pools.has(q.id)).length,
      candidates: X.length, positives: y.filter(Boolean).length, precisionTarget: precision } };
  const report = {
    kind: 'ruvnet-brain-judge-report', features: JUDGE_FEATURES, trainedOn: model.trainedOn, threshold: tau,
    weights: Object.fromEntries(JUDGE_FEATURES.map((f, j) => [f, +model.weights[j].toFixed(4)])),
    train: { crossEncoder: metrics(decide(train, pools, ceScore), train.length), judge: metrics(decide(train, pools, judgeScore(model)), train.length) },
    heldout: { crossEncoder: metrics(decide(held, pools, ceScore), held.length), judge: metrics(decide(held, pools, judgeScore(model)), held.length) },
  };
  // Offline replay on the recall-gate fixture's recorded pools: does re-ranking hurt questions the
  // cross-encoder already answers? (Approximate: selectResults' name boosts are not replayed here, so
  // the full path is the authority; this only flags gross damage early.)
  if (arg('--recall-trace') && arg('--recall-fixture')) {
    const fx = JSON.parse(fs.readFileSync(arg('--recall-fixture'), 'utf8')).queries;
    const items = Object.entries(fx).map(([store, v]) => ({ id: store, need: v.query, repo: store, path: v.expected.path }));
    const rpools = poolsByNeed(items, fs.readFileSync(arg('--recall-trace'), 'utf8'));
    report.recallReplay = { crossEncoder: metrics(decide(items, rpools, ceScore), items.length),
      judge: metrics(decide(items, rpools, judgeScore(model)), items.length) };
  }
  if (arg('--weights')) fs.writeFileSync(arg('--weights'), `${JSON.stringify(model, null, 1)}\n`);
  if (arg('--report')) fs.writeFileSync(arg('--report'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify({ threshold: tau, trainedOn: model.trainedOn, heldout: report.heldout }, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
