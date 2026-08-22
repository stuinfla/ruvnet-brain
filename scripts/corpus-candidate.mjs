#!/usr/bin/env node
// Seal and independently verify the exact public corpus bytes used by a release.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { validatePublicInventory } from './public-inventory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_SUFFIXES = [
  '.big.rvf',
  '.big.rvf.idmap.json',
  '.big.rvf.embed.json',
  '.passages.jsonl',
  '.meta.json',
];
const OPTIONAL_SHIPPED_SUFFIXES = ['.big.passages.jsonl', '.big.meta.json'];

function fail(message) {
  throw new Error(`[corpus-candidate] ${message}`);
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} missing (${file || 'no path supplied'})`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} unreadable/corrupt (${error.message})`);
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fileIdentity(file) {
  return { file: path.basename(file), sha256: sha256File(file), bytes: fs.statSync(file).size };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function policyRows(policy) {
  if (Array.isArray(policy)) return policy;
  for (const key of ['sources', 'rows', 'repositories', 'repos']) {
    if (Array.isArray(policy?.[key])) return policy[key];
  }
  return [];
}

function assertPolicyCurrent(policy) {
  const rows = policyRows(policy);
  const stale = rows.filter((row) => row?.eligible !== false && row?.status !== 'CURRENT');
  if (stale.length) fail(`eligibility policy has ${stale.length} eligible row(s) that are not CURRENT`);
  return {
    eligibleRepoCount: rows.filter((row) => row?.eligible !== false && row?.status === 'CURRENT').length,
    gistCount: rows.filter((row) => /gist/i.test(String(row?.kind || row?.type || ''))).length,
  };
}

async function verifyArchive({ bundleFile, stores, privateStores }) {
  if (!bundleFile || !fs.existsSync(bundleFile)) fail(`bundle missing (${bundleFile || 'no path supplied'})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-candidate-'));
  try {
    let extraction;
    try {
      extraction = await extractZip(bundleFile, tmp);
    } catch (error) {
      fail(`cannot extract archive (${error.message})`);
    }
    const entries = extraction.entryNames;
    for (const privateStore of privateStores) {
      const escaped = privateStore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const privateFile = new RegExp(`(?:^|/)${escaped}(?:\\.|$)`, 'i');
      if (entries.some((entry) => privateFile.test(entry.replaceAll('\\', '/')))) {
        fail(`private store ${privateStore} is present in archive`);
      }
    }
    for (const store of stores) {
      for (const expected of store.files) {
        const matches = entries.filter((entry) => path.posix.basename(entry.replaceAll('\\', '/')) === expected.file);
        if (matches.length !== 1) fail(`archive must contain exactly one ${expected.file}; found ${matches.length}`);
        const extracted = path.join(tmp, ...matches[0].replaceAll('\\', '/').split('/'));
        if (sha256File(extracted) !== expected.sha256) fail(`archive ${expected.file} differs from canonical assets`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return fileIdentity(bundleFile);
}

async function buildReceipt({
  assetsDir,
  bundleFile,
  policyFile,
  builderSourceSha,
  createdAt,
}) {
  const assets = path.resolve(assetsDir || '');
  if (!fs.existsSync(assets) || !fs.statSync(assets).isDirectory()) fail(`assets directory missing (${assets})`);
  if (!/^[a-f0-9]{40,64}$/i.test(builderSourceSha || '')) fail('builderSourceSha must be a 40-64 hex source identity');

  const fenceFile = path.join(assets, 'PRIVATE-STORES.json');
  const fence = readJson(fenceFile, 'private fence');
  if (!Array.isArray(fence.privateStores)) fail('private fence has no privateStores array');
  const privateStores = [...new Set(fence.privateStores.map((name) => String(name).toLowerCase()))].sort();
  const privateSet = new Set(privateStores);
  const ledgerFile = path.join(assets, 'RVF-GENERATIONS.json');
  const ledger = readJson(ledgerFile, 'RVF generation ledger');
  if (!ledger.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
    fail('RVF generation ledger has no stores object');
  }
  const policy = readJson(path.resolve(policyFile || ''), 'eligibility policy');

  const rvfFiles = fs.readdirSync(assets).filter((name) => /^.+\.big\.rvf$/.test(name)).sort();
  const rvfByStore = new Map(rvfFiles.map((file) => [file.slice(0, -'.big.rvf'.length), file]));
  const unreceipted = [...rvfByStore.keys()].filter((store) => !ledger.stores[store]);
  if (unreceipted.length) fail(`unreceipted RVF files: ${unreceipted.join(', ')}`);
  const orphanLedger = Object.entries(ledger.stores)
    .filter(([store, generation]) => generation.file !== `${store}.big.rvf` || !rvfByStore.has(store))
    .map(([store]) => store);
  if (orphanLedger.length) fail(`ledger rows without RVFs: ${orphanLedger.join(', ')}`);

  const digestOwners = new Map();
  for (const [store, file] of rvfByStore) {
    const digest = sha256File(path.join(assets, file));
    const owners = digestOwners.get(digest) || [];
    owners.push(store);
    digestOwners.set(digest, owners);
  }
  const duplicateRvfDigests = [...digestOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([sha256, owners]) => ({ sha256, stores: owners.sort() }));
  if (duplicateRvfDigests.length) fail(`duplicate RVF bytes: ${duplicateRvfDigests.map((row) => row.stores.join('/')).join(', ')}`);
  const publicInventory = validatePublicInventory({ assetsDir: assets, coverage: policy, ledger });
  const counts = assertPolicyCurrent(policy);

  const missingSidecars = [];
  const stores = [];
  for (const [store, rvfFile] of [...rvfByStore].sort(([a], [b]) => a.localeCompare(b))) {
    const generation = ledger.stores[store];
    const rvfPath = path.join(assets, rvfFile);
    if (generation.file !== rvfFile || generation.sha256 !== sha256File(rvfPath) || generation.bytes !== fs.statSync(rvfPath).size) {
      fail(`${store}: generation receipt does not match RVF bytes`);
    }
    if (!generation.sourceCommit || !generation.builtUtc || !generation.model || !Number.isInteger(generation.dimensions)) {
      fail(`${store}: generation receipt lacks sourceCommit, builtUtc, model, or dimensions provenance`);
    }
    if (privateSet.has(store.toLowerCase())) continue;
    const files = [];
    for (const suffix of REQUIRED_SUFFIXES) {
      const file = path.join(assets, `${store}${suffix}`);
      if (!fs.existsSync(file)) missingSidecars.push(path.basename(file));
      else files.push(fileIdentity(file));
    }
    for (const suffix of OPTIONAL_SHIPPED_SUFFIXES) {
      const file = path.join(assets, `${store}${suffix}`);
      if (fs.existsSync(file)) files.push(fileIdentity(file));
    }
    stores.push({
      name: store,
      sourceCommit: generation.sourceCommit,
      builtUtc: generation.builtUtc,
      model: generation.model,
      dimensions: generation.dimensions,
      files,
    });
  }
  if (missingSidecars.length) fail(`missing sidecars: ${missingSidecars.join(', ')}`);
  if (!stores.length) fail('zero public corpus stores remain after the private fence');
  const finalByteFiles = stores.flatMap((store) => store.files.map((file) => ({ store: store.name, ...file })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.store.localeCompare(b.store));
  const finalBytePartitionSha256 = crypto.createHash('sha256').update(canonicalJson({
    publicInventoryPartitionSha256: publicInventory.partitionSha256,
    publicStores: publicInventory.publicStores,
    files: finalByteFiles,
  })).digest('hex');
  const archive = await verifyArchive({ bundleFile: path.resolve(bundleFile || ''), stores, privateStores });
  const policyIdentity = fileIdentity(path.resolve(policyFile));
  const fenceIdentity = fileIdentity(fenceFile);
  const ledgerIdentity = fileIdentity(ledgerFile);
  const coverageGeneration = String(policy.coverageGeneration || policy.generation || policy.generated || policyIdentity.sha256);

  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-corpus-candidate',
    builderSourceSha: builderSourceSha.toLowerCase(),
    createdAt,
    coverageGeneration,
    eligibleRepoCount: counts.eligibleRepoCount,
    gistCount: counts.gistCount,
    storeCount: stores.length,
    stores,
    privateFence: fenceIdentity,
    eligibilityPolicy: policyIdentity,
    generationLedger: ledgerIdentity,
    publicInventory,
    finalBytePartitionSha256,
    excludedPrivateStores: privateStores.filter((privateStore) =>
      [...rvfByStore.keys()].some((store) => store.toLowerCase() === privateStore)),
    duplicateRvfDigests,
    unreceiptedRvfFiles: [],
    missingSidecars: [],
    archive,
    generator: { corpusCandidateSha256: sha256File(fileURLToPath(import.meta.url)) },
  };
}

function currentGitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(HERE, '..'), encoding: 'utf8' });
  if (result.status !== 0) fail('cannot determine builder source SHA');
  return result.stdout.trim();
}

export async function createCorpusReceipt(options) {
  const receiptFile = path.resolve(options.receiptFile || 'dist/corpus-receipt.json');
  const receipt = await buildReceipt({
    ...options,
    builderSourceSha: options.builderSourceSha || currentGitSha(),
    createdAt: options.createdAt || new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: options.overwrite === false ? 'wx' : 'w' });
  return receipt;
}

export async function verifyCorpusReceipt(options) {
  const receipt = readJson(path.resolve(options.receiptFile || ''), 'corpus receipt');
  if (receipt.kind !== 'ruvnet-brain-corpus-candidate' || receipt.schemaVersion !== 1) fail('unsupported corpus receipt');
  const exactFiles = [
    ['archive', path.resolve(options.bundleFile || '')],
    ['eligibility policy', path.resolve(options.policyFile || '')],
    ['private fence', path.join(path.resolve(options.assetsDir || ''), 'PRIVATE-STORES.json')],
    ['generation ledger', path.join(path.resolve(options.assetsDir || ''), 'RVF-GENERATIONS.json')],
  ];
  for (const [label, file] of exactFiles) {
    if (!fs.existsSync(file)) fail(`${label} missing (${file})`);
    const expected = label === 'archive'
      ? receipt.archive
      : label === 'eligibility policy'
        ? receipt.eligibilityPolicy
        : label === 'private fence'
          ? receipt.privateFence
          : receipt.generationLedger;
    if (sha256File(file) !== expected?.sha256) fail(`${label} sha256 differs from receipt`);
    if (fs.statSync(file).size !== expected?.bytes) fail(`${label} byte length differs from receipt`);
  }
  const actual = await buildReceipt({
    ...options,
    builderSourceSha: receipt.builderSourceSha,
    createdAt: receipt.createdAt,
  });
  if (canonicalJson(actual) !== canonicalJson(receipt)) fail('receipt does not match the exact corpus inputs');
  return receipt;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const mode = process.argv.includes('--verify') ? 'verify' : 'create';
  const options = {
    assetsDir: arg('--assets', 'kb'),
    bundleFile: arg('--bundle', 'dist/ruvnet-brain.zip'),
    policyFile: arg('--policy'),
    receiptFile: arg('--receipt', arg('--out', 'dist/corpus-receipt.json')),
    builderSourceSha: arg('--builder-source-sha'),
  };
  const receipt = mode === 'verify' ? await verifyCorpusReceipt(options) : await createCorpusReceipt(options);
  console.log(JSON.stringify({ ok: true, mode, archive: receipt.archive, stores: receipt.storeCount }, null, 2));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
