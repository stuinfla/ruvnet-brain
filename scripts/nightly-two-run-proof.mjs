#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assessLifecycleEvidence } from '../kb/lifecycle-evidence-retention.mjs';
import { managedStorageInventory } from '../kb/update-storage-transaction.mjs';
import { REQUIRED_REFRESH_PHASES, validateCurrentRunPhaseExecution, inspectRefreshOwner, refreshLockPath } from '../kb/refresh-run.mjs';
import { npmInvocation } from './npm-invocation.mjs';
import { packageTreeObservation, observeNpxPackage, validateNpxObservations } from './nightly-package-observation.mjs';
import { validateRefreshReceiptEnvelope } from '../plugin/scripts/nightly-scheduler.mjs';
import { validateCoverageDirectory, validateCoverageLedger } from '../plugin/scripts/coverage-integrity.mjs';

const PUBLIC_KEY = fs.readFileSync(new URL('../keys/ruvnet-brain-signing.pub.pem', import.meta.url), 'utf8');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`invalid argument: ${token}`);
    }
    result[token.slice(2)] = argv[++i];
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message
      || String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])]));
  return value;
}

function receiptDigest(receipt) {
  return sha256(Buffer.from(JSON.stringify(canonical(receipt))));
}

export function stageExactBundle({ bundlePath, packageRoot } = {}) {
  const sourcePath = path.resolve(bundlePath || '');
  let sourceStat;
  try { sourceStat = fs.lstatSync(sourcePath); } catch { /* handled below */ }
  if (!sourcePath.endsWith('.zip') || !sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('bundle must be a regular candidate bundle .zip file');
  }
  const packageDir = path.resolve(packageRoot || '');
  if (!fs.lstatSync(packageDir).isDirectory()) throw new Error('installed package root is not a directory');
  const bytes = fs.readFileSync(sourcePath);
  const dist = path.join(packageDir, 'dist');
  const stagedPath = path.join(dist, 'ruvnet-brain.zip');
  fs.mkdirSync(dist, { recursive: false });
  fs.copyFileSync(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
  return { sourcePath, stagedPath, bytes: bytes.length, sha256: sha256(bytes) };
}

export function removeEmptyInstallerScaffolds(kbDir) {
  const parent = path.dirname(kbDir);
  const prefix = `${path.basename(kbDir)}.install-preserved-`;
  const removed = [];
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(parent, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(file).length === 0) {
      fs.rmdirSync(file); removed.push(file);
    }
  }
  return removed;
}

function observeUpdateLog(file) {
  if (!fs.existsSync(file)) return { bytes: 0, sha256: sha256(Buffer.alloc(0)) };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('native update log is not a regular file');
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function nightlyReceipts(brainHome, identity) {
  const dir = path.join(brainHome, 'refresh-runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`untrusted refresh evidence: ${file}`);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, receipt };
  }).filter(({ receipt }) => receipt.kind === 'ruvnet-brain-refresh-run'
    && receipt.action === 'nightly' && receipt.schedulerIdentity === identity);
}

function refreshExecutionStopped(receipt, kbDir) {
  if (inspectRefreshOwner(receipt.ownerToken) !== 'dead') return false;
  const lock = refreshLockPath(kbDir);
  const parent = path.dirname(lock);
  return !fs.existsSync(lock) && (!fs.existsSync(parent) || !fs.readdirSync(parent)
    .some((name) => name.startsWith(`${path.basename(lock)}.release-`)));
}

