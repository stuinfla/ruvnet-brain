#!/usr/bin/env node
// forge-big.mjs — build the canonical computer-class 768-dim RVF from existing passages.
//
//   canonical: Xenova/bge-base-en-v1.5 · 768-dim · Mac/PC
//
// bge-base-en-v1.5 is ASYMMETRIC: PASSAGES embedded with NO prefix (here); QUERIES get an
// instruction prefix at query time (forge-ask reads it from <name>.big.rvf.embed.json). Pool = CLS.
//
// MODES (embedding is the slow part — SHARD it across processes, then ingest once):
//   node forge-big.mjs embed  --dir <d> --name <n> --shard <i> --of <n>   # write one vec shard
//   node forge-big.mjs ingest --dir <d> --name <n>                        # assemble .big.rvf from shards
//   node forge-big.mjs both   --dir <d> --name <n>                        # single-process (slow)
//   node forge-big.mjs --smoke --dir <d> --name <n>                       # model sanity check
//
// Sharding: run N `embed` processes in parallel (shard 0..N-1), each writes one atomic
// <name>.big.vecs.<i>-<N>.jsonl; then ONE `ingest` assembles them into <name>.big.rvf and writes
// the query-side embed.json. Canonical passages/meta keep their unsuffixed names and are not
// duplicated. Readers retain a fallback for legacy bundles. Shards are cleaned on success.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadRvf, loadTransformers, chooseModelCache } from './resolve-deps.mjs';
import { materializeModelRevision, modelCacheReady } from './model-requirements.mjs';
import { persistAndVerifyRvfIndex } from './rvf-index.mjs';
import { lowerBuildPriority } from './process-priority.mjs';

// BGE embedding can saturate a core for several minutes. Keep interactive lifecycle hooks
// responsive while this maintenance job runs; unsupported/denied reprioritization is non-fatal.
const BUILD_PRIORITY = lowerBuildPriority();
console.log(`[big] process priority: ${BUILD_PRIORITY.applied ? 'below-normal' : `unchanged (${BUILD_PRIORITY.error})`}`);

const MODEL = 'Xenova/bge-base-en-v1.5';
// MODEL-WEIGHT PIN: address the embedder by an exact HuggingFace commit SHA, not the floating `main`
// branch, so a rebuild always produces the SAME 768-dim vectors as the shipped corpus (verified live
// against the HF Hub API; main HEAD unchanged since 2025-07-29). Offline-first is preserved — a
// locally-cached model is resolved via env.localModelPath regardless of revision, so this never
// forces a re-download of an already-cached model, only makes the first fetch deterministic.
const MODEL_REVISION = '4d6cd88e18e51a5e020c2c305726d76ada9c03cf';
const DIM = 768;
const POOLING = 'cls';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const argv = process.argv.slice(2);
const MODE = argv[0];
const DIR = arg('--dir');
const NAME = arg('--name');
const SMOKE = argv.includes('--smoke');
if (!DIR || !NAME) { console.error('Usage: forge-big.mjs <embed|ingest|both|--smoke> --dir <d> --name <n> [--shard i --of n]'); process.exit(2); }

const passagesFile = path.join(DIR, `${NAME}.passages.jsonl`);
const vecShardPath = (i, n) => path.join(DIR, `${NAME}.big.vecs.${i}-${n}.jsonl`);

const { mod: rvfMod } = loadRvf();
const { RvfDatabase } = rvfMod;

// ---- embedder (bge needs remote download on first run; allow it explicitly) ----
let _fe = null;
async function getEmbedder() {
  if (_fe) return _fe;
  const { T, via } = await loadTransformers();
  const cache = chooseModelCache();
  materializeModelRevision(cache, MODEL, MODEL_REVISION);
  T.env.localModelPath = cache;
  T.env.cacheDir = cache;
  T.env.allowRemoteModels = !modelCacheReady(cache, MODEL);
  console.log(`[big] transformers via ${via} | model ${MODEL}@${MODEL_REVISION} | cache ${cache} (${T.env.allowRemoteModels ? 'will download' : 'local'})`);
  _fe = await T.pipeline('feature-extraction', MODEL, { quantized: true, revision: MODEL_REVISION });
  materializeModelRevision(cache, MODEL, MODEL_REVISION);
  return _fe;
}
async function embedTexts(texts) {
  const fe = await getEmbedder();
  return fe(texts, { pooling: POOLING, normalize: true }); // { data, dims:[n,DIM] }
}
function readPassages(file, limit = 0) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { const s = line.trim(); if (!s) return; try { rows.push(JSON.parse(s)); } catch { /* skip */ } if (limit && rows.length >= limit) rl.close(); });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
  });
}
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

