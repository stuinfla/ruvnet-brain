#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCapabilityClaimAggregate } from '../plugin/scripts/capability-claim-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_REVIEWERS = Object.freeze(['claude-fable-5', 'gpt-5.6-sol']);

const command = (cwd, bin, args) => {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  return String(result.stdout || '').trim();
};

export function evaluateCompletion({ root = ROOT, run = command,
  receiptFile = path.join(root, 'release-evidence', 'product-integrity-receipt.json'),
  capabilityClaimPublicKey = null } = {}) {
  const failures = [];
  let head = null;
  let version = null;
  const check = (label, fn) => { try { fn(); } catch (error) { failures.push(`${label}: ${error.message}`); } };

  check('worktree', () => {
    const dirty = run(root, 'git', ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) throw new Error('working tree is not clean');
    if (run(root, 'git', ['branch', '--show-current']) !== 'main') throw new Error('release checkout is not main');
    head = run(root, 'git', ['rev-parse', 'HEAD']);
    const remote = run(root, 'git', ['rev-parse', 'origin/main']);
    if (head !== remote) throw new Error(`HEAD ${head} differs from origin/main ${remote}`);
  });
  check('version', () => {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const npmVersion = JSON.parse(run(root, 'npm', ['view', 'ruvnet-brain@latest', 'version', '--json']));
    if (npmVersion !== version) throw new Error(`npm latest ${npmVersion} differs from ${version}`);
    const release = JSON.parse(run(root, 'gh', ['release', 'view', `v${version}`, '--repo', 'stuinfla/ruvnet-brain',
      '--json', 'tagName,targetCommitish,isDraft,isPrerelease']));
    if (release.tagName !== `v${version}` || release.targetCommitish !== head || release.isDraft || release.isPrerelease) {
      throw new Error('GitHub release does not expose the exact main candidate');
    }
  });
  check('public proof', () => {
    if (!fs.existsSync(receiptFile)) throw new Error(`missing ${receiptFile}`);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'ruvnet-brain-product-integrity'
      || receipt.verdict !== 'PASS' || receipt.sourceSha !== head || receipt.version !== version) {
      throw new Error('product integrity receipt identity or verdict is invalid');
    }
    if (receipt.release?.state !== 'install-verified' || receipt.release?.publicAggregateVerified !== true) {
      throw new Error('release is not cryptographically install-verified');
    }
    if (receipt.coverage?.eligibleCurrent !== receipt.coverage?.eligibleTotal
      || receipt.coverage?.gistCurrent !== receipt.coverage?.gistTotal) {
      throw new Error('installed public corpus is incomplete');
    }
    if (receipt.retrieval?.deltaCitationRate !== 1 || receipt.retrieval?.recallAt10 < 0.98
      || receipt.retrieval?.skipped !== 0 || receipt.retrieval?.unknown !== 0) {
      throw new Error('retrieval acceptance is incomplete');
    }
    if (receipt.hosts?.passed !== 9 || receipt.hosts?.required !== 9) throw new Error('public 3x3 host matrix is incomplete');
    if (receipt.lifecycle?.nativeRuns !== 2 || receipt.lifecycle?.secondVerdict !== 'noop'
      || receipt.lifecycle?.redundantCopyCount !== 0 || receipt.lifecycle?.withinRetentionBudget !== true) {
      throw new Error('native two-run lifecycle proof is incomplete');
    }
    if (receipt.continuity?.verdict !== 'PASS'
      || receipt.continuity?.crashResumeVerified !== true
      || receipt.continuity?.concurrentWritersVerified !== true
      || receipt.continuity?.hosts?.join(',') !== 'claude,codex') {
      throw new Error('cross-host AgentDB continuity proof is incomplete');
    }
    const capabilityKey = capabilityClaimPublicKey
      || fs.readFileSync(path.join(root, 'keys', 'ruvnet-brain-signing.pub.pem'));
    verifyCapabilityClaimAggregate(receipt.capabilityClaims, capabilityKey);
    if (receipt.capabilityClaims.verdict !== 'PASS'
      || receipt.capabilityClaims.identity.sourceSha !== head
      || receipt.capabilityClaims.os?.join(',') !== 'linux,macos,windows'
      || receipt.capabilityClaims.hosts?.join(',') !== 'claude,codex'
      || receipt.capabilityClaims.untested?.length) {
      throw new Error('RuvNet capability-claim integrity proof is incomplete');
    }
    for (const reviewer of REQUIRED_REVIEWERS) {
      const review = receipt.reviews?.find((row) => row.id === reviewer);
      if (!review || review.score < 95 || review.sourceSha !== head || review.untested?.length) {
        throw new Error(`${reviewer} review is missing, below 95, stale, or has untested scope`);
      }
    }
    if (receipt.mechanicalScore < 98) throw new Error('mechanical whole-product score is below 98');
  });
  return { ok: failures.length === 0, head, version, receiptFile, failures };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const receiptIndex = process.argv.indexOf('--receipt');
  const result = evaluateCompletion({ receiptFile: receiptIndex >= 0 ? path.resolve(process.argv[receiptIndex + 1]) : undefined });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