// Dependency seams here exercise orchestration without touching a developer's native scheduler.
// Only runNightlyTwoRunProof writes proof, and it supplies the real installed adapter and commands.
export async function triggerNativeRun({ scheduler, registration, platform, env, brainHome, kbDir,
  timeoutMs, command = run, receipts = nightlyReceipts, pause = sleep, now = Date.now, stopped = refreshExecutionStopped }) {
  const identity = registration.identity;
  if (!/^com\.ruvnet\.brain-update\.proof-[A-Za-z0-9._-]+$/.test(identity || '')) {
    throw new Error('native proof requires a unique proof scheduler identity');
  }
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`unsupported native scheduler platform: ${platform}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('proof timeout must be a positive integer');
  const options = { platform, env, brainHome, kbDir, identity, proofTick: platform === 'linux',
    ...(platform === 'linux' ? { proofAt: now() + 60_000 } : {}) };
  const before = scheduler.schedulerStatus(options);
  if (before.state !== 'off') throw new Error(`proof scheduler identity is not absent: ${before.evidence}`);
  const beforeIds = new Set(receipts(brainHome, identity).map(({ receipt }) => receipt.runId));
  let attempted = false;
  let removed = false;
  const remove = () => {
    const result = scheduler.removeScheduler(options);
    if (!result.ok) throw new Error(`proof scheduler cleanup failed: ${result.why}`);
    const status = scheduler.schedulerStatus(options);
    if (status.state !== 'off') throw new Error(`proof scheduler absence unverified: ${status.evidence}`);
    removed = true;
  };
  try {
    attempted = true;
    const installed = scheduler.installScheduler(registration, { ...options, pathValue: env.PATH });
    if (!installed.ok) throw new Error(`native scheduler unavailable: ${installed.why}`);
    const status = scheduler.schedulerStatus(options);
    if (status.state !== 'on') throw new Error(`proof scheduler is not on: ${status.evidence}`);
    if (platform === 'darwin') {
      // Darwin has getuid, but the qualification suite also exercises the Darwin
      // branch from Windows. Keep that simulation portable without changing the
      // real launchctl identity on macOS.
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      command('launchctl', ['kickstart', '-k', `gui/${uid}/${identity}`]);
    }
    if (platform === 'win32') command('schtasks', ['/Run', '/TN', identity]);
    // Cron itself must deliver the Linux trigger. Never execute its command directly as proof.
    const startedAt = now();
    let observedStart = false;
    while (now() - startedAt < timeoutMs) {
      const created = receipts(brainHome, identity)
      .filter(({ receipt }) => !beforeIds.has(receipt.runId));
      if (created.length > 1) throw new Error(`scheduler produced ${created.length} refresh runs; expected exactly one`);
      if (created.length === 1) {
        observedStart = true;
        // Stop the minute cadence at the first receipt, including RUNNING, so long updates do
        // not launch again. Removing a cron row does not kill its already running child.
        if (platform === 'linux' && !removed) remove();
        if (['SUCCEEDED', 'FAILED', 'ABANDONED'].includes(created[0].receipt.status)
          && stopped(created[0].receipt, kbDir)) {
          await pause(250); // Let the exited child's npm parent finish flushing its log.
          return { ...created[0],
          trigger: { kind: { darwin: 'launchctl-kickstart', linux: 'cron-tick', win32: 'schtasks-run' }[platform], identity } };
        }
      }
      if (platform === 'linux' && !observedStart && now() - startedAt >= 120_000) {
        throw new Error('cron did not start the owned proof job within two minutes; check that the cron service is running');
      }
      await pause(1000);
    }
    throw new Error(`timed out waiting for ${identity} terminal refresh receipt`);
  } finally {
    if (attempted && !removed) remove();
  }
}

/**
 * Fast release proof for the native scheduler boundary. This deliberately checks only the
 * scheduler's real registration, load, trigger dispatch, and cleanup. The expensive two-run
 * updater lifecycle remains a scheduled/post-publication soak and must not block every release.
 */
export async function runNativeSchedulerSmoke({ packageRoot, packagePath, bundlePath, sourceSha, workflowRunId,
  scheduler, env, brainHome, kbDir, now = Date.now, command = run } = {}) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    throw new Error(`unsupported native scheduler platform: ${process.platform}`);
  }
  if (!packageRoot || !fs.lstatSync(packageRoot).isDirectory()) throw new Error('scheduler smoke package root is missing');
  const packageArchive = path.resolve(packagePath || '');
  const packageStat = fs.lstatSync(packageArchive);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || !packageArchive.endsWith('.tgz')) {
    throw new Error('scheduler smoke package archive is not a regular file');
  }
  const bundle = path.resolve(bundlePath || '');
  const stat = fs.lstatSync(bundle);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('scheduler smoke bundle is not a regular file');
  if (!/^[a-f0-9]{40}$/.test(String(sourceSha || ''))) throw new Error('scheduler smoke source SHA is invalid');
  if (!/^\d+$/.test(String(workflowRunId || ''))) throw new Error('scheduler smoke workflow run ID is invalid');
  if (!scheduler || typeof scheduler.installNightlyRunner !== 'function'
    || typeof scheduler.installScheduler !== 'function' || typeof scheduler.schedulerStatus !== 'function'
    || typeof scheduler.removeScheduler !== 'function') throw new Error('scheduler smoke adapter is incomplete');

  const identity = `com.ruvnet.brain-update.proof-smoke-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const packageSha256 = sha256(fs.readFileSync(packageArchive));
  const bundleSha256 = sha256(fs.readFileSync(bundle));
  const registration = scheduler.installNightlyRunner({ brainHome,
    source: path.join(packageRoot, 'bin', 'nightly-refresh.mjs'), nodePath: process.execPath, identity, env,
    packageTarget: { spec: packageArchive, sha256: packageSha256 },
    bundleTarget: { spec: bundle, sha256: bundleSha256 } });
  const options = { platform: process.platform, env, brainHome, kbDir, identity,
    proofTick: process.platform === 'linux', proofAt: process.platform === 'linux' ? now() + 60_000 : undefined,
    pathValue: env.PATH };
  const before = scheduler.schedulerStatus(options);
  if (before.state !== 'off') throw new Error(`scheduler smoke identity is not absent: ${before.evidence}`);
  let installed = false;
  let cleaned = false;
  try {
    const result = scheduler.installScheduler(registration, options);
    if (!result.ok) throw new Error(`native scheduler smoke install failed: ${result.why}`);
    installed = true;
    const loaded = scheduler.schedulerStatus(options);
    if (loaded.state !== 'on') throw new Error(`native scheduler smoke was not loaded: ${loaded.evidence}`);
    if (process.platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      command('launchctl', ['kickstart', '-k', `gui/${uid}/${identity}`]);
    } else if (process.platform === 'win32') {
      command('schtasks', ['/Run', '/TN', identity]);
    }
    const removed = scheduler.removeScheduler({ platform: process.platform, env, identity });
    if (!removed.ok) throw new Error(`native scheduler smoke cleanup failed: ${removed.why}`);
    cleaned = true;
    const absent = scheduler.schedulerStatus(options);
    if (absent.state !== 'off') throw new Error(`native scheduler smoke absence was not verified: ${absent.evidence}`);
    return {
      schemaVersion: 1,
      kind: 'ruvnet-brain-native-scheduler-smoke',
      scope: 'public-release-scheduler-boundary',
      platform: process.platform,
      sourceSha: String(sourceSha),
      workflowRunId: String(workflowRunId),
      identity,
      registration: {
        recordPath: registration.recordPath, nodePath: registration.nodePath,
        runnerPath: registration.runnerPath, runnerSha256: registration.runnerSha256,
        packageTarget: registration.packageTarget, bundleTarget: registration.bundleTarget,
      },
      trigger: { kind: { darwin: 'launchctl-kickstart', linux: 'cron-registration', win32: 'schtasks-run' }[process.platform], identity },
      loaded: true,
      cleaned: true,
      observedAt: new Date().toISOString(),
    };
  } finally {
    if (installed && !cleaned) {
      try { scheduler.removeScheduler({ platform: process.platform, env, identity }); } catch { /* preserve original failure */ }
    }
  }
}

