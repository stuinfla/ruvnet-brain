#!/usr/bin/env node
// corpus-qa.mjs — permanent machine gate: "everything embeds correctly and everything gets read
// correctly." Born from the 2026-07-10 depth-restore failure, where a rebuilt ruvector store had
// 18,491 passages and 0 full bodies and nothing noticed until a human grepped for '(full body):'.
//
// For EVERY .rvf store in the kb dir (both variants — small MiniLM-384 and .big bge-768 — plus
// single-variant stores like concepts.big / ruv-gists.big):
//
//   STRUCTURAL (cheap, always):
//     S1  <name>.passages.jsonl exists and has > 0 rows
//     S2  full-body passage count > 0 whenever scripts/full-hints.mjs FULL_HINTS names the store
//         (the exact failure class this gate exists to kill — hints defined, bodies zeroed = FAIL)
//     S3  .rvf totalVectors === passages rows (no missing/extra rows), via RvfDatabase.openReadonly
//     S4  <name>.rvf.embed.json exists (a store the read path can't embed queries for is unreadable)
//
//   ROUND-TRIP (heavy, skipped with --structural):
//     R1  sample 3 passages DETERMINISTICALLY (FNV-1a of "store.variant:k" — reproducible, no RNG),
//         re-embed each passage exactly as the pipeline indexed it (small: "title — path\ntext",
//         mean pooling; big: raw text, cls pooling — read from the store's own embed.json),
//         query THAT store, and require the sampled row itself (same id, same path, or identical
//         text — overlapping chunks of one doc may legitimately outrank each other) in top-3,
//         OR within NEAR_DUP_EPS cosine distance of the best hit inside top-10. The epsilon arm
//         exists because near-duplicate corpus rows (e.g. FACT's timestamped benchmark_report
//         JSONs, ~95% identical text) crowd the podium while quantized batch-vs-single embed
//         drift (~0.035 measured) exceeds the true gap between near-dups — the row IS stored and
//         readable (fact.big id=722: rank 6, Δ0.007 behind rank 1), so that's a photo-finish,
//         not a broken store. Photo-finish passes are still surfaced as a `note` so the
//         near-dup-noise signal feeds the dedup backlog instead of being hidden. A row absent
//         from top-10 (or far from the leader) remains a hard FAIL — missing/zero vectors and
//         broken read paths cannot hide behind the epsilon.
//         Proves embed-write AND read-path in one check. Retrieval QUALITY (real questions) stays
//         forge-guard/prove's job; this gate proves the machinery, not the answers.
//
// Usage:
//   node scripts/corpus-qa.mjs                     # whole corpus, structural + round-trip, serial
//   node scripts/corpus-qa.mjs --store ruvector    # one store (both variants)
//   node scripts/corpus-qa.mjs --structural        # cheap checks only
//   [--dir <kb-dir>] [--samples N]                 # fixture/test hooks
//
// Output: one table row per store-variant, PASS/FAIL + reasons; skipped store classes are printed
// with why (nothing is skipped silently). Exit 1 if ANY row fails — self-update.mjs runs this per
// rebuilt store and aborts before publish on failure.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FULL_HINTS } from './full-hints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');

// resolve-deps lives in the real kb/ regardless of --dir (fixtures point --dir elsewhere).
const { loadRvf, loadTransformers, configureModel, chooseModelCache } =
  await import(path.join(KB, 'resolve-deps.mjs')).then((m) => m);

const FULL_BODY_MARK = '(full body):';
// R1 photo-finish epsilon: measured quantized batch-vs-single embed drift is ~0.035 cosine
// distance (fact.big id=722 replay); near-dup siblings sit within ~0.005 of each other. 0.02
// forgives the drift-scale tie WITHOUT forgiving genuinely different rows.
const NEAR_DUP_EPS = 0.02;

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function readPassages(file) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (l) => { const s = l.trim(); if (!s) return; try { rows.push(JSON.parse(s)); } catch { /* counted structurally via row parse below */ } });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
  });
}

