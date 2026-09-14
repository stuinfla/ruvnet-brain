#!/usr/bin/env node
// forge-big.mjs — build the canonical computer-class 768-dim RVF from existing passages.
//
//   canonical: Xenova/bge-base-en-v1.5 · 768-dim · Mac/PC
//
// bge-base-en-v1.5 is ASYMMETRIC: PASSAGES embedded with NO prefix (here); QUERIES get an
// instruction prefix at query time (forge-ask reads it from <name>.big.rvf.embed.json). Pool = CLS.
//
// MODES (embedding is the slow part — SHARD it across processes, then ingest once):
//   node forge-big.mjs embed     --dir <d> --name <n> --shard <i> --of <n>   # write one vec shard
//   node forge-big.mjs shard-all --dir <d> --name <n> --shards <n> [--stall-minutes <m>] [--poll-seconds <s>]
//                                                                          # spawn+supervise all N shards
//   node forge-big.mjs ingest    --dir <d> --name <n>                       # assemble .big.rvf from shards
//   node forge-big.mjs both      --dir <d> --name <n>                       # single-process (slow)
//   node forge-big.mjs --smoke   --dir <d> --name <n>                       # model sanity check
//
// Sharding: run N `embed` processes in parallel (shard 0..N-1), each writes one atomic
// <name>.big.vecs.<i>-<N>.jsonl; then ONE `ingest` assembles them into <name>.big.rvf and writes
// the query-side embed.json. Canonical passages/meta keep their unsuffixed names and are not
// duplicated. Readers retain a fallback for legacy bundles. Shards are cleaned on success.
//
// PROGRESS + STALL DETECTION (2026-09-11, incident: an 8-shard gists embed sat at 0% CPU for six
// hours overnight with a `job-heartbeat.sh` receipt that still said "running" — a live wrapper pid
// proves the WRAPPER survived, it says nothing about whether the WORK inside it is still moving).
// `embed` now writes `<name>.big.progress.<shard>-<of>.json` — `{shard, of, completed, total,
// updatedAt}` — after every completed batch, tied to COMPLETED WORK rather than log/output activity
// (which can lag behind, or misleadingly survive, a real stall). `shard-all` is the supervising
// "parent embed process": it spawns all N `embed` children itself and polls their progress files;
// if any shard's `completed` count has not advanced within `--stall-minutes` (default 15), it logs
// which shard stalled, SIGTERMs (then SIGKILLs) every shard, and exits non-zero — refusing to let a
// hung shard silently hold the corpus rebuild open. `scripts/nightly-watchdog.mjs` can also read the
// same progress files directly (see its `readJobProgress`) to report STALLED for a job whose
// heartbeat still says "running" but whose declared `progressGlob` has gone stale.
//
// ── ID-LEVEL INGEST RECONCILIATION (2026-09-14, incident: ruv-gists shipped 3,055 passages and
// 3,054 vectors for six weeks) ───────────────────────────────────────────────────────────────────
// Passage id 2740 ("Jailbreak any LLM using MathPrompt") was present in ruv-gists.passages.jsonl
// and in the store's meta, had NO vector, and was therefore permanently unretrievable: measured
// against the installed brain, idToLabel held 3,054 entries while nextLabel stood at 3,055 — the
// label was allocated and the embedding never landed. The build reported success.
//
// It reported success because BOTH of the guards below were blind to it, each for its own reason:
//
//   1. readPassages() DISCARDED any line that failed JSON.parse with no count, no warning, and no
//      error (`catch { /* skip */ }`). A corpus can therefore lose a passage between the file on
//      disk and the rows the builder believes it read, and nothing anywhere says so.
//   2. The reconciliation at the end of ingestStore() compared `status.totalVectors` against
//      `totalPassages` — but `totalPassages` was itself produced by that same lossy reader. A line
//      dropped in (1) lowers BOTH sides of the comparison equally, so the check reports MATCH=true
//      on a store that is missing exactly the passage that was dropped. It is a count check that
//      cannot see the failure mode it was written to catch, because it measures the builder's
//      belief about the corpus instead of the corpus.
//
// Both are now closed, and the order matters: (1) is what makes (2) sound. readPassages() FAILS
// CLOSED on a malformed line, naming the file, the line number and the parse error, so the row set
// is complete by construction or there is no build at all; a caller that genuinely needs tolerance
// must pass `tolerateMalformed: true`, and even then every skipped line is counted and reported.
// That makes the parsed id set authoritative, and ingest then reconciles by ID, not by count:
// reconcileStoreIds() compares the expected passage ids against the ids actually present in the
// idmap the RVF runtime persisted next to the store — the artifact a reader will really resolve —
// and on any mismatch FAILS naming the exact missing ids. A store that cannot be proven complete is
// also DELETED rather than left on disk, because the six-week defect survived precisely by looking
// like a finished artifact; the expensive vec shards are retained so a re-ingest is cheap.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRvf, loadTransformers, chooseModelCache } from './resolve-deps.mjs';
import { materializeModelRevision, modelCacheReady } from './model-requirements.mjs';
import { persistAndVerifyRvfIndex } from './rvf-index.mjs';
import { lowerBuildPriority } from './process-priority.mjs';
import { writeShardProgress, clearShardProgress, createStallWatcher } from './shard-progress.mjs';

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