export function validateNativeSchedulerSmoke(smoke, { platform, sourceSha, workflowRunId,
  bundleSha256 } = {}) {
  const failures = [];
  if (smoke?.schemaVersion !== 1 || smoke?.kind !== 'ruvnet-brain-native-scheduler-smoke'
    || smoke.scope !== 'public-release-scheduler-boundary') failures.push('scheduler smoke envelope is invalid');
  if (smoke.platform !== platform || smoke.sourceSha !== sourceSha
    || String(smoke.workflowRunId || '') !== String(workflowRunId || '')) failures.push('scheduler smoke identity differs');
  if (!/^com\.ruvnet\.brain-update\.proof-smoke-[A-Za-z0-9._-]+$/.test(smoke.identity || '')) failures.push('scheduler smoke identity is not isolated');
  if (smoke.loaded !== true || smoke.cleaned !== true || smoke.trigger?.identity !== smoke.identity) failures.push('scheduler smoke did not prove load, trigger, and cleanup');
  const expectedTrigger = { darwin: 'launchctl-kickstart', linux: 'cron-registration', win32: 'schtasks-run' }[platform];
  if (smoke.trigger?.kind !== expectedTrigger) failures.push('scheduler smoke trigger differs');
  const registration = smoke.registration;
  if (!registration || !/^[a-f0-9]{64}$/.test(registration.runnerSha256 || '')
    || !/^[a-f0-9]{64}$/.test(registration.bundleTarget?.sha256 || '')
    || registration.bundleTarget.sha256 !== bundleSha256
    || !/^[a-f0-9]{64}$/.test(registration.packageTarget?.sha256 || '')
    || !path.isAbsolute(registration.packageTarget?.spec || '') || !registration.packageTarget.spec.endsWith('.tgz')
    || !path.isAbsolute(registration.recordPath || '') || !path.isAbsolute(registration.nodePath || '')
    || !path.isAbsolute(registration.runnerPath || '')) failures.push('scheduler smoke registration identity is incomplete');
  if (!Number.isFinite(Date.parse(smoke.observedAt)) || Date.parse(smoke.observedAt) > Date.now() + 60_000) failures.push('scheduler smoke observation time is invalid');
  return { ok: failures.length === 0, failures };
}

