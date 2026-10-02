// keyword-lane.mjs — THE KEYWORD LANE: up to N keyword-matched files per repository store join the
// candidate pool, so the one cross-encoder can judge files dense retrieval never surfaced.
//
// WHY (measured 2026-10-01, evals/runs/2026-10-01-retrieval-4.5). On the 206-question novice need
// set, the gold repository was searched for 87 needs, but the gold FILE was in that store's 64-deep
// dense pool for only 13 of them. The other 74 could not be cited however the reranker scored. An
// additive BM25 lane (experiment E2, need-baseline agent) took gold-or-alternative-in-top-5 from 1 to
// 5/206 and the recall gate from 162 to 165/182 without moving off-topic abstention.
//
// WHAT IT IS. Okapi BM25 over the store's own passage sidecar, scored exactly as forge-hybrid.mjs's
// bm25Score (k1 1.5, b 0.75, smoothed idf, duplicate query tokens counted), ranked by score with
// sidecar order breaking ties; each FILE is represented by its best-scoring chunk, and only files
// dense did not already pool are added. They are never fused into a score: the cross-encoder
// judges them like any other candidate.
//
// WHAT IT COSTS, and how that is bounded. Holding the forge-hybrid corpus (parsed passages + token
// arrays) costs ~5.6x the sidecar's size: 530 MB for ruvector alone, ~2.7 GB if a long-lived worker
// touched every store. This index keeps only what scoring needs -- a per-store token dictionary,
// postings in typed arrays, document lengths, each passage's path and its byte range in the sidecar
// -- and reads the few winning passages back from the file (measured retained: ruvector 162 MB,
// ruflo 82 MB, ruview 64 MB; cold build 5.4 / 3.4 / 1.9 s; warm 11.5 / 6.9 / 3.1 ms per question).
// Indexes are keyed by the sidecar's (dev, inode, mtime, size), so an update or overlay is never
// served from an old index, and residency is bounded by KEYWORD_INDEX_STORES_MAX stores and a
// KEYWORD_INDEX_BUDGET_MB sidecar budget (least recently used out).
//
// OFF BY DEFAULT (4.5 decision, 2026-10-01). Paired warm latency on 69 need questions: +2.1 s median
// [1.4-2.9], p90 +5.9 s. Nearly all of that is building this index at query time: replaying the same
// questions' store accesses, the lane's own time is p50 1.5 s and p90 5.1 s, and over 1 s on 41 of
// 65 questions. A 4000 MB budget barely changes that, because the index is built per store per
// process. The extra cross-encoder pairs are only ~17 of ~224 per question. Neither a "dense is
// weak" gate nor a read cap buys the time back. Dense is weak on 167/196 need questions, so such a
// gate still fires on 57/65 latency questions, and the recall-gate wins came on questions where
// dense was strong (top dense CE 1.9-5.2). A read cap leaves the build untouched. The lane needs an
// index built with the corpus rather than at query time; until then RUVNET_BRAIN_KEYWORD_LANE=1
// turns it on.
import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './forge-hybrid.mjs';

/** The keyword lane runs only when RUVNET_BRAIN_KEYWORD_LANE=1 (read per call, like the judge flag). */
export function keywordLaneEnabled() {
  return process.env.RUVNET_BRAIN_KEYWORD_LANE === '1';
}

export const REPO_KEYWORD_TOPN = 8;
export const KEYWORD_INDEX_STORES_MAX = 8;
export const KEYWORD_INDEX_BUDGET_MB = 160;
const K1 = 1.5;
const B = 0.75;
const _indexes = new Map(); // sidecar file -> index

function sidecarFor(dir, name) {
  const big = path.join(dir, `${name}.big.passages.jsonl`);
  if (fs.existsSync(big)) return big;
  const small = path.join(dir, `${name}.passages.jsonl`);
  return fs.existsSync(small) ? small : null;
}

