#!/usr/bin/env node
// forge-refresh.mjs — transactional, incremental refresh for one repository segment.
//
// The first run against a legacy sequential-ID store performs one clean staged rebuild. Later
// runs derive stable IDs from repository/path/chunk ordinal/content, embed only IDs entering the
// corpus, retire IDs leaving it, QA the complete candidate, then promote the whole artifact set
// under a short reader-visible lock. The live store is never mutated in place.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCorpus, FORGE_BUILD_FINGERPRINT } from './forge-corpus.mjs';
import { buildForkDeltaCorpus } from './fork-source.mjs';
import {
  buildCorpusLedger,
  chunkDelta,
  planLegacyDelta,
  planLegacyRekey,
  planIncrementalRefresh,
  promoteArtifactSet,
  rekeyStagedIdmap,
  stageRvfDelta,
} from './incremental-refresh.mjs';
import { chooseModelCache, loadRvf, loadTransformers } from './resolve-deps.mjs';
import { getVersion, getVersionTag } from '../scripts/version.mjs';
import { RVF_GENERATIONS_FILE, writeRvfGeneration } from '../scripts/rvf-generation.mjs';
const BGE = {
  model: 'Xenova/bge-base-en-v1.5',
  revision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
  dimensions: 768,
  pooling: 'cls',
};

const arg = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const REPO = arg('--repo');
const OUT = arg('--out');
const NAME = arg('--name');
const FULL = (arg('--full', '') || '').split(',').map((value) => value.trim()).filter(Boolean);
const KEEP = (arg('--keep', '') || '').split(',').map((value) => value.trim()).filter(Boolean);
const CANONICAL_URL = (arg('--canonical-url', '') || '').replace(/\/+$/, '');
const STRUCTURAL_ONLY = process.argv.includes('--structural-only');
const FORK_DELTA_FILE = arg('--fork-delta');
if (!REPO || !OUT || !NAME) {
  console.error('Usage: node forge-refresh.mjs --repo <repo> --out <dir> --name <kb-name> [--full a,b] [--keep v2] [--fork-delta metadata.json]');
  process.exit(2);
}

const KB_DIR = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(REPO);
const out = path.resolve(OUT);
const candidate = fs.mkdtempSync(path.join(path.dirname(out), `.forge-${NAME}-candidate-`));
const env = { ...process.env };
let sourceProvenance = null;

const artifactFiles = [
  `${NAME}.passages.jsonl`,
  `${NAME}.meta.json`,
  `${NAME}.big.rvf`,
  `${NAME}.big.rvf.idmap.json`,
  `${NAME}.big.rvf.embed.json`,
  'SOURCE.json',
  RVF_GENERATIONS_FILE,
];
if (FORK_DELTA_FILE) artifactFiles.push(`${NAME}.fork-delta.inventory.json`);

const run = (script, args, options = {}) => execFileSync(process.execPath, [script, ...args], {
  cwd: KB_DIR,
  env,
  stdio: 'inherit',
  ...options,
});

async function runBigFull() {
  const configured = Number.parseInt(process.env.RUVNET_BIG_SHARDS || '', 10);
  const shards = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
  console.log(`[refresh] full big rebuild using ${shards} shard(s)`);
  if (shards === 1) {
    run('forge-big.mjs', ['both', '--dir', candidate, '--name', NAME]);
    return;
  }
  await Promise.all(Array.from({ length: shards }, (_, index) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [
      'forge-big.mjs', 'embed', '--dir', candidate, '--name', NAME,
      '--shard', String(index), '--of', String(shards),
    ], { cwd: KB_DIR, env });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`big embed shard ${index}/${shards} exited ${code ?? signal}`)));
  })));
  run('forge-big.mjs', ['ingest', '--dir', candidate, '--name', NAME]);
}

