#!/usr/bin/env node
// scripts/corpus-next-seed.mjs — resolve night N+1's seed from night N's published generation.
//
// ADR-086 step 18, verbatim: "Resolve the previous compatible, verified corpus generation at runtime
// as the next seed; retain the committed exact seed as bootstrap/recovery input. Do not commit a new
// pointer every night."
//
// So this NEVER writes to the repository. It reads the published release list, picks the newest
// corpus generation that is genuinely usable as a seed, and prints a descriptor for the preparation
// workflow to consume. When nothing published qualifies — first run, an incompatible runtime, an
// unsigned or half-uploaded release — it falls back to the committed data/corpus-seed.json, which is
// the bootstrap/recovery input and is content-addressed independently.
//
// "Compatible" is decided against the SAME approved runtime pin that gates promotion
// (scripts/approved-runtime.mjs): a generation whose archive shipped a different brainVersion is a
// different runtime, and seeding from it would drag unapproved executables forward through reuse.
//
// "Verified" is decided by evidence that is checkable without downloading 500 MB here: the tag must
// be the content-addressed corpus-sha256-<digest> form, the release must not be a draft, and it must
// carry all three of ruvnet-brain.zip, its detached .sig, and corpus-receipt.json, with the receipt's
// own archive digest equal to the digest in the tag. The full byte-level proof still happens
// downstream where the archive is actually fetched (corpus-seed.yml re-checks sha256 and byte length
// before reconciliation, and corpus-candidate.mjs re-derives the whole candidate from the bytes).
//
// Usage:
//   node scripts/corpus-next-seed.mjs --repo owner/name [--pin data/approved-runtime.json]
//                                     [--bootstrap data/corpus-seed.json] [--out <file>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readApprovedRuntime, validateApprovedRuntime } from './approved-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/;
const CORPUS_TAG = /^corpus-sha256-([0-9a-f]{64})$/;
const ARCHIVE_ASSET = 'ruvnet-brain.zip';
const SIGNATURE_ASSET = 'ruvnet-brain.zip.sig';
const RECEIPT_ASSET = 'corpus-receipt.json';

const defaultRun = (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options });

function ghJson(run, args) {
  const result = run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(String(result.error?.message || result.stderr || result.stdout || `gh exited ${result.status}`).trim());
  }
  return JSON.parse(String(result.stdout || 'null'));
}

export function validateBootstrapSeed(seed) {
  const failures = [];
  if (!seed || typeof seed !== 'object') return ['committed bootstrap seed is not an object'];
  if (seed.schemaVersion !== 1) failures.push('committed bootstrap seed schemaVersion must be 1');
  if (!seed.tag || seed.tag === 'latest') failures.push('committed bootstrap seed tag is missing or forbidden');
  if (seed.asset !== ARCHIVE_ASSET) failures.push(`committed bootstrap seed asset must be ${ARCHIVE_ASSET}`);
  if (!HEX64.test(String(seed.sha256 || ''))) failures.push('committed bootstrap seed sha256 is malformed');
  if (!Number.isSafeInteger(seed.bytes) || seed.bytes < 1) failures.push('committed bootstrap seed bytes is malformed');
  return failures;
}

/**
 * One published release, judged. Returns null when it cannot serve as a seed, with the reason
 * recorded on `rejected` so a no-op night is explainable rather than silent.
 */