// argv-derived state. Populated by main() and ONLY by main(), so that importing this module — which
// is how the shard math and the reconciliation below are tested — parses no argv, resolves no paths,
// loads no native dependency and starts no embedding or ingest work. Before this was hoisted into
// main(), `tests/unit/forge-big-sharding.test.mjs` recorded the hazard in prose and stayed unwritten:
// a bare `import` of this file fired the real MODE dispatch as an import side effect.
let DIR = null;
let NAME = null;
let passagesFile = null;
const vecShardPath = (i, n) => path.join(DIR, `${NAME}.big.vecs.${i}-${n}.jsonl`);

// Lazy for the same reason: loadRvf() resolves and loads the native @ruvector/rvf binding, which an
// importing test neither needs nor should pay for.
let _RvfDatabase = null;
function getRvfDatabase() {
  if (!_RvfDatabase) { const { mod } = loadRvf(); _RvfDatabase = mod.RvfDatabase; }
  return _RvfDatabase;
}

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

/**
 * Read a JSONL corpus (passages, or a vec shard) — FAIL CLOSED on any line that will not parse.
 *
 * The predecessor swallowed a malformed line with `catch { /* skip *\/ }`: no count, no warning, no
 * error. That is the silent-discard path at the head of the ruv-gists incident described in this
 * file's header, and it is worse than a crash, because everything downstream — including the
 * reconciliation that is supposed to catch a missing passage — then measures the SHORTENED row set
 * and agrees with itself.
 *
 * Default behaviour rejects, naming file, line number and the underlying parse error. `limit` still
 * stops early for the smoke path. A caller that genuinely wants to survive a malformed corpus must
 * say so with `tolerateMalformed: true`; even then, every skipped line is counted, reported on
 * stderr, passed to `onMalformed`, and attached to the returned array as a non-enumerable
 * `malformed` property — tolerance is allowed, silence is not.
 */