// ---------- MODE: embed one shard ----------
async function embedShard(shardIdx, nShards) {
  const rows = await readPassages(passagesFile);
  const mine = rows.filter((_, i) => i % nShards === shardIdx);
  const outFile = vecShardPath(shardIdx, nShards);
  console.log(`[embed ${shardIdx}/${nShards}] ${mine.length} of ${rows.length} passages -> ${path.basename(outFile)}`);
  const fd = fs.openSync(outFile + '.tmp', 'w');
  const BATCH = 32; const t0 = Date.now(); let done = 0;
  for (let i = 0; i < mine.length; i += BATCH) {
    const batch = mine.slice(i, i + BATCH);
    const out = await embedTexts(batch.map((r) => r.text));
    const dim = out.dims[1];
    if (dim !== DIM) throw new Error(`embed dim ${dim} != ${DIM}`);
    for (let j = 0; j < batch.length; j++) {
      const v = Array.from(out.data.slice(j * dim, (j + 1) * dim));
      fs.writeSync(fd, JSON.stringify({ id: batch[j].id, v }) + '\n');
    }
    done += batch.length;
    if ((i / BATCH) % 20 === 0) console.log(`[embed ${shardIdx}/${nShards}] ${done}/${mine.length} (${(done / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`);
  }
  fs.closeSync(fd);
  fs.renameSync(outFile + '.tmp', outFile); // atomic: file appears only when complete
  console.log(`[embed ${shardIdx}/${nShards}] DONE ${done} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ---------- MODE: ingest all shards into one .big.rvf ----------
async function ingestStore() {
  const totalPassages = (await readPassages(passagesFile)).length;
  const shardFiles = fs.readdirSync(DIR)
    .filter((f) => f.startsWith(`${NAME}.big.vecs.`) && f.endsWith('.jsonl'))
    .map((f) => path.join(DIR, f));
  if (!shardFiles.length) throw new Error(`no vec shards for ${NAME} — run embed mode first`);
  console.log(`[ingest] ${shardFiles.length} shard file(s)`);

  const OUT_RVF = path.join(DIR, `${NAME}.big.rvf`);
  for (const f of [OUT_RVF, OUT_RVF + '.idmap.json']) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = await RvfDatabase.create(OUT_RVF, { dimensions: DIM, metric: 'cosine' });

  const seen = new Set(); let accepted = 0, rejected = 0, dupes = 0;
  for (const sf of shardFiles) {
    const rows = await readPassages(sf); // {id, v}
    const BATCH = 256;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).filter((r) => { if (seen.has(r.id)) { dupes++; return false; } seen.add(r.id); return true; });
      if (!batch.length) continue;
      const res = await db.ingestBatch(batch.map((r) => ({ id: r.id, vector: r.v })));
      accepted += res.accepted; rejected += res.rejected;
    }
  }
  const status = await db.status();
  const indexProof = await persistAndVerifyRvfIndex({
    db,
    dimensions: DIM,
    rvfPath: OUT_RVF,
    RvfDatabase,
  });
  console.log('[ingest] index:', JSON.stringify(indexProof));

  // query-side embedder config (how forge-ask embeds a query for THIS .rvf — asymmetric bge)
  fs.writeFileSync(OUT_RVF + '.embed.json', JSON.stringify({
    model: MODEL, revision: MODEL_REVISION, dimensions: DIM, metric: 'cosine', pooling: POOLING, normalize: true,
    queryPrefix: QUERY_PREFIX,
    note: 'Big (Mac/PC) variant. Passages embedded with NO prefix; queries use queryPrefix (asymmetric).',
    builtFrom: path.basename(passagesFile), generated: new Date().toISOString(),
  }, null, 2) + '\n');

  const ok = status.totalVectors === totalPassages && accepted === totalPassages;
  console.log(`[ingest] vectors=${status.totalVectors} passages=${totalPassages} accepted=${accepted} rejected=${rejected} dupes=${dupes} MATCH=${ok}`);
  if (!ok) { console.error('[ingest] RECONCILE FAILED — vectors != passages. NOT cleaning shards.'); process.exit(1); }
  for (const sf of shardFiles) fs.unlinkSync(sf); // clean shards only on success
  console.log(`[ingest] OK — wrote ${NAME}.big.rvf (+embed.json); canonical passages/meta retained; shards cleaned. Run forge-guard --variant big next.`);
}

async function smoke() {
  console.log('=== SMOKE ===');
  const rows = await readPassages(passagesFile, 3);
  if (!rows.length) { console.error('no passages — run forge-build.mjs first'); process.exit(1); }
  const out = await embedTexts(rows.map((r) => r.text));
  console.log('passage dim:', out.dims[1], '(expected', DIM + ')');
  if (out.dims[1] !== DIM) process.exit(1);
  const fe = await getEmbedder();
  const q = await fe([QUERY_PREFIX + `about ${rows[0].path}`], { pooling: POOLING, normalize: true });
  console.log('cosine(query, passage0) =', cosine(Array.from(q.data), Array.from(out.data.slice(0, DIM))).toFixed(4), '(should be > the other two)');
  process.exit(0);
}

if (SMOKE) { await smoke(); }
else if (MODE === 'embed') { await embedShard(parseInt(arg('--shard', '0'), 10), parseInt(arg('--of', '1'), 10)); }
else if (MODE === 'ingest') { await ingestStore(); }
else if (MODE === 'both') { await embedShard(0, 1); await ingestStore(); }
else { console.error('usage: forge-big.mjs <embed|ingest|both|--smoke> --dir <d> --name <n> [--shard i --of n]'); process.exit(2); }