function buildIndex(file, key) {
  const buf = fs.readFileSync(file);
  const dict = new Map();
  const docLen = [];
  const paths = [];
  const offsets = [];
  const lengths = [];
  const postDoc = [];
  const postTok = [];
  const postTf = [];
  const intern = new Map();
  let start = 0;
  let doc = 0;
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    if (end > start) {
      let row = null;
      try { row = JSON.parse(buf.toString('utf8', start, end)); } catch { row = null; }
      if (row) {
        const toks = tokenize(row.text || '');
        const tf = new Map();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        for (const [t, f] of tf) {
          let tid = dict.get(t);
          if (tid === undefined) dict.set(t, (tid = dict.size));
          postDoc.push(doc); postTok.push(tid); postTf.push(f);
        }
        docLen.push(toks.length);
        const p = String(row.path || '');
        let ip = intern.get(p);
        if (ip === undefined) intern.set(p, (ip = p));
        paths.push(ip);
        offsets.push(start);
        lengths.push(end - start);
        doc++;
      }
    }
    start = end + 1;
  }
  // CSR by token id: postings of token t are docs[tokStart[t] .. tokStart[t+1]).
  const T = dict.size;
  const tokStart = new Uint32Array(T + 1);
  for (const t of postTok) tokStart[t + 1]++;
  for (let t = 0; t < T; t++) tokStart[t + 1] += tokStart[t];
  const fill = tokStart.slice(0, T);
  const docs = new Uint32Array(postDoc.length);
  const tfs = new Uint16Array(postDoc.length);
  for (let i = 0; i < postDoc.length; i++) {
    const at = fill[postTok[i]]++;
    docs[at] = postDoc[i];
    tfs[at] = Math.min(65535, postTf[i]);
  }
  const lens = Uint32Array.from(docLen);
  let total = 0;
  for (const l of lens) total += l;
  return { key, file, dict, tokStart, docs, tfs, docLen: lens, avgDocLen: doc ? total / doc : 0, N: doc,
    paths, offsets: Float64Array.from(offsets), lengths: Uint32Array.from(lengths) };
}

function indexFor(dir, name) {
  const file = sidecarFor(dir, name);
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.dev}:${st.ino}|${st.mtimeMs}|${st.size}`;
  let idx = _indexes.get(file);
  if (!idx || idx.key !== key) { idx = buildIndex(file, key); idx.bytes = st.size; }
  _indexes.delete(file);
  _indexes.set(file, idx);
  // Two bounds, least recently used out first, never evicting the index just used: a store count,
  // and a budget in sidecar bytes (a resident index retains ~1.7x its sidecar: 162 MB for
  // ruvector's 95 MB). The default budget is 160 MB of sidecar; RUVNET_BRAIN_KEYWORD_INDEX_BUDGET_MB
  // overrides it.
  const budget = (Number(process.env.RUVNET_BRAIN_KEYWORD_INDEX_BUDGET_MB) || KEYWORD_INDEX_BUDGET_MB) * 1048576;
  let total = 0;
  for (const v of _indexes.values()) total += v.bytes;
  while (_indexes.size > 1 && (_indexes.size > KEYWORD_INDEX_STORES_MAX || total > budget)) {
    const oldest = _indexes.keys().next().value;
    total -= _indexes.get(oldest).bytes;
    _indexes.delete(oldest);
  }
  return idx;
}

/** BM25 scores for every passage with a positive score, ranked; sidecar order breaks ties. */
export function keywordRank(idx, query) {
  const qt = tokenize(query);
  const scores = new Float64Array(idx.N);
  const touched = [];
  for (const t of qt) {
    const tid = idx.dict.get(t);
    if (tid === undefined) continue;
    const from = idx.tokStart[tid];
    const to = idx.tokStart[tid + 1];
    const df = to - from;
    const idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
    if (idf === 0) continue;
    for (let i = from; i < to; i++) {
      const d = idx.docs[i];
      const f = idx.tfs[i];
      const norm = idx.docLen[d] / (idx.avgDocLen || 1);
      if (scores[d] === 0) touched.push(d);
      scores[d] += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * norm)));
    }
  }
  return touched.filter((d) => scores[d] > 0)
    .sort((a, b) => scores[b] - scores[a] || a - b)
    .map((d) => ({ doc: d, score: scores[d] }));
}

function readPassage(idx, doc) {
  const fd = fs.openSync(idx.file, 'r');
  try {
    const out = Buffer.alloc(idx.lengths[doc]);
    fs.readSync(fd, out, 0, out.length, idx.offsets[doc]);
    return JSON.parse(out.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

/**
 * Up to topN files of a repository store whose best passage wins BM25 for this question, skipping
 * paths already pooled. Each candidate carries its best passage's text and rides the `bm25` lane.
 */
export function keywordCandidates(dir, name, query, { topN = REPO_KEYWORD_TOPN, exclude = new Set() } = {}) {
  if (!(topN > 0)) return [];
  const idx = indexFor(dir, name);
  if (!idx) return [];
  const picked = [];
  const seen = new Set();
  for (const { doc } of keywordRank(idx, query)) {
    if (picked.length >= topN) break;
    const p = idx.paths[doc];
    if (seen.has(p)) continue;
    seen.add(p);
    picked.push(doc);
  }
  // The top-N files are chosen first and THEN the ones dense already pooled are dropped (the measured
  // E2 rule), so the lane adds at most topN files and fewer when dense already found them.
  return picked.filter((doc) => !exclude.has(idx.paths[doc])).map((doc) => {
    const row = readPassage(idx, doc);
    return { path: row.path, title: row.title, fullText: row.text, text: row.text,
      bestDistance: 1.0, distance: 1.0, _lane: 'bm25' };
  });
}
