#!/usr/bin/env node
// forge-rerank.mjs — cross-encoder reranker on top of searchKb (the highest-leverage REAL-USE lever).
// Pulls a wide candidate set (vector + heuristics + symbol routing) then RE-SCORES each candidate by
// reading (query, passage) TOGETHER with a cross-encoder — which picks the file that actually answers,
// not the one that's merely embedding-close or mentions the symbol. Falls back to searchKb order on error.
//
//   import { rerankKb } from './forge-rerank.mjs'
//   node forge-rerank.mjs --dir . --name ruflo --variant big --q "..."   # CLI smoke
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKb } from './forge-ask.mjs';
import { loadTransformers } from './resolve-deps.mjs';

const DEFAULT_CE_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const CE_MODEL = process.env.CE_MODEL || DEFAULT_CE_MODEL;
// MODEL-WEIGHT PIN: when using the DEFAULT cross-encoder, pin it to an exact HuggingFace commit SHA
// instead of the floating `main` branch so reranking is reproducible and cannot silently shift under
// an upstream re-publish (verified live against the HF Hub API; main HEAD unchanged since 2025-06-30).
// If the operator overrides CE_MODEL via env we do NOT force this SHA (it belongs to the default
// model) and fall back to `main` for the custom model.
const CE_REVISION = CE_MODEL === DEFAULT_CE_MODEL ? 'a09144355adeed5f58c8ed011d209bf8ee5a1fec' : 'main';
let _ce = null;
async function loadCE() {
  if (_ce) return _ce;
  const { T } = await loadTransformers();   // same resolver as forge-ask (KB node_modules / XENOVA_PATH), not a bare import
  if (process.env.KB_MODEL_CACHE) { T.env.cacheDir = process.env.KB_MODEL_CACHE; T.env.localModelPath = process.env.KB_MODEL_CACHE; }
  T.env.allowRemoteModels = true;
  const tok = await T.AutoTokenizer.from_pretrained(CE_MODEL, { revision: CE_REVISION });
  const model = await T.AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { quantized: true, revision: CE_REVISION });
  _ce = { T, tok, model };
  return _ce;
}

// score one (query, passage) pair → relevance logit (higher = more relevant)
async function ceScore(ce, query, passage) {
  const inputs = ce.tok(query, { text_pair: passage.slice(0, 3000), padding: true, truncation: true });
  const out = await ce.model(inputs);
  const logits = out.logits.data;
  return logits.length ? Number(logits[0]) : -Infinity;
}

export async function rerankKb({ dir, name, query, k = 6, variant, pool = 20 }) {
  const base = await searchKb({ dir, name, query, k: pool, n: pool, variant });
  if (base.length <= 1) return base.slice(0, k);
  // Skip rerank for design / ADR-status / "where is the doc" queries — base heuristic routing already
  // finds the AUTHORITATIVE doc, and the relevance-optimizing cross-encoder would bury it.
  if (/\badr[-\s_]?\d/i.test(query) || /\b(proposed|propose|decides?|decision|rationale|design choice|where are|where is the|documentation|is it (implemented|proposed))\b/i.test(query)) return base.slice(0, k);
  let ce;
  try { ce = await loadCE(); }
  catch (e) { if (process.env.CE_DEBUG) console.error('CE load failed, using base order:', e.message); return base.slice(0, k); }
  const scored = [];
  for (const d of base) {
    try { scored.push({ ...d, ceScore: await ceScore(ce, query, d.fullText || '') }); }
    catch { scored.push({ ...d, ceScore: -Infinity }); }
  }
  scored.sort((a, b) => b.ceScore - a.ceScore);
  return scored.slice(0, k);
}

// rerankPairs — cross-repo common-scale scorer. Given an ALREADY-RETRIEVED candidate list (e.g.
// pooled from searchKb across several repos, each with .fullText/.text), load the cross-encoder ONCE
// and score every (query, passage) pair on the SAME logit scale, so candidates from different repos
// (and different embedders/dims) become directly comparable. Returns the list sorted by ceScore desc.
// Falls back to input order (ceScore=null) if the cross-encoder can't load — never throws.
export async function rerankPairs(query, docs) {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  let ce;
  try { ce = await loadCE(); }
  catch (e) { if (process.env.CE_DEBUG) console.error('CE load failed, using input order:', e.message); return docs.map((d) => ({ ...d, ceScore: null })); }
  const scored = [];
  for (const d of docs) {
    const text = d.fullText || d.text || '';
    try { scored.push({ ...d, ceScore: await ceScore(ce, query, text) }); }
    catch { scored.push({ ...d, ceScore: -Infinity }); }
  }
  scored.sort((a, b) => (b.ceScore ?? -Infinity) - (a.ceScore ?? -Infinity));
  return scored;
}

// CLI smoke
if (process.argv[1] && process.argv[1].endsWith('forge-rerank.mjs')) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const r = await rerankKb({ dir: arg('--dir', '.'), name: arg('--name', 'ruflo'), variant: arg('--variant', 'big'), query: arg('--q', ''), k: 6 });
  for (let i = 0; i < r.length; i++) console.log(`#${i + 1} ce=${r[i].ceScore?.toFixed(3)} ${r[i].path}`);
}
