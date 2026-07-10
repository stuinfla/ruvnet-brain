#!/usr/bin/env node
// forge-rerank.mjs — cross-encoder reranker on top of searchKb (the highest-leverage REAL-USE lever).
// Pulls a wide candidate set (vector + heuristics + symbol routing) then RE-SCORES each candidate by
// reading (query, passage) TOGETHER with a cross-encoder — which picks the file that actually answers,
// not the one that's merely embedding-close or mentions the symbol. Falls back to searchKb order on error.
//
//   import { rerankKb } from './forge-rerank.mjs'
//   node forge-rerank.mjs --dir . --name ruflo --variant big --q "..."   # CLI smoke
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadTransformers } from './resolve-deps.mjs';

// ADR-0011 Phase 3: this file doubles as its OWN worker_threads entry (single-file pattern —
// scripts/build-bundle.mjs ships a fixed tools list, so no new file may be added to the bundle).
// A CE worker is identified by the workerData sentinel below, NOT by !isMainThread alone, so being
// imported inside someone else's worker (e.g. a vitest thread pool) never trips worker mode.
const IS_CE_WORKER = !isMainThread && workerData && workerData.__ceWorker === true;

// searchKb is only needed by rerankKb on the main thread. forge-ask.mjs calls loadRvf() at import
// time, so a static import would drag the whole @ruvector/rvf native module into every CE worker
// for nothing — conditional top-level await keeps the worker's module graph down to transformers.
let searchKb = null;
if (!IS_CE_WORKER) ({ searchKb } = await import('./forge-ask.mjs'));

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

// score one (query, passage) pair → relevance logit (higher = more relevant). Used as the per-pair
// fallback when a batched call fails (see ceScoreBatch below) — kept isolated so one bad passage in a
// batch degrades to -Infinity for just that item instead of losing the whole batch's scores.
async function ceScore(ce, query, passage) {
  const inputs = ce.tok(query, { text_pair: passage.slice(0, 3000), padding: true, truncation: true });
  const out = await ce.model(inputs);
  const logits = out.logits.data;
  return logits.length ? Number(logits[0]) : -Infinity;
}

// Cap how many (query, passage) pairs go into ONE tokenizer+model forward pass. Cross-repo pools can
// exceed 200 candidates (pool * 27 repos) — batching ALL of them in a single call would pad every
// short passage out to the longest one in the set, an unbounded memory/compute spike. Chunking keeps
// the batching win (one ONNX invocation per CE_BATCH_SIZE items instead of per item) bounded.
const CE_BATCH_SIZE = 16;

// score a whole batch of (query, passage) pairs in ONE forward pass per chunk — the actual perf win
// vs. one ONNX invocation per candidate (100+ pooled across repos). Falls back to per-pair scoring
// (isolating a single bad passage to -Infinity) if a chunk's batched call throws.
async function ceScoreBatch(ce, query, passages) {
  if (!passages.length) return [];
  const scores = new Array(passages.length);
  for (let start = 0; start < passages.length; start += CE_BATCH_SIZE) {
    const chunk = passages.slice(start, start + CE_BATCH_SIZE);
    try {
      const inputs = ce.tok(new Array(chunk.length).fill(query), {
        text_pair: chunk.map((p) => p.slice(0, 3000)),
        padding: true,
        truncation: true,
      });
      const out = await ce.model(inputs);
      const dims = out.logits.dims;
      const numLabels = dims && dims.length ? dims[dims.length - 1] : 1;
      const data = out.logits.data;
      for (let i = 0; i < chunk.length; i++) scores[start + i] = data.length ? Number(data[i * numLabels]) : -Infinity;
    } catch (e) {
      if (process.env.CE_DEBUG) console.error('CE batch scoring failed, falling back to per-pair:', e.message);
      for (let i = 0; i < chunk.length; i++) {
        try { scores[start + i] = await ceScore(ce, query, chunk[i]); }
        catch { scores[start + i] = -Infinity; }
      }
    }
  }
  return scores;
}

