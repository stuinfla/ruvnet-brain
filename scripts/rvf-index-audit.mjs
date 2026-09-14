#!/usr/bin/env node
// rvf-index-audit.mjs — the C2 ("stores them correctly") gate for shipped RVF stores.
//
// Two layers:
//   1. Legacy presence audit (inspectRvfIndex / auditRvfIndexes / repairRvfIndex): does an eligible
//      store carry an INDEX_SEG at all. Kept verbatim for build-bundle.mjs and ci.yml, but segment
//      presence proves no recall figure — rUv's rvf-index has three progressive layers (~0.70 / ~0.85 /
//      >=0.95 recall; ruvector/crates/rvf/rvf-index/src/lib.rs:5-7) and `segments()` reports segType only.
//   2. Deep store audit (auditCorpusStores): reopen each persisted store read-only, execute the SDK's
//      k-NN query against sampled STORED vectors, compare with exact neighbours brute-forced over the
//      store's own VEC_SEG bytes (scripts/rvf-wire.mjs), verify every segment's content hash, and prove
//      id-map <-> vector <-> passage <-> source-mapping correspondence. Stores under the engine's HNSW
//      threshold are reported as 'PASS-SMALL-STORE' — never folded into 'PASS'.
//
// Installed engine facts this gate relies on (all verified 2026-09-13 against the installed
// @ruvector/rvf 0.3.4 / @ruvector/rvf-node 0.2.3 and rUv's rvf-runtime source):
//   - openReadonly / query(vec, k, {efSearch}) / status() / segments(): @ruvector/rvf dist/database.d.ts:37,91,99,133;
//     dist/types.d.ts:106-113 (efSearch), :163-180 (status shape), :216-225 (segments shape — no layer/tier field).
//   - @ruvector/rvf-node index.d.ts:263 indexStats(), :280 metric() exist on the NATIVE class only; the SDK class
//     does not re-export them (dist/database.d.ts has neither). Neither class reads a vector back by id.
//   - Routing: stores with < INDEX_MIN_VECTORS (1024) vectors, or > INDEX_MAX_DELETED_FRACTION (0.25) soft-deleted,
//     or filtered queries are served by the exact scan; otherwise by HNSW (store.rs:415-478, :566-579;
//     index_path.rs:37,41). ef_search is floored at INDEX_MIN_EF_SEARCH = 256 (index_path.rs:48; store.rs:793-797),
//     so the SDK's efSearch knob cannot push recall below the engine's own >= 0.95 contract.
//   - A missing/corrupt INDEX_SEG is silently rebuilt in memory on the first query (store.rs:761-780), so recall
//     alone cannot detect a damaged persisted index — the content-hash check in rvf-wire.mjs can.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadRvf, closeReadonlyRvf, loadTransformers, chooseModelCache } from '../kb/resolve-deps.mjs';
import { materializeModelRevision, modelCacheReady } from '../kb/model-requirements.mjs';
import { persistAndVerifyRvfIndex } from '../kb/rvf-index.mjs';
import {
  readRvfGenerations,
  sha256File,
  writeRvfGeneration,
} from './rvf-generation.mjs';
import { metricFromId, readRvfStoredVectors } from './rvf-wire.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RVF_HNSW_THRESHOLD = 1024;
export const RVF_RECALL_THRESHOLD = 0.95;
export const RVF_RECALL_K = 10;
export const RVF_RECALL_SAMPLE = 50;
export const RVF_PROBE_SAMPLE = 5;
export const RVF_PROBE_MIN_COSINE = 0.98;
const MAX_LISTED_FAILURES = 20;

export function isPassingState(state) {
  return state === 'PASS' || state === 'PASS-SMALL-STORE';
}

function dimensionsFor(rvfPath) {
  const embedPath = `${rvfPath}.embed.json`;
  const config = JSON.parse(fs.readFileSync(embedPath, 'utf8'));
  const dimensions = Number(config.dimensions);
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error(`invalid dimensions in ${embedPath}`);
  }
  return dimensions;
}

export async function inspectRvfIndex(rvfPath, RvfDatabase) {
  const db = await RvfDatabase.openReadonly(rvfPath);
  try {
    const [status, segments] = await Promise.all([db.status(), db.segments()]);
    const hasIndex = segments.some(({ segType }) => segType === 'index');
    return {
      path: rvfPath,
      totalVectors: status.totalVectors,
      indexRequired: status.totalVectors >= RVF_HNSW_THRESHOLD,
      hasIndex,
      state: status.totalVectors >= RVF_HNSW_THRESHOLD && !hasIndex ? 'FAIL' : 'PASS',
    };
  } finally {
    await closeReadonlyRvf(db);
  }
}