function previousChunks(ledger) {
  return Object.entries(ledger?.files || {}).flatMap(([sourcePath, file]) =>
    (file.chunkIds || []).map((id) => ({ id, path: sourcePath })),
  );
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function gitInfo(repoDir) {
  const git = (args) => {
    try { return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  return {
    sha: git(['rev-parse', 'HEAD']),
    describe: git(['describe', '--tags', '--always']),
    remote: git(['config', '--get', 'remote.origin.url']),
  };
}

function releasesApiUrl(canonicalBase) {
  const match = canonicalBase?.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  return match ? `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest` : null;
}

function writeSourceManifest() {
  const liveSource = path.join(out, 'SOURCE.json');
  let source = { builder: 'rvf-kb-forge', stores: {} };
  if (fs.existsSync(liveSource)) {
    try { source = JSON.parse(fs.readFileSync(liveSource, 'utf8')); } catch { /* rebuild below */ }
  }
  const builtUtc = new Date().toISOString();
  const provenance = gitInfo(root);
  const manifestUrl = releasesApiUrl(CANONICAL_URL);
  source.builder = 'rvf-kb-forge';
  source.brainVersion = getVersion();
  source.releaseTag = getVersionTag();
  source.builtUtc = builtUtc;
  source.canonicalManifestUrl = manifestUrl;
  source.selfUpdate = 'node forge-update.mjs';
  source.stores ||= {};
  source.stores[NAME] = {
    kbName: NAME,
    sourceRepo: provenance.remote || root,
    sourceCommit: provenance.sha,
    sourceDescribe: provenance.describe,
    builtUtc,
    builder: 'rvf-kb-forge',
    canonicalManifestUrl: manifestUrl,
    canonicalBundleUrl: CANONICAL_URL ? `${CANONICAL_URL}/${NAME}-kb-bundle.zip` : null,
    selfUpdate: `node forge-update.mjs ${NAME}`,
    ...(sourceProvenance ? {
      sourceMode: 'fork-delta',
      forkDelta: {
        version: sourceProvenance.version,
        forkRepository: sourceProvenance.forkRepository,
        upstream: sourceProvenance.upstream,
        upstreamHeadSha: sourceProvenance.upstreamHeadSha,
        forkHeadSha: sourceProvenance.forkHeadSha,
        mergeBaseSha: sourceProvenance.mergeBaseSha,
        aheadBy: sourceProvenance.aheadBy,
        behindBy: sourceProvenance.behindBy,
        inventorySha256: sourceProvenance.inventorySha256,
        passagesSha256: sourceProvenance.passagesSha256,
      },
    } : {}),
  };
  fs.writeFileSync(path.join(candidate, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
}

function writeCandidateSidecars(chunks, corpus, ledger, previousMeta) {
  const passages = chunks.map(({ id, text, path: sourcePath, title, operation }) =>
    JSON.stringify({ id, text, path: sourcePath, title, ...(operation ? { operation } : {}) })).join('\n') + '\n';
  const entries = Object.fromEntries(chunks.map((chunk) => [chunk.id, {
    path: chunk.path,
    kind: chunk.kind,
    title: chunk.title,
    chunk: `${chunk.chunk}/${chunk.of}`,
    preview: chunk.preview,
    ...(chunk.operation ? { operation: chunk.operation } : {}),
    ...(sourceProvenance ? { sourceMode: 'fork-delta', forkDelta: sourceProvenance } : {}),
  }]));
  const generated = new Date().toISOString();
  const meta = {
    ...previousMeta,
    model: BGE.model,
    dimensions: BGE.dimensions,
    metric: 'cosine',
    generated,
    repo: root,
    name: NAME,
    census: corpus.census,
    corpusCounts: corpus.counts,
    coveredPaths: corpus.coveredPaths,
    intentionallySkipped: corpus.intentionallySkipped,
    ...(sourceProvenance ? { sourceMode: 'fork-delta', forkDelta: sourceProvenance } : {}),
    incremental: ledger,
    entries,
  };
  fs.writeFileSync(path.join(candidate, `${NAME}.passages.jsonl`), passages);
  if (sourceProvenance) {
    fs.copyFileSync(path.join(candidate, 'fork-delta.inventory.json'), path.join(candidate, `${NAME}.fork-delta.inventory.json`));
  }
  fs.writeFileSync(path.join(candidate, `${NAME}.meta.json`), JSON.stringify(meta));
  writeSourceManifest();
}

async function embedChunks(chunks, config) {
  if (!chunks.length) return [];
  const { T } = await loadTransformers();
  const cache = chooseModelCache();
  T.env.localModelPath = cache;
  T.env.allowRemoteModels = !fs.existsSync(path.join(cache, config.model));
  const pipeline = await T.pipeline('feature-extraction', config.model, {
    quantized: true,
    revision: config.revision,
  });
  const rows = [];
  const batchSize = 32;
  for (let index = 0; index < chunks.length; index += batchSize) {
    const batch = chunks.slice(index, index + batchSize);
    const texts = batch.map(({ text }) => text);
    const result = await pipeline(texts, { pooling: config.pooling, normalize: true });
    if (result.dims[1] !== config.dimensions) {
      throw new Error(`${config.model} returned ${result.dims[1]} dimensions, expected ${config.dimensions}`);
    }
    for (let offset = 0; offset < batch.length; offset++) {
      rows.push({
        id: batch[offset].id,
        vector: Array.from(result.data.slice(offset * config.dimensions, (offset + 1) * config.dimensions)),
      });
    }
    console.log(`[refresh] ${config.model}: ${Math.min(index + batch.length, chunks.length)}/${chunks.length} changed chunks`);
  }
  return rows;
}

function validateDeltaResult(label, result, expectedVectors) {
  if (result.rejected !== 0 || result.totalVectors !== expectedVectors) {
    throw new Error(`${label} reconcile failed: vectors=${result.totalVectors}, expected=${expectedVectors}, rejected=${result.rejected}`);
  }
}

function removeLegacyDuplicates() {
  for (const file of [
    `${NAME}.rvf`,
    `${NAME}.rvf.idmap.json`,
    `${NAME}.rvf.embed.json`,
    `${NAME}.big.passages.jsonl`,
    `${NAME}.big.meta.json`,
  ]) {
    fs.rmSync(path.join(out, file), { force: true });
  }
}

async function qaCandidate() {
  const qaArgs = ['../scripts/corpus-qa.mjs', '--dir', candidate, '--store', NAME];
  if (STRUCTURAL_ONLY) qaArgs.push('--structural');
  run(qaArgs.shift(), qaArgs);
}

function stampCandidateGeneration() {
  const manifest = writeRvfGeneration({
    dir: candidate,
    previousDir: out,
    store: NAME,
    model: BGE.model,
    dimensions: BGE.dimensions,
    sourceCommit: gitInfo(root).sha,
  });
  if (sourceProvenance) {
    const file = path.join(candidate, RVF_GENERATIONS_FILE);
    const generations = JSON.parse(fs.readFileSync(file, 'utf8'));
    generations.stores[NAME] = { ...manifest, sourceMode: 'fork-delta', forkDelta: sourceProvenance };
    fs.writeFileSync(file, `${JSON.stringify(generations, null, 2)}\n`);
  }
}

async function fullRefresh(reason, corpus, previousMeta, currentLedger) {
  console.log(`[refresh] safe full fallback: ${reason}`);
  writeCandidateSidecars(corpus.chunks, corpus, currentLedger, previousMeta);
  await runBigFull();
  stampCandidateGeneration();
  await qaCandidate();
  promoteArtifactSet({ liveDir: out, candidateDir: candidate, files: artifactFiles });
  removeLegacyDuplicates();
}

async function incrementalRefresh(corpus, previousMeta, currentLedger) {
  const before = previousChunks(previousMeta.incremental);
  const delta = chunkDelta(before, corpus.chunks);
  const insertSet = new Set(delta.insertIds);
  const inserts = corpus.chunks.filter(({ id }) => insertSet.has(String(id)));
  console.log(`[refresh] incremental: keep=${corpus.chunks.length - inserts.length}, add=${inserts.length}, delete=${delta.deleteIds.length}`);

  const { mod: rvf } = loadRvf();
  const bigVectors = await embedChunks(inserts, BGE);
  const big = await stageRvfDelta({
    sourcePath: path.join(out, `${NAME}.big.rvf`),
    stagePath: path.join(candidate, `${NAME}.big.rvf`),
    deleteIds: delta.deleteIds,
    inserts: bigVectors,
    dimensions: BGE.dimensions,
    RvfDatabase: rvf.RvfDatabase,
  });
  validateDeltaResult('big', big, corpus.chunks.length);
  writeCandidateSidecars(corpus.chunks, corpus, currentLedger, previousMeta);
  fs.copyFileSync(
    path.join(out, `${NAME}.big.rvf.embed.json`),
    path.join(candidate, `${NAME}.big.rvf.embed.json`),
  );
  stampCandidateGeneration();
  await qaCandidate();
  promoteArtifactSet({ liveDir: out, candidateDir: candidate, files: artifactFiles });
  removeLegacyDuplicates();
}

async function migrateLegacyStore(corpus, previousMeta, currentLedger) {
  const rvf = path.join(out, `${NAME}.big.rvf`);
  const idmapFile = `${rvf}.idmap.json`;
  const embedFile = `${rvf}.embed.json`;
  const legacyPassages = [
    path.join(out, `${NAME}.big.passages.jsonl`),
    path.join(out, `${NAME}.passages.jsonl`),
  ].find((file) => fs.existsSync(file));
  if (!legacyPassages || ![rvf, idmapFile, embedFile].every((file) => fs.existsSync(file))) {
    return { migrated: false, reason: 'legacy-artifacts-incomplete' };
  }
  const rekey = planLegacyRekey({
    passages: readJsonl(legacyPassages),
    chunks: corpus.chunks,
    idmap: JSON.parse(fs.readFileSync(idmapFile, 'utf8')),
  });
  if (rekey.ok) {
    console.log(`[refresh] zero-embed migration: re-keying ${corpus.chunks.length} existing BGE vectors`);
    fs.copyFileSync(rvf, path.join(candidate, `${NAME}.big.rvf`));
    fs.writeFileSync(
      path.join(candidate, `${NAME}.big.rvf.idmap.json`),
      `${JSON.stringify(rekey.idmap)}\n`,
    );
  } else {
    const passages = readJsonl(legacyPassages);
    const legacyMap = JSON.parse(fs.readFileSync(idmapFile, 'utf8'));
    const delta = planLegacyDelta({ passages, chunks: corpus.chunks, idmap: legacyMap });
    if (!delta.ok) return { migrated: false, reason: delta.reason };
    const insertSet = new Set(delta.insertIds);
    const inserts = corpus.chunks.filter(({ id }) => insertSet.has(String(id)));
    console.log(`[refresh] legacy incremental migration: keep=${delta.matches.length}, add=${inserts.length}, delete=${delta.deleteIds.length}`);
    const { mod: rvfMod } = loadRvf();
    const vectors = await embedChunks(inserts, BGE);
    const result = await stageRvfDelta({
      sourcePath: rvf,
      stagePath: path.join(candidate, `${NAME}.big.rvf`),
      deleteIds: delta.deleteIds,
      inserts: vectors,
      dimensions: BGE.dimensions,
      RvfDatabase: rvfMod.RvfDatabase,
    });
    validateDeltaResult('legacy-big', result, corpus.chunks.length);
    const stageMapFile = path.join(candidate, `${NAME}.big.rvf.idmap.json`);
    const staged = JSON.parse(fs.readFileSync(stageMapFile, 'utf8'));
    const stableMap = rekeyStagedIdmap({
      staged,
      matches: delta.matches,
      insertedIds: delta.insertIds,
    });
    fs.writeFileSync(stageMapFile, `${JSON.stringify(stableMap)}\n`);
  }
  fs.copyFileSync(embedFile, path.join(candidate, `${NAME}.big.rvf.embed.json`));
  writeCandidateSidecars(corpus.chunks, corpus, currentLedger, previousMeta);
  stampCandidateGeneration();
  await qaCandidate();
  promoteArtifactSet({ liveDir: out, candidateDir: candidate, files: artifactFiles });
  removeLegacyDuplicates();
  return { migrated: true, reason: null };
}

try {
  fs.mkdirSync(out, { recursive: true });
  let corpus;
  if (FORK_DELTA_FILE) {
    const metadata = JSON.parse(fs.readFileSync(path.resolve(FORK_DELTA_FILE), 'utf8'));
    const delta = await buildForkDeltaCorpus({ repo: root, name: NAME, metadata, outputDir: candidate });
    sourceProvenance = {
      version: delta.version, forkRepository: delta.forkRepository, upstream: delta.upstream,
      upstreamHeadSha: delta.upstreamHeadSha, forkHeadSha: delta.forkHeadSha, mergeBaseSha: delta.mergeBaseSha,
      aheadBy: delta.aheadBy, behindBy: delta.behindBy, inventorySha256: delta.inventorySha256,
      passagesSha256: delta.passagesSha256,
    };
    const operationCount = Math.max(delta.operations.length, 1);
    corpus = { ...delta, census: { 'fork-delta': operationCount }, counts: { 'fork-delta': operationCount },
      intentionallySkipped: [], coveredPaths: new Set(delta.operations.map((operation) => operation.paths.at(-1))).size };
  } else {
    corpus = buildCorpus({ repo: root, name: NAME, fullPrefixes: FULL, keepNames: KEEP });
  }
  if (!corpus.chunks.length) throw new Error('0 chunks produced; refusing to replace a live store');
  const currentLedger = buildCorpusLedger(corpus.chunks, {
    buildFingerprint: sourceProvenance
      ? `${FORGE_BUILD_FINGERPRINT}|${sourceProvenance.version}|${sourceProvenance.inventorySha256}|${sourceProvenance.passagesSha256}`
      : FORGE_BUILD_FINGERPRINT,
  });
  const metaPath = path.join(out, `${NAME}.meta.json`);
  const previousMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  const plan = planIncrementalRefresh({
    previous: previousMeta?.incremental,
    current: currentLedger,
  });
  const completeLiveSet = artifactFiles.every((file) => fs.existsSync(path.join(out, file)));
  if (FORK_DELTA_FILE) {
    await fullRefresh('fork-delta-source', corpus, previousMeta, currentLedger);
  } else if (!previousMeta?.incremental) {
    const migration = await migrateLegacyStore(corpus, previousMeta, currentLedger);
    if (!migration.migrated) {
      await fullRefresh(migration.reason || 'no-incremental-ledger', corpus, previousMeta, currentLedger);
    }
  } else if (!completeLiveSet || plan.mode === 'full') {
    await fullRefresh(
      !completeLiveSet ? 'missing-live-artifact' : plan.reason || 'no-incremental-ledger',
      corpus,
      previousMeta,
      currentLedger,
    );
  } else {
    await incrementalRefresh(corpus, previousMeta, currentLedger);
  }
  console.log(`[refresh] complete: ${NAME}`);
} finally {
  fs.rmSync(candidate, { recursive: true, force: true });
}
