#!/usr/bin/env node
// forge-rerank.mjs — cross-encoder reranker on top of searchKb (the highest-leverage REAL-USE lever).
// Pulls a wide candidate set (vector + heuristics + symbol routing) then RE-SCORES each candidate by
// reading (query, passage) TOGETHER with a cross-encoder — which picks the file that actually answers,
// not the one that's merely embedding-close or mentions the symbol. Falls back to searchKb order on error.
//
//   import { rerankKb } from './forge-rerank.mjs'
//   node forge-rerank.mjs --dir . --name ruflo --variant big --q "..."   # CLI smoke
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { loadTransformers } from './resolve-deps.mjs';
import { QueryDeadlineExceeded } from './query-deadline.mjs';
import { materializeModelRevision, modelCacheReady } from './model-requirements.mjs';

// Same packaged entry, separate process: a native ONNX/V8 fault cannot kill the parent host.
// Both the literal fork argument and a live IPC channel are required; ambient env cannot opt in.
const IS_CE_WORKER = process.argv[2] === '--ce-worker' && typeof process.send === 'function';

// searchKb is only needed by rerankKb in the parent. forge-ask.mjs calls loadRvf() at import
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
  const { T, modelCache } = await loadTransformers();   // same resolver as forge-ask (KB node_modules / XENOVA_PATH), not a bare import
  // Bug A (issue #29, found+fixed by Jan Lafko): the cache dir was only wired up when KB_MODEL_CACHE
  // was explicitly exported — otherwise the loader had no idea where the pre-cached models lived and
  // tried (and in restricted networks, HUNG) fetching fresh on every call. Resolve it UNCONDITIONALLY
  // via the same chooseModelCache() path getEmbedder() already used correctly. His verification:
  // rerankPairs() with KB_MODEL_CACHE unset went from hang/timeout to 710ms, zero network.
  // A resolver may legitimately return no modelCache (hermetic tests mock { T } only) — skip the
  // cache wiring rather than path.join(undefined,…) throwing, which nulled every hermetic score.
  if (modelCache) {
    T.env.cacheDir = modelCache;
    T.env.localModelPath = modelCache;
    if (!modelCacheReady(modelCache, CE_MODEL)) {
      materializeModelRevision(modelCache, CE_MODEL, CE_REVISION);
    }
  }
  T.env.allowRemoteModels = !(modelCache && modelCacheReady(modelCache, CE_MODEL));
  const ceDir = modelCache ? path.join(modelCache, CE_MODEL) : null;
  const attempt = async () => {
    const tok = await T.AutoTokenizer.from_pretrained(CE_MODEL, { revision: CE_REVISION });
    const model = await T.AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { quantized: true, revision: CE_REVISION });
    return { T, tok, model };
  };
  try {
    _ce = await attempt();
  } catch (e) {
    // Bug B (issue #29, Jan Lafko): a directory on disk proves a download STARTED, not that it
    // finished. A truncated .onnx (interrupted download — the exact #27 failure mode) silently
    // disabled reranking on every query and DEADLOCKED the process on the second query (ORT's wasm
    // fallback wedges in futex_wait). Self-heal ONCE: wipe the suspect copy, refetch, retry.
    if (ceDir && fs.existsSync(ceDir)) {
      console.error(`[forge-rerank] cross-encoder failed to load (${String(e.message).slice(0, 120)}) — treating the local copy as corrupted: wiping ${ceDir} and re-fetching once (issue #29)`);
      fs.rmSync(ceDir, { recursive: true, force: true });
      // The ready-cache probe disabled downloads above; that copy no longer exists.
      T.env.allowRemoteModels = true;
      _ce = await attempt();
    } else throw e;
  }
  return _ce;
}

// Stable-Spine readiness hook; see warmQueryEmbedder in forge-ask.mjs.
export async function warmReranker() {
  const ce = await loadCE();
  // Prime the first ONNX forward pass, not merely weight loading. Without this, the first real
  // question still paid 5-6 seconds even though the parent had received a warmup acknowledgement.
  await ceScoreBatch(ce, 'readiness', ['source-grounded readiness'], 64);
}

