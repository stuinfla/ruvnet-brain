#!/usr/bin/env node
// forge-build.mjs — GENERALIZED RVF knowledge-base builder (rvf-kb-forge skill).
//
// Walks the WHOLE source tree of any repo, categorizes every file, chunks text at ~4000
// chars, embeds with local MiniLM (Xenova/all-MiniLM-L6-v2, 384-dim, mean+normalize, cosine),
// ingests vectors into a <kb>.rvf store, AND — critically — writes the FULL chunk text to
// <kb>.passages.jsonl keyed by the SAME id used in the .rvf. The .rvf query() returns only
// {id, distance}; the human/AI-readable TEXT comes from the passages join. If you skip the
// passages sidecar you ship a teaser, not knowledge — that is the exact bug this skill exists
// to prevent.
//
// Usage:
//   node forge-build.mjs --repo <repo-path> --out <output-dir> --name <kb-name> [--full <glob,glob>]
//
//   --repo  absolute path to the repo (or subtree) to index
//   --out   directory to write <name>.rvf, <name>.passages.jsonl, <name>.meta.json
//   --name  KB name / filename prefix (e.g. "myrepo")
//   --full  comma-separated path prefixes (relative to repo) whose .rs/.ts/.py/.js source
//           files get indexed in FULL body (engines, CLIs, command handlers). Optional.
//
// Env: KB_REPO_ROOT (overrides --repo), KB_MODEL_CACHE (model cache dir), KB_DEBUG.
//
// Outputs (in --out):
//   <name>.rvf                 vector store (HNSW, cosine, 384-dim)
//   <name>.rvf.idmap.json      store-internal id map (written by @ruvector/rvf)
//   <name>.passages.jsonl      FULL TEXT per id  {id,text,path,title}  <- the join target
//   <name>.meta.json           { model, dimensions, metric, generated, entries:{id:{path,kind,title,chunk,preview}} }

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRvf, loadTransformers, configureModel } from './resolve-deps.mjs';
import { buildCorpus, FORGE_BUILD_FINGERPRINT } from './forge-corpus.mjs';
import { buildCorpusLedger } from './incremental-refresh.mjs';
import { persistAndVerifyRvfIndex } from './rvf-index.mjs';
import { writeRvfGeneration, projectSourceStore } from '../scripts/rvf-generation.mjs';