export function readPassages(file, limit = 0, { tolerateMalformed = false, onMalformed = null } = {}) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const malformed = [];
    let lineNo = 0;
    let settled = false;
    const stream = fs.createReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = (fn, value) => { if (settled) return; settled = true; rl.close(); stream.destroy(); fn(value); };
    rl.on('line', (line) => {
      if (settled) return;
      lineNo += 1;
      const s = line.trim();
      if (!s) return; // a blank line carries no row and loses nothing
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch (error) {
        const record = { lineNo, error: error.message, bytes: s.length };
        malformed.push(record);
        if (onMalformed) onMalformed(record);
        if (!tolerateMalformed) {
          finish(reject, new Error(
            `${file}:${lineNo} — malformed JSON line (${s.length} bytes): ${error.message}. `
            + 'Refusing to silently drop a row: a dropped passage becomes an unretrievable document '
            + 'and every count downstream agrees with the shortened set. Repair the line, or pass '
            + 'tolerateMalformed to accept the loss explicitly.',
          ));
          return;
        }
        console.error(`[passages] TOLERATED malformed line ${file}:${lineNo} (${s.length} bytes): ${error.message}`);
        return;
      }
      rows.push(parsed);
      if (limit && rows.length >= limit) finish(resolve, attachMalformed(rows, malformed));
    });
    rl.on('close', () => {
      if (settled) return;
      if (malformed.length) {
        console.error(`[passages] ${malformed.length} malformed line(s) TOLERATED in ${file} — lines ${malformed.map((m) => m.lineNo).join(', ')}`);
      }
      finish(resolve, attachMalformed(rows, malformed));
    });
    rl.on('error', (error) => finish(reject, error));
    stream.on('error', (error) => finish(reject, error));
  });
}
function attachMalformed(rows, malformed) {
  Object.defineProperty(rows, 'malformed', { value: malformed, enumerable: false });
  return rows;
}

export function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

/**
 * Which rows belong to shard `shardIdx` of `nShards`. Extracted from the inline modulo filter that
 * embedShard() used to carry so the property that actually matters — every row lands in EXACTLY one
 * shard, no drops and no duplicates — can be asserted directly instead of inferred from a corpus
 * rebuild. Same math, given a name and a fixture-friendly signature.
 */
export function shardAssign(rows, shardIdx, nShards) {
  if (!Array.isArray(rows)) throw new TypeError('shardAssign: rows must be an array');
  if (!Number.isInteger(nShards) || nShards < 1) throw new RangeError(`shardAssign: nShards must be a positive integer, got ${nShards}`);
  if (!Number.isInteger(shardIdx) || shardIdx < 0 || shardIdx >= nShards) {
    throw new RangeError(`shardAssign: shardIdx must be an integer in [0, ${nShards - 1}], got ${shardIdx}`);
  }
  return rows.filter((_, i) => i % nShards === shardIdx);
}

/**
 * The ids the store will actually resolve, read back from the idmap the RVF runtime persists beside
 * it. This is deliberately the ON-DISK artifact rather than an in-process counter: the ruv-gists
 * defect was visible there and nowhere else (idToLabel 3,054 vs nextLabel 3,055), and an in-memory
 * `accepted` tally is a record of what the builder believed it sent, not of what a reader can find.
 */
export function readStoredIds(rvfPath) {
  const mapFile = `${rvfPath}.idmap.json`;
  if (!fs.existsSync(mapFile)) {
    throw new Error(`${mapFile} is missing — cannot prove the store contains every passage, refusing to report success`);
  }
  let map;
  try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch (error) {
    throw new Error(`${mapFile} is unreadable (${error.message}) — cannot prove store completeness`);
  }
  const idToLabel = map?.idToLabel;
  if (!idToLabel || typeof idToLabel !== 'object') {
    throw new Error(`${mapFile} has no idToLabel object — cannot prove store completeness`);
  }
  return Object.keys(idToLabel).map(String);
}

/**
 * Reconcile a built store against the corpus it was built from, BY ID.
 *
 * Pure, so the guard itself is testable without a corpus or a native store. `expectedIds` come from
 * the (now fail-closed) passages read; `storedIds` from the persisted idmap. A count comparison is
 * kept as a secondary assertion, but the id-set comparison is the one that would have caught
 * ruv-gists: it names the missing document instead of reporting a number that matched.
 */
