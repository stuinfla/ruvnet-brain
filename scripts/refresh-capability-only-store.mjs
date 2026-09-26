#!/usr/bin/env node
// Rebuild ruOS's release store from the curated capability summary, never from repository source.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorpus } from '../kb/forge-corpus.mjs';
import { loadRvf } from '../kb/resolve-deps.mjs';
import { CAPABILITY_RETIRED_SUFFIXES, isCapabilityOnly } from '../kb/capability-only.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'cognitum-ruos';
const MODEL = 'Xenova/bge-base-en-v1.5';
const DIMENSIONS = 768;

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function prepareCapabilityOnlyInputs(assetsDir) {
  const dir = path.resolve(assetsDir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`assets directory is invalid: ${dir}`);
  const corpus = buildCorpus({ repo: dir, name: NAME });
  if (corpus.chunks.length !== 1 || corpus.chunks[0].path !== 'CAPABILITIES.md'
    || corpus.chunks[0].kind !== 'doc') {
    throw new Error('curated ruOS source must produce exactly one CAPABILITIES.md document');
  }

  for (const suffix of CAPABILITY_RETIRED_SUFFIXES) fs.rmSync(path.join(dir, `${NAME}${suffix}`), { force: true });
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${NAME}.big.vecs.`) || file.startsWith(`${NAME}.big.progress.`)) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
  }
  const chunk = corpus.chunks[0];
  writeJsonLines(path.join(dir, `${NAME}.passages.jsonl`), [{
    id: chunk.id, text: chunk.text, path: chunk.path, title: chunk.title,
  }]);
  writeJson(path.join(dir, `${NAME}.meta.json`), {
    model: MODEL, dimensions: DIMENSIONS, metric: 'cosine', generated: new Date().toISOString(),
    entries: { [chunk.id]: { path: chunk.path, kind: chunk.kind, title: chunk.title, chunk: '1/1', preview: chunk.preview } },
  });
  return { dir, sourceText: chunk.text, id: chunk.id };
}

// Historical v4.3.26 Brain self-store embedded the implementation primer. Remove those
// vectors from the copied seed and bind the rewritten bytes before packaging.
export async function pruneCapabilityOnlySelfStore(assetsDir, { RvfDatabase = null } = {}) {
  const dir = path.resolve(assetsDir);
  const passagesFile = path.join(dir, 'ruvnet-brain.passages.jsonl');
  const metaFile = path.join(dir, 'ruvnet-brain.meta.json');
  const rvfFile = path.join(dir, 'ruvnet-brain.big.rvf');
  const ledgerFile = path.join(dir, 'RVF-GENERATIONS.json');
  const rows = fs.readFileSync(passagesFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const removed = rows.filter(row => /(?:^|\/)cognitum-ruos-primer\.md$/i.test(row.path || ''));
  if (!removed.length) return { removed: 0 };
  if (!RvfDatabase) ({ mod: { RvfDatabase } } = loadRvf());
  const db = await RvfDatabase.open(rvfFile);
  try {
    await db.delete(removed.map(row => row.id));
    await db.compact();
  } finally { await db.close(); }
  const kept = rows.filter(row => !removed.some(item => item.id === row.id));
  writeJsonLines(passagesFile, kept);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const removedIds = new Set(removed.map(row => row.id));
  for (const row of removed) {
    const entry = meta.entries?.[row.path];
    if (!entry) continue;
    entry.chunkIds = (entry.chunkIds || []).filter(id => !removedIds.has(id));
    if (!entry.chunkIds.length) delete meta.entries[row.path];
  }
  writeJson(metaFile, meta);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const bytes = fs.readFileSync(rvfFile);
  ledger.stores['ruvnet-brain'] = {
    ...ledger.stores['ruvnet-brain'],
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    builtUtc: new Date().toISOString(),
  };
  writeJson(ledgerFile, ledger);
  return { removed: removed.length };
}

function writeJsonLines(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

export function bindCapabilityOnlyGeneration(assetsDir, { builtUtc = new Date().toISOString() } = {}) {
  const dir = path.resolve(assetsDir);
  const rvfFile = path.join(dir, `${NAME}.big.rvf`);
  const metaFile = path.join(dir, `${NAME}.meta.json`);
  const ledgerFile = path.join(dir, 'RVF-GENERATIONS.json');
  const embedFile = path.join(dir, `${NAME}.big.rvf.embed.json`);
  const rvf = fs.readFileSync(rvfFile);
  const embed = JSON.parse(fs.readFileSync(embedFile, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (embed.model !== MODEL || embed.dimensions !== DIMENSIONS || Object.keys(meta.entries || {}).length !== 1) {
    throw new Error('rebuilt ruOS store does not match the 768-dim, one-summary contract');
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  if (!ledger || ![1, 2].includes(ledger.schemaVersion) || typeof ledger.stores !== 'object' || !ledger.stores) {
    throw new Error('seed runtime generation ledger is malformed');
  }
  const previous = ledger.stores[NAME] || {};
  ledger.stores[NAME] = {
    file: `${NAME}.big.rvf`,
    sha256: crypto.createHash('sha256').update(rvf).digest('hex'),
    bytes: rvf.length,
    model: MODEL,
    dimensions: DIMENSIONS,
    sourceCommit: previous.sourceCommit ?? null,
    builtUtc,
  };
  writeJson(ledgerFile, ledger);
  return ledger.stores[NAME];
}

export async function refreshCapabilityOnlyStore(assetsDir) {
  const { dir } = prepareCapabilityOnlyInputs(assetsDir);
  const selfStore = await pruneCapabilityOnlySelfStore(dir);
  const script = path.join(ROOT, 'kb/forge-big.mjs');
  const result = spawnSync(process.execPath, [script, 'both', '--dir', dir, '--name', NAME], {
    cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ruOS capability-only RVF build exited ${result.status}`);
  return { ...bindCapabilityOnlyGeneration(dir), selfStore };
}

async function main(argv) {
  const index = argv.indexOf('--assets');
  const assetsDir = index >= 0 ? argv[index + 1] : null;
  if (!assetsDir) throw new Error('Usage: refresh-capability-only-store.mjs --assets <seed-kb-directory>');
  if (!isCapabilityOnly(NAME)) throw new Error('configured store is not capability-only');
  const result = await refreshCapabilityOnlyStore(assetsDir);
  console.log(JSON.stringify({ store: NAME, ...result }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(`[capability-store] ${error.message}`); process.exitCode = 1; }
}
