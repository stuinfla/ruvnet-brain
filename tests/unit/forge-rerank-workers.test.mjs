// tests/unit/forge-rerank-workers.test.mjs — ADR-0011 Phase 3: process-isolated CE parallelization
// in kb/forge-rerank.mjs (single-file entry, explicit argument plus live IPC channel).
// Sibling file tests/unit/forge-rerank.test.mjs covers the inline path's semantics and
// stays untouched; THIS file covers the parallel dispatch:
//   (a) determinism — CE_WORKERS=0 and CE_WORKERS=4 produce IDENTICAL ceScore arrays (real model;
//       skips loudly if the cross-encoder is not in any local cache, since the test env is offline)
//   (b) empty docs short-circuit to [] before any pool/CE work
//   (c) an unscoreable passage degrades to -Infinity ALONE, in BOTH paths
//   (d) worker-construction failure (CE_FORCE_WORKER_FAIL=1) falls back to the inline path
//
// Every test resets modules and dynamically imports forge-rerank.mjs so each gets fresh module
// state (_ce / worker pool / stats counters). Env knobs are read at CALL time by the module, and
// saved/restored around every test here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const MOD = '../../kb/forge-rerank.mjs';

// ---------- real-model availability probe ----------
// The real-model suite needs (1) the CE checkpoint in a LOCAL cache (no downloads from a unit
// test) and (2) kb/node_modules resolvable (the unmocked module graph loads forge-ask → rvf).
const CE_MODEL_SUBDIR = 'Xenova/ms-marco-MiniLM-L-6-v2';
const CACHE_CANDIDATES = [
  process.env.KB_MODEL_CACHE,
  path.join(REPO, 'kb', 'models-cache'),
  // The documented dogfood cache on the author machine (MEMORY.md "How to USE the brain").
  '/Users/stuartkerr/Code/PowerPlatePulse/scripts/models-cache',
].filter(Boolean);
const MODEL_CACHE = CACHE_CANDIDATES.find((d) => fs.existsSync(path.join(d, CE_MODEL_SUBDIR)));
const HAVE_DEPS = fs.existsSync(path.join(REPO, 'kb', 'node_modules', '@xenova', 'transformers'))
  && fs.existsSync(path.join(REPO, 'kb', 'node_modules', '@ruvector', 'rvf'));
const HAVE_REAL = Boolean(MODEL_CACHE && HAVE_DEPS);
if (!HAVE_REAL) {
  // LOUD skip, per the suite contract: absence of the offline model must never read as a pass.
  console.error(
    `[forge-rerank-workers.test] SKIPPING real-model determinism tests: `
    + (MODEL_CACHE ? '' : `cross-encoder ${CE_MODEL_SUBDIR} not found in any local cache (checked: ${CACHE_CANDIDATES.join(', ')}); `)
    + (HAVE_DEPS ? '' : 'kb/node_modules is missing @xenova/transformers and/or @ruvector/rvf; ')
    + 'this offline env cannot load the CE model, so worker-vs-inline score equality cannot be exercised.'
  );
}
const itReal = HAVE_REAL ? it : it.skip;
const REAL_TIMEOUT = 180_000; // pool spawn + per-worker model load (~1s each, measured) + scoring

// ---------- env save/restore ----------
const ENV_KEYS = ['CE_WORKERS', 'CE_PARALLEL_MIN', 'CE_FORCE_WORKER_FAIL', 'KB_MODEL_CACHE', 'CE_DEBUG', 'CE_MODEL'];
const savedEnv = {};
beforeEach(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.doUnmock('../../kb/forge-ask.mjs');
  vi.doUnmock('../../kb/resolve-deps.mjs');
});

// Fake transformers namespace for the hermetic tests (same shape as forge-rerank.test.mjs's): the
// passage text IS its score, so a sorted result proves which scoring path produced it.
function fakeT() {
  const tok = (query, opts) => ({ passage: opts.text_pair });
  const model = async (inputs) => {
    if (Array.isArray(inputs.passage)) {
      return { logits: { dims: [inputs.passage.length, 1], data: inputs.passage.map(Number) } };
    }
    return { logits: { data: [Number(inputs.passage)] } };
  };
  return {
    env: {},
    AutoTokenizer: { from_pretrained: vi.fn(async () => tok) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) },
  };
}

async function importMocked() {
  vi.resetModules();
  vi.doMock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
  vi.doMock('../../kb/resolve-deps.mjs', () => ({ loadTransformers: vi.fn(async () => ({ T: fakeT() })) }));
  return import(MOD);
}

async function importReal() {
  vi.resetModules();
  return import(MOD);
}