// Best-effort git provenance of the repo being indexed (for the evergreen SOURCE.json).
function gitInfo(repoDir) {
  const run = (args) => {
    try { return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  return {
    sha: run(['rev-parse', 'HEAD']),
    describe: run(['describe', '--tags', '--always']),
    remote: run(['config', '--get', 'remote.origin.url']),
  };
}

// ---------- args ----------
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const REPO = process.env.KB_REPO_ROOT || arg('--repo');
const OUT_DIR = arg('--out');
const NAME = arg('--name');
const FULL_PREFIXES = (arg('--full', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
// --keep: comma-separated directory NAMES to exempt from SKIP_DIRS for THIS repo. SKIP_DIRS
// excludes 'v2' as noise globally, but for open-claude-code (all source in v2/src) and RuView
// (active tree v2/crates) that skip deletes the repo's real content. Per-repo keep lives in
// scripts/full-hints.mjs (KEEP_DIRS) so ingest-repo.mjs / self-update.mjs pass it automatically.
const KEEP_NAMES = (arg('--keep', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Canonical host where THIS deployment will serve the live manifest + bundle (for the EVERGREEN
// self-updater). Differs per deployment, so it's a flag. Trailing slash optional. When omitted,
// SOURCE.json is still written with null URLs (provenance only; self-update disabled until set).
const CANONICAL_URL = (arg('--canonical-url', '') || '').replace(/\/+$/, '');
if (!REPO || !OUT_DIR || !NAME) {
  console.error('Usage: node forge-build.mjs --repo <repo> --out <dir> --name <kb-name> [--full a,b] [--canonical-url https://host/path/to/kb]');
  process.exit(2);
}
const R = path.resolve(REPO);
if (!fs.existsSync(R)) { console.error(`repo not found: ${R}`); process.exit(2); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_RVF = path.join(OUT_DIR, `${NAME}.rvf`);
const OUT_PASSAGES = path.join(OUT_DIR, `${NAME}.passages.jsonl`);
const OUT_META = path.join(OUT_DIR, `${NAME}.meta.json`);

const { mod: rvfMod, via: rvfVia } = loadRvf();
const { RvfDatabase } = rvfMod;
console.log('[forge] repo:', R);
console.log('[forge] out :', OUT_DIR, '| name:', NAME);
console.log('[forge] @ruvector/rvf via:', rvfVia);

if (KEEP_NAMES.length) console.log('[forge] --keep (un-skipped dirs):', KEEP_NAMES.join(', '));
const {
  allFiles,
  census,
  excluded,
  counts,
  intentionallySkipped,
  chunks,
  coveredPaths,
} = buildCorpus({
  repo: R,
  name: NAME,
  fullPrefixes: FULL_PREFIXES,
  keepNames: KEEP_NAMES,
});

console.log('\n=== STEP 1: CENSUS (every file in the tree, by category) ===');
console.log(JSON.stringify(census, null, 2));
console.log('total files walked:', allFiles.length, '| excluded (stubs/minified/lockfiles):', excluded.files);
console.log('excluded dirs encountered:', [...excluded.dirs].join(', ') || '(none)');

console.log('\n=== STEP 2: CORPUS (files per kind ingested) ===');
console.log(JSON.stringify(counts, null, 2));
console.log('distinct source paths covered:', coveredPaths, '| total chunks:', chunks.length);

// Guard against a vacuous build: 0 chunks means the repo path is wrong, empty, or fully
// excluded. Reporting "MATCH = true" on an empty KB would look like success — fail loudly.
if (chunks.length === 0) {
  console.error('\n[forge] ERROR: 0 chunks produced — nothing to index. Check --repo path, that '
    + 'the tree is not entirely excluded (node_modules/target/etc.), and that it contains '
    + 'docs/source/manifests/config. Aborting before writing an empty KB.');
  process.exit(3);
}

// ---------- embeddings + ingest ----------
const { T, modelCache: MODEL_CACHE, via: tVia } = await loadTransformers();
const { haveLocalModel } = configureModel(T, MODEL_CACHE);
console.log('\n[forge] transformers via:', tVia);
console.log('[forge] embedder:', haveLocalModel ? `local cache ${MODEL_CACHE}` : `remote download (cache ${MODEL_CACHE})`);
// MODEL-WEIGHT PIN: address MiniLM by an exact HuggingFace commit SHA rather than the floating
// `main` branch, so every rebuild yields byte-identical 384-dim vectors to the shipped corpus
// (verified live against the HF Hub API; main HEAD unchanged since 2025-07-22). Offline-first is
// preserved — configureModel() above resolves an already-cached model via env.localModelPath
// regardless of revision, so this never re-downloads a cached model, only pins the first fetch.
const MINILM_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const embed = await T.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true, revision: MINILM_REVISION });

fs.rmSync(OUT_RVF, { force: true });
fs.rmSync(OUT_RVF + '.idmap.json', { force: true });
const db = await RvfDatabase.create(OUT_RVF, { dimensions: 384, metric: 'cosine' });

// Full-text passages sidecar — one JSON object per line {id,text,path,title}. SAME id as the
// vector in the .rvf and in meta — so retrieval can JOIN. THIS is the non-negotiable file.
fs.rmSync(OUT_PASSAGES, { force: true });
const fd = fs.openSync(OUT_PASSAGES, 'w');
let passageLines = 0;
const meta = {};
const BATCH = 48;
let accepted = 0, rejected = 0;
const t0 = Date.now();
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const out = await embed(batch.map((c) => c.embedText), { pooling: 'mean', normalize: true });
  const dim = out.dims[1];
  const ingestBatch = batch.map((c, j) => {
    fs.writeSync(fd, JSON.stringify({ id: c.id, text: c.text, path: c.path, title: c.title }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n');
    passageLines++;
    meta[c.id] = { path: c.path, kind: c.kind, title: c.title, chunk: `${c.chunk}/${c.of}`, preview: c.preview };
    // No `metadata` field: @ruvector/rvf never persisted per-vector metadata (upstream
    // ruvnet/RuVector#704 — "SDK silently drops metadata"), and 0.3.0 turned that silent
    // drop into a hard RvfError rather than keep lying about it. Retrieval has always read
    // the richer `<name>.meta.json` sidecar written on the line above (full title, chunk/of,
    // preview) — this field was a truncated copy that nothing ever read back. Dropping it is
    // a functional no-op. Re-add ONLY once the SDK returns metadata durably on query.
    return {
      id: c.id,
      vector: Array.from(out.data.slice(j * dim, (j + 1) * dim)),
    };
  });
  const r = await db.ingestBatch(ingestBatch);
  accepted += r.accepted; rejected += r.rejected;
  if ((i / BATCH) % 20 === 0) {
    const rate = (i + batch.length) / ((Date.now() - t0) / 1000);
    console.log(`progress ${i + batch.length}/${chunks.length} (${rate.toFixed(1)}/s, accepted=${accepted}, rejected=${rejected})`);
  }
}
fs.closeSync(fd);
console.log(`\ningest done: accepted=${accepted} rejected=${rejected} in ${((Date.now() - t0) / 1000).toFixed(0)}s | passages lines: ${passageLines}`);

const status = await db.status();
console.log('RVF status:', JSON.stringify(status));
console.log('Reconcile: chunks =', chunks.length, '| vectors =', status.totalVectors,
  '| passages lines =', passageLines, '| meta ids =', Object.keys(meta).length,
  '| MATCH =', chunks.length === status.totalVectors && passageLines === chunks.length && Object.keys(meta).length === chunks.length);

const indexProof = await persistAndVerifyRvfIndex({
  db,
  dimensions: 384,
  rvfPath: OUT_RVF,
  RvfDatabase,
});
console.log('RVF index:', JSON.stringify(indexProof));

fs.writeFileSync(OUT_META, JSON.stringify({
  model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, metric: 'cosine',
  generated: new Date().toISOString(),
  repo: R, name: NAME,
  census, corpusCounts: counts, coveredPaths,
  intentionallySkipped,   // doc-comment-less source files Step 7 excludes from the denominator
  incremental: buildCorpusLedger(chunks, { buildFingerprint: FORGE_BUILD_FINGERPRINT }),
  entries: meta,
}));
console.log('meta written:', OUT_META);

// Query-side embedder config for THIS .rvf — so forge-ask reads the SAME model the corpus used.
// The small (default) build is MiniLM: mean pooling, no query prefix (symmetric). The big build
// (forge-big.mjs) writes its own <name>.big.rvf.embed.json with the bge model + queryPrefix.
fs.writeFileSync(OUT_RVF + '.embed.json', JSON.stringify({
  model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, metric: 'cosine',
  pooling: 'mean', normalize: true, queryPrefix: '',
  note: 'Small (edge/Seed-compatible) variant. Symmetric: passages and queries embedded the same way.',
  builtFrom: path.basename(OUT_PASSAGES), generated: new Date().toISOString(),
}, null, 2) + '\n');
console.log('embed.json written:', OUT_RVF + '.embed.json');
console.log('rvf size:', fs.statSync(OUT_RVF).size, 'bytes');

// ---- EVERGREEN: write SOURCE.json (embedded provenance + canonical URLs) ----
// Ships in the bundle alongside forge-update.mjs so a copied KB can self-update later.
//
// The self-update manifest URL must RESOLVE and return JSON that forge-update.mjs can parse. The old
// `${base}/.last-built.json` form pointed at a file that was never published — it 404'd, silently
// re-breaking self-update on EVERY rebuild (Jan's bug; commit 0d2c1ec fixed the shipped SOURCE.json
// artifact but NOT this generator, so the nightly regressed it right back). The GitHub releases API for
// the repo IS a valid manifest — it always resolves and returns the latest Release JSON (bundle asset
// included), which is exactly what forge-update.mjs fetches. Derive owner/repo from the raw
// canonical base; if it isn't a github raw URL, emit null (forge-update then says "not configured",
// an honest error, never a 404). verify-channels + the pre-push gate assert this resolves.
function releasesApiUrl(canonicalBase) {
  if (!canonicalBase) return null;
  const m = canonicalBase.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest` : null;
}
{
  const g = gitInfo(R);
  const base = CANONICAL_URL || null;
  const manifestUrl = releasesApiUrl(base);
  // S4 (ONE PROVENANCE RECORD): stamp RVF-GENERATIONS.json FIRST; SOURCE.json's store entry is
  // then a projection of that ledger row (projectSourceStore, scripts/rvf-generation.mjs) instead
  // of an independent second construction of the same sourceRepo/sourceCommit/sourceDescribe/
  // builtUtc facts. This build produces the MiniLM/384-dim "small" tier (`${NAME}.rvf`, not the
  // BGE/768-dim "big" tier `canonicalRvfStores` discovers) — an explicit `rvfFile` names it.
  const generation = writeRvfGeneration({
    dir: OUT_DIR, store: NAME, rvfFile: `${NAME}.rvf`, model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384,
    sourceCommit: g.sha || null, sourceRepo: g.remote || R, sourceDescribe: g.describe || null,
  });
  const source = {
    builder: 'rvf-kb-forge',
    builtUtc: generation.builtUtc,
    canonicalManifestUrl: manifestUrl,
    selfUpdate: 'node forge-update.mjs',
    stores: {
      [NAME]: projectSourceStore(NAME, generation, {
        builder: 'rvf-kb-forge',
        canonicalManifestUrl: manifestUrl,
        canonicalBundleUrl: base ? `${base}/${NAME}-kb-bundle.zip` : null,
        selfUpdate: `node forge-update.mjs ${NAME}`,
      }),
    },
  };
  const OUT_SOURCE = path.join(OUT_DIR, 'SOURCE.json');
  fs.writeFileSync(OUT_SOURCE, JSON.stringify(source, null, 2) + '\n');
  console.log('SOURCE.json written:', OUT_SOURCE, base ? `(canonical: ${base})` : '(no --canonical-url; self-update disabled)');
}

console.log('\n=== STEP 2 COMPLETE — run forge-guard.mjs next ===');
