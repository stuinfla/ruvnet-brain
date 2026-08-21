#!/usr/bin/env node
// Publish a corpus candidate once, under a tag derived from its exact archive digest.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCorpusReceipt } from './corpus-candidate.mjs';

function fail(message) {
  throw new Error(`[corpus-seed-publish] ${message}`);
}

function sha256File(file) {
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

export function corpusSeedTag(receipt) {
  if (!/^[a-f0-9]{64}$/.test(receipt?.archive?.sha256 || '')) fail('cannot derive tag without an archive sha256');
  return `corpus-sha256-${receipt.archive.sha256}`;
}

function defaultRun(command, args, options) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

export function publishCorpusSeed({
  receiptFile,
  bundleFile,
  assetsDir,
  policyFile,
  repo,
  run = defaultRun,
}) {
  const receiptPath = path.resolve(receiptFile || '');
  const bundlePath = path.resolve(bundleFile || '');
  if (!assetsDir || !policyFile) fail('publishing requires --assets and --policy for full receipt verification');
  const receipt = verifyCorpusReceipt({
    receiptFile: receiptPath,
    bundleFile: bundlePath,
    assetsDir,
    policyFile,
  });
  if (!fs.existsSync(bundlePath)) fail(`bundle missing (${bundlePath})`);
  const archiveSha256 = sha256File(bundlePath);
  if (archiveSha256 !== receipt.archive.sha256) fail(`archive sha256=${archiveSha256}, receipt=${receipt.archive.sha256}`);
  if (fs.statSync(bundlePath).size !== receipt.archive.bytes) fail('archive byte length differs from receipt');

  const tag = corpusSeedTag(receipt);
  const repoArgs = repo ? ['--repo', repo] : [];
  const view = run('gh', ['release', 'view', tag, '--json', 'tagName', ...repoArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (view.status === 0) fail(`release ${tag} already exists; refusing to overwrite immutable corpus seed`);
  const viewError = String(view.stderr || view.stdout || '');
  if (!/(not found|404|no release found)/i.test(viewError)) {
    fail(`cannot prove ${tag} is absent (${viewError.trim() || `gh exited ${view.status}`})`);
  }

  // Publication stays behind the repository's one-publisher authority. This wrapper validates and
  // seals the corpus inputs; scripts/release.mjs owns the protected GitHub mutation and its receipt.
  const publish = run(process.execPath, [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'release.mjs'),
    '--corpus-seed',
    '--corpus-tag', tag,
    '--corpus-bundle', bundlePath,
    '--corpus-receipt', receiptPath,
    '--target', receipt.builderSourceSha,
    ...(repo ? ['--repo', repo] : []),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (publish.status !== 0) fail(`protected corpus publication failed (${String(publish.stderr || publish.stdout || '').trim()})`);
  return {
    tag,
    archiveSha256,
    receiptSha256: sha256File(receiptPath),
    draft: false,
    prerelease: true,
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const result = publishCorpusSeed({
    receiptFile: arg('--receipt', 'dist/corpus-receipt.json'),
    bundleFile: arg('--bundle', 'dist/ruvnet-brain.zip'),
    assetsDir: arg('--assets'),
    policyFile: arg('--policy'),
    repo: arg('--repo'),
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