export function validateTwoRunEvidence({ first, second, inventoryBefore, inventoryAfterFirst,
  inventoryAfterSecond, retention, validateEnvelope, identity }) {
  const failures = [];
  for (const [label, receipt] of [['first', first], ['second', second]]) {
    const envelope = validateEnvelope(receipt);
    if (!envelope.ok) failures.push(`${label} run: ${envelope.why}`);
    const execution = validateCurrentRunPhaseExecution(receipt);
    failures.push(...execution.failures.map((failure) => `${label} run: ${failure}`));
    if (receipt.schedulerIdentity !== identity) failures.push(`${label} run scheduler identity differs`);
  }
  failures.push(...validateStorageEvidence({ first, second, inventoryBefore, inventoryAfterFirst, inventoryAfterSecond, retention }));
  return { ok: failures.length === 0, failures };
}

function validateStorageEvidence({ first, second, inventoryBefore, inventoryAfterFirst, inventoryAfterSecond, retention }) {
  const failures = [];
  if (first.runId === second.runId) failures.push('two scheduler invocations reused one run ID');
  if (!Number.isFinite(Date.parse(first.finishedAt)) || !Number.isFinite(Date.parse(second.startedAt))
    || Date.parse(second.startedAt) < Date.parse(first.finishedAt)) failures.push('second run did not start after first completion');
  if (!['applied', 'noop'].includes(first.terminalVerdict)) failures.push('first run did not converge');
  if (second.terminalVerdict !== 'noop') failures.push('second run was not a no-op');
  const secondDelta = second.detail?.storageDelta;
  if (!secondDelta || secondDelta.redundantCopyCount !== 0
    || !Number.isSafeInteger(secondDelta.additionalFullCorpusCopyDelta)
    || secondDelta.additionalFullCorpusCopyDelta > 0) {
    failures.push('second run did not prove a zero-redundancy storage delta');
  }
  for (const [label, inventory] of [['before', inventoryBefore], ['after first', inventoryAfterFirst],
    ['after second', inventoryAfterSecond]]) {
    if (inventory.additionalFullCorpusCopyCount !== 0) failures.push(`${label} inventory has redundant corpus copies`);
    if (!Number.isSafeInteger(inventory.totalManagedBytes) || inventory.totalManagedBytes < 0) failures.push(`${label} inventory has no measured byte count`);
  }
  let logGrowth = 0;
  if (retention.updateLog !== undefined) {
    const { before, after } = retention.updateLog;
    if (![before, after].every((row) => Number.isSafeInteger(row?.bytes) && row.bytes >= 0
      && /^[a-f0-9]{64}$/.test(row.sha256 || '')) || !Number.isSafeInteger(retention.policy?.maxEvidenceBytes)
      || retention.policy.maxEvidenceBytes <= 0 || after.bytes > retention.policy.maxEvidenceBytes) {
      failures.push('native log byte measurements are invalid or exceed the evidence budget');
    } else logGrowth = Math.max(0, after.bytes - before.bytes);
  }
  if (inventoryAfterSecond.totalManagedBytes > inventoryAfterFirst.totalManagedBytes
    + Math.max(0, retention.after?.bytes - retention.before?.bytes) + logGrowth) {
    failures.push('second no-op increased managed storage outside retained lifecycle evidence');
  }
  if (retention.withinBudget !== true || retention.unsafe?.length) failures.push('lifecycle evidence is not within policy');
  if (![retention.before?.bytes, retention.after?.bytes].every((bytes) => Number.isSafeInteger(bytes) && bytes >= 0)) failures.push('lifecycle evidence byte measurements are missing');
  return failures;
}

