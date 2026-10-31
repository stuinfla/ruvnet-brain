#!/usr/bin/env node
// restore-run-artifact.mjs — prove a payload artifact restored COMPLETELY before anything signs or
// publishes it, and fetch it again by ID if it did not.
//
// WHY (4.7.26, protected-release run 41159273131). `actions/download-artifact@v4` ended the seal job's
// restore step as a success after 33 s without its "SHA256 digest of downloaded artifact" and
// "Artifact download completed successfully" lines; the ~796 MB payload was incomplete and the next step
// died on `ENOENT ... release-evidence/ruvnet-brain-4.7.26.tgz`. The artifact itself was whole (the run
// re-dispatched as 41159509553 restored the same bytes), so a whole new dispatch was spent on a transfer.
//
// This checks every member the payload manifest names (present, regular file, exact size). If any is
// missing it downloads the same artifact from this run again through the API (by ID, not by name
// alone), unzips it over the directory and checks again, up to --attempts times, then fails naming
// the missing members. It never changes what is accepted: the step after it still verifies every
// member's SHA-256 and the signature exactly as before.
//
//   node scripts/restore-run-artifact.mjs --name ARTIFACT --dir release-evidence [--manifest payload-manifest.json] [--attempts 3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

export const RESTORE_ATTEMPTS = 3;

/** Members the manifest names that are absent or the wrong size in dir (no hashing; the next step hashes). */
export function missingMembers(dir, manifestName = 'payload-manifest.json') {
  const manifestFile = path.join(dir, manifestName);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { return [manifestName]; }
  if (!Array.isArray(manifest?.members) || !manifest.members.length) return [manifestName];
  const missing = [];
  for (const member of manifest.members) {
    if (!member?.name || path.basename(member.name) !== member.name) { missing.push(String(member?.name)); continue; }
    let stat = null;
    try { stat = fs.lstatSync(path.join(dir, member.name)); } catch { /* absent */ }
    if (!stat?.isFile() || stat.size !== member.size) missing.push(member.name);
  }
  return missing;
}

function liveFetch({ repo, runId, name, dir }) {
  const gh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  const listed = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`]));
  const artifacts = (listed.artifacts || []).filter((artifact) => artifact.name === name && artifact.expired === false
    && String(artifact.workflow_run?.id) === String(runId));
  if (artifacts.length !== 1) throw new Error(`expected one ${name} artifact in run ${runId}, found ${artifacts.length}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-run-artifact-'));
  try {
    const zip = path.join(temp, 'artifact.zip');
    const fd = fs.openSync(zip, 'w');
    try {
      execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${artifacts[0].id}/zip`], { stdio: ['ignore', fd, 'pipe'], timeout: 1_200_000 });
    } finally { fs.closeSync(fd); }
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function restoreRunArtifact({ name, dir, manifestName = 'payload-manifest.json', attempts = RESTORE_ATTEMPTS,
  repo = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID, fetchArtifact = liveFetch, log = console.error } = {}) {
  if (!name || !dir) throw new Error('--name and --dir are required');
  let missing = missingMembers(dir, manifestName);
  if (!missing.length) return { verdict: 'PASS', refetched: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    log(`[restore-run-artifact] ${name} restored incomplete (missing or short: ${missing.join(', ')}); fetching it again by ID, attempt ${attempt}/${attempts}`);
    fs.mkdirSync(dir, { recursive: true });
    try { await fetchArtifact({ repo, runId, name, dir }); } catch (error) { log(`[restore-run-artifact] fetch failed: ${error.message}`); }
    missing = missingMembers(dir, manifestName);
    if (!missing.length) return { verdict: 'PASS', refetched: attempt };
  }
  throw new Error(`${name} is still incomplete after ${attempts} re-download(s): ${missing.join(', ')}. The artifact upload in this run `
    + 'is what to inspect; nothing was signed or published.');
}

if (isDirectInvocation(import.meta.url)) {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
  try {
    const result = await restoreRunArtifact({ name: arg('--name'), dir: arg('--dir'), manifestName: arg('--manifest') || undefined,
      attempts: arg('--attempts') ? Number(arg('--attempts')) : undefined });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`restore-run-artifact: ${error.message}`);
    process.exitCode = 1;
  }
}