export function reconcileStoreIds({
  expectedIds, storedIds, totalVectors = null, accepted = null, rejected = 0, dupes = 0, sample = 25,
} = {}) {
  if (!Array.isArray(expectedIds)) throw new TypeError('reconcileStoreIds: expectedIds must be an array');
  if (!Array.isArray(storedIds)) throw new TypeError('reconcileStoreIds: storedIds must be an array');
  const expected = expectedIds.map(String);
  const stored = storedIds.map(String);
  const expectedSet = new Set(expected);
  const storedSet = new Set(stored);

  const duplicateExpected = [...countDuplicates(expected)];
  const duplicateStored = [...countDuplicates(stored)];
  const missing = [...expectedSet].filter((id) => !storedSet.has(id));   // passage with no vector
  const unexpected = [...storedSet].filter((id) => !expectedSet.has(id)); // vector with no passage

  const countsAgree = (totalVectors === null || totalVectors === expectedSet.size)
    && (accepted === null || accepted === expectedSet.size);
  const ok = missing.length === 0 && unexpected.length === 0 && duplicateExpected.length === 0
    && duplicateStored.length === 0 && rejected === 0 && countsAgree;

  const lines = [
    `[reconcile] passages=${expected.length} (distinct ${expectedSet.size}) storedIds=${stored.length} (distinct ${storedSet.size})`
    + ` vectors=${totalVectors ?? 'n/a'} accepted=${accepted ?? 'n/a'} rejected=${rejected} dupes=${dupes} OK=${ok}`,
  ];
  if (missing.length) lines.push(`[reconcile] MISSING VECTOR for ${missing.length} passage id(s): ${preview(missing, sample)}`);
  if (unexpected.length) lines.push(`[reconcile] VECTOR WITHOUT PASSAGE for ${unexpected.length} id(s): ${preview(unexpected, sample)}`);
  if (duplicateExpected.length) lines.push(`[reconcile] DUPLICATE passage id(s) in the corpus — one id cannot hold two passages: ${preview(duplicateExpected, sample)}`);
  if (duplicateStored.length) lines.push(`[reconcile] DUPLICATE stored id(s): ${preview(duplicateStored, sample)}`);
  if (rejected !== 0) lines.push(`[reconcile] the store REJECTED ${rejected} vector(s)`);
  if (!countsAgree) lines.push(`[reconcile] count mismatch — distinct passages ${expectedSet.size}, vectors ${totalVectors ?? 'n/a'}, accepted ${accepted ?? 'n/a'}`);

  return { ok, missing, unexpected, duplicateExpected, duplicateStored, countsAgree, report: lines.join('\n') };
}
function countDuplicates(values) {
  const seen = new Set(); const dupes = new Set();
  for (const v of values) { if (seen.has(v)) dupes.add(v); else seen.add(v); }
  return dupes;
}
function preview(ids, sample) {
  return ids.length > sample ? `${ids.slice(0, sample).join(', ')} … (+${ids.length - sample} more)` : ids.join(', ');
}