// score one (query, passage) pair → relevance logit (higher = more relevant). Used as the per-pair
// fallback when a batched call fails (see ceScoreBatch below) — kept isolated so one bad passage in a
// batch degrades to -Infinity for just that item instead of losing the whole batch's scores.
async function ceScore(ce, query, passage, maxLength) {
  const inputs = ce.tok(query, tokOpts(passage.slice(0, 3000), maxLength));
  const out = await ce.model(inputs);
  const logits = out.logits.data;
  return logits.length ? Number(logits[0]) : -Infinity;
}

// Tokenizer options for ONE (query, passage) pair or batch. `maxLength` is the ONLY knob the
// cascade adds: leaving it undefined truncates at the model's own 512-token limit, which is the
// pre-cascade behaviour byte-for-byte. Passing e.g. 192 makes the model read a PREFIX of each
// passage — the same model, the same head, the same logit scale, just less of the document.
function tokOpts(textPair, maxLength) {
  const o = { text_pair: textPair, padding: true, truncation: true };
  if (maxLength > 0) o.max_length = maxLength;
  return o;
}

// Cap how many (query, passage) pairs go into ONE tokenizer+model forward pass. Cross-repo pools can
// exceed 200 candidates (pool * 27 repos) — batching ALL of them in a single call would pad every
// short passage out to the longest one in the set, an unbounded memory/compute spike. Chunking keeps
// the batching win (one ONNX invocation per CE_BATCH_SIZE items instead of per item) bounded.
const CE_BATCH_SIZE = 16;

// score a whole batch of (query, passage) pairs in ONE forward pass per chunk — the actual perf win
// vs. one ONNX invocation per candidate (100+ pooled across repos). Falls back to per-pair scoring
// (isolating a single bad passage to -Infinity) if a chunk's batched call throws.
async function ceScoreBatch(ce, query, passages, maxLength, deadline = null) {
  if (!passages.length) return [];
  const scores = new Array(passages.length);
  for (let start = 0; start < passages.length; start += CE_BATCH_SIZE) {
    // THE ONLY PLACE THIS PHASE CAN BE INTERRUPTED. An ONNX forward pass is a native call on the
    // JS thread: nothing in this process — not a timer, not a promise — runs while the model is
    // inside a batch. So the deadline's granularity here is exactly one batch, by construction,
    // and kb/query-deadline.mjs's watchdog exists because of it.
    deadline?.check('rerank');
    const chunk = passages.slice(start, start + CE_BATCH_SIZE);
    try {
      const inputs = ce.tok(new Array(chunk.length).fill(query), tokOpts(chunk.map((p) => p.slice(0, 3000)), maxLength));
      const out = await ce.model(inputs);
      const dims = out.logits.dims;
      const numLabels = dims && dims.length ? dims[dims.length - 1] : 1;
      const data = out.logits.data;
      for (let i = 0; i < chunk.length; i++) scores[start + i] = data.length ? Number(data[i * numLabels]) : -Infinity;
    } catch (e) {
      if (process.env.CE_DEBUG) console.error('CE batch scoring failed, falling back to per-pair:', e.message);
      for (let i = 0; i < chunk.length; i++) {
        try { scores[start + i] = await ceScore(ce, query, chunk[i], maxLength); }
        catch { scores[start + i] = -Infinity; }
      }
    }
  }
  return scores;
}

// ---------- ADR-0011 Phase 3: process-isolated parallel scoring ----------
// ONNX inference is CPU-bound and serializes on the JS thread (Promise.all concurrency buys
// nothing). The cross-repo rerank (~248 pairs at ~61ms/pair ≈ 12-15s) is ~97% of query time, so
// big pools are sharded across child processes, each running THIS file as its worker entry with its
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
let _pool = null;         // ChildProcess[] — spawned lazily and reused while warm
let _poolBroken = false;  // any spawn/runtime worker failure pins this process to the inline path
let _msgId = 0;
const _stats = { parallelCalls: 0, inlineCalls: 0, childResponses: 0 };

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

