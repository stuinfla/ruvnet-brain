#!/usr/bin/env node
// Build a corpus candidate from one immutable seed and exact upstream repository SHAs.
// This module deliberately has no publication capability. The protected-release workflow owns
// the only legal call to corpus-seed-publish.mjs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { FULL_HINTS, KEEP_DIRS } from './full-hints.mjs';
import { observeSourceUniverse, sourceObservationDigest } from './source-coverage.mjs';
import { reconcileGistReceipts } from './gist-receipts.mjs';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_STORE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STORE_ARTIFACT_SUFFIXES = [
  '.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.big.passages.jsonl',
  '.big.meta.json', '.passages.jsonl', '.meta.json',
];
const REQUIRED_STORE_ARTIFACT_SUFFIXES = [
  '.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json',
];

function fail(message) {
  throw new Error(`[corpus-reconcile] ${message}`);
}

function sha256File(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`seed archive missing (${file || 'no path supplied'})`);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} missing (${file || 'no path supplied'})`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} unreadable (${error.message})`);
  }
}

export function assertBootstrapIdentity({ archiveFile, tag, sha256, allowPinnedTag = false }) {
  const expected = String(sha256 || '').toLowerCase();
  if (!HEX64.test(expected) || (!allowPinnedTag && tag !== `corpus-sha256-${expected}`) || !tag || tag === 'latest') {
    fail('bootstrap requires the exact digest-derived tag corpus-sha256-<configured sha256>; latest is forbidden');
  }
  const actual = sha256File(path.resolve(archiveFile || ''));
  if (actual !== expected) fail(`downloaded archive sha256 ${actual} differs from configured ${expected}`);
  return { tag, sha256: expected };
}

function filesNamed(root, wanted) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === wanted) found.push(file);
    }
  };
  visit(root);
  return found;
}

export function normalizeExtractedCorpus({ extractedDir, assetsDir }) {
  const extracted = path.resolve(extractedDir || '');
  const assets = path.resolve(assetsDir || '');
  if (!fs.existsSync(extracted) || !fs.statSync(extracted).isDirectory()) {
    fail(`extracted seed directory missing (${extracted})`);
  }
  if (fs.existsSync(assets) && fs.readdirSync(assets).length) fail(`bootstrap assets directory is not empty (${assets})`);
  const ledgers = filesNamed(extracted, 'RVF-GENERATIONS.json');
  if (ledgers.length !== 1) fail(`seed archive must contain exactly one RVF-GENERATIONS.json; found ${ledgers.length}`);
  const corpusRoot = path.dirname(ledgers[0]);
  if (fs.existsSync(path.join(corpusRoot, 'PRIVATE-STORES.json'))) {
    fail('a published seed must not supply a private-store fence; the exact builder checkout owns that policy');
  }
  fs.mkdirSync(assets, { recursive: true });
  for (const entry of fs.readdirSync(corpusRoot)) fs.renameSync(path.join(corpusRoot, entry), path.join(assets, entry));
  return assets;
}