describe('parallel dispatch — hermetic (mocked CE, no model, no real workers)', () => {
  it('(b) empty docs -> [] even with workers configured (short-circuits before pool/CE)', async () => {
    process.env.CE_WORKERS = '4';
    process.env.CE_PARALLEL_MIN = '1';
    const { rerankPairs, ceWorkerStats } = await importMocked();
    expect(await rerankPairs('q', [])).toEqual([]);
    expect(await rerankPairs('q', null)).toEqual([]);
    const stats = ceWorkerStats();
    expect(stats.poolSize).toBe(0);       // no worker was ever spawned
    expect(stats.parallelCalls + stats.inlineCalls).toBe(0); // no scoring happened at all
  });

  it('(d) CE_FORCE_WORKER_FAIL=1: worker construction throws, scores still come from the inline path', async () => {
    process.env.CE_WORKERS = '4';
    process.env.CE_PARALLEL_MIN = '1';
    process.env.CE_FORCE_WORKER_FAIL = '1';
    const { rerankPairs, ceWorkerStats } = await importMocked();
    // 20 docs > CE_BATCH_SIZE=16, so the parallel path is eligible and the spawn is attempted.
    const docs = Array.from({ length: 20 }, (_, i) => ({ path: `p${i}`, fullText: String(i) }));
    const r = await rerankPairs('q', docs);
    // Inline (mocked) scoring sorts by the numeric passage text, desc — 19..0. If the forced spawn
    // failure crashed instead of falling back, we'd never get here; if real workers had somehow
    // spawned, they'd have loaded the real model and produced entirely different scores.
    expect(r.map((d) => d.ceScore)).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
    const stats = ceWorkerStats();
    expect(stats.poolBroken).toBe(true);
    expect(stats.parallelCalls).toBe(0);
    expect(stats.inlineCalls).toBe(1);
    // A broken pool pins the process to the inline path — the second call must not retry spawning
    // (CE_FORCE_WORKER_FAIL would make a retry throw again; more importantly, no respawn loops).
    const r2 = await rerankPairs('q', docs.slice(0, 17));
    expect(r2[0].ceScore).toBe(16);
    expect(ceWorkerStats().inlineCalls).toBe(2);
  });

  it('(e) DEFAULT (CE_WORKERS unset) behaves as CE_WORKERS=0 — the 2026-07-10 quiet-machine benchmark flip (commit 9107fde)', async () => {
    delete process.env.CE_WORKERS;
    process.env.CE_PARALLEL_MIN = '1';
    const { rerankPairs, ceWorkerStats } = await importMocked();
    // 40 docs clears both CE_BATCH_SIZE (16) and CE_PARALLEL_MIN (1) -- if ceWorkerCount() still
    // computed a cores-based default instead of the new hardcoded 0, the pool WOULD engage here.
    const docs = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}`, fullText: String(i) }));
    const r = await rerankPairs('q', docs);
    expect(r.map((d) => d.ceScore)).toEqual(Array.from({ length: 40 }, (_, i) => 39 - i));
    const stats = ceWorkerStats();
    expect(stats.poolSize).toBe(0);
    expect(stats.parallelCalls).toBe(0);
    expect(stats.inlineCalls).toBe(1);
  });
});

describe('parallel vs inline determinism — real cross-encoder (skips loudly when the model cannot load offline)', () => {
  const QUERY = 'how does the cross-encoder rerank pooled candidates?';
  const byPath = (r) => Object.fromEntries(r.map((d) => [d.path, d.ceScore]));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function waitGone(pids) {
    const deadline = Date.now() + 5000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pids.filter(alive)).toEqual([]);
  }

  itReal('a killed child cannot kill its caller or masquerade as successful parallel work', async () => {
    process.env.KB_MODEL_CACHE = MODEL_CACHE; process.env.CE_PARALLEL_MIN = '1'; process.env.CE_WORKERS = '4';
    const mod = await importReal();
    let pids = [];
    try {
      const docs = Array.from({ length: 24 }, (_, i) => ({ path: `d${i}`, fullText: `Retrieval passage ${i}.` }));
      const first = await mod.rerankPairs(QUERY, docs);
      pids = mod.ceWorkerStats().childPids;
      process.kill(pids[0], 'SIGKILL');
      await waitGone([pids[0]]);
      const next = await mod.rerankPairs(QUERY, docs);
      expect(byPath(next)).toEqual(byPath(first));
      expect(mod.ceWorkerStats()).toMatchObject({ parallelCalls: 1, inlineCalls: 1, poolBroken: true });
    } finally { await mod.ceWorkerShutdown(); await waitGone(pids); }
  }, REAL_TIMEOUT);

  itReal('parent death disconnects and reaps the real warm child pool', async () => {
    const parent = fork(path.join(REPO, 'tests/fixtures/ce-pool-parent.mjs'), [], {
      execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, KB_MODEL_CACHE: MODEL_CACHE, CE_WORKERS: '4', CE_PARALLEL_MIN: '1' },
    });
    let pids = [];
    try {
      const stats = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('parent fixture readiness timeout')), 10000);
        parent.once('message', (m) => { clearTimeout(timer); resolve(m); });
        parent.once('error', (e) => { clearTimeout(timer); reject(e); });
        parent.once('exit', () => { clearTimeout(timer); reject(new Error('parent exited before readiness')); });
      });
      expect(stats).toMatchObject({ parallelCalls: 1, childResponses: 2, poolBroken: false });
      pids = stats.childPids; expect(pids).toHaveLength(4); expect(pids.every(alive)).toBe(true);
      const exited = new Promise((resolve) => parent.once('exit', resolve));
      parent.kill('SIGKILL'); await exited;
      await waitGone(pids);
    } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); }
  }, REAL_TIMEOUT);

  itReal('(a) CE_WORKERS=0 and CE_WORKERS=4 produce identical ceScore arrays on a 24-doc fixture', async () => {
    process.env.KB_MODEL_CACHE = MODEL_CACHE;
    process.env.CE_PARALLEL_MIN = '1'; // the 24-doc fixture is below the production default of 33
    const { rerankPairs, ceWorkerStats, ceWorkerShutdown } = await importReal();
    let children = [];
    try {
      // 24 docs = 2 CE_BATCH_SIZE chunks -> 2 contiguous shards; short synthetic passages.
      const docs = Array.from({ length: 24 }, (_, i) => ({
        path: `d${i}`,
        fullText: `RVF stores HNSW vectors in one binary file; witness chains give verifiable history. `
          + `Variant ${i} covers ${i % 2 ? 'cross-encoder reranking' : 'vector retrieval'} in repo ${i % 5}.`,
      }));
      process.env.CE_WORKERS = '0';
      const inline = await rerankPairs(QUERY, docs);
      process.env.CE_WORKERS = '4';
      const parallel = await rerankPairs(QUERY, docs);
      // Prove the worker path REALLY ran (a silent inline fallback would make this test a no-op).
      expect(ceWorkerStats()).toMatchObject({ parallelCalls: 1, inlineCalls: 1, poolBroken: false });
      children = ceWorkerStats().childPids;
      expect(children).toHaveLength(4);
      expect(children.every((pid) => Number.isInteger(pid) && pid !== process.pid)).toBe(true);
      expect(ceWorkerStats().childResponses).toBe(2);
      // Chunk-aligned contiguous sharding => identical ONNX batches => identical scores.
      expect(byPath(parallel)).toEqual(byPath(inline));
      expect(parallel.map((d) => d.path)).toEqual(inline.map((d) => d.path));
      expect(inline.every((d) => Number.isFinite(d.ceScore))).toBe(true);
      const again = await rerankPairs(QUERY, docs);
      expect(byPath(again)).toEqual(byPath(inline));
      expect(ceWorkerStats().childPids).toEqual(children);
      expect(ceWorkerStats().childResponses).toBe(4);
      const concurrent = await Promise.all([rerankPairs(QUERY, docs), rerankPairs(QUERY, docs)]);
      for (const result of concurrent) expect(byPath(result)).toEqual(byPath(inline));
      expect(ceWorkerStats().childResponses).toBe(8);
      expect(ceWorkerStats().childPids).toEqual(children);
    } finally {
      await ceWorkerShutdown();
      for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
    }
  }, REAL_TIMEOUT);

  itReal('(c) a doc whose text cannot be scored degrades to -Infinity ALONE, in BOTH paths', async () => {
    process.env.KB_MODEL_CACHE = MODEL_CACHE;
    process.env.CE_PARALLEL_MIN = '1';
    const { rerankPairs, ceWorkerStats, ceWorkerShutdown } = await importReal();
    try {
      // NOTE on "no text": a doc with NO text fields at all maps to '' and the real model scores ''
      // with a finite (low) logit — that is pre-existing inline behavior, preserved. The -Infinity
      // degradation contract is about a passage the scorer CANNOT process; a non-string truthy
      // fullText throws inside the batch (.slice is not a function), which must poison ONLY that
      // item via the per-pair fallback — in the worker path exactly as in the inline path.
      const docs = Array.from({ length: 24 }, (_, i) => ({
        path: `d${i}`,
        fullText: i === 5 ? 12345 : `Passage ${i} about HNSW retrieval and witness chains.`,
      }));
      process.env.CE_WORKERS = '0';
      const inline = await rerankPairs(QUERY, docs);
      process.env.CE_WORKERS = '4';
      const parallel = await rerankPairs(QUERY, docs);
      expect(ceWorkerStats().parallelCalls).toBe(1);
      for (const r of [inline, parallel]) {
        const scores = byPath(r);
        expect(scores.d5).toBe(-Infinity);                       // the bad doc, isolated
        expect(r.at(-1).path).toBe('d5');                        // ...and sorted to the bottom
        const rest = r.filter((d) => d.path !== 'd5');
        expect(rest.every((d) => Number.isFinite(d.ceScore))).toBe(true); // nobody else was poisoned
      }
      expect(byPath(parallel)).toEqual(byPath(inline));
    } finally {
      await ceWorkerShutdown();
    }
  }, REAL_TIMEOUT);
});
