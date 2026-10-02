#!/usr/bin/env node
/**
 * scripts/oracle/abstain-trace.mjs — WHY does the reranker abstain on a novice need whose gold
 * repository WAS searched?
 *
 * For each need it measures, in the gold store, with the production models:
 *   poolRank       rank of the gold file among the store's dense pool (searchKb, depth --pool)
 *   ceProduction   cross-encoder logit on the text production reranks (the assembled document, which
 *                  the reranker reads only through its first 3000 chars / 512 tokens)
 *   ceBestChunk    best logit over the gold file's own sidecar chunks, each read on its own
 *   ceSpan         logit on the verbatim gold span the question was written from (an upper bound:
 *                  the answer text itself, nothing else)
 *   ceTopProd      production's top logit for this need (from the measured needs run)
 * and classifies the abstention:
 *   not-in-pool        dense retrieval never surfaced the gold file
 *   window             gold scores >= 0 on some chunk but < 0 on the text production reads
 *   calibration        even the verbatim span scores < 0: the model, not the window, says "irrelevant"
 *   chunking           span >= 0 but every stored chunk < 0 (the answer is split across chunks)
 *   outranked          production text >= 0, yet the top citation is another file
 *
 *   node scripts/oracle/abstain-trace.mjs --kb <kbDir> --set <need-set.json> --rows <needs.json>
 *     [--runtime <dir>] [--keyword 8] [--sample 20] [--pool 64] [--out <file>]
 *
 * --rows is a measure-need-set output (it supplies reposSearched and the production top logit);
 * only needs whose gold repository was searched are traced. Nothing written contains a local path.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

export function classify({ poolRank, ceProduction, ceBestChunk, ceSpan }) {
  if (poolRank == null) return 'not-in-pool';
  if (ceProduction >= 0) return 'outranked';
  if (ceBestChunk >= 0) return 'window';
  if (ceSpan < 0) return 'calibration';
  return 'chunking';
}

/** Deterministic sample: every step-th need of the eligible list, spread over the whole list. */
export function sampleEvenly(list, n) {
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}

async function chunksOf(kb, store, file) {
  const out = [];
  for (const name of [`${store}.passages.jsonl`, `${store}.big.passages.jsonl`]) {
    const p = path.join(kb, name);
    if (!fs.existsSync(p)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes(file)) continue;
      try { const r = JSON.parse(line); if (r.path === file) out.push(String(r.text || '')); } catch { /* skip */ }
    }
    if (out.length) break;
  }
  return out;
}

async function main() {
  const kb = arg('--kb');
  const set = JSON.parse(fs.readFileSync(arg('--set'), 'utf8'));
  const rows = JSON.parse(fs.readFileSync(arg('--rows'), 'utf8')).rows;
  const poolDepth = Number(arg('--pool', 64));
  const want = Number(arg('--sample', 20));
  const byId = new Map(set.questions.map((q) => [q.id, q]));
  // The runtime is the KB directory's own copy of the reader (as in production), unless --runtime
  // names another directory holding forge-ask.mjs / forge-rerank.mjs and their node_modules.
  const runtime = path.resolve(arg('--runtime', kb));
  const { searchKb } = await import(pathToFileURL(path.join(runtime, 'forge-ask.mjs')).href);
  const { rerankPairs } = await import(pathToFileURL(path.join(runtime, 'forge-rerank.mjs')).href);
  // --keyword N also counts the keyword lane (keyword-lane.mjs in the runtime) as part of the pool.
  const keywordTopN = Number(arg('--keyword', 0));
  const keywordCandidates = keywordTopN > 0
    ? (await import(pathToFileURL(path.join(runtime, 'keyword-lane.mjs')).href)).keywordCandidates : null;
  const ce = async (query, texts) => {
    if (!texts.length) return [];
    const scored = await rerankPairs(query, texts.map((t, i) => ({ fullText: t, i })));
    const out = new Array(texts.length);
    for (const s of scored) out[s.i] = s.ceScore;
    return out;
  };
  const eligible = rows.filter((r) => (r.reposSearched || []).some((s) => s.toLowerCase() === r.repo.toLowerCase()));
  const traced = [];
  for (const r of eligible) {
    const q = byId.get(r.id);
    const store = r.repo.toLowerCase();
    const hits = await searchKb({ dir: kb, name: store, query: q.need, k: poolDepth, n: poolDepth });
    const idx = hits.findIndex((h) => h.path === q.path);
    let lane = idx < 0 ? null : 'dense';
    let gold = idx < 0 ? null : hits[idx];
    if (!gold && keywordCandidates) {
      const kw = keywordCandidates(kb, store, q.need, { topN: keywordTopN, exclude: new Set(hits.map((h) => h.path)) });
      const k = kw.findIndex((c) => c.path === q.path);
      if (k >= 0) { gold = kw[k]; lane = 'keyword'; }
    }
    traced.push({ r, q, store, gold, lane, poolRank: idx < 0 ? (gold ? poolDepth + 1 : null) : idx + 1 });
    process.stderr.write(`\r[abstain-trace] pool ${traced.length}/${eligible.length}`);
  }
  const inPool = traced.filter((t) => t.poolRank != null);
  const sample = sampleEvenly(inPool, want);
  const out = [];
  for (const t of sample) {
    const { gold } = t;
    const chunks = await chunksOf(kb, t.store, t.q.path);
    const [ceProduction] = await ce(t.q.need, [gold.fullText || gold.text || '']);
    const chunkScores = await ce(t.q.need, chunks);
    const [ceSpan] = await ce(t.q.need, [t.q.span || '']);
    const row = {
      id: t.q.id, repo: t.r.repo, need: t.q.need, poolRank: t.poolRank, lane: t.lane,
      ceProduction: +ceProduction.toFixed(3),
      ceBestChunk: chunkScores.length ? +Math.max(...chunkScores).toFixed(3) : null,
      chunks: chunks.length, goldDocChars: (gold.fullText || '').length,
      ceSpan: +ceSpan.toFixed(3), ceTopProd: t.r.topCe, prodTop: t.r.topPath, prodAbstained: t.r.abstained,
    };
    row.cause = classify(row);
    out.push(row);
    process.stderr.write(`\r[abstain-trace] ce ${out.length}/${sample.length}   `);
  }
  const count = (k) => out.filter((x) => x.cause === k).length;
  const report = {
    kind: 'ruvnet-brain-abstain-trace', poolDepth,
    eligible: eligible.length, goldInPool: inPool.length, goldViaKeyword: traced.filter((t) => t.lane === 'keyword').length, notInPool: traced.length - inPool.length, sampled: out.length,
    causes: Object.fromEntries(['not-in-pool', 'window', 'calibration', 'chunking', 'outranked'].map((k) => [k, count(k)])),
    rows: out,
    poolRanks: traced.map((t) => ({ id: t.q.id, poolRank: t.poolRank })),
  };
  const file = arg('--out');
  if (file) fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined, poolRanks: undefined }, null, 1));
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