// ---------- MODE: embed one shard ----------
async function embedShard(shardIdx, nShards) {
  const rows = await readPassages(passagesFile);
  const mine = shardAssign(rows, shardIdx, nShards);
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
    // Tied to COMPLETED WORK, written after every batch — not throttled like the console log below,
    // and not derived from log/CPU activity, either of which can lag behind (or misleadingly
    // survive) a real stall. This is what shard-all's stall watcher and nightly-watchdog.mjs read.
    writeShardProgress(DIR, NAME, shardIdx, nShards, done, mine.length);
    if ((i / BATCH) % 20 === 0) console.log(`[embed ${shardIdx}/${nShards}] ${done}/${mine.length} (${(done / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`);
  }
  fs.closeSync(fd);
  fs.renameSync(outFile + '.tmp', outFile); // atomic: file appears only when complete
  console.log(`[embed ${shardIdx}/${nShards}] DONE ${done} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  clearShardProgress(DIR, NAME, shardIdx, nShards); // finished — no longer a stall candidate
}

// ---------- MODE: spawn + supervise all N embed shards (the "parent embed process") ----------
// Replaces a shell-level `&`/`wait` fan-out (nightly-gists.sh used to do this itself) with a
// supervisor that can actually SEE per-shard progress and act on a stall, rather than just waiting
// blindly for N background pids that might never finish.
async function shardAll(nShards, { stallMinutes, pollSeconds } = {}) {
  for (let i = 0; i < nShards; i++) clearShardProgress(DIR, NAME, i, nShards); // no stale progress from a prior crashed run
  const scriptPath = path.resolve(process.argv[1]);
  const children = [];
  const exitCodes = new Array(nShards).fill(null);
  const exits = [];
  for (let i = 0; i < nShards; i++) {
    const child = spawn(process.execPath, [scriptPath, 'embed', '--dir', DIR, '--name', NAME, '--shard', String(i), '--of', String(nShards)], { stdio: 'inherit' });
    children.push(child);
    exits.push(new Promise((resolve) => child.on('exit', (code, signal) => { exitCodes[i] = code ?? (signal ? 128 : 1); resolve(); })));
  }
  let stalledOut = false;
  const killAll = () => {
    for (const c of children) { if (exitCodes[children.indexOf(c)] === null) { try { c.kill('SIGTERM'); } catch { /* already gone */ } } }
    setTimeout(() => {
      for (const c of children) { if (exitCodes[children.indexOf(c)] === null) { try { c.kill('SIGKILL'); } catch { /* already gone */ } } }
    }, 5000).unref();
  };
  const watcher = createStallWatcher({
    dir: DIR, name: NAME, of: nShards, stallMs: stallMinutes * 60_000, pollMs: pollSeconds * 1000,
    onStall: (i, info) => {
      stalledOut = true;
      console.error(`[shard-all] STALL: shard ${i}/${nShards} has not advanced past ${info.lastCompleted} passages in ${(info.staleMs / 60_000).toFixed(1)}m (stall budget ${stallMinutes}m) — terminating all shards`);
      killAll();
    },
  });
  await Promise.all(exits);
  watcher.stop();
  for (let i = 0; i < nShards; i++) clearShardProgress(DIR, NAME, i, nShards);
  if (stalledOut) {
    console.error('[shard-all] aborted due to a stalled shard — refusing to ingest a half-embedded corpus');
    process.exit(1);
  }
  const failed = exitCodes.filter((c) => c !== 0).length;
  if (failed > 0) {
    console.error(`[shard-all] ${failed} of ${nShards} shard(s) exited nonzero (${exitCodes.join(',')})`);
    process.exit(1);
  }
  console.log(`[shard-all] all ${nShards} shards completed`);
}

// ---------- MODE: ingest all shards into one .big.rvf ----------
async function ingestStore() {
  const passages = await readPassages(passagesFile); // fail-closed: the id set below is complete or we never get here
  const expectedIds = passages.map((r) => String(r.id));
  const shardFiles = fs.readdirSync(DIR)
    .filter((f) => f.startsWith(`${NAME}.big.vecs.`) && f.endsWith('.jsonl'))
    .map((f) => path.join(DIR, f));
  if (!shardFiles.length) throw new Error(`no vec shards for ${NAME} — run embed mode first`);
  console.log(`[ingest] ${shardFiles.length} shard file(s)`);

  const RvfDatabase = getRvfDatabase();
  const OUT_RVF = path.join(DIR, `${NAME}.big.rvf`);
  for (const f of [OUT_RVF, OUT_RVF + '.idmap.json', OUT_RVF + '.embed.json']) if (fs.existsSync(f)) fs.unlinkSync(f);
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

  // THE GATE. Runs before the query-side config is written and before the shards are cleaned, so a
  // store that cannot be proven complete leaves behind neither a usable-looking artifact nor a
  // finished-looking build. Reconciliation is by ID against the persisted idmap — the six-week
  // ruv-gists defect passed a count check that compared two numbers derived from the same lossy read.
  let recon;
  try {
    recon = reconcileStoreIds({
      expectedIds, storedIds: readStoredIds(OUT_RVF), totalVectors: status.totalVectors, accepted, rejected, dupes,
    });
  } catch (error) {
    recon = { ok: false, missing: [], report: `[reconcile] UNVERIFIABLE — ${error.message}` };
  }
  console.log(recon.report);
  if (!recon.ok) {
    console.error('[ingest] RECONCILE FAILED — the store does not contain every passage. NOT cleaning shards.');
    // Remove the unprovable artifact. The defect this guard exists to stop survived six weeks by
    // looking exactly like a finished store; a nonzero exit alone did not stop a caller from
    // shipping what was already on disk. Embedding work (the expensive part) is preserved in the
    // retained shards, so a corrected re-ingest is cheap.
    for (const f of [OUT_RVF, OUT_RVF + '.idmap.json', OUT_RVF + '.embed.json']) {
      if (fs.existsSync(f)) { fs.unlinkSync(f); console.error(`[ingest] removed unverified artifact ${path.basename(f)}`); }
    }
    process.exit(1);
  }

  // query-side embedder config (how forge-ask embeds a query for THIS .rvf — asymmetric bge)
  fs.writeFileSync(OUT_RVF + '.embed.json', JSON.stringify({
    model: MODEL, revision: MODEL_REVISION, dimensions: DIM, metric: 'cosine', pooling: POOLING, normalize: true,
    queryPrefix: QUERY_PREFIX,
    note: 'Big (Mac/PC) variant. Passages embedded with NO prefix; queries use queryPrefix (asymmetric).',
    builtFrom: path.basename(passagesFile), generated: new Date().toISOString(),
  }, null, 2) + '\n');

  for (const sf of shardFiles) fs.unlinkSync(sf); // clean shards only on success
  console.log(`[ingest] OK — wrote ${NAME}.big.rvf (+embed.json); every one of ${expectedIds.length} passage ids has a vector; canonical passages/meta retained; shards cleaned. Run forge-guard --variant big next.`);
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

// ---------- CLI ----------
// Guarded so that the MODE dispatch, the argv parsing and the usage exits fire ONLY when this file
// is executed directly. Importing it (tests/unit/forge-big-sharding.test.mjs) now yields the pure
// exports above and nothing else — no argv, no paths, no native binding, no work.
async function main() {
  // BGE embedding can saturate a core for several minutes. Keep interactive lifecycle hooks
  // responsive while this maintenance job runs; unsupported/denied reprioritization is non-fatal.
  const priority = lowerBuildPriority();
  console.log(`[big] process priority: ${priority.applied ? 'below-normal' : `unchanged (${priority.error})`}`);

  const argv = process.argv.slice(2);
  const MODE = argv[0];
  const SMOKE = argv.includes('--smoke');
  DIR = arg('--dir');
  NAME = arg('--name');
  if (!DIR || !NAME) { console.error('Usage: forge-big.mjs <embed|ingest|both|--smoke> --dir <d> --name <n> [--shard i --of n]'); process.exit(2); }
  passagesFile = path.join(DIR, `${NAME}.passages.jsonl`);

  if (SMOKE) { await smoke(); }
  else if (MODE === 'embed') { await embedShard(parseInt(arg('--shard', '0'), 10), parseInt(arg('--of', '1'), 10)); }
  else if (MODE === 'shard-all') {
    await shardAll(parseInt(arg('--shards', '8'), 10), {
      stallMinutes: parseFloat(arg('--stall-minutes', '15')),
      pollSeconds: parseFloat(arg('--poll-seconds', '15')),
    });
  }
  else if (MODE === 'ingest') { await ingestStore(); }
  else if (MODE === 'both') { await embedShard(0, 1); await ingestStore(); }
  else { console.error('usage: forge-big.mjs <embed|shard-all|ingest|both|--smoke> --dir <d> --name <n> [--shard i --of n] [--shards n --stall-minutes m]'); process.exit(2); }
}

const INVOKED_DIRECTLY = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (INVOKED_DIRECTLY) {
  try {
    await main();
  } catch (error) {
    // One greppable line first, then the full stack. `nightly-gists.sh` appends this to a log a
    // human reads after the fact, and a corpus error that arrives only as an unhandled rejection
    // reads like a crash rather than the actionable "line 3 will not parse" that it is.
    console.error(`[big] FATAL: ${error?.message ?? error}`);
    console.error(error?.stack ?? '');
    process.exit(1);
  }
}
