#!/usr/bin/env node
// Local publication is deliberately impossible. The one publisher may mutate public channels only
// when the reviewer-protected GitHub workflow carries a fully valid candidate seal into it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateCandidateReceipt } from './release-proof.mjs';
import { getVersion } from './version.mjs';

export const PROTECTED_WORKFLOW = 'protected-release';
export const PROTECTED_VERSION = getVersion();

const hex = (value, length) => new RegExp(`^[0-9a-f]{${length}}$`).test(String(value || ''));
const digestOf = (receipt) => String(receipt?.artifact?.sha256 || '').replace(/^sha256:/, '');

export function validatePublishableVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version || ''))
    ? []
    : ['development versions cannot be published'];
}

export function validateProtectedPublishEnvironment(env = process.env) {
  const failures = [];
  if (env.GITHUB_ACTIONS !== 'true'
    || env.GITHUB_WORKFLOW !== PROTECTED_WORKFLOW
    || env.GITHUB_REPOSITORY !== 'stuinfla/ruvnet-brain'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REF_PROTECTED !== 'true') {
    failures.push('publication is allowed only inside the protected-release GitHub workflow on a protected workflow_dispatch ref');
  }
  return failures;
}

export function validateProtectedPublishInvocation({ root = process.cwd(), env = process.env } = {}) {
  const failures = [...validateProtectedPublishEnvironment(env)];
  let releaseMode = 'unknown';

  const expectedSha = String(env.RUVNET_EXPECTED_SHA || '');
  const expectedDigest = String(env.RUVNET_EXPECTED_ARTIFACT_SHA256 || '').replace(/^sha256:/, '');
  const expectedVersion = String(env.RUVNET_EXPECTED_VERSION || '');
  if (!hex(expectedSha, 40)) failures.push('expected candidate SHA is missing or malformed');
  if (!hex(expectedDigest, 64)) failures.push('expected artifact digest is missing or malformed');
  if (expectedVersion !== PROTECTED_VERSION) failures.push(`release generation must be ${PROTECTED_VERSION}`);
  failures.push(...validatePublishableVersion(expectedVersion));

  const receiptRelative = String(env.RUVNET_CANDIDATE_RECEIPT || '');
  const evidenceRoot = path.resolve(root, 'release-evidence');
  const receiptPath = path.resolve(root, receiptRelative || '.missing-candidate-receipt');
  if (!receiptRelative || !(receiptPath === evidenceRoot || receiptPath.startsWith(`${evidenceRoot}${path.sep}`))) {
    failures.push('candidate receipt must be inside release-evidence');
  }

  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    failures.push(`candidate receipt unavailable: ${error.message}`);
  }

  if (receipt) {
    const seal = evaluateCandidateReceipt(receipt);
    if (seal.verdict !== 'PASS') failures.push(`candidate seal failed: ${seal.failures.map(({ code }) => code).join(',')}`);
    const receiptDigest = digestOf(receipt);
    if (receipt.sha !== expectedSha) failures.push('candidate receipt SHA mismatch');
    if (receiptDigest !== expectedDigest) failures.push('candidate artifact digest mismatch');
    if (receipt.version !== expectedVersion) failures.push('candidate version mismatch');
    const expectedMode = receipt.phase === 'stabilization-candidate' ? 'stabilization' : 'strict';
    releaseMode = expectedMode;
    if (env.RUVNET_RELEASE_MODE !== expectedMode) failures.push(`release mode must be ${expectedMode} for this receipt`);

    const artifactPath = path.resolve(root, String(receipt.artifact?.path || '.missing-artifact'));
    if (!(artifactPath === evidenceRoot || artifactPath.startsWith(`${evidenceRoot}${path.sep}`))) {
      failures.push('candidate artifact must be inside release-evidence');
    } else {
      try {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
        if (actual !== expectedDigest) failures.push('candidate artifact bytes do not match the seal');
      } catch (error) {
        failures.push(`candidate artifact unavailable: ${error.message}`);
      }
    }
  }

  return {
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    sha: expectedSha,
    artifactSha256: expectedDigest,
    version: expectedVersion,
    mode: releaseMode,
    failures,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = validateProtectedPublishInvocation();
  if (result.verdict !== 'PASS') {
    console.error('[protected-release] publication refused:');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('[protected-release] exact candidate publication authority verified');
  }
}