// Deterministic k distinct sample indices for a store-variant. Same store => same samples, always.
export function sampleIndices(storeKey, n, k) {
  const idx = new Set();
  for (let salt = 0; idx.size < Math.min(k, n) && salt < 50 * k; salt++) idx.add(fnv1a(`${storeKey}:${salt}`) % n);
  return [...idx].slice(0, Math.min(k, n));
}

// ---- embedder cache: one pipeline per model, shared across stores. Caches the in-flight PROMISE
// (not just the resolved pipe) so concurrent qaStore() calls that both miss on the same model don't
// each trigger their own T.pipeline() load — first caller wins, the rest await its promise.
const pipelines = new Map();
function getPipeline(model) {
  if (pipelines.has(model)) return pipelines.get(model);
  const p = (async () => {
    const { T } = await loadTransformers();
    configureModel(T, chooseModelCache());
    return T.pipeline('feature-extraction', model, { quantized: true });
  })();
  pipelines.set(model, p);
  return p;
}

/**
 * QA one store-variant. Returns { store, variant, passages, fullBodies, vectors, roundtrip, fails, notes }.
 * `fails` is [] on PASS; every entry is a specific reason string (receipts, not adjectives).
 * `notes` are non-fatal signals (e.g. near-dup crowding) that should reach the dedup backlog.
 */
export async function qaStore(dir, store, variant, { roundtrip = true, samples = 3 } = {}) {
  const base = variant === 'big' ? `${store}.big` : store;
  const rvfPath = path.join(dir, `${base}.rvf`);
  const passagesPath = path.join(dir, `${base}.passages.jsonl`);
  const embedPath = `${rvfPath}.embed.json`;
  const res = { store, variant, passages: 0, fullBodies: 0, vectors: null, roundtrip: 'skipped', fails: [], notes: [] };

  // S1: passages sidecar
  if (!fs.existsSync(passagesPath)) { res.fails.push(`S1 missing ${path.basename(passagesPath)}`); return res; }
  const rows = await readPassages(passagesPath);
  res.passages = rows.length;
  if (rows.length === 0) { res.fails.push('S1 passages file has 0 rows'); return res; }

  // S2: full-body floor wherever hints exist (the 2026-07-10 failure class)
  res.fullBodies = rows.filter((r) => typeof r.text === 'string' && r.text.includes(FULL_BODY_MARK)).length;
  if (FULL_HINTS[store] && res.fullBodies === 0) {
    res.fails.push(`S2 FULL_HINTS defines --full for "${store}" but store has 0 full-body passages (silent depth loss)`);
  }

  // S3: vector count parity
  let db = null;
  try {
    const { mod } = loadRvf();
    db = await mod.RvfDatabase.openReadonly(rvfPath);
    const st = await db.status();
    res.vectors = st.totalVectors;
    if (st.totalVectors !== rows.length) res.fails.push(`S3 vectors=${st.totalVectors} != passages=${rows.length}`);
  } catch (e) {
    res.fails.push(`S3 cannot open ${path.basename(rvfPath)}: ${e.message.split('\n')[0]}`);
  }

  // S4: query-side embed config
  let embedConf = null;
  if (!fs.existsSync(embedPath)) res.fails.push(`S4 missing ${path.basename(embedPath)} (read path cannot embed queries)`);
  else embedConf = JSON.parse(fs.readFileSync(embedPath, 'utf8'));

  // R1: deterministic self-retrieval round trip
  if (roundtrip && db && embedConf && !res.fails.some((f) => f.startsWith('S3'))) {
    try {
      const picks = sampleIndices(`${store}.${variant}`, rows.length, samples);
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      let hit = 0;
      const misses = [];
      const pipe = await getPipeline(embedConf.model);
      for (const i of picks) {
        const r = rows[i];
        // Re-embed EXACTLY what the pipeline indexed for this variant (forge-build/forge-big):
        const text = variant === 'big'
          ? r.text
          : `${r.title} — ${r.path}\n${r.text}`.slice(0, 4300);
        const out = await pipe([text], { pooling: embedConf.pooling || 'mean', normalize: true });
        if (out.dims[1] !== embedConf.dimensions) throw new Error(`embed dim ${out.dims[1]} != ${embedConf.dimensions}`);
        const top = await db.query(Array.from(out.data), 10);
        const matches = (t) => String(t.id) === String(r.id)
          || byId.get(String(t.id))?.path === r.path
          || byId.get(String(t.id))?.text === r.text;
        const rank = top.findIndex(matches); // -1 = absent from top-10
        if (rank >= 0 && rank < 3) hit++;
        else if (rank >= 0 && top[rank].distance - top[0].distance <= NEAR_DUP_EPS) {
          hit++; // photo-finish behind near-duplicates: stored + readable; surface the crowd as a note
          res.notes.push(`near-dup crowd: id=${r.id} rank ${rank + 1}, Δ${(top[rank].distance - top[0].distance).toFixed(4)} behind #1 (${r.path})`);
        } else {
          misses.push(`id=${r.id} ${rank < 0 ? 'ABSENT from top-10' : `rank ${rank + 1}, Δ${(top[rank].distance - top[0].distance).toFixed(4)}`} ${r.path}`);
        }
      }
      res.roundtrip = `${hit}/${picks.length}`;
      if (hit < picks.length) res.fails.push(`R1 self-retrieval missed: ${misses.join('; ')}`);
    } catch (e) {
      res.roundtrip = 'error';
      res.fails.push(`R1 round-trip error: ${e.message.split('\n')[0]}`);
    }
  }
  if (db) await db.close();
  return res;
}

