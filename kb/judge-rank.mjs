// judge-rank.mjs — THE LEARNED JUDGE (ADR-099 arm C): re-scores the cross-encoder's pooled candidates
// with a tiny logistic model over signals the search already computed, and puts its decision
// threshold at 0 so every downstream rule (prune, evidence grade, abstain) reads it unchanged.
//
// WHY. On the novice need set the gold file reaches the pool for 35 of 87 gold-repository searches,
// yet for 32 of those 35 the cross-encoder scores even the verbatim gold span below 0. The failure
// is ranking among pooled candidates, so the judge ranks them. It plays ReasoningBank's JUDGE role
// (agentic-flow/src/reasoningbank/core/judge.ts) locally: no LLM call, no key, nothing leaves the
// machine.
//
// OFF BY DEFAULT. It runs only when RUVNET_BRAIN_JUDGE=1 AND a weights file (kb/judge-weights.json,
// trained offline by scripts/oracle/judge-train.mjs on the need-set TRAIN split) is present and
// matches JUDGE_FEATURES. The cross-encoder logit is kept on every candidate as `ceRaw`.
import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './forge-hybrid.mjs';

export const JUDGE_FEATURES = ['ce', 'ceGap', 'ceRankLog', 'dist', 'laneBm25', 'laneRescue', 'titlePathOverlap', 'lenLog'];

/** Feature vector for every candidate of one pooled, cross-encoder-scored list (any order). */
export function judgeFeatures(query, cands) {
  const q = new Set(tokenize(query));
  const ces = cands.map((c) => (typeof c.ce === 'number' ? c.ce : -20));
  const top = Math.max(...ces);
  const order = ces.map((ce, i) => [ce, i]).sort((a, b) => b[0] - a[0]);
  const rankOf = new Array(cands.length);
  order.forEach(([, i], r) => { rankOf[i] = r; });
  return cands.map((c, i) => {
    const tp = new Set(tokenize(`${c.title || ''} ${String(c.path || '').replace(/[/._-]+/g, ' ')}`));
    let overlap = 0;
    for (const t of q) if (tp.has(t)) overlap++;
    return [
      ces[i],
      ces[i] - top,
      Math.log1p(rankOf[i]),
      typeof c.dist === 'number' ? c.dist : 1,
      c.lane === 'bm25' ? 1 : 0,
      c.lane === 'rescue' ? 1 : 0,
      q.size ? overlap / q.size : 0,
      Math.log1p(Number(c.len) || 0),
    ];
  });
}

/** Logit of the model; `bias` already folds in the decision threshold, so >= 0 means "answer". */
export function judgeLogit(model, x) {
  let s = model.bias;
  for (let j = 0; j < x.length; j++) s += model.weights[j] * ((x[j] - model.mean[j]) / (model.std[j] || 1));
  return s;
}

let _model;
export function loadJudge(dir) {
  if (process.env.RUVNET_BRAIN_JUDGE !== '1') return null;
  if (_model !== undefined && _model.dir === dir) return _model.model;
  let model = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'judge-weights.json'), 'utf8'));
    if (JSON.stringify(m.features) === JSON.stringify(JUDGE_FEATURES) && m.weights?.length === JUDGE_FEATURES.length) model = m;
  } catch { model = null; }
  _model = { dir, model };
  return model;
}

/**
 * Re-score a reranked pool with the judge: ceScore becomes the judge logit (decision threshold at
 * 0), ceRaw keeps the cross-encoder's. Returns the pool sorted by the new score. A null model returns
 * the pool untouched.
 */
export function applyJudge(model, query, ranked) {
  if (!model || !ranked.length) return ranked;
  const xs = judgeFeatures(query, ranked.map((r) => ({ ce: r.ceScore, dist: r.bestDistance, lane: r._lane,
    title: r.title, path: r.path, len: (r.fullText || r.text || '').length })));
  return ranked.map((r, i) => ({ ...r, ceRaw: r.ceScore, ceScore: judgeLogit(model, xs[i]), judged: true }))
    .sort((a, b) => b.ceScore - a.ceScore);
}