// Keep child cleanup single-flight, including partial-spawn and fallback paths.
let _shutdown = Promise.resolve();
function forceStop(worker) {
  if (worker.__ceDead) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(hard); clearTimeout(deadline); worker.off('exit', done); resolve(); };
    worker.once('exit', done);
    const hard = setTimeout(() => { try { worker.kill('SIGKILL'); } catch { /* exit races */ } }, 1000);
    const deadline = setTimeout(() => {
      worker.off('exit', done); reject(new Error('CE child could not be reaped'));
    }, 2000);
    try { worker.kill('SIGTERM'); } catch { /* escalation remains armed */ }
  });
}
async function stopWorker(worker) {
  if (worker.__ceDead) return;
  try {
    await new Promise((resolve, reject) => {
      const done = (error) => {
        clearTimeout(timer);
        worker.off('exit', onExit); worker.off('error', onError);
        if (error) reject(error); else resolve();
      };
      const onExit = () => done();
      const onError = (error) => done(error);
      const timer = setTimeout(() => done(new Error('CE shutdown timed out')), 5000);
      worker.once('exit', onExit); worker.once('error', onError);
      try { worker.ref(); worker.channel?.ref(); worker.send({ shutdown: true }, (error) => { if (error) done(error); }); } catch (error) { done(error); }
    });
  } catch {
    // Broken/unresponsive workers still have a bounded forced-exit path.
    await forceStop(worker);
  }
}
function terminateWorkers(workers) {
  if (workers.length) _shutdown = _shutdown.catch(() => {}).then(async () => {
    const failures = [];
    for (const worker of workers) {
      try { await stopWorker(worker); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'CE children could not all be reaped');
  });
  return _shutdown;
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
      const w = fork(fileURLToPath(import.meta.url), ['--ce-worker', String(intraOpThreads)], {
        execPath: process.execPath, execArgv: [], serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      w.unref(); // idle workers must never keep a one-shot CLI process alive
      w.channel?.unref();
      // A worker that dies while IDLE would otherwise emit an unhandled 'error' (process crash —
      // a failure mode the inline path never had) or silently hang the next call. Permanent `on`
      // (not `once`): every error must stay handled, or a second one would crash after all.
      w.on('error', (e) => { _poolBroken = true; if (process.env.CE_DEBUG) console.error('CE worker error:', e.message); });
      w.once('exit', () => { w.__ceDead = true; if (!w.__ceStopping) _poolBroken = true; });
      workers.push(w);
    }
    return workers;
  } catch (e) {
    void terminateWorkers(workers).catch(() => {}); // fallback awaits and surfaces the same cleanup result
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

function callWorker(w, query, passages, maxLength) {
  // Bound queued work and include queue time in the existing MCP call budget, not a
  // shorter new search deadline (plugin/mcp/server.mjs owns the external watchdog).
  if ((w.__cePending || 0) >= 32) return Promise.reject(new Error('CE child queue full'));
  const configured = Number(process.env.RUVNET_BRAIN_CALL_TIMEOUT_MS);
  const deadline = Date.now() + (Number.isFinite(configured) && configured > 0 ? configured : 240_000);
  w.__cePending = (w.__cePending || 0) + 1;
  const task = (w.__ceQueue || Promise.resolve()).then(() => new Promise((resolve, reject) => {
    if (w.__ceDead || w.__ceStopping) return reject(new Error('CE child is unavailable'));
    const id = ++_msgId;
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); fn(v); };
    const onMsg = (m) => { if (m && m.id === id) {
      if (m.error) done(reject, new Error(m.error));
      else if (!Array.isArray(m.scores) || m.scores.length !== passages.length
        || m.scores.some((score) => !Number.isFinite(score) && score !== -Infinity)) done(reject, new Error('invalid CE child scores'));
      else { _stats.childResponses++; done(resolve, m.scores); }
    } };
    const onErr = (e) => done(reject, e);
    const onExit = (code) => done(reject, new Error(`CE worker exited (${code}) mid-task`));
    const timer = setTimeout(() => {
      _poolBroken = true; w.__ceStopping = true;
      void forceStop(w).catch(() => {});
      done(reject, new Error('CE child task timed out'));
    }, Math.max(1, deadline - Date.now()));
    w.on('message', onMsg); w.on('error', onErr); w.on('exit', onExit);
    try { w.send({ id, query, passages, maxLength }, (error) => { if (error) done(reject, error); }); }
    catch (error) { done(reject, error); }
  }));
  w.__ceQueue = task.catch(() => {});
  return task.finally(() => { w.__cePending--; });
}

async function ceScoreParallel(query, passages, maxLength, deadline = null) {
  deadline?.check('rerank');
  if (!_pool) _pool = spawnPool(ceWorkerCount());
  const ranges = shardRanges(passages.length, _pool.length);
  const used = _pool.slice(0, ranges.length);
  if (used.some((w) => w.__ceDead)) throw new Error('CE worker pool degraded (a worker exited)');
  for (const w of used) { w.ref(); w.channel?.ref(); }
  try {
    const parts = await Promise.all(ranges.map((r, i) => callWorker(used[i], query, passages.slice(r.start, r.end), maxLength)));
    const scores = new Array(passages.length);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = 0; j < parts[i].length; j++) scores[ranges[i].start + j] = parts[i][j];
    }
    return scores;
  } finally {
    for (const w of used) { try { if (!w.__cePending) { w.unref(); w.channel?.unref(); } } catch { /* already terminated */ } }
  }
}