function validateInstalledRun(run, proof) {
  const receipt = run.receipt;
  const failures = [];
  const envelope = validateRefreshReceiptEnvelope(receipt);
  if (!envelope.ok) failures.push(envelope.why);
  const projection = run.installedCoverage;
  const coverage = JSON.parse(projection?.raw || 'null');
  if (!coverage || projection.sha256 !== sha256(Buffer.from(projection.raw))) throw new Error('installed coverage bytes differ');
  const ledger = validateCoverageLedger(coverage);
  failures.push(...ledger.failures);
  if (coverage.kind !== 'ruvnet-brain-release-coverage' || coverage.releaseIdentity?.sourceSnapshot !== proof.sourceSha
    || coverage.releaseIdentity?.version !== proof.candidate.version) failures.push('installed ReleaseCoverage is not the exact candidate');
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) failures.push('installed update time window is invalid');
  if (!Number.isFinite(Date.parse(projection.observedAt)) || Date.parse(projection.observedAt) < end
    || Date.parse(projection.observedAt) > Date.parse(proof.observedAt)) failures.push('installed coverage observation is outside run completion');
  if (JSON.stringify(receipt.phases?.map(({ phase }) => phase)) !== JSON.stringify(REQUIRED_REFRESH_PHASES)) failures.push('installed update phases are incomplete');
  const performed = new Set(['update', 'host-convergence', 'cleanup']);
  for (const phase of receipt.phases || []) {
    const execution = phase.evidence?.execution;
    const at = Date.parse(phase.at);
    if (phase.status !== 'PASS' || !Number.isFinite(at) || at < start || at > end) failures.push(`${phase.phase} has invalid run evidence`);
    if (performed.has(phase.phase) || (phase.phase === 'local-overlay-restoration' && execution?.kind === 'executed')) {
      if (execution?.kind !== 'executed' || execution.runId !== receipt.runId) failures.push(`${phase.phase} was not executed by this run`);
    } else if (phase.phase === 'local-overlay-restoration') {
      if (execution?.kind !== 'not-executed' || phase.evidence?.restoredStores !== 0) failures.push('unexecuted private overlay restoration is not empty');
    } else if (execution?.kind !== 'imported-release' || execution.sourceSnapshot !== proof.sourceSha
      || execution.upstreamFreshness !== 'UNKNOWN') failures.push(`${phase.phase} imported corpus provenance is invalid`);
  }
  const evidence = Object.fromEntries((receipt.phases || []).map(({ phase, evidence }) => [phase, evidence]));
  if (evidence['coverage-generation']?.coverageSha256 !== projection.sha256
    || evidence['coverage-generation']?.releaseCoverageGeneration !== coverage.releaseCoverageGeneration
    || evidence['source-enumeration']?.sourceObservationSha256 !== coverage.sourceObservationSha256
    || evidence['source-enumeration']?.rows !== coverage.totals.rows
    || evidence['source-enumeration']?.terminal !== true
    || evidence.ingestion?.eligibleCurrent !== coverage.rows.filter((row) => row.disposition === 'eligible' && row.status === 'CURRENT').length
    || evidence.ingestion?.storeCount !== coverage.generationLedger.storeCount
    || evidence['bundle-assembly']?.version !== coverage.releaseIdentity.version
    || evidence['bundle-assembly']?.sourceSnapshot !== proof.sourceSha
    || evidence['generation-ledger-reconciliation']?.sha256 !== coverage.generationLedger.sha256) failures.push('imported corpus evidence differs from installed projection');
  const r = proof.registration;
  const expectedIdentity = { schedulerIdentity: proof.identity, registrationPath: r.recordPath,
    nodePath: r.nodePath, runnerPath: r.runnerPath, runnerSha256: r.runnerSha256, argv: [] };
  const absolute = (value) => typeof value === 'string' && (proof.platform === 'win32' ? path.win32.isAbsolute(value) && !value.startsWith('/') : path.posix.isAbsolute(value));
  if (!/^[a-f0-9]{64}$/.test(r.runnerSha256 || '') || !absolute(r.recordPath)
    || !absolute(r.nodePath) || !absolute(r.runnerPath)
    || !receipt.executableIdentity || receiptDigest(receipt.executableIdentity) !== receiptDigest(expectedIdentity)
    || receipt.schedulerIdentity !== proof.identity) failures.push('native executable identity differs');
  if (run.trigger?.identity !== proof.identity || run.trigger?.kind !== {
    darwin: 'launchctl-kickstart', linux: 'cron-tick', win32: 'schtasks-run',
  }[proof.platform]) failures.push('native scheduler trigger differs');
  return failures;
}