// ---------- ADR-0011 Phase 3: worker_threads parallel scoring ----------
// ONNX inference is CPU-bound and serializes on the JS thread (Promise.all concurrency buys
// nothing). The cross-repo rerank (~248 pairs at ~61ms/pair ≈ 12-15s) is ~97% of query time, so
// big pools are sharded across worker threads, each running THIS file as its worker entry with its
// own copy of the CE model (~30MB per worker; loaded lazily on the worker's first task).
//
// DETERMINISM: shards are CONTIGUOUS and aligned to CE_BATCH_SIZE chunk boundaries, so every ONNX
// forward pass sees exactly the same batch composition as the inline path — parallel scores are
// identical to inline scores — and results reassemble by index.
//
// Env knobs (read at CALL time, not import time, so operators/tests can flip them per call):
//   CE_WORKERS            0 or 1 = the inline path (THE DEFAULT). Set >=2 to opt into the worker
//                         pool. Measured 2026-07-10 on a quiet M3 Max over the 32-store corpus:
//                         inline median 20.85s vs 8-worker median 23.97s — pool spawn + per-worker
//                         ONNX model load cost more than sharded scoring returned. Workers kept as
//                         an explicit experiment knob only; only measured winners get defaults.
//   CE_PARALLEL_MIN       min pairs before workers engage (default 2*CE_BATCH_SIZE+1 = 33 — below
//                         that, pool spawn + per-worker model load costs more than inline scoring).
//   CE_FORCE_WORKER_FAIL  test hook: makes worker spawn throw, proving the inline fallback.
let _pool = null;         // Worker[] — spawned lazily on the first big-enough call, reused after
let _poolBroken = false;  // any spawn/runtime worker failure pins this process to the inline path
let _msgId = 0;
const _stats = { parallelCalls: 0, inlineCalls: 0 };

function ceWorkerCount() {
  const raw = process.env.CE_WORKERS;
  if (raw !== undefined && raw !== '') {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0; // inline by default — the worker pool lost its quiet-machine benchmark (see header)
}

function ceParallelMin() {
  const n = Number(process.env.CE_PARALLEL_MIN);
  return Number.isFinite(n) && n > 0 ? n : CE_BATCH_SIZE * 2 + 1;
}

function spawnPool(n) {
  if (process.env.CE_FORCE_WORKER_FAIL) throw new Error('CE_FORCE_WORKER_FAIL is set (test hook)');
  const workers = [];
  try {
    // Split the machine's cores across the pool. onnxruntime's DEFAULT intra-op pool spins one
    // thread per core PER SESSION — measured on the real 248-candidate pool, N workers x 16
    // spinning threads contend so hard the parallel win disappears (18.9s -> 18.1s), while a
    // 2-thread cap scores the same workload at the same speed as 16 threads (9.3s vs 9.1s,
    // identical score digest). Each worker honors this via an InferenceSession.create wrap below.
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const intraOpThreads = Math.max(1, Math.floor(cores / n));
    for (let i = 0; i < n; i++) {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { __ceWorker: true, intraOpThreads } });
      w.unref(); // idle workers must never keep a one-shot CLI process alive
      // A worker that dies while IDLE would otherwise emit an unhandled 'error' (process crash —
      // a failure mode the inline path never had) or silently hang the next call. Permanent `on`
      // (not `once`): every error must stay handled, or a second one would crash after all.
      w.on('error', (e) => { w.__ceDead = true; _poolBroken = true; if (process.env.CE_DEBUG) console.error('CE worker error:', e.message); });
      w.once('exit', () => { w.__ceDead = true; });
      workers.push(w);
    }
    return workers;
  } catch (e) {
    for (const w of workers) w.terminate().catch(() => {});
    throw e;
  }
}

// contiguous, CE_BATCH_SIZE-aligned shard ranges over `total` passages (see DETERMINISM note)
function shardRanges(total, maxShards) {
  const chunks = Math.ceil(total / CE_BATCH_SIZE);
  const nShards = Math.min(maxShards, chunks);
  const per = Math.floor(chunks / nShards), extra = chunks % nShards;
  const ranges = [];
  let chunk = 0;
  for (let s = 0; s < nShards; s++) {
    const take = per + (s < extra ? 1 : 0);
    ranges.push({ start: chunk * CE_BATCH_SIZE, end: Math.min(total, (chunk + take) * CE_BATCH_SIZE) });
    chunk += take;
  }
  return ranges;
}

function callWorker(w, query, passages) {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    const done = (fn, v) => { w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); fn(v); };
    const onMsg = (m) => { if (m && m.id === id) (m.error ? done(reject, new Error(m.error)) : done(resolve, m.scores)); };
    const onErr = (e) => done(reject, e);
    const onExit = (code) => done(reject, new Error(`CE worker exited (${code}) mid-task`));
    w.on('message', onMsg); w.on('error', onErr); w.on('exit', onExit);
    w.postMessage({ id, query, passages });
  });
}

async function ceScoreParallel(query, passages) {
  if (!_pool) _pool = spawnPool(ceWorkerCount());
  const ranges = shardRanges(passages.length, _pool.length);
  const used = _pool.slice(0, ranges.length);
  if (used.some((w) => w.__ceDead)) throw new Error('CE worker pool degraded (a worker exited)');
  for (const w of used) w.ref(); // keep the event loop alive while tasks are in flight
  try {
    const parts = await Promise.all(ranges.map((r, i) => callWorker(used[i], query, passages.slice(r.start, r.end))));
    const scores = new Array(passages.length);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = 0; j < parts[i].length; j++) scores[ranges[i].start + j] = parts[i][j];
    }
    return scores;
  } finally {
    for (const w of used) { try { w.unref(); } catch { /* already terminated */ } }
  }
}