// Dispatch: parallel path for big pools when workers are enabled and healthy, the pre-existing
// inline ceScoreBatch otherwise. NEVER crashes where the inline path worked — any worker failure
// (construction throw, worker death, worker-side error) tears the pool down and falls back inline.
async function ceScoreAuto(ce, query, passages, maxLength, deadline = null) {
  if (_poolBroken && _pool) await ceWorkerShutdown();
  const eligible = !_poolBroken
    && ceWorkerCount() >= 2
    && passages.length >= ceParallelMin()
    && passages.length > CE_BATCH_SIZE; // a single chunk has nothing to parallelize
  if (eligible) {
    try {
      const scores = await ceScoreParallel(query, passages, maxLength, deadline);
      _stats.parallelCalls++;
      return scores;
    } catch (e) {
      // A deadline is a DECISION, not a worker fault: reap the children (so a timeout can never
      // orphan forked work) and re-raise instead of silently retrying the same work inline, which
      // would double the overrun the deadline just caught.
      await ceWorkerShutdown();
      if (e instanceof QueryDeadlineExceeded) throw e;
      _poolBroken = true;
      if (process.env.CE_DEBUG) console.error('CE worker path failed, falling back to inline:', e.message);
    }
  }
  _stats.inlineCalls++;
  return ceScoreBatch(ce, query, passages, maxLength, deadline);
}