function repositorySlug(url) {
  const match = String(url || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function planReconciliation({ coverage, ledger, assetsDir = null }) {
  if (coverage?.schemaVersion !== 1 || !Array.isArray(coverage.rows) || !coverage.coverageGeneration) {
    fail('coverage policy is missing a supported complete generation');
  }
  if (!ledger?.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
    fail('RVF generation ledger has no stores object');
  }
  const eligible = coverage.rows.filter((row) => row?.kind === 'repository' && row?.disposition === 'eligible');
  const seen = new Set();
  const plan = [];
  for (const row of eligible) {
    const store = String(row?.artifact?.store || '');
    if (!SAFE_STORE.test(store)) fail(`${row?.name || row?.key || 'eligible repository'} has an unsafe or missing store name`);
    const folded = store.toLowerCase();
    if (seen.has(folded)) fail(`duplicate eligible store ${store} in coverage policy`);
    seen.add(folded);
    const upstreamSha = String(row?.upstream?.sha || '').toLowerCase();
    if (!HEX40.test(upstreamSha)) fail(`${row?.name || store} has a missing or malformed upstream SHA`);
    if (!repositorySlug(row.url)) fail(`${row?.name || store} has no exact GitHub repository URL`);
    const generation = Object.entries(ledger.stores).find(([name]) => name.toLowerCase() === folded)?.[1] || null;
    const current = String(generation?.sourceCommit || '').toLowerCase();
    let reason = generation?.sourceCommit ? 'sourceCommit differs' : 'missing ledger receipt';
    if (current === upstreamSha) {
      if (!assetsDir) continue;
      const expectedFile = `${store}.big.rvf`;
      const rvfFile = path.join(path.resolve(assetsDir), expectedFile);
      const receiptMatches = generation?.file === expectedFile
        && fs.existsSync(rvfFile)
        && generation?.bytes === fs.statSync(rvfFile).size
        && generation?.sha256 === sha256File(rvfFile);
      if (receiptMatches) continue;
      reason = 'generation receipt differs from seed bytes';
    }
    plan.push({
      name: String(row.name || store),
      store,
      url: row.url,
      upstreamSha,
      ledgerSourceCommit: generation?.sourceCommit || null,
      reason,
    });
  }
  return plan.sort((a, b) => a.store.localeCompare(b.store));
}

export async function reconcileUntilStable({ maxRounds = 3, assetsDir = null, observe, build, readLedger: currentLedger,
  execute, prune, rebuild } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10
    || [observe, build, currentLedger, execute, prune, rebuild].some((fn) => typeof fn !== 'function')) {
    fail('bounded reconciliation loop configuration is invalid');
  }
  const rounds = [];
  let observation = await observe();
  for (let round = 1; round <= maxRounds; round += 1) {
    const preliminary = await build(observation);
    const plan = planReconciliation({ coverage: preliminary, ledger: currentLedger(), assetsDir });
    const reconciliation = await execute(plan, round);
    const pruning = await prune(preliminary, round);
    let aggregates;
    try {
      aggregates = await rebuild(preliminary, observation, round);
    } catch (error) {
      if (error?.code !== 'GIST_OBSERVATION_MOVED') throw error;
      const nextObservation = await observe();
      rounds.push({ round, before: observation.observationSha256, after: nextObservation.observationSha256,
        plan, ...reconciliation, ...pruning, rebuilt: [], invalidated: {
          reason: 'gist observation moved during exact detail fetch', gistId: error.gistId || null } });
      observation = nextObservation;
      continue;
    }
    const nextObservation = await observe();
    rounds.push({ round, before: observation.observationSha256, after: nextObservation.observationSha256,
      plan, ...reconciliation, ...pruning, ...aggregates });
    if (nextObservation.observationSha256 === observation.observationSha256) {
      const coverage = await build(nextObservation);
      const remaining = planReconciliation({ coverage, ledger: currentLedger(), assetsDir });
      if (remaining.length) fail(`reconciliation stabilized with ${remaining.length} unresolved repository artifact(s)`);
      const unresolved = coverage.rows.filter((row) => row.disposition === 'eligible' && row.status !== 'CURRENT');
      if (unresolved.length) fail(`reconciliation stabilized with ${unresolved.length} unresolved eligible source(s)`);
      return { observation: nextObservation, coverage, rounds };
    }
    observation = nextObservation;
  }
  fail(`source observation did not stabilize within ${maxRounds} reconciliation rounds`);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function checked(run, command, args, options = {}) {
  const result = run(command, args, options) || {};
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
    fail(`${command} ${args.join(' ')} failed${detail ? ` (${detail})` : ''}`);
  }
  return result;
}

function defaultRunAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const inherited = options.stdio === 'inherit';
    const child = spawn(command, args, { ...options, encoding: undefined,
      stdio: inherited ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (!inherited) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', (error) => resolve({ status: null, error, stdout, stderr }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function checkedAsync(run, command, args, options = {}) {
  const result = await run(command, args, options) || {};
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
    fail(`${command} ${args.join(' ')} failed${detail ? ` (${detail})` : ''}`);
  }
  return result;
}

const storeArtifacts = (store) => STORE_ARTIFACT_SUFFIXES.map((suffix) => `${store}${suffix}`);

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function seedWorkerAssets({ assets, output, store, ledger, source }) {
  fs.mkdirSync(output, { recursive: true });
  for (const name of storeArtifacts(store)) {
    const input = path.join(assets, name);
    if (!fs.existsSync(input)) continue;
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${store}: canonical seed artifact is not a regular file (${name})`);
    fs.copyFileSync(input, path.join(output, name));
  }
  writeJsonAtomic(path.join(output, 'RVF-GENERATIONS.json'), {
    ...ledger, stores: ledger.stores?.[store] ? { [store]: ledger.stores[store] } : {},
  });
  writeJsonAtomic(path.join(output, 'SOURCE.json'), {
    ...(source || { builder: 'rvf-kb-forge' }), stores: source?.stores?.[store] ? { [store]: source.stores[store] } : {},
  });
}

function validateWorkerOutput({ output, item }) {
  const allowed = new Set([...storeArtifacts(item.store), 'RVF-GENERATIONS.json', 'SOURCE.json']);
  const names = fs.readdirSync(output).filter((name) => !name.startsWith('._')).sort();
  const unexpected = names.filter((name) => !allowed.has(name));
  if (unexpected.length) fail(`${item.store}: worker emitted unexpected artifact(s): ${unexpected.join(', ')}`);
  const caseFolded = names.map((name) => name.toLowerCase());
  if (new Set(caseFolded).size !== names.length) fail(`${item.store}: worker emitted case-fold aliases`);
  for (const name of names) {
    const stat = fs.lstatSync(path.join(output, name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${item.store}: worker artifact is not a regular file (${name})`);
  }
  for (const suffix of REQUIRED_STORE_ARTIFACT_SUFFIXES) {
    if (!names.includes(`${item.store}${suffix}`)) fail(`${item.store}: worker artifact family is incomplete (${suffix})`);
  }
  const ledger = readJson(path.join(output, 'RVF-GENERATIONS.json'), `${item.store} worker ledger`);
  const ledgerStores = Object.keys(ledger.stores || {});
  if (ledgerStores.length !== 1 || ledgerStores[0] !== item.store) fail(`${item.store}: worker ledger must contain exactly its own store`);
  const generation = ledger.stores[item.store];
  const expectedRvf = `${item.store}.big.rvf`;
  if (generation?.file !== expectedRvf || String(generation.sourceCommit || '').toLowerCase() !== item.upstreamSha
    || !fs.existsSync(path.join(output, expectedRvf))
    || generation.sha256 !== sha256File(path.join(output, expectedRvf))
    || generation.bytes !== fs.statSync(path.join(output, expectedRvf)).size) {
    fail(`${item.store}: worker generation does not bind exact source and RVF bytes`);
  }
  const source = readJson(path.join(output, 'SOURCE.json'), `${item.store} worker source manifest`);
  if (Object.keys(source.stores || {}).length !== 1 || !source.stores[item.store]
    || String(source.stores[item.store].sourceCommit || '').toLowerCase() !== item.upstreamSha) {
    fail(`${item.store}: worker SOURCE manifest does not bind exact source`);
  }
  const files = names.filter((name) => !['RVF-GENERATIONS.json', 'SOURCE.json'].includes(name))
    .map((name) => ({ name, sha256: sha256File(path.join(output, name)), bytes: fs.statSync(path.join(output, name)).size }));
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-worker-result', store: item.store,
    sourceCommit: item.upstreamSha, generation, source: source.stores[item.store], files };
  return { ...payload, receiptSha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), output };
}

