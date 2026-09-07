// forge-hybrid.mjs — hybrid (sparse BM25 + dense cosine) retrieval primitives, ported from rUv's
// tested implementation + his grid-searched tuned defaults, NOT a hand-roll:
//   ruflo/v3/@claude-flow/cli/src/memory/hybrid-retrieval.ts  — bm25Score (Okapi k1=1.5,b=0.75),
//     normalise (min-max), hybridScores (α·cosineNorm + (1-α)·bm25Norm), multiFieldBM25. `mmrRerank`
//     (diversity re-ranking, mmrLambda=0.7) was NEVER ported — no such function is defined below;
//     it remains future work (docs/adr/0025-hybrid-retrieval-and-self-retrieval-gate.md, Open Items).
//   ruflo ADR-082 (ACCEPTED, ruflo 3.10.22) — grid-searched defaults: α=0.5, subjectWeight=2.0,
//     mmrLambda=0.7. Measured nDCG@3 0.900→0.963. "BM25 carries more discriminating power than the
//     cosine on small corpora" — exactly our regime.
// Only `tokenize`/`buildCorpusStats`/`bm25Score` are wired into production today (forge-ask-all.mjs's
// KB_TRANSCRIPT_STORES-scoped candidate pool). `hybridScores`/`multiFieldBM25`/`normalise` are defined
// and exported but have no caller anywhere in this repo — the global fusion path they belonged to was
// reverted (see ADR-025's "Outcome"); they are dead code kept for the future work ADR-025 names, not
// live behavior. This file's exports were the subject of a citation-binding bug tonight: this comment
// itself used to list `mmrRerank` as part of the port when it was never implemented — see the new
// tests/unit/forge-hybrid-port-claims.test.mjs guard.

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','of','in','to','for','on','at','by','with','from',
  'is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','should',
  'could','can','may','might','must','this','that','these','those','it','its','as','also','not','no','so','too','very',
]);
// Keep length>=3 content tokens — but preserve pure IDs/hex/flags (needles) even if short-ish.
export function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase().split(/[^a-z0-9_\-/.]+/g).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// BM25 corpus statistics over tokenised docs.
export function buildCorpusStats(tokenisedDocs) {
  const N = tokenisedDocs.length;
  const df = new Map();
  let totalLen = 0;
  for (const doc of tokenisedDocs) {
    totalLen += doc.length;
    const seen = new Set();
    for (const tok of doc) { if (seen.has(tok)) continue; seen.add(tok); df.set(tok, (df.get(tok) || 0) + 1); }
  }
  const idf = new Map();
  for (const [tok, dfv] of df) idf.set(tok, Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5))); // smoothed, >0
  return { df, idf, avgDocLen: N > 0 ? totalLen / N : 0, N };
}

// Okapi BM25, rUv's params (k1=1.5, b=0.75).
export function bm25Score(queryTokens, docTokens, stats, k1 = 1.5, b = 0.75) {
  if (!queryTokens.length || !docTokens.length) return 0;
  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const norm = docTokens.length / (stats.avgDocLen || 1);
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt); if (!f) continue;
    const idf = stats.idf.get(qt) || 0; if (idf === 0) continue;
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * norm)));
  }
  return score;
}

// Multi-field BM25: subject (title) tokens weighted over body tokens (rUv subjectWeight default 3.0;
// ADR-082 tuned to 2.0). Caller passes the same stats for both fields (one combined corpus) — a
// reasonable simplification of rUv's separate subject/body IDF that keeps the title-signal boost.
export function multiFieldBM25(queryTokens, subjectTokens, bodyTokens, stats, subjectWeight = 2.0, bodyWeight = 1.0) {
  return subjectWeight * bm25Score(queryTokens, subjectTokens, stats) + bodyWeight * bm25Score(queryTokens, bodyTokens, stats);
}

// Min-max normalise to [0,1]; constant vector → all 0.5.
export function normalise(scores) {
  if (!scores.length) return scores;
  let lo = Infinity, hi = -Infinity;
  for (const s of scores) { if (s < lo) lo = s; if (s > hi) hi = s; }
  const range = hi - lo;
  if (range < 1e-9) return scores.map(() => 0.5);
  return scores.map((s) => (s - lo) / range);
}

// rUv's fusion: hybrid = α·cosineNorm + (1-α)·bm25Norm, on aligned score vectors. ADR-082 α=0.5.
export function hybridScores(cosine, bm25, alpha = 0.5) {
  const cN = normalise(cosine), bN = normalise(bm25);
  return cN.map((c, i) => alpha * c + (1 - alpha) * bN[i]);
}
