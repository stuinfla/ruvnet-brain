#!/usr/bin/env node
// Build a corpus candidate from one immutable seed and exact upstream repository SHAs.
// This module deliberately has no publication capability. The protected-release workflow owns
// the only legal call to corpus-seed-publish.mjs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_STORE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function planReconciliation({ coverage, ledger }) {
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
    if (current === upstreamSha) continue;
    plan.push({
      name: String(row.name || store),
      store,
      url: row.url,
      upstreamSha,
      ledgerSourceCommit: generation?.sourceCommit || null,
      reason: generation?.sourceCommit ? 'sourceCommit differs' : 'missing ledger receipt',
    });
  }
  return plan.sort((a, b) => a.store.localeCompare(b.store));
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

export function executeReconciliation({
  plan,
  assetsDir,
  workspaceDir,
  root = DEFAULT_ROOT,
  run = defaultRun,
}) {
  if (!Array.isArray(plan)) fail('reconciliation plan must be an array');
  const assets = path.resolve(assetsDir || '');
  const workspace = path.resolve(workspaceDir || '');
  const ledgerFile = path.join(assets, 'RVF-GENERATIONS.json');
  if (!fs.existsSync(ledgerFile)) fail(`RVF generation ledger missing (${ledgerFile})`);
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length) fail(`fresh-clone workspace is not empty (${workspace})`);
  fs.mkdirSync(workspace, { recursive: true });
  const forge = path.join(path.resolve(root), 'kb', 'forge-refresh.mjs');
  if (!fs.existsSync(forge)) fail(`forge-refresh missing (${forge})`);
  const refreshed = [];

  for (const item of plan) {
    if (!SAFE_STORE.test(item.store) || !HEX40.test(item.upstreamSha) || !repositorySlug(item.url)) {
      fail(`unsafe reconciliation item for ${item?.store || item?.name || 'unknown store'}`);
    }
    const cloneDir = path.join(workspace, item.store);
    if (fs.existsSync(cloneDir)) fail(`fresh clone target already exists (${cloneDir})`);
    checked(run, 'git', ['clone', '--no-checkout', '--filter=blob:none', item.url, cloneDir]);
    checked(run, 'git', ['-C', cloneDir, 'fetch', '--depth=1', 'origin', item.upstreamSha]);
    checked(run, 'git', ['-C', cloneDir, 'checkout', '--detach', 'FETCH_HEAD']);
    const head = checked(run, 'git', ['-C', cloneDir, 'rev-parse', 'HEAD']);
    if (String(head.stdout || '').trim().toLowerCase() !== item.upstreamSha) {
      fail(`${item.store}: fresh clone did not resolve the exact upstream SHA`);
    }
    checked(run, process.execPath, [forge, '--repo', cloneDir, '--out', assets, '--name', item.store], { stdio: 'inherit' });
    const ledger = readJson(ledgerFile, 'RVF generation ledger after forge-refresh');
    const generation = Object.entries(ledger.stores || {}).find(([name]) => name.toLowerCase() === item.store.toLowerCase())?.[1];
    if (String(generation?.sourceCommit || '').toLowerCase() !== item.upstreamSha) {
      fail(`forge-refresh did not bind ${item.store} to the exact upstream SHA`);
    }
    refreshed.push(item.store);
  }
  return { refreshed };
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
  const coverageScript = path.join(root, 'scripts', 'source-coverage.mjs');
  checked(defaultRun, process.execPath, [coverageScript, '--owner', owner, '--assets', assetsDir, '--write'], { stdio: 'inherit' });
  const policy = readJson(coverageFile, 'source coverage policy');
  const ledger = readJson(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'bootstrap RVF generation ledger');
  const plan = planReconciliation({ coverage: policy, ledger });
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