export async function executeReconciliation({
  plan,
  assetsDir,
  workspaceDir,
  root = DEFAULT_ROOT,
  run = defaultRunAsync,
  concurrency = 5,
}) {
  if (!Array.isArray(plan) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    fail('reconciliation plan or worker concurrency is invalid');
  }
  const assets = path.resolve(assetsDir || '');
  const workspace = path.resolve(workspaceDir || '');
  const ledgerFile = path.join(assets, 'RVF-GENERATIONS.json');
  if (!fs.existsSync(ledgerFile)) fail(`RVF generation ledger missing (${ledgerFile})`);
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length) fail(`fresh-clone workspace is not empty (${workspace})`);
  fs.mkdirSync(workspace, { recursive: true });
  const forge = path.join(path.resolve(root), 'kb', 'forge-refresh.mjs');
  if (!fs.existsSync(forge)) fail(`forge-refresh missing (${forge})`);
  const canonicalLedger = readJson(ledgerFile, 'RVF generation ledger');
  const sourceFile = path.join(assets, 'SOURCE.json');
  const canonicalSource = fs.existsSync(sourceFile) ? readJson(sourceFile, 'SOURCE manifest') : { builder: 'rvf-kb-forge', stores: {} };
  const orderedPlan = [...plan].sort((a, b) => a.store.localeCompare(b.store));
  const lowerStores = orderedPlan.map(({ store }) => store.toLowerCase());
  if (new Set(lowerStores).size !== lowerStores.length) fail('reconciliation plan has duplicate or case-fold-colliding stores');

  const worker = async (item) => {
    if (!SAFE_STORE.test(item.store) || !HEX40.test(item.upstreamSha) || !repositorySlug(item.url)) {
      fail(`unsafe reconciliation item for ${item?.store || item?.name || 'unknown store'}`);
    }
    const workerRoot = path.join(workspace, 'workers', item.store);
    const cloneDir = path.join(workerRoot, 'clone');
    const output = path.join(workerRoot, 'assets');
    fs.mkdirSync(workerRoot, { recursive: true });
    seedWorkerAssets({ assets, output, store: item.store, ledger: canonicalLedger, source: canonicalSource });
    await checkedAsync(run, 'git', ['clone', '--no-checkout', '--filter=blob:none', item.url, cloneDir]);
    await checkedAsync(run, 'git', ['-C', cloneDir, 'fetch', '--depth=1', 'origin', item.upstreamSha]);
    await checkedAsync(run, 'git', ['-C', cloneDir, 'checkout', '--detach', 'FETCH_HEAD']);
    const head = await checkedAsync(run, 'git', ['-C', cloneDir, 'rev-parse', 'HEAD']);
    if (String(head.stdout || '').trim().toLowerCase() !== item.upstreamSha) {
      fail(`${item.store}: fresh clone did not resolve the exact upstream SHA`);
    }
    await checkedAsync(run, process.execPath, [forge, '--repo', cloneDir, '--out', output, '--name', item.store,
      ...(FULL_HINTS[item.store] ? ['--full', FULL_HINTS[item.store]] : []),
      ...(KEEP_DIRS[item.store] ? ['--keep', KEEP_DIRS[item.store]] : []),
    ], { stdio: 'inherit', env: { ...process.env, RUVNET_BIG_SHARDS: '1' } });
    return validateWorkerOutput({ output, item });
  };

  const results = new Array(orderedPlan.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, orderedPlan.length) }, async () => {
    while (next < orderedPlan.length) {
      const index = next++;
      results[index] = await worker(orderedPlan[index]);
    }
  }));
  if (!results.length) return { refreshed: [], workers: [] };

  const merge = path.join(workspace, 'merge-candidate');
  fs.mkdirSync(merge);
  const mergedLedger = structuredClone(canonicalLedger);
  const mergedSource = structuredClone(canonicalSource);
  mergedLedger.stores ||= {};
  mergedSource.stores ||= {};
  const promotedFiles = [];
  for (const result of results) {
    for (const file of result.files) {
      fs.copyFileSync(path.join(result.output, file.name), path.join(merge, file.name), fs.constants.COPYFILE_EXCL);
      promotedFiles.push(file.name);
    }
    mergedLedger.stores[result.store] = result.generation;
    mergedSource.stores[result.store] = result.source;
  }
  mergedLedger.stores = Object.fromEntries(Object.entries(mergedLedger.stores).sort(([a], [b]) => a.localeCompare(b)));
  mergedSource.stores = Object.fromEntries(Object.entries(mergedSource.stores).sort(([a], [b]) => a.localeCompare(b)));
  writeJsonAtomic(path.join(merge, 'RVF-GENERATIONS.json'), mergedLedger);
  writeJsonAtomic(path.join(merge, 'SOURCE.json'), mergedSource);
  promotedFiles.push('RVF-GENERATIONS.json', 'SOURCE.json');
  promoteArtifactSet({ liveDir: assets, candidateDir: merge, files: promotedFiles.sort() });
  return { refreshed: results.map(({ store }) => store),
    workers: results.map(({ output: _output, ...receipt }) => receipt) };
}