export async function auditRvfIndexes(rvfPaths) {
  const { mod: { RvfDatabase } } = loadRvf();
  return Promise.all(rvfPaths.map((rvfPath) => inspectRvfIndex(rvfPath, RvfDatabase)));
}

export async function repairRvfIndex(rvfPath, RvfDatabase) {
  const before = await inspectRvfIndex(rvfPath, RvfDatabase);
  if (before.state === 'PASS') return { ...before, repaired: false, elapsedMs: 0 };

  const started = Date.now();
  const db = await RvfDatabase.open(rvfPath);
  const proof = await persistAndVerifyRvfIndex({
    db,
    dimensions: dimensionsFor(rvfPath),
    rvfPath,
    RvfDatabase,
  });
  return {
    ...before,
    hasIndex: proof.hasIndex,
    state: proof.hasIndex ? 'PASS' : 'FAIL',
    repaired: proof.hasIndex,
    elapsedMs: Date.now() - started,
  };
}

export function restampChangedRvfGenerations(kbDir, results) {
  const ledger = readRvfGenerations(kbDir);
  let stamped = 0;
  for (const result of results) {
    if (!isPassingState(result.state) || !result.path.endsWith('.big.rvf')) continue;
    const store = path.basename(result.path, '.big.rvf');
    const prior = ledger.stores?.[store];
    if (!prior || prior.sha256 === sha256File(result.path)) continue;
    const embed = JSON.parse(fs.readFileSync(`${result.path}.embed.json`, 'utf8'));
    writeRvfGeneration({
      dir: kbDir,
      store,
      rvfFile: path.basename(result.path),
      model: prior.model || embed.model || null,
      dimensions: prior.dimensions || Number(embed.dimensions),
      sourceCommit: prior.sourceCommit ?? null,
    });
    stamped++;
  }
  return stamped;
}

// ---------------------------------------------------------------------------------------------
// Deep store audit
// ---------------------------------------------------------------------------------------------

const storeBase = (rvfPath) => rvfPath.replace(/\.big\.rvf$/, '').replace(/\.rvf$/, '');
const storeName = (rvfPath) => path.basename(storeBase(rvfPath));

/** Resolve the native @ruvector/rvf-node binding the SDK itself uses (for metric()/indexStats()). */
export function loadRvfNative() {
  try {
    const kbRequire = createRequire(new URL('../kb/package.json', import.meta.url));
    const sdkMain = kbRequire.resolve('@ruvector/rvf');
    const sdkRequire = createRequire(sdkMain);
    const nativeMain = sdkRequire.resolve('@ruvector/rvf-node');
    const version = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return {
      native: sdkRequire('@ruvector/rvf-node'),
      versions: {
        '@ruvector/rvf': version(path.join(path.dirname(sdkMain), '..', 'package.json')),
        '@ruvector/rvf-node': version(path.join(path.dirname(nativeMain), 'package.json')),
      },
    };
  } catch (error) {
    return { native: null, versions: null, error: error.message };
  }
}

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The SDK's own string-id <-> numeric-label sidecar (`<store>.big.rvf.idmap.json`, written by
 * @ruvector/rvf dist/backend.js:491-512 and validated at :576-584). Read and validate it HERE, before
 * the SDK opens the store: a malformed sidecar makes the SDK quarantine (rename) it, which must never
 * happen inside an archive under verification.
 */
export function readRvfIdMap(rvfPath) {
  const file = `${rvfPath}.idmap.json`;
  const failures = [];
  const idToLabel = new Map();
  const labelToId = new Map();
  if (!fs.existsSync(file)) return { file, idToLabel, labelToId, nextLabel: null, failures: [{ kind: 'idmap-missing', detail: path.basename(file) }] };
  const raw = readJsonOrNull(file);
  if (!raw || typeof raw.idToLabel !== 'object' || Array.isArray(raw.idToLabel) || !raw.idToLabel
    || typeof raw.labelToId !== 'object' || Array.isArray(raw.labelToId) || !raw.labelToId
    || !Number.isSafeInteger(raw.nextLabel) || raw.nextLabel < 1) {
    return { file, idToLabel, labelToId, nextLabel: null, failures: [{ kind: 'idmap-malformed', detail: 'expected { idToLabel, labelToId, nextLabel >= 1 }' }] };
  }
  for (const [id, label] of Object.entries(raw.idToLabel)) {
    if (!Number.isSafeInteger(label) || label < 1 || label >= raw.nextLabel) failures.push({ kind: 'idmap-label-out-of-range', id, detail: String(label) });
    idToLabel.set(id, label);
  }
  for (const [labelText, id] of Object.entries(raw.labelToId)) labelToId.set(Number(labelText), id);
  let inconsistent = 0;
  for (const [id, label] of idToLabel) if (labelToId.get(label) !== id) inconsistent++;
  for (const [label, id] of labelToId) if (idToLabel.get(id) !== label) inconsistent++;
  if (inconsistent) failures.push({ kind: 'idmap-not-bijective', detail: `${inconsistent} id/label pairs disagree between idToLabel and labelToId` });
  return { file, idToLabel, labelToId, nextLabel: raw.nextLabel, failures };
}