export function validateNightlyProofReceipt(receipt, { platform, version, packageSha256, bundleSha256,
  sourceSha, workflowRunId, publicKey = PUBLIC_KEY } = {}) {
  const failures = [];
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'ruvnet-brain-native-two-run-nightly-proof') {
    return { ok: false, failures: ['invalid native nightly proof envelope'] };
  }
  const { receiptSha256: declaredDigest, ...body } = receipt;
  if (receipt.scope !== 'installed-update' || receipt.upstreamFreshness !== 'UNKNOWN') failures.push('native proof scope is not installed-update with unknown upstream freshness');
  try {
    if (!crypto.verify(null, Buffer.from(bundleSha256 || '', 'hex'), publicKey,
      Buffer.from(receipt.candidate?.bundle?.signatureBase64 || '', 'base64'))) failures.push('public bundle signature is invalid');
  } catch { failures.push('public bundle signature is invalid'); }
  if (declaredDigest !== receiptDigest(body)) failures.push('native proof receipt digest differs');
  if (!['darwin', 'linux', 'win32'].includes(platform) || receipt.platform !== platform) failures.push('native proof platform differs');
  if (!version || receipt.candidate?.version !== version) failures.push('native proof version differs');
  if (!/^[a-f0-9]{64}$/.test(packageSha256 || '') || receipt.candidate?.sha256 !== packageSha256) failures.push('native proof package digest differs');
  if (!/^[a-f0-9]{64}$/.test(bundleSha256 || '') || receipt.candidate?.bundle?.sha256 !== bundleSha256) failures.push('native proof bundle digest differs');
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || receipt.sourceSha !== sourceSha) failures.push('native proof source SHA differs');
  if (!/^\d+$/.test(String(workflowRunId || '')) || String(receipt.workflowRunId || '') !== String(workflowRunId)) failures.push('native proof workflow run differs');
  if (!/^com\.ruvnet\.brain-update\.proof-[A-Za-z0-9._-]+$/.test(receipt.identity || '')) failures.push('native proof identity is not isolated');
  if (receipt.packageExecution !== undefined || receipt.registration?.packageTarget?.spec === 'ruvnet-brain@latest') {
    failures.push(...validateNpxObservations(receipt));
  }
  const observedAt = Date.parse(receipt.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 60_000) failures.push('native proof observation time is invalid');
  if (!Array.isArray(receipt.runs) || receipt.runs.length !== 2) failures.push('native proof requires exactly two runs');
  else {
    for (const run of receipt.runs) {
      if (!run.receipt || run.receiptSha256 !== receiptDigest(run.receipt)
        || run.runId !== run.receipt.runId || run.terminalVerdict !== run.receipt.terminalVerdict) {
        failures.push('embedded run identity or digest differs');
      }
      const finishedAt = Date.parse(run.receipt?.finishedAt);
      if (!Number.isFinite(finishedAt) || finishedAt > observedAt) failures.push('native run completion is not bounded by observation');
    }
    try {
      failures.push(...receipt.runs.flatMap((run) => validateInstalledRun(run, receipt)));
      if (Date.parse(receipt.runs[0].installedCoverage.observedAt) > Date.parse(receipt.runs[1].receipt.startedAt)) {
        failures.push('first installed coverage was not observed before the second run');
      }
      failures.push(...validateStorageEvidence({ first: receipt.runs[0].receipt, second: receipt.runs[1].receipt,
        inventoryBefore: receipt.inventory.before, inventoryAfterFirst: receipt.inventory.afterFirst,
        inventoryAfterSecond: receipt.inventory.afterSecond, retention: receipt.retention }));
    } catch (error) { failures.push(`incomplete native proof evidence: ${error.message}`); }
  }
  return { ok: failures.length === 0, failures };
}