export function syncCorpusInputs({ root = DEFAULT_ROOT, assetsDir }) {
  const sourceKb = path.join(path.resolve(root), 'kb');
  const assets = path.resolve(assetsDir || '');
  const required = ['capability-cards.md', 'external-sources.json', 'no-corpus-repos.json',
    'public-store-classes.json'];
  for (const name of required) {
    const source = path.join(sourceKb, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`canonical corpus input missing (${source})`);
    fs.copyFileSync(source, path.join(assets, name));
  }
  const sourceL2 = path.join(sourceKb, 'l2');
  if (!fs.existsSync(sourceL2) || !fs.statSync(sourceL2).isDirectory()) fail(`canonical L2 input missing (${sourceL2})`);
  fs.rmSync(path.join(assets, 'l2'), { recursive: true, force: true });
  fs.cpSync(sourceL2, path.join(assets, 'l2'), { recursive: true });
  for (const entry of fs.readdirSync(sourceKb)) {
    if (entry.endsWith('-primer.md') || /^l2-topics\..+\.json$/.test(entry)) {
      fs.copyFileSync(path.join(sourceKb, entry), path.join(assets, entry));
    }
  }
  return { copied: required };
}

export async function materializeGistReceipts({ observation, assetsDir, fetchGist, fetchBody, now } = {}) {
  if (observation?.observationSha256 !== sourceObservationDigest(observation)) {
    fail('gist receipts require an exact sealed source observation');
  }
  const sourceFile = path.join(path.resolve(assetsDir || ''), 'ruv-gists.sources.json');
  const existing = fs.existsSync(sourceFile) ? readJson(sourceFile, 'existing gist receipts') : null;
  const receipt = await reconcileGistReceipts({ observation, existing, fetchGist, fetchBody, now });
  if (receipt.sourceObservationSha256 !== observation.observationSha256) {
    fail('gist receipts differ from the sealed source observation');
  }
  writeJsonAtomic(sourceFile, receipt);
  return { sourceFile, receipt };
}