export function checkPrivateExclusion({ dir, privateStores = null, rvfFiles = null }) {
  let fence = privateStores;
  if (!fence) {
    const file = path.join(dir, 'PRIVATE-STORES.json');
    const raw = readJsonOrNull(file);
    if (!raw || !Array.isArray(raw.privateStores)) throw new Error(`private-store fence missing or malformed (${file}); refusing to audit without one`);
    fence = raw.privateStores;
  }
  const folded = new Set([...fence].map((name) => String(name).toLowerCase()));
  const files = rvfFiles || fs.readdirSync(dir).filter((name) => name.endsWith('.big.rvf'));
  const leaks = files.map((file) => path.basename(file).replace(/\.big\.rvf$/, ''))
    .filter((name) => folded.has(name.toLowerCase())).sort();
  return { state: leaks.length ? 'FAIL' : 'PASS', fenceSize: folded.size, checked: files.length, leaks };
}

const SOURCE_PATH_OK = (value) => typeof value === 'string' && value.length > 0 && value.length < 4096
  && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && !value.split(/[#?]/)[0].split('/').some((segment) => segment === '..' || segment === '');

function capFailures(failures) {
  if (failures.length <= MAX_LISTED_FAILURES) return { failures, omittedFailures: 0 };
  return { failures: failures.slice(0, MAX_LISTED_FAILURES), omittedFailures: failures.length - MAX_LISTED_FAILURES };
}

/**
 * (a) id-map <-> stored vectors, (b) id -> passage row, (c) passage -> source mapping.
 * Source mapping follows the two shapes the corpus actually ships: repository stores bind each
 * passage's `path` in `<store>.meta.json#incremental.files[path].chunkIds` (kb/forge-corpus.mjs
 * incremental schema 2); aggregate stores (ruv-gists, concepts) bind `meta.entries[id].path`.
 * A store with neither is a source-map failure, not a pass.
 */
export function checkStoreCorrespondence({ rvfPath, stored, idmap, totalVectors }) {
  const failures = [];
  const base = storeBase(rvfPath);
  if (idmap.labelToId.size !== totalVectors) failures.push({ kind: 'idmap-count-mismatch', detail: `idmap has ${idmap.labelToId.size} labels, engine reports ${totalVectors} live vectors` });
  if (stored.vectors.size !== totalVectors) failures.push({ kind: 'vector-count-mismatch', detail: `${stored.vectors.size} live stored vectors (${stored.entries} entries, ${stored.deleted.size} deleted, ${stored.duplicateLabels} duplicate labels) vs engine ${totalVectors}` });
  for (const label of idmap.labelToId.keys()) if (!stored.vectors.has(label)) failures.push({ kind: 'idmap-label-without-vector', id: idmap.labelToId.get(label), detail: `label ${label}` });
  for (const label of stored.vectors.keys()) if (!idmap.labelToId.has(label)) failures.push({ kind: 'vector-without-idmap-label', detail: `label ${label}` });

  const passages = new Map();
  const passagesFile = `${base}.passages.jsonl`;
  if (!fs.existsSync(passagesFile)) failures.push({ kind: 'passages-missing', detail: path.basename(passagesFile) });
  else {
    const lines = fs.readFileSync(passagesFile, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch { failures.push({ kind: 'passage-malformed', detail: `line ${index + 1} is not JSON` }); return; }
      if (!row || typeof row.id !== 'string' || !row.id) { failures.push({ kind: 'passage-malformed', detail: `line ${index + 1} has no string id` }); return; }
      if (passages.has(row.id)) failures.push({ kind: 'passage-duplicate-id', id: row.id });
      passages.set(row.id, { path: row.path, text: typeof row.text === 'string' ? row.text : null, line: index + 1 });
    });
    for (const id of idmap.idToLabel.keys()) if (!passages.has(id)) failures.push({ kind: 'passage-missing', id, detail: 'vector id has no row in passages.jsonl' });
    for (const id of passages.keys()) if (!idmap.idToLabel.has(id)) failures.push({ kind: 'passage-orphan', id, detail: 'passage row has no stored vector' });
  }

  const meta = readJsonOrNull(`${base}.meta.json`);
  let metaFiles = null;
  if (!meta) failures.push({ kind: 'meta-missing', detail: path.basename(`${base}.meta.json`) });
  else if (meta.incremental && meta.incremental.files && typeof meta.incremental.files === 'object') {
    metaFiles = Object.keys(meta.incremental.files).length;
    const chunkOwner = new Map();
    for (const [filePath, entry] of Object.entries(meta.incremental.files)) {
      for (const id of entry?.chunkIds || []) chunkOwner.set(id, filePath);
    }
    for (const [id, row] of passages) {
      if (!SOURCE_PATH_OK(row.path)) { failures.push({ kind: 'source-path-malformed', id, path: row.path ?? null }); continue; }
      if (chunkOwner.get(id) !== row.path) failures.push({ kind: 'source-map-mismatch', id, path: row.path, detail: `meta.incremental.files binds this id to ${chunkOwner.has(id) ? JSON.stringify(chunkOwner.get(id)) : 'nothing'}` });
    }
    for (const [id, filePath] of chunkOwner) if (!passages.has(id)) failures.push({ kind: 'source-map-orphan-chunk', id, path: filePath, detail: 'meta chunkId has no passage row' });
  } else if (meta.entries && typeof meta.entries === 'object') {
    metaFiles = Object.keys(meta.entries).length;
    for (const [id, row] of passages) {
      if (!SOURCE_PATH_OK(row.path)) { failures.push({ kind: 'source-path-malformed', id, path: row.path ?? null }); continue; }
      const entry = meta.entries[id];
      if (!entry || entry.path !== row.path) failures.push({ kind: 'source-map-mismatch', id, path: row.path, detail: `meta.entries binds this id to ${entry ? JSON.stringify(entry.path) : 'nothing'}` });
    }
  } else failures.push({ kind: 'source-map-missing', detail: 'meta.json has neither incremental.files nor entries' });

  return {
    result: { state: failures.length ? 'FAIL' : 'PASS', counts: { idmapIds: idmap.idToLabel.size, storedVectors: stored.vectors.size, passages: passages.size, metaFiles }, ...capFailures(failures) },
    passages,
  };
}

// --- recall -----------------------------------------------------------------------------------

function seededRandom(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let s = h || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function sampleDistinct(items, count, random) {
  if (count >= items.length) return [...items];
  const picked = new Set();
  while (picked.size < count) picked.add(items[Math.floor(random() * items.length)]);
  return [...picked];
}

const DISTANCE = {
  l2: (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; },
  cosine: (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - d / (Math.sqrt(na * nb) || 1); },
  dotproduct: (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return -d; },
};

/** Exact top-k under `metric` with tie tolerance: every label whose distance ties the k-th best counts. */
function exactNeighbourLabels(query, vectors, k, metric) {
  const distance = DISTANCE[metric] || DISTANCE.l2;
  const scored = [];
  for (const [label, vector] of vectors) scored.push([distance(query, vector), label]);
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const kth = scored[Math.min(k, scored.length) - 1][0];
  const tolerance = 1e-6 * Math.max(1, Math.abs(kth));
  return new Set(scored.filter(([d]) => d <= kth + tolerance).map(([, label]) => label));
}

function norm(vector) { let s = 0; for (let i = 0; i < vector.length; i++) s += vector[i] * vector[i]; return Math.sqrt(s); }
function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null; }

async function openStore(rvfPath, RvfDatabase) {
  const db = await RvfDatabase.openReadonly(rvfPath);
  try {
    const [status, segments, dimension] = await Promise.all([db.status(), db.segments(), db.dimension()]);
    return { db, status, segments, dimension };
  } catch (error) {
    await closeReadonlyRvf(db).catch(() => {});
    throw error;
  }
}

/**
 * Reopen a persisted store read-only, run the SDK's k-NN query for a deterministic sample of its own
 * stored vectors, and compare with exact neighbours brute-forced over the store's VEC_SEG bytes.
 * recall@k = |approx ∩ exact| / min(k, liveVectors), averaged over the sample. Cost: O(sample × N × dim)
 * — for the corpus' largest store (ruvector, 29,872 × 768) 50 queries take ~2.5 s wall including parsing.
 */
export async function measureRecall({
  rvfPath, RvfDatabase, sampleSize = RVF_RECALL_SAMPLE, k = RVF_RECALL_K, efSearch = null, seed = 0,
  recallThreshold = RVF_RECALL_THRESHOLD, preloaded = null, native = undefined,
}) {
  if (!RvfDatabase) ({ mod: { RvfDatabase } } = loadRvf());
  const nativeBinding = native === undefined ? loadRvfNative().native : native;
  const idmap = preloaded?.idmap || readRvfIdMap(rvfPath);
  const failures = [...idmap.failures];
  const opened = preloaded?.db ? preloaded : await openStore(rvfPath, RvfDatabase);
  const ownsHandle = !preloaded?.db;
  try {
    const { db, status, segments, dimension } = opened;
    const stored = preloaded?.stored || readRvfStoredVectors(rvfPath, segments);
    failures.push(...stored.failures);
    const hasIndex = segments.some(({ segType }) => segType === 'index');
    const indexRequired = status.totalVectors >= RVF_HNSW_THRESHOLD;
    if (indexRequired && !hasIndex) failures.push({ kind: 'index-missing', detail: `${status.totalVectors} vectors >= ${RVF_HNSW_THRESHOLD} but no INDEX_SEG is persisted` });
    if (stored.dimension !== null && stored.dimension !== dimension) failures.push({ kind: 'dimension-mismatch', detail: `VEC_SEG dimension ${stored.dimension} != engine ${dimension}` });

    let engineMetric = stored.manifest ? stored.manifest.metric : null;
    let indexStats = null;
    if (nativeBinding) {
      const handle = nativeBinding.RvfDatabase.openReadonly(rvfPath);
      try {
        const reported = String(handle.metric()).replace('inner_product', 'dotproduct');
        indexStats = handle.indexStats();
        if (engineMetric && reported !== engineMetric) failures.push({ kind: 'engine-metric-disagreement', detail: `native metric() ${reported} vs manifest byte ${engineMetric}` });
        engineMetric = reported;
      } finally { handle.close(); }
    }
    if (!engineMetric) failures.push({ kind: 'metric-unknown', detail: 'neither the native binding nor the manifest reported a distance metric' });
    const embedConfig = readJsonOrNull(`${rvfPath}.embed.json`);
    const declaredMetric = embedConfig?.metric ?? null;
    const metricMismatch = Boolean(declaredMetric && engineMetric && declaredMetric !== engineMetric);

    const random = seededRandom(`${storeName(rvfPath)}:${seed}`);
    const labels = [...stored.vectors.keys()].sort((a, b) => a - b);
    const sample = sampleDistinct(labels, sampleSize, random);
    const kEffective = Math.min(k, stored.vectors.size);
    const latencies = [];
    let recallSum = 0;
    let minRecall = 1;
    let unmappedResultIds = 0;
    let maxNormDeviation = 0;
    if (!sample.length) failures.push({ kind: 'empty-store', detail: 'no live stored vectors to sample' });
    for (const label of sample) {
      const query = stored.vectors.get(label);
      if (metricMismatch) maxNormDeviation = Math.max(maxNormDeviation, Math.abs(norm(query) - 1));
      const started = process.hrtime.bigint();
      let results;
      try {
        results = efSearch === null ? await db.query(query, k) : await db.query(query, k, { efSearch });
      } catch (error) {
        failures.push({ kind: 'query-failed', id: idmap.labelToId.get(label) ?? null, detail: error.message });
        continue;
      }
      latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
      const exact = exactNeighbourLabels(query, stored.vectors, kEffective, engineMetric || 'l2');
      const hits = new Set();
      for (const { id } of results) {
        const resultLabel = idmap.idToLabel.get(String(id));
        if (resultLabel === undefined) { unmappedResultIds++; continue; }
        if (exact.has(resultLabel)) hits.add(resultLabel);
      }
      const recall = Math.min(1, hits.size / kEffective);
      recallSum += recall;
      minRecall = Math.min(minRecall, recall);
    }
    const queries = latencies.length;
    const recallAtK = queries ? recallSum / queries : null;
    if (unmappedResultIds) failures.push({ kind: 'query-id-unmapped', detail: `${unmappedResultIds} query result ids are not in the id map` });
    if (recallAtK !== null && recallAtK < recallThreshold) failures.push({ kind: 'recall-below-threshold', detail: `measured recall@${kEffective} ${recallAtK.toFixed(4)} < ${recallThreshold} over ${queries} persisted queries` });
    if (metricMismatch && maxNormDeviation > 1e-3) failures.push({ kind: 'metric-mismatch-unnormalized', detail: `engine ranks by ${engineMetric}, embed.json declares ${declaredMetric}, and sampled vectors deviate from unit norm by up to ${maxNormDeviation.toExponential(2)} — rankings are not equivalent` });
    latencies.sort((a, b) => a - b);
    const state = failures.length ? 'FAIL' : indexRequired ? 'PASS' : 'PASS-SMALL-STORE';
    return {
      path: rvfPath,
      store: storeName(rvfPath),
      state,
      totalVectors: status.totalVectors,
      storedVectors: stored.vectors.size,
      storedEntries: stored.entries,
      deletedVectors: stored.deleted.size,
      duplicateLabels: stored.duplicateLabels,
      dimension,
      indexRequired,
      hasIndex,
      segmentsHashVerified: stored.hashesVerified,
      segmentCount: stored.segmentCount,
      supersededSegments: stored.supersededSegments,
      engineMetric,
      declaredMetric,
      metricMismatch,
      unitNorm: metricMismatch ? { checked: sample.length, maxDeviation: maxNormDeviation } : null,
      indexStats,
      sampleSize: sample.length,
      queries,
      k,
      kEffective,
      efSearch: efSearch === null ? 'sdk-default' : efSearch,
      recallThreshold,
      recallAtK,
      minRecall: queries ? minRecall : null,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      ...capFailures(failures),
    };
  } finally {
    if (ownsHandle) await closeReadonlyRvf(opened.db);
  }
}

// --- passage -> vector spot check ---------------------------------------------------------------

/**
 * Build the store's own embedder from `<store>.big.rvf.embed.json` exactly the way kb/forge-big.mjs:80-96
 * builds it (pinned model + revision, pooling, normalize, quantized, passages embedded WITHOUT the query
 * prefix), so a re-embedded passage is comparable to the stored vector.
 */
export async function createPassageEmbedder(embedConfig) {
  if (!embedConfig?.model) throw new Error('embed.json has no model');
  const { T } = await loadTransformers();
  const cache = chooseModelCache();
  if (embedConfig.revision) materializeModelRevision(cache, embedConfig.model, embedConfig.revision);
  T.env.localModelPath = cache;
  T.env.cacheDir = cache;
  T.env.allowRemoteModels = !modelCacheReady(cache, embedConfig.model);
  const pipe = await T.pipeline('feature-extraction', embedConfig.model, { quantized: true, ...(embedConfig.revision ? { revision: embedConfig.revision } : {}) });
  const pooling = embedConfig.pooling || 'mean';
  const normalize = embedConfig.normalize !== false;
  return async (texts) => {
    const out = await pipe(texts, { pooling, normalize });
    const dim = out.dims[1];
    return texts.map((_, i) => Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
  };
}

/**
 * A CONSISTENT id-map swap (idToLabel and labelToId swapped together) is invisible to label-level
 * recall, so vector<->passage correspondence is proven by re-embedding a few sampled passages and
 * comparing them with the vector stored under their id. Without an embedder the probe reports
 * NOT-RUN — visibly, never as a pass.
 */
export async function probePassageEmbeddings({
  rvfPath, stored, idmap, passages, embedder, sampleSize = RVF_PROBE_SAMPLE, minCosine = RVF_PROBE_MIN_COSINE, seed = 0,
}) {
  if (!embedder) return { state: 'NOT-RUN', reason: 'no embedder (pass embedder or set RUVNET_BRAIN_RVF_AUDIT_EMBED=1 to load the store\'s pinned model)', failures: [] };
  const candidates = [...idmap.idToLabel.keys()].filter((id) => passages.get(id)?.text && stored.vectors.has(idmap.idToLabel.get(id))).sort();
  const sample = sampleDistinct(candidates, sampleSize, seededRandom(`${storeName(rvfPath)}:probe:${seed}`));
  if (!sample.length) return { state: 'FAIL', failures: [{ kind: 'probe-no-candidates', detail: 'no passage with text maps to a stored vector' }] };
  const embedded = await embedder(sample.map((id) => passages.get(id).text));
  const results = [];
  const failures = [];
  sample.forEach((id, index) => {
    const storedVector = stored.vectors.get(idmap.idToLabel.get(id));
    const cosine = 1 - DISTANCE.cosine(storedVector, embedded[index]);
    results.push({ id, cosine: Number(cosine.toFixed(6)) });
    if (!(cosine >= minCosine)) failures.push({ kind: 'vector-passage-mismatch', id, detail: `re-embedded passage vs stored vector cosine ${cosine.toFixed(4)} < ${minCosine}` });
  });
  return { state: failures.length ? 'FAIL' : 'PASS', sampleSize: sample.length, minCosine, results, failures };
}

// --- composite ------------------------------------------------------------------------------------

async function auditOneStore(rvfPath, { RvfDatabase, native, sampleSize, k, efSearch, seed, recallThreshold, embedderFor, probeSampleSize }) {
  const idmap = readRvfIdMap(rvfPath);
  if (idmap.failures.length) {
    return { path: rvfPath, store: storeName(rvfPath), state: 'FAIL', totalVectors: null, recall: null, correspondence: null, passageProbe: { state: 'NOT-RUN', reason: 'id map invalid', failures: [] }, ...capFailures(idmap.failures) };
  }
  const opened = await openStore(rvfPath, RvfDatabase);
  try {
    const stored = readRvfStoredVectors(rvfPath, opened.segments);
    const recall = await measureRecall({ rvfPath, RvfDatabase, sampleSize, k, efSearch, seed, recallThreshold, native, preloaded: { ...opened, stored, idmap } });
    const { result: correspondence, passages } = checkStoreCorrespondence({ rvfPath, stored, idmap, totalVectors: opened.status.totalVectors });
    const embedConfig = readJsonOrNull(`${rvfPath}.embed.json`);
    const embedder = embedderFor ? await embedderFor(embedConfig) : null;
    const passageProbe = await probePassageEmbeddings({ rvfPath, stored, idmap, passages, embedder, sampleSize: probeSampleSize, seed });
    const failures = [...recall.failures, ...correspondence.failures, ...passageProbe.failures];
    const { failures: recallFailures, omittedFailures: _omit, ...recallRest } = recall;
    return {
      path: rvfPath,
      store: recall.store,
      state: failures.length ? 'FAIL' : recall.indexRequired ? 'PASS' : 'PASS-SMALL-STORE',
      totalVectors: opened.status.totalVectors,
      recall: recallRest,
      correspondence,
      passageProbe,
      ...capFailures(failures),
    };
  } finally {
    await closeReadonlyRvf(opened.db);
  }
}

/**
 * Deep-audit every `.big.rvf` under `dir` (or the supplied paths). Returns the full measured result —
 * this object (not the corpus receipt) is where per-store recall, engine state and correspondence live.
 * `privateStores` may be a Set/array of fenced names; otherwise `<dir>/PRIVATE-STORES.json` is required.
 */
export async function auditCorpusStores({
  dir, rvfPaths = null, privateStores = null, RvfDatabase = null, sampleSize = RVF_RECALL_SAMPLE, k = RVF_RECALL_K,
  efSearch = null, seed = 0, recallThreshold = RVF_RECALL_THRESHOLD, embedder = undefined, probeSampleSize = RVF_PROBE_SAMPLE,
} = {}) {
  if (!dir) throw new TypeError('dir is required');
  if (!RvfDatabase) ({ mod: { RvfDatabase } } = loadRvf());
  const { native, versions } = loadRvfNative();
  const paths = (rvfPaths || fs.readdirSync(dir).filter((name) => name.endsWith('.big.rvf')).map((name) => path.join(dir, name))).slice().sort();
  const privateExclusion = checkPrivateExclusion({ dir, privateStores, rvfFiles: paths.map((file) => path.basename(file)) });

  let embedderFor = null;
  if (embedder) embedderFor = async () => embedder;
  else if (embedder === undefined && process.env.RUVNET_BRAIN_RVF_AUDIT_EMBED === '1') {
    const cache = new Map();
    embedderFor = async (config) => {
      if (!config?.model) return null;
      const key = JSON.stringify([config.model, config.revision ?? null, config.pooling ?? null, config.normalize ?? null]);
      if (!cache.has(key)) cache.set(key, createPassageEmbedder(config));
      return cache.get(key);
    };
  }

  const stores = [];
  for (const rvfPath of paths) {
    try {
      stores.push(await auditOneStore(rvfPath, { RvfDatabase, native, sampleSize, k, efSearch, seed, recallThreshold, embedderFor, probeSampleSize }));
    } catch (error) {
      // rvf-runtime verifies each segment's content hash when it loads it, so tampered VEC/manifest
      // bytes surface here as an open/read failure ("Segment hash verification failed ...
      // InvalidChecksum") rather than through this gate's own hash check. Classify it as the same
      // finding so the failure vocabulary means one thing regardless of which layer caught it.
      // (Index-segment damage is NOT caught by the engine — it rebuilds silently — which is why the
      // gate hashes segments itself as well; see the b2 case in tests/unit/rvf-store-audit.test.mjs.)
      const kind = /checksum|hash verification/i.test(error.message) ? 'segment-content-hash-mismatch' : 'audit-error';
      stores.push({ path: rvfPath, store: storeName(rvfPath), state: 'FAIL', totalVectors: null, recall: null, correspondence: null, passageProbe: null, failures: [{ kind, detail: error.message }], omittedFailures: 0 });
    }
  }
  const failing = stores.filter((row) => !isPassingState(row.state));
  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-rvf-audit',
    createdAt: new Date().toISOString(),
    dir,
    sdk: versions,
    contract: {
      hnswThreshold: RVF_HNSW_THRESHOLD,
      recallThreshold,
      k,
      sampleSize,
      efSearch: efSearch === null ? 'sdk-default' : efSearch,
      note: 'rvf-runtime floors ef_search at INDEX_MIN_EF_SEARCH=256 (index_path.rs:48; store.rs:793-797) and serves stores under 1024 vectors, or over 25% soft-deleted, by exact scan (store.rs:566-579); PASS-SMALL-STORE marks the exact-scan exception explicitly.',
    },
    state: failing.length || privateExclusion.leaks.length ? 'FAIL' : 'PASS',
    storeCount: stores.length,
    smallStoreExceptions: stores.filter((row) => row.state === 'PASS-SMALL-STORE').map((row) => row.store),
    privateExclusion,
    stores,
  };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const has = (flag) => process.argv.includes(flag);
  const value = (flag, fallback) => { const at = process.argv.indexOf(flag); return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback; };
  const repair = has('--repair');
  const deep = has('--deep');
  const concurrency = Math.max(1, Number(value('--concurrency', 3)));
  const names = has('--names') ? new Set(String(value('--names', '')).split(',').filter(Boolean)) : null;
  const kbDir = path.resolve(ROOT, value('--dir', 'kb'));
  const rvfPaths = fs.readdirSync(kbDir)
    .filter((name) => name.endsWith('.rvf') && (!names || names.has(name.replace(/\.rvf$/, ''))))
    .sort()
    .map((name) => path.join(kbDir, name));

  if (deep) {
    if (has('--embed')) process.env.RUVNET_BRAIN_RVF_AUDIT_EMBED = '1';
    const result = await auditCorpusStores({
      dir: kbDir,
      rvfPaths: rvfPaths.filter((file) => file.endsWith('.big.rvf')),
      sampleSize: Number(value('--sample', RVF_RECALL_SAMPLE)),
      k: Number(value('--k', RVF_RECALL_K)),
      efSearch: has('--ef') ? Number(value('--ef', 0)) : null,
    });
    for (const row of result.stores) {
      console.log(JSON.stringify({ store: row.store, state: row.state, vectors: row.totalVectors, recall: row.recall?.recallAtK, min: row.recall?.minRecall, p50Ms: row.recall?.p50Ms, hasIndex: row.recall?.hasIndex, metric: `${row.recall?.engineMetric}/${row.recall?.declaredMetric}`, probe: row.passageProbe?.state, failures: row.failures.map((f) => f.kind) }));
    }
    const out = value('--out', null);
    if (out) fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`SUMMARY deep state=${result.state} stores=${result.storeCount} pass=${result.stores.filter((r) => r.state === 'PASS').length} smallStore=${result.smallStoreExceptions.length} failed=${result.stores.filter((r) => r.state === 'FAIL').length} privateLeaks=${result.privateExclusion.leaks.length}${out ? ` out=${out}` : ''}`);
    if (result.state !== 'PASS') process.exitCode = 1;
    return;
  }

  const { mod: { RvfDatabase } } = loadRvf();
  const results = new Array(rvfPaths.length);
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, rvfPaths.length || 1) }, async () => {
    for (let index = next++; index < rvfPaths.length; index = next++) {
      const rvfPath = rvfPaths[index];
      try {
        results[index] = repair
          ? await repairRvfIndex(rvfPath, RvfDatabase)
          : await inspectRvfIndex(rvfPath, RvfDatabase);
      } catch (error) {
        results[index] = { path: rvfPath, state: 'FAIL', error: error.message };
      }
      const row = results[index];
      console.log(JSON.stringify({ ...row, path: path.relative(ROOT, row.path) }));
    }
  }));

  const failed = results.filter(({ state }) => !isPassingState(state));
  const repaired = results.filter(({ repaired }) => repaired).length;
  const stamped = repair && !failed.length
    ? restampChangedRvfGenerations(kbDir, results)
    : 0;
  console.log(`SUMMARY checked=${results.length} repaired=${repaired} stamped=${stamped} failed=${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