/** Discover store-variants in a dir. Returns { stores: [{store, variant}], skipped: [{file, why}] }. */
export function discoverStores(dir) {
  const stores = [];
  const skipped = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.rvf')) continue;               // idmaps/embed.json/etc. are per-store sidecars, not stores
    const name = f.slice(0, -'.rvf'.length);
    if (name.endsWith('.big')) stores.push({ store: name.slice(0, -'.big'.length), variant: 'big' });
    else stores.push({ store: name, variant: 'small' });
  }
  return { stores, skipped };
}

// ---------------- CLI ----------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const has = (f) => process.argv.includes(f);
  const DIR = path.resolve(arg('--dir', KB));
  const ONLY = arg('--store', null);
  const STRUCTURAL_ONLY = has('--structural');
  const SAMPLES = parseInt(arg('--samples', '3'), 10) || 3;
  const CONC = Math.max(1, parseInt(arg('--concurrency', '4'), 10) || 4);

  const { stores } = discoverStores(DIR);
  const todo = ONLY ? stores.filter((s) => s.store === ONLY) : stores;
  if (ONLY && todo.length === 0) { console.error(`[corpus-qa] no store named "${ONLY}" in ${DIR}`); process.exit(2); }
  console.log(`[corpus-qa] ${todo.length} store-variant(s) in ${DIR}${ONLY ? ` (store=${ONLY})` : ''}${STRUCTURAL_ONLY ? ' [structural only]' : ' [structural + round-trip]'} — concurrency ${CONC}, one process`);

  // qaStore() shares the in-process pipelines cache (getPipeline above) and each store-variant
  // touches its own .rvf/.passages.jsonl files, so concurrent runs don't step on each other.
  const results = new Array(todo.length);
  let cursor = 0;
  const runOne = async () => {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const { store, variant } = todo[i];
      results[i] = await qaStore(DIR, store, variant, { roundtrip: !STRUCTURAL_ONLY, samples: SAMPLES });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, runOne));

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('store', 26) + pad('variant', 8) + pad('passages', 10) + pad('full-b', 8) + pad('vectors', 9) + pad('roundtrip', 11) + 'verdict');
  let failed = 0;
  for (const r of results) {
    const verdict = r.fails.length ? 'FAIL' : 'PASS';
    if (r.fails.length) failed++;
    console.log(pad(r.store, 26) + pad(r.variant, 8) + pad(r.passages, 10) + pad(r.fullBodies, 8) + pad(r.vectors ?? '?', 9) + pad(r.roundtrip, 11) + verdict);
    for (const f of r.fails) console.log('    ↳ ' + f);
    for (const n of r.notes) console.log('    · note: ' + n);
  }
  console.log(`\n[corpus-qa] ${results.length - failed}/${results.length} store-variants PASS${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}