export async function observeAndMaterializeGistReceipts({ owner = 'ruvnet', assetsDir,
  observe = observeSourceUniverse, fetchGist, fetchBody, now } = {}) {
  const assets = path.resolve(assetsDir || '');
  const externalFile = path.join(assets, 'external-sources.json');
  const policy = fs.existsSync(externalFile) ? readJson(externalFile, 'external source policy') : { sources: [] };
  if (!Array.isArray(policy.sources)) fail('external source policy has no sources array');
  const observation = await observe({ owner, externalSources: policy.sources });
  const materialized = await materializeGistReceipts({ observation, assetsDir: assets, fetchGist, fetchBody, now });
  return { observation, ...materialized };
}

export function prepareCorpusCandidate({
  root = DEFAULT_ROOT,
  assetsDir,
  owner = 'ruvnet',
  builderSha,
  candidateDir,
  receiptFile,
  coverageFile,
  run = defaultRun,
}) {
  const sourceRoot = path.resolve(root);
  const assets = path.resolve(assetsDir || '');
  const candidate = path.resolve(candidateDir || path.join(sourceRoot, 'dist', 'corpus-candidate'));
  const receipt = path.resolve(receiptFile || path.join(sourceRoot, 'dist', 'corpus-receipt.json'));
  const policy = path.resolve(coverageFile || path.join(sourceRoot, 'data', 'source-coverage.json'));
  if (!HEX40.test(String(builderSha || '').toLowerCase())) fail('builder SHA must be exact 40-character lowercase hex');
  const expectedPolicy = path.join(sourceRoot, 'data', 'source-coverage.json');
  if (policy !== expectedPolicy) fail(`coverage policy must be the generator's canonical projection (${expectedPolicy})`);
  const coverageScript = path.join(sourceRoot, 'scripts', 'source-coverage.mjs');
  const buildScript = path.join(sourceRoot, 'scripts', 'build-bundle.mjs');
  const receiptScript = path.join(sourceRoot, 'scripts', 'corpus-candidate.mjs');
  for (const required of [coverageScript, buildScript, receiptScript]) {
    if (!fs.existsSync(required)) fail(`required candidate builder missing (${required})`);
  }
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  checked(run, process.execPath, [coverageScript, '--owner', owner, '--assets', assets, '--write'], { stdio: 'inherit' });
  checked(run, process.execPath, [coverageScript, '--owner', owner, '--assets', assets, '--check', '--strict'], { stdio: 'inherit' });
  checked(run, process.execPath, [buildScript, '--assets', assets, '--out', candidate], { stdio: 'inherit' });
  const bundleFile = path.join(path.dirname(candidate), `${path.basename(candidate)}.zip`);
  checked(run, process.execPath, [receiptScript, '--assets', assets, '--bundle', bundleFile,
    '--policy', policy, '--receipt', receipt, '--builder-source-sha', builderSha], { stdio: 'inherit' });
  checked(run, process.execPath, [receiptScript, '--verify', '--assets', assets, '--bundle', bundleFile,
    '--policy', policy, '--receipt', receipt], { stdio: 'inherit' });
  return { bundleFile, receiptFile: receipt, coverageFile: policy };
}

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(arg(argv, '--root', DEFAULT_ROOT));
  const archiveFile = path.resolve(arg(argv, '--seed-archive', ''));
  const seedTag = arg(argv, '--seed-tag');
  const seedSha256 = arg(argv, '--seed-sha256');
  const assetsDir = path.resolve(arg(argv, '--assets', ''));
  const workspaceDir = path.resolve(arg(argv, '--workspace', ''));
  const coverageFile = path.resolve(arg(argv, '--coverage', path.join(root, 'data', 'source-coverage.json')));
  const candidateDir = path.resolve(arg(argv, '--candidate-out', path.join(root, 'dist', 'corpus-candidate')));
  const receiptFile = path.resolve(arg(argv, '--receipt-out', path.join(root, 'dist', 'corpus-receipt.json')));
  const builderSha = String(arg(argv, '--builder-sha', '')).toLowerCase();
  const owner = arg(argv, '--owner', 'ruvnet');

  assertBootstrapIdentity({ archiveFile, tag: seedTag, sha256: seedSha256, allowPinnedTag: process.argv.includes('--allow-pinned-seed-tag') });
  if (fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length) fail(`bootstrap assets directory is not empty (${assetsDir})`);
  fs.mkdirSync(path.dirname(assetsDir), { recursive: true });
  const extractParent = fs.mkdtempSync(path.join(path.dirname(assetsDir), '.corpus-seed-extract-'));
  await extractZip(archiveFile, extractParent);
  normalizeExtractedCorpus({ extractedDir: extractParent, assetsDir });
  const privateFence = path.join(root, 'kb', 'PRIVATE-STORES.json');
  if (!fs.existsSync(privateFence)) fail(`canonical private-store fence missing (${privateFence})`);
  fs.copyFileSync(privateFence, path.join(assetsDir, 'PRIVATE-STORES.json'), fs.constants.COPYFILE_EXCL);
  fs.rmSync(extractParent, { recursive: true, force: true });
  await observeAndMaterializeGistReceipts({ owner, assetsDir });
  const coverageScript = path.join(root, 'scripts', 'source-coverage.mjs');
  checked(defaultRun, process.execPath, [coverageScript, '--owner', owner, '--assets', assetsDir, '--write'], { stdio: 'inherit' });
  const policy = readJson(coverageFile, 'source coverage policy');
  const ledger = readJson(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'bootstrap RVF generation ledger');
  const plan = planReconciliation({ coverage: policy, ledger, assetsDir });
  const reconciliation = executeReconciliation({ plan, assetsDir, workspaceDir, root });
  const candidate = prepareCorpusCandidate({ root, assetsDir, owner, builderSha, candidateDir, receiptFile, coverageFile });
  process.stdout.write(`${JSON.stringify({ ok: true, seedTag, seedSha256, plan, ...reconciliation, ...candidate }, null, 2)}\n`);
  return 0;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