function judgeRelease({ run, repo, tag, digest, approved, rejected }) {
  let view;
  try {
    view = ghJson(run, ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,assets']);
  } catch (error) {
    rejected.push({ tag, reason: `release view failed (${error.message})` });
    return null;
  }
  if (view?.tagName !== tag || view.isDraft) {
    rejected.push({ tag, reason: 'release is a draft or names another tag' });
    return null;
  }
  const assets = Array.isArray(view.assets) ? view.assets : [];
  const named = (name) => assets.filter((asset) => asset?.name === name);
  for (const name of [ARCHIVE_ASSET, SIGNATURE_ASSET, RECEIPT_ASSET]) {
    if (named(name).length !== 1) {
      rejected.push({ tag, reason: `unverified: expected exactly one ${name} asset` });
      return null;
    }
  }
  const archive = named(ARCHIVE_ASSET)[0];
  if (!Number.isSafeInteger(archive.size) || archive.size < 1) {
    rejected.push({ tag, reason: 'unverified: archive asset has no usable byte length' });
    return null;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-next-seed-'));
  try {
    const download = run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', RECEIPT_ASSET, '--dir', scratch],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (download.error || download.status !== 0) {
      rejected.push({ tag, reason: 'unverified: corpus receipt could not be downloaded' });
      return null;
    }
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(scratch, RECEIPT_ASSET), 'utf8')); }
    catch (error) { rejected.push({ tag, reason: `unverified: corpus receipt unreadable (${error.message})` }); return null; }

    // ADR-086 Step 15 / A6 moved the corpus receipt to schemaVersion 3 (it now binds the detached
    // retrieval-accuracy report). This reader has to move with it: left at 2 it would reject every
    // schema-3 generation as unverified and silently fall back to the committed bootstrap seed every
    // night — a degradation that looks exactly like "no new generation yet".
    if (receipt.schemaVersion !== 3 || receipt.kind !== 'ruvnet-brain-corpus-candidate') {
      rejected.push({ tag, reason: 'unverified: receipt schema or kind is not a schema-3 corpus candidate' });
      return null;
    }
    if (!receipt.accuracyReport?.file || !/^[a-f0-9]{64}$/.test(String(receipt.accuracyReport.sha256 || ''))
      || !Number.isSafeInteger(receipt.accuracyReport.bytes)) {
      rejected.push({ tag, reason: 'unverified: receipt carries no retrieval-accuracy binding' });
      return null;
    }
    if (receipt.archive?.sha256 !== digest || receipt.archive?.bytes !== archive.size) {
      rejected.push({ tag, reason: 'unverified: receipt archive identity disagrees with the content-addressed tag' });
      return null;
    }
    if (receipt.archiveManifestVersion !== approved.brainVersion || receipt.archiveManifestReleaseTag !== approved.releaseTag) {
      rejected.push({ tag, reason: `incompatible: generation shipped runtime ${receipt.archiveManifestReleaseTag}, approved runtime is ${approved.releaseTag}` });
      return null;
    }
    return {
      origin: 'published-generation',
      tag,
      asset: ARCHIVE_ASSET,
      sha256: digest,
      bytes: archive.size,
      sourceCommit: typeof receipt.builderSourceSha === 'string' ? receipt.builderSourceSha : null,
      brainVersion: receipt.archiveManifestVersion,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function resolveNextCorpusSeed({
  repo, run = defaultRun, root = ROOT, pinFile, bootstrapFile, limit = 100,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo || ''))) throw new Error('--repo must be owner/name');

  const approved = readApprovedRuntime(pinFile || path.join(root, 'data/approved-runtime.json'));
  const pinFailures = validateApprovedRuntime(approved);
  if (pinFailures.length) throw new Error(`approved runtime pin is invalid: ${pinFailures.join('; ')}`);

  const bootstrapPath = path.resolve(bootstrapFile || path.join(root, 'data/corpus-seed.json'));
  const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
  const bootstrapFailures = validateBootstrapSeed(bootstrap);
  if (bootstrapFailures.length) throw new Error(`committed bootstrap seed is invalid: ${bootstrapFailures.join('; ')}`);

  const rejected = [];
  let listed = [];
  try {
    listed = ghJson(run, ['release', 'list', '--repo', repo, '--limit', String(limit), '--json', 'tagName,isDraft,createdAt']) || [];
  } catch (error) {
    rejected.push({ tag: null, reason: `release list failed (${error.message})` });
  }

  // Every corpus-shaped tag that is NOT usable gets an explicit reason. A silently skipped row is
  // indistinguishable from "there were none", and this project has already paid for one diagnostic
  // that reported a defect nobody read — a skip nobody can see is worse.
  const corpusShaped = (Array.isArray(listed) ? listed : [])
    .filter((row) => row && CORPUS_TAG.test(String(row.tagName || '')));
  const candidates = [];
  for (const row of corpusShaped) {
    if (row.isDraft) { rejected.push({ tag: row.tagName, reason: 'unverified: release is still a draft' }); continue; }
    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) { rejected.push({ tag: row.tagName, reason: 'unverified: release has no readable publication time' }); continue; }
    candidates.push({ tag: row.tagName, digest: CORPUS_TAG.exec(row.tagName)[1], createdAt });
  }
  candidates.sort((left, right) => right.createdAt - left.createdAt);

  for (const candidate of candidates) {
    const resolved = judgeRelease({ run, repo, tag: candidate.tag, digest: candidate.digest, approved, rejected });
    if (resolved) return { seed: resolved, rejected, approvedRuntime: approved.releaseTag };
  }

  return {
    seed: {
      origin: 'committed-bootstrap',
      tag: bootstrap.tag,
      asset: bootstrap.asset,
      sha256: String(bootstrap.sha256).toLowerCase(),
      bytes: bootstrap.bytes,
      sourceCommit: typeof bootstrap.sourceCommit === 'string' ? bootstrap.sourceCommit : null,
      brainVersion: null,
    },
    rejected,
    approvedRuntime: approved.releaseTag,
  };
}

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

function main() {
  let result;
  try {
    result = resolveNextCorpusSeed({
      repo: arg('--repo', process.env.GITHUB_REPOSITORY),
      pinFile: arg('--pin'),
      bootstrapFile: arg('--bootstrap'),
    });
  } catch (error) {
    console.error(`[corpus-next-seed] ${error.message}`);
    return 1;
  }
  for (const row of result.rejected) console.error(`[corpus-next-seed] skipped ${row.tag || '(list)'}: ${row.reason}`);
  const out = arg('--out');
  const serialized = `${JSON.stringify(result.seed, null, 2)}\n`;
  if (out) fs.writeFileSync(path.resolve(out), serialized);
  process.stdout.write(serialized);
  console.error(`[corpus-next-seed] ${result.seed.origin} ${result.seed.tag} (approved runtime ${result.approvedRuntime})`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