// Diagnostics + lifecycle helpers (rerankKb/rerankPairs contracts unchanged). ceWorkerStats lets
// tests prove which path actually scored; ceWorkerShutdown lets long-running hosts / test files
// release the pool deterministically (workers are unref()ed, so exit never blocks on them anyway).
export function ceWorkerStats() {
  return { ..._stats, poolSize: _pool ? _pool.length : 0, poolBroken: _poolBroken,
    childPids: (_pool || []).map((worker) => worker.pid) };
}
export async function ceWorkerShutdown() {
  const pool = _pool; _pool = null;
  for (const worker of pool || []) worker.__ceStopping = true;
  await terminateWorkers(pool || []);
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

// ── STAGE 1 OF THE CASCADE ──────────────────────────────────────────────────────────────────────
// Score every (query, passage) pair with the SAME cross-encoder but reading only the first
// `maxLength` tokens of each passage. This is the cheap, high-recall selector that decides which
// pairs are worth a FULL read (rerankPairs, below).
//
// WHY A PREFIX AND NOT THE BI-ENCODER DISTANCE. The obvious cheap signal is free — the vector
// distances are already computed. It was measured and it does not work. On held-out question s-05
// ("instant rollback without replaying the whole day") the document the full cross-encoder ranks
// FIRST out of 608 — agenticow/examples/rollback-quarantine.mjs, ce +1.717, a 4.6-logit margin over
// second place — sits at rank 593 of 608 BY VECTOR DISTANCE. A distance-ordered cascade would have
// to keep 594 of 608 pairs to retain it, which saves nothing. The bi-encoder is not a weak proxy
// for the cross-encoder on that question; it is very nearly an inverted one. This is the same
// failure that made the flat pool cap of ADR-057 drop that answer.
//
// A prefix score does not have that problem, because it is the same model and the same head
// reading a subset of the same input, so it is a genuine approximation of the full score rather
// than a different opinion. That is the property agentic-qe's rabitq.ts names as the cascade
// contract: "a cheap ranking proxy to shrink the candidate pool, then run exact ... on the
// survivors" (agentic-qe/src/shared/utils/rabitq.ts).
//
// THE COST CURVE, measured 2026-07-27 on 608 real corpus passages drawn to the production length
// distribution (62.8% of production passages reach the model's 512-token ceiling; mean 397 tokens):
//   full (512)      16223 ms   1.000x
//   max_length=256   7087 ms   0.437x
//   max_length=192   5195 ms   0.320x     <- the shipped stage-1 budget
//   max_length=128   3334 ms   0.206x
//   max_length=64    1589 ms   0.098x
// Below 192 the ranking starts losing documents the full model ranks in its top 3, so 192 is
// where the curve stops being free. Cost is superlinear in length (attention is quadratic), which
// is why cutting the sequence buys more than cutting the pool: half the tokens is well under half
// the time, while half the pool is exactly half the time.
export async function cePrefilterScores(query, docs, { maxLength = 192, deadline = null } = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  let ce;
  try { ce = await loadCE(); }
  catch (e) { if (process.env.CE_DEBUG) console.error('CE load failed, no prefilter scores:', e.message); return null; }
  return ceScoreAuto(ce, query, docs.map((d) => (typeof d === 'string' ? d : d.fullText || d.text || '')), maxLength, deadline);
}

// rerankPairs — cross-repo common-scale scorer. Given an ALREADY-RETRIEVED candidate list (e.g.
// pooled from searchKb across several repos, each with .fullText/.text), load the cross-encoder ONCE
// and score every (query, passage) pair on the SAME logit scale, so candidates from different repos
// (and different embedders/dims) become directly comparable. Returns the list sorted by ceScore desc.
// Falls back to input order (ceScore=null) if the cross-encoder can't load — never throws.
export async function rerankPairs(query, docs, { deadline = null } = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  let ce;
  try { ce = await loadCE(); }
  catch (e) { if (process.env.CE_DEBUG) console.error('CE load failed, using input order:', e.message); return docs.map((d) => ({ ...d, ceScore: null })); }
  const scores = await ceScoreAuto(ce, query, docs.map((d) => d.fullText || d.text || ''), undefined, deadline);
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
    const cap = Math.max(1, Math.floor(Number(process.argv[3]) || 0));
    if (cap && ort?.InferenceSession?.create) {
      const orig = ort.InferenceSession.create.bind(ort.InferenceSession);
      ort.InferenceSession.create = (buf, opts = {}) => orig(buf, { ...opts, intraOpNumThreads: cap, interOpNumThreads: 1 });
    }
  } catch { /* onnxruntime-node not present — transformers' fallback backend keeps its defaults */ }
  let tasks = Promise.resolve();
  // IPC disconnect is also delivered when the parent is killed: do not orphan a warm model.
  process.on('disconnect', () => { process.exit(0); });
  process.on('message', (message) => { tasks = tasks.then(async () => {
    const { id, query, passages, maxLength } = message;
    if (message.shutdown === true) {
      // Drain scoring, call the supported disposal API, then allow normal isolate exit.
      // Older onnxruntime-node handlers implement dispose() as a no-op: this does not claim
      // native release on those versions, and must still be exercised with the real backend.
      try { await _ce?.model?.dispose(); } finally { _ce = null; process.disconnect(); }
      return;
    }
    try {
      const hadCE = !!_ce;
      const t0 = Date.now();
      const ce = await loadCE();
      if (!hadCE && process.env.CE_DEBUG) console.error(`[ce-worker] model loaded in ${Date.now() - t0}ms`);
      process.send?.({ id, scores: await ceScoreBatch(ce, query, passages, maxLength) });
    } catch (e) {
      process.send?.({ id, error: String((e && e.message) || e) });
    }
  }).catch((error) => { if (process.connected) process.send?.({ error: String(error?.message || error) }); }); });
}

// CLI smoke. The IS_CE_WORKER guard is load-bearing: inside a worker, process.argv[1] IS this
// file's path (verified empirically), so without it every spawned worker would re-run the CLI.
if (!IS_CE_WORKER && process.argv[1] && process.argv[1].endsWith('forge-rerank.mjs')) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const r = await rerankKb({ dir: arg('--dir', '.'), name: arg('--name', 'ruflo'), variant: arg('--variant', 'big'), query: arg('--q', ''), k: 6 });
  for (let i = 0; i < r.length; i++) console.log(`#${i + 1} ce=${r[i].ceScore?.toFixed(3)} ${r[i].path}`);
}
