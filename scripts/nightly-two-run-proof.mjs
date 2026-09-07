#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assessLifecycleEvidence } from '../kb/lifecycle-evidence-retention.mjs';
import { managedStorageInventory } from '../kb/update-storage-transaction.mjs';
import { validateCurrentRunPhaseExecution } from '../kb/refresh-run.mjs';

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

async function awaitOneTerminalReceipt({ brainHome, identity, beforeIds, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const created = nightlyReceipts(brainHome, identity)
      .filter(({ receipt }) => !beforeIds.has(receipt.runId));
    if (created.length > 1) throw new Error(`scheduler produced ${created.length} refresh runs; expected exactly one`);
    if (created.length === 1 && ['SUCCEEDED', 'FAILED', 'ABANDONED'].includes(created[0].receipt.status)) {
      return created[0];
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${identity} terminal refresh receipt`);
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
  if (first.runId === second.runId) failures.push('two scheduler invocations reused one run ID');
  if (!['applied', 'noop'].includes(first.terminalVerdict)) failures.push('first run did not converge');
  if (second.terminalVerdict !== 'noop') failures.push('second run was not a no-op');
  const secondDelta = second.detail?.storageDelta;
  if (!secondDelta || secondDelta.redundantCopyCount !== 0
    || secondDelta.additionalFullCorpusCopyDelta > 0) {
    failures.push('second run did not prove a zero-redundancy storage delta');
  }
  for (const [label, inventory] of [['before', inventoryBefore], ['after first', inventoryAfterFirst],
    ['after second', inventoryAfterSecond]]) {
    if (inventory.additionalFullCorpusCopyCount !== 0) failures.push(`${label} inventory has redundant corpus copies`);
  }
  if (inventoryAfterSecond.totalManagedBytes > inventoryAfterFirst.totalManagedBytes
    + Math.max(0, retention.after?.bytes - retention.before?.bytes)) {
    failures.push('second no-op increased managed storage outside retained lifecycle evidence');
  }
  if (retention.withinBudget !== true || retention.unsafe?.length) failures.push('lifecycle evidence is not within policy');
  return { ok: failures.length === 0, failures };
}

export async function runNightlyTwoRunProof({ packagePath, bundlePath, out, timeoutMs = 30 * 60 * 1000,
  keepRoot = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('native two-run scheduler proof requires macOS launchd');
  const candidate = path.resolve(packagePath || '');
  const output = path.resolve(out || '');
  if (!candidate.endsWith('.tgz') || !fs.lstatSync(candidate).isFile()) throw new Error('candidate must be a regular .tgz file');
  const bundle = path.resolve(bundlePath || '');
  let bundleStat;
  try { bundleStat = fs.lstatSync(bundle); } catch { /* handled below */ }
  if (!bundle.endsWith('.zip') || !bundleStat?.isFile() || bundleStat.isSymbolicLink()) {
    throw new Error('bundle must be a regular candidate bundle .zip file');
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
  const env = {
    PATH: [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    RUVNET_BRAIN_HOME: brainHome,
    RUVNET_BRAIN_KB: kbDir,
    npm_config_cache: npmCache,
    NO_COLOR: '1',
  };
  fs.mkdirSync(home, { recursive: true });
  let scheduler;
  let registration;
  try {
    run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', candidate], { env });
    const packageRoot = path.join(prefix, 'node_modules', 'ruvnet-brain');
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const stagedBundle = stageExactBundle({ bundlePath: bundle, packageRoot });
    run(process.execPath, [path.join(packageRoot, 'bin', 'install.mjs'), '--yes', '--no-nightly-prompt'], {
      env, stdio: 'inherit', encoding: undefined,
    });
    scheduler = await import(`${pathToFileURL(path.join(packageRoot, 'plugin', 'scripts', 'nightly-scheduler.mjs')).href}?proof=${Date.now()}`);
    registration = scheduler.installNightlyRunner({ brainHome,
      source: path.join(packageRoot, 'bin', 'nightly-refresh.mjs'), nodePath: process.execPath, identity,
      packageTarget: { spec: candidate, sha256: packageSha256 },
      bundleTarget: { spec: stagedBundle.sourcePath, sha256: stagedBundle.sha256 } });
    const installed = scheduler.installScheduler(registration, { platform: 'darwin', env, kbDir,
      pathValue: env.PATH });
    if (!installed.ok) throw new Error(installed.why);
    const status = scheduler.schedulerStatus({ platform: 'darwin', env, brainHome, kbDir, identity });
    if (status.state !== 'on') throw new Error(`proof LaunchAgent is not on: ${status.evidence}`);

    const inventoryBefore = managedStorageInventory(kbDir);
    const kick = async () => {
      const before = new Set(nightlyReceipts(brainHome, identity).map(({ receipt }) => receipt.runId));
      run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${identity}`]);
      return awaitOneTerminalReceipt({ brainHome, identity, beforeIds: before, timeoutMs });
    };
    const firstEntry = await kick();
    const inventoryAfterFirst = managedStorageInventory(kbDir);
    const secondEntry = await kick();
    const inventoryAfterSecond = managedStorageInventory(kbDir);
    const retention = assessLifecycleEvidence({ brainHome, kbDir });
    const validation = validateTwoRunEvidence({ first: firstEntry.receipt, second: secondEntry.receipt,
      inventoryBefore, inventoryAfterFirst, inventoryAfterSecond, retention,
      validateEnvelope: scheduler.validateRefreshReceiptEnvelope, identity });
    const receipt = {
      schemaVersion: 1,
      kind: 'ruvnet-brain-native-two-run-nightly-proof',
      observedAt: new Date().toISOString(),
      platform: process.platform,
      identity,
      candidate: { path: candidate, sha256: packageSha256, version: packageJson.version,
        bundle: { path: stagedBundle.sourcePath, sha256: stagedBundle.sha256, bytes: stagedBundle.bytes } },
      registration: { recordPath: registration.recordPath, runnerSha256: registration.runnerSha256,
        packageTarget: registration.packageTarget, bundleTarget: registration.bundleTarget },
      runs: [firstEntry.receipt, secondEntry.receipt].map((row) => ({ runId: row.runId,
        terminalVerdict: row.terminalVerdict, receiptSha256: receiptDigest(row), finishedAt: row.finishedAt,
        receipt: row })),
      inventory: { before: inventoryBefore, afterFirst: inventoryAfterFirst, afterSecond: inventoryAfterSecond },
      retention,
      validation,
      log: { path: logPath, exists: fs.existsSync(logPath),
        sha256: fs.existsSync(logPath) ? sha256(fs.readFileSync(logPath)) : null },
    };
    receipt.receiptSha256 = receiptDigest(receipt);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    if (!validation.ok) throw new Error(`native two-run proof failed: ${validation.failures.join('; ')}`);
    return receipt;
  } finally {
    if (scheduler) scheduler.removeScheduler({ platform: 'darwin', env, identity });
    else spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${identity}`], { stdio: 'ignore' });
    if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const receipt = await runNightlyTwoRunProof({ packagePath: args.package, bundlePath: args.bundle, out: args.out,
      timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
      keepRoot: args['keep-root'] === 'true' });
    console.log(JSON.stringify({ ok: true, receipt: path.resolve(args.out),
      receiptSha256: receipt.receiptSha256, runs: receipt.runs }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