export async function runNightlyTwoRunProof({ packagePath, bundlePath, out, timeoutMs = 30 * 60 * 1000,
  keepRoot = false, sourceSha = process.env.GITHUB_SHA || null,
  workflowRunId = process.env.GITHUB_RUN_ID || null, signaturePath = `${bundlePath}.sig` } = {}) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error(`unsupported native scheduler platform: ${process.platform}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('proof timeout must be a positive integer');
  const candidate = path.resolve(packagePath || '');
  const output = path.resolve(out || '');
  if (!candidate.endsWith('.tgz') || !fs.lstatSync(candidate).isFile()) throw new Error('candidate must be a regular .tgz file');
  const bundle = path.resolve(bundlePath || '');
  let bundleStat;
  try { bundleStat = fs.lstatSync(bundle); } catch { /* handled below */ }
  if (!bundle.endsWith('.zip') || !bundleStat?.isFile() || bundleStat.isSymbolicLink()) {
    throw new Error('bundle must be a regular candidate bundle .zip file');
  }
  const bundleSha256 = sha256(fs.readFileSync(bundle));
  const signatureBase64 = fs.readFileSync(signaturePath).toString('base64');
  if (!crypto.verify(null, Buffer.from(bundleSha256, 'hex'), PUBLIC_KEY, Buffer.from(signatureBase64, 'base64'))) {
    throw new Error('public candidate bundle signature is invalid');
  }
  const packageSha256 = sha256(fs.readFileSync(candidate));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-nightly-proof-'));
  const home = path.join(root, 'home');
  const brainHome = path.join(root, 'brain');
  const kbDir = path.join(brainHome, 'kb');
  const prefix = path.join(root, 'prefix');
  const npmCache = path.join(root, 'npm-cache');
  const logPath = path.join(kbDir, 'update.log');
  const identity = `com.ruvnet.brain-update.proof-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tempDir = path.join(root, 'tmp');
  const env = {
    ...Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    PATH: [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    RUVNET_BRAIN_HOME: brainHome,
    RUVNET_BRAIN_KB: kbDir,
    npm_config_cache: npmCache,
    TEMP: tempDir,
    TMP: tempDir,
    NO_COLOR: '1',
  };
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tempDir);
  let scheduler;
  let registration;
  let completed = false;
  try {
    const npm = npmInvocation(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', candidate]);
    run(npm.executable, npm.args, { env });
    const packageRoot = path.join(prefix, 'node_modules', 'ruvnet-brain');
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const expectedPackage = packageTreeObservation(packageRoot);
    // Release verification already downloaded and hashed the exact npm bytes above. Reusing
    // those bytes keeps the per-release scheduler smoke deterministic and avoids a second
    // registry/latest resolution. The unattended production nightly still uses @latest.
    const packageTarget = {
      spec: candidate,
      sha256: packageSha256,
      policy: 'sealed-candidate-exact-cache-v1',
    };
    const prepare = npmInvocation(['exec', '--yes', `--package=${packageTarget.spec}`, '--', 'ruvnet-brain', '--help']);
    run(prepare.executable, prepare.args, { env, cwd: home });
    const packageObservations = [observeNpxPackage(npmCache, expectedPackage)];
    // Register the exact public package's plugin in this fresh home. GitHub shorthand can
    // select SSH on Windows and leave no staged plugin for the first scheduled activation.
    env.RUVNET_CLAUDE_MARKETPLACE_SOURCE = packageRoot;
    const stagedBundle = stageExactBundle({ bundlePath: bundle, packageRoot });
    run(process.execPath, [path.join(packageRoot, 'bin', 'install.mjs'), '--yes', '--no-nightly-prompt'], {
      env: { ...env, npm_config_bin_links: 'false' }, stdio: 'inherit', encoding: undefined,
    });
    const removedEmptyScaffolds = removeEmptyInstallerScaffolds(kbDir);
    scheduler = await import(`${pathToFileURL(path.join(packageRoot, 'plugin', 'scripts', 'nightly-scheduler.mjs')).href}?proof=${Date.now()}`);
    registration = scheduler.installNightlyRunner({ brainHome,
      source: path.join(packageRoot, 'bin', 'nightly-refresh.mjs'), nodePath: process.execPath, identity, env,
      packageTarget: { spec: packageTarget.spec, sha256: packageTarget.sha256 },
      bundleTarget: { spec: stagedBundle.sourcePath, sha256: stagedBundle.sha256 } });
    const inventoryBefore = managedStorageInventory(kbDir);
    const kick = () => triggerNativeRun({ scheduler, registration, platform: process.platform,
      env, brainHome, kbDir, timeoutMs });
    const observeCoverage = () => {
      const checked = validateCoverageDirectory(kbDir, { expectedVersion: packageJson.version, expectedSourceSnapshot: sourceSha });
      if (!checked.valid) throw new Error(`installed candidate ReleaseCoverage failed: ${checked.failures.join('; ')}`);
      const raw = fs.readFileSync(path.join(kbDir, 'COVERAGE.json'), 'utf8');
      return { raw, sha256: sha256(Buffer.from(raw)), observedAt: new Date().toISOString() };
    };
    const firstEntry = await kick();
    firstEntry.installedCoverage = observeCoverage();
    const inventoryAfterFirst = managedStorageInventory(kbDir);
    packageObservations.push(observeNpxPackage(npmCache, expectedPackage));
    const retentionAfterFirst = assessLifecycleEvidence({ brainHome, kbDir });
    const logAfterFirst = observeUpdateLog(logPath);
    const secondEntry = await kick();
    secondEntry.installedCoverage = observeCoverage();
    const inventoryAfterSecond = managedStorageInventory(kbDir);
    packageObservations.push(observeNpxPackage(npmCache, expectedPackage));
    const retentionAfterSecond = assessLifecycleEvidence({ brainHome, kbDir });
    const retention = { ...retentionAfterSecond, before: retentionAfterFirst.after,
      withinBudget: retentionAfterFirst.withinBudget && retentionAfterSecond.withinBudget,
      unsafe: [...retentionAfterFirst.unsafe, ...retentionAfterSecond.unsafe],
      updateLog: { before: logAfterFirst, after: observeUpdateLog(logPath) } };
    const receipt = {
      schemaVersion: 1,
      kind: 'ruvnet-brain-native-two-run-nightly-proof',
      scope: 'installed-update',
      installationConfiguration: { npmBinLinks: false, source: 'initial-reader-install-only', removedEmptyScaffolds },
      packageExecution: { policy: packageTarget.policy,
        expected: { ...expectedPackage, packageSha256 }, observations: packageObservations },
      upstreamFreshness: 'UNKNOWN',
      observedAt: new Date().toISOString(),
      platform: process.platform,
      sourceSha,
      workflowRunId: workflowRunId == null ? null : String(workflowRunId),
      identity,
      candidate: { path: candidate, sha256: packageSha256, version: packageJson.version,
        bundle: { path: stagedBundle.sourcePath, sha256: stagedBundle.sha256, bytes: stagedBundle.bytes, signatureBase64 } },
      registration: { recordPath: registration.recordPath, runnerSha256: registration.runnerSha256,
        nodePath: registration.nodePath, runnerPath: registration.runnerPath,
        packageTarget: registration.packageTarget, bundleTarget: registration.bundleTarget },
      runs: [firstEntry, secondEntry].map(({ receipt: row, installedCoverage, trigger }) => ({ runId: row.runId,
        terminalVerdict: row.terminalVerdict, receiptSha256: receiptDigest(row), finishedAt: row.finishedAt,
        receipt: row, installedCoverage, trigger })),
      inventory: { before: inventoryBefore, afterFirst: inventoryAfterFirst, afterSecond: inventoryAfterSecond },
      retention,
      log: { path: logPath, exists: fs.existsSync(logPath),
        sha256: fs.existsSync(logPath) ? sha256(fs.readFileSync(logPath)) : null },
    };
    receipt.receiptSha256 = receiptDigest(receipt);
    const validation = validateNightlyProofReceipt(receipt, { platform: process.platform, version: packageJson.version,
      packageSha256, bundleSha256, sourceSha, workflowRunId });
    delete receipt.receiptSha256;
    receipt.validation = validation;
    receipt.receiptSha256 = receiptDigest(receipt);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    if (!validation.ok) throw new Error(`native two-run proof failed: ${validation.failures.join('; ')}`);
    completed = true;
    return receipt;
  } finally {
    // Each trigger owns cleanup and verifies absence before returning. Failed runs retain their
    // root so an active child or failed cleanup never loses the evidence/runner it still needs.
    if (completed && !keepRoot) fs.rmSync(root, { recursive: true, force: true });
    if (!completed) console.error(`Native proof diagnostics retained at ${root}`);
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const receipt = await runNightlyTwoRunProof({ packagePath: args.package, bundlePath: args.bundle, out: args.out,
      timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
      sourceSha: args['source-sha'] || process.env.GITHUB_SHA,
      signaturePath: args.signature,
      workflowRunId: args['workflow-run-id'] || process.env.GITHUB_RUN_ID,
      keepRoot: args['keep-root'] === 'true' });
    console.log(JSON.stringify({ ok: true, receipt: path.resolve(args.out),
      receiptSha256: receipt.receiptSha256, runs: receipt.runs }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