// Dispatch: parallel path for big pools when workers are enabled and healthy, the pre-existing
// inline ceScoreBatch otherwise. NEVER crashes where the inline path worked — any worker failure
// (construction throw, worker death, worker-side error) tears the pool down and falls back inline.
async function ceScoreAuto(ce, query, passages) {
  const eligible = !_poolBroken
    && ceWorkerCount() >= 2
    && passages.length >= ceParallelMin()
    && passages.length > CE_BATCH_SIZE; // a single chunk has nothing to parallelize
  if (eligible) {
    try {
      const scores = await ceScoreParallel(query, passages);
      _stats.parallelCalls++;
      return scores;
    } catch (e) {
      _poolBroken = true;
      if (_pool) { for (const w of _pool) { try { w.terminate(); } catch { /* best effort */ } } _pool = null; }
      if (process.env.CE_DEBUG) console.error('CE worker path failed, falling back to inline:', e.message);
    }
  }
  _stats.inlineCalls++;
  return ceScoreBatch(ce, query, passages);
}

// Diagnostics + lifecycle helpers (rerankKb/rerankPairs contracts unchanged). ceWorkerStats lets
// tests prove which path actually scored; ceWorkerShutdown lets long-running hosts / test files
// release the pool deterministically (workers are unref()ed, so exit never blocks on them anyway).
export function ceWorkerStats() {
  return { ..._stats, poolSize: _pool ? _pool.length : 0, poolBroken: _poolBroken };
}
export async function ceWorkerShutdown() {
  const pool = _pool; _pool = null;
  if (pool) await Promise.allSettled(pool.map((w) => w.terminate()));
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
  const scores = await ceScoreAuto(ce, query, base.map((d) => d.fullText || ''));
  const scored = base.map((d, i) => ({ ...d, ceScore: scores[i] }));
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
  const scores = await ceScoreAuto(ce, query, docs.map((d) => d.fullText || d.text || ''));
  const scored = docs.map((d, i) => ({ ...d, ceScore: scores[i] }));
  scored.sort((a, b) => (b.ceScore ?? -Infinity) - (a.ceScore ?? -Infinity));
  return scored;
}

// ---------- worker entry: this same file, spawned by ceScoreParallel ----------
// Scores one contiguous shard per message with the SAME loadCE (same resolve-deps resolution; the
// worker inherits process.env, so KB_MODEL_CACHE/CE_MODEL flow through) and the SAME ceScoreBatch —
// including its per-pair fallback, so a bad passage degrades to -Infinity alone here too.
if (IS_CE_WORKER) {
  // Cap this worker's ORT intra-op threads (see the spawnPool comment: uncapped pools spin-wait
  // each other to death). @xenova/transformers 2.x hardcodes InferenceSession.create options, so
  // the cap is injected by wrapping the shared class's static create. Best-effort: if
  // onnxruntime-node isn't resolvable (e.g. a wasm-only environment), default threading applies.
  // Thread count does NOT change numerics (verified: identical score digest at 2 vs 16 threads).
  try {
    const { createRequire } = await import('node:module');
    const ort = createRequire(import.meta.url)('onnxruntime-node');
    const cap = Math.max(1, Math.floor(Number(workerData.intraOpThreads) || 0));
    if (cap && ort?.InferenceSession?.create) {
      const orig = ort.InferenceSession.create.bind(ort.InferenceSession);
      ort.InferenceSession.create = (buf, opts = {}) => orig(buf, { ...opts, intraOpNumThreads: cap, interOpNumThreads: 1 });
    }
  } catch { /* onnxruntime-node not present — transformers' fallback backend keeps its defaults */ }
  parentPort.on('message', async ({ id, query, passages }) => {
    try {
      const hadCE = !!_ce;
      const t0 = Date.now();
      const ce = await loadCE();
      if (!hadCE && process.env.CE_DEBUG) console.error(`[ce-worker] model loaded in ${Date.now() - t0}ms`);
      parentPort.postMessage({ id, scores: await ceScoreBatch(ce, query, passages) });
    } catch (e) {
      parentPort.postMessage({ id, error: String((e && e.message) || e) });
    }
  });
}

// CLI smoke. The IS_CE_WORKER guard is load-bearing: inside a worker, process.argv[1] IS this
// file's path (verified empirically), so without it every spawned worker would re-run the CLI.
if (!IS_CE_WORKER && process.argv[1] && process.argv[1].endsWith('forge-rerank.mjs')) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const r = await rerankKb({ dir: arg('--dir', '.'), name: arg('--name', 'ruflo'), variant: arg('--variant', 'big'), query: arg('--q', ''), k: 6 });
  for (let i = 0; i < r.length; i++) console.log(`#${i + 1} ce=${r[i].ceScore?.toFixed(3)} ${r[i].path}`);
}
