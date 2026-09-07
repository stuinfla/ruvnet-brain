import { packageTreeObservation, observeNpxPackage, validateNpxObservations } from '../../scripts/nightly-package-observation.mjs';
import { spawnSync } from 'node:child_process';
import { npmInvocation } from '../../scripts/npm-invocation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { removeEmptyInstallerScaffolds, stageExactBundle, triggerNativeRun, validateNightlyProofReceipt, validateTwoRunEvidence } from '../../scripts/nightly-two-run-proof.mjs';
import { REQUIRED_REFRESH_PHASES } from '../../kb/refresh-run.mjs';
import { validateRefreshReceiptEnvelope } from '../../plugin/scripts/nightly-scheduler.mjs';
import { managedStorageInventory } from '../../kb/update-storage-transaction.mjs';
import { releaseCoverageGenerationFor } from '../../plugin/scripts/coverage-integrity.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const inventory = (copies = 0, bytes = 100) => ({ additionalFullCorpusCopyCount: copies,
  totalManagedBytes: bytes });
// Structural fixtures only: these do not represent actual scheduler executions.
const receipt = (runId, terminalVerdict) => ({ runId, schedulerIdentity: 'proof', terminalVerdict,
  schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', status: 'SUCCEEDED',
  requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES],
  startedAt: runId === 'two' ? '2026-09-05T10:01:00Z' : '2026-09-05T10:00:00Z',
  finishedAt: runId === 'two' ? '2026-09-05T10:02:00Z' : '2026-09-05T10:01:00Z',
  phases: REQUIRED_REFRESH_PHASES.map((phase) => ({ phase, status: 'PASS', at: runId === 'two' ? '2026-09-05T10:01:30Z' : '2026-09-05T10:00:30Z',
    evidence: { execution: { kind: 'executed', runId } } })),
  detail: { storageDelta: { redundantCopyCount: 0, additionalFullCorpusCopyDelta: 0 } } });
const envelope = (value) => ({ ok: ['applied', 'noop'].includes(value.terminalVerdict), why: 'bad envelope' });

function nativeFixture(platform = 'linux') {
  const calls = [];
  let on = false;
  let time = 1_000_000;
  let reads = 0;
  const identity = 'com.ruvnet.brain-update.proof-fixture';
  const scheduler = {
    installScheduler(record, options) { calls.push(['install', record.identity, options]); on = true; return { ok: true }; },
    removeScheduler(options) { calls.push(['remove', options.identity]); on = false; return { ok: true }; },
    schedulerStatus() { return { state: on ? 'on' : 'off', evidence: 'fake unit adapter' }; },
  };
  return { calls, scheduler, options: { scheduler, registration: { identity }, platform,
    env: { PATH: '/fixture' }, brainHome: '/fixture/brain', kbDir: '/fixture/brain/kb', timeoutMs: 180_000,
    command: (...args) => calls.push(['command', ...args]), now: () => time, stopped: () => true,
    pause: async (ms) => { time += ms; },
    receipts: () => ++reads === 1 ? [] : [{ receipt: { runId: 'one', status: reads === 2 ? 'RUNNING' : 'SUCCEEDED' } }],
  } };
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function proofFixture() {
  const identity = 'com.ruvnet.brain-update.proof-fixture';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const coverage = { schemaVersion: 1, kind: 'ruvnet-brain-release-coverage',
    generatorSourceSha: '1'.repeat(64), snapshotRoot: '2'.repeat(64), sourceObservationSha256: '3'.repeat(64),
    releaseIdentity: { version: '9.9.9', tag: 'v9.9.9', sourceSnapshot: 'c'.repeat(40) },
    corpusSeed: { tag: 'corpus-seed-fixture', archiveSha256: '4'.repeat(64), archiveBytes: 100, receiptSha256: '5'.repeat(64) },
    corpusCoverage: { sha256: '6'.repeat(64), coverageGeneration: '7'.repeat(64) },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: '8'.repeat(64), bytes: 200, storeCount: 1 },
    publicInventoryPartitionSha256: '9'.repeat(64), installedProjectionSchema: 2, rows: [],
    totals: { repositories: 0, gists: 0, rows: 0, byStatus: {} },
    enumerationReceipt: { schemaVersion: 1, terminal: true, duplicateKeys: 0,
      repositories: { expected: 0, pages: [] }, gists: { expected: 0, pages: [] } },
    policy: { policyDispositionDigests: [], exemptionDigests: [] } };
  coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(coverage);
  const raw = JSON.stringify(coverage);
  const projection = { raw, sha256: crypto.createHash('sha256').update(raw).digest('hex'), observedAt: '2026-09-05T10:02:00Z' };
  const registration = { recordPath: '/fixture/registration.json', nodePath: '/fixture/node', runnerPath: '/fixture/runner.mjs', runnerSha256: 'd'.repeat(64) };
  const body = { schemaVersion: 1, kind: 'ruvnet-brain-native-two-run-nightly-proof', platform: 'linux',
    scope: 'installed-update', upstreamFreshness: 'UNKNOWN', registration,
    sourceSha: 'c'.repeat(40), workflowRunId: '12345',
    observedAt: '2026-09-05T10:02:00Z', identity,
    candidate: { version: '9.9.9', sha256: 'a'.repeat(64), bundle: { sha256: 'b'.repeat(64),
      signatureBase64: crypto.sign(null, Buffer.from('b'.repeat(64), 'hex'), privateKey).toString('base64') } },
    runs: [receipt('one', 'applied'), receipt('two', 'noop')].map((row) => {
      row.schedulerIdentity = identity;
      row.executableIdentity = { schedulerIdentity: identity, registrationPath: registration.recordPath,
        nodePath: registration.nodePath, runnerPath: registration.runnerPath, runnerSha256: registration.runnerSha256, argv: [] };
      for (const phase of row.phases) {
        if (['update', 'host-convergence', 'cleanup'].includes(phase.phase)) continue;
        phase.evidence.execution = phase.phase === 'local-overlay-restoration' ? { kind: 'not-executed' }
          : { kind: 'imported-release', sourceSnapshot: 'c'.repeat(40), upstreamFreshness: 'UNKNOWN' };
        if (phase.phase === 'local-overlay-restoration') phase.evidence.restoredStores = 0;
        if (phase.phase === 'source-enumeration') Object.assign(phase.evidence, {
          sourceObservationSha256: coverage.sourceObservationSha256, rows: 0, terminal: true });
        if (phase.phase === 'ingestion') Object.assign(phase.evidence, { eligibleCurrent: 0, storeCount: 1 });
        if (phase.phase === 'bundle-assembly') Object.assign(phase.evidence, { version: '9.9.9', sourceSnapshot: 'c'.repeat(40) });
        if (phase.phase === 'generation-ledger-reconciliation') phase.evidence.sha256 = coverage.generationLedger.sha256;
        if (phase.phase === 'coverage-generation') Object.assign(phase.evidence, {
          coverageSha256: projection.sha256, releaseCoverageGeneration: coverage.releaseCoverageGeneration });
      }
      return { runId: row.runId, terminalVerdict: row.terminalVerdict, receipt: row, receiptSha256: digest(row),
        installedCoverage: { ...projection, observedAt: row.finishedAt }, trigger: { kind: 'cron-tick', identity } };
    }), inventory: { before: inventory(), afterFirst: inventory(), afterSecond: inventory() },
    retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
    validation: { ok: true, failures: [] } };
  return { proof: { ...body, receiptSha256: digest(body) }, expected: { platform: 'linux', version: '9.9.9',
    packageSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64), sourceSha: 'c'.repeat(40), workflowRunId: '12345', publicKey } };
}

describe('native two-run nightly proof', () => {
  it.each(['darwin', 'linux', 'win32'])('uses the native %s trigger and verifies cleanup (fake adapters only)', async (platform) => {
    const f = nativeFixture(platform);
    // The Darwin adapter is fake: supply its UID even when this test runs on Windows.
    const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 });
    try {
      expect((await triggerNativeRun(f.options)).receipt.status).toBe('SUCCEEDED');
    } finally {
      if (uid) Object.defineProperty(process, 'getuid', uid);
      else delete process.getuid;
    }
    expect(f.calls.filter(([kind]) => kind === 'remove')).toHaveLength(1);
    const commands = f.calls.filter(([kind]) => kind === 'command');
    if (platform === 'linux') {
      expect(commands).toEqual([]);
      expect(f.calls[0][2]).toMatchObject({ proofTick: true, proofAt: 1_060_000 });
    } else {
      expect(commands[0][1]).toBe(platform === 'darwin' ? 'launchctl' : 'schtasks');
      if (platform === 'darwin') expect(commands[0][2]).toEqual([
        'kickstart', '-k', `gui/501/${f.options.registration.identity}`,
      ]);
    }
  });

  it('removes cron as soon as a RUNNING receipt appears, before waiting for completion', async () => {
    const f = nativeFixture();
    const pause = f.options.pause;
    f.options.pause = async (ms) => {
      expect(f.calls.some(([kind]) => kind === 'remove')).toBe(true);
      await pause(ms);
    };
    await triggerNativeRun(f.options);
  });

  it.each(['com.ruvnet.brain-update', 'foreign-job'])('rejects non-proof identity %s before scheduler access', async (identity) => {
    const f = nativeFixture();
    f.options.registration.identity = identity;
    await expect(triggerNativeRun(f.options)).rejects.toThrow(/unique proof/);
    expect(f.calls).toEqual([]);
  });

  it('fails and cleans up when native cron never produces a receipt within two minutes', async () => {
    const f = nativeFixture();
    f.options.receipts = () => [];
    await expect(triggerNativeRun(f.options)).rejects.toThrow(/within two minutes/);
    expect(f.calls.at(-1)).toEqual(['remove', f.options.registration.identity]);
  });

  it('cleans up partially registered jobs on installation error', async () => {
    const f = nativeFixture();
    f.scheduler.installScheduler = () => ({ ok: false, why: 'scheduler denied registration' });
    await expect(triggerNativeRun(f.options)).rejects.toThrow(/denied registration/);
    expect(f.calls).toEqual([['remove', f.options.registration.identity]]);
  });

  it('does not return success when native trigger or cleanup fails', async () => {
    const f = nativeFixture('win32');
    f.options.command = () => { throw new Error('native trigger failed'); };
    await expect(triggerNativeRun(f.options)).rejects.toThrow(/native trigger failed/);
    expect(f.calls.at(-1)[0]).toBe('remove');
    const g = nativeFixture();
    g.scheduler.removeScheduler = () => ({ ok: false, why: 'removal denied' });
    await expect(triggerNativeRun(g.options)).rejects.toThrow(/cleanup failed.*removal denied/);
  });

  it('rejects duplicate native runs and unverified removal', async () => {
    const f = nativeFixture();
    let reads = 0;
    f.options.receipts = () => reads++ === 0 ? [] : [{ receipt: { runId: 'one' } }, { receipt: { runId: 'two' } }];
    await expect(triggerNativeRun(f.options)).rejects.toThrow(/2 refresh runs/);
    const g = nativeFixture();
    let statuses = 0;
    g.scheduler.schedulerStatus = () => ({ state: statuses++ === 0 ? 'off' : 'on', evidence: 'still installed' });
    await expect(triggerNativeRun(g.options)).rejects.toThrow(/absence unverified/);
  });

  it('never overwrites or removes an existing scheduler identity', async () => {
    const f = nativeFixture();
    f.scheduler.schedulerStatus = () => ({ state: 'on', evidence: 'existing job' });
    await expect(triggerNativeRun(f.options)).rejects.toThrow(/identity is not absent/);
    expect(f.calls).toEqual([]);
  });

  it('rederives native receipt and embedded run evidence, not its claimed validation flag', () => {
    const { proof, expected } = proofFixture();
    expect(validateNightlyProofReceipt(proof, expected)).toEqual({ ok: true, failures: [] });
    proof.runs[1].receipt.detail.storageDelta.redundantCopyCount = 1;
    proof.runs[1].receiptSha256 = digest(proof.runs[1].receipt);
    const { receiptSha256, ...body } = proof;
    proof.receiptSha256 = digest(body);
    expect(validateNightlyProofReceipt(proof, expected).failures.join(' ')).toMatch(/zero-redundancy/);
  });

  it('validates native Windows paths on any verifier OS and rejects POSIX substitutions', () => {
    const { proof, expected } = proofFixture();
    proof.platform = expected.platform = 'win32';
    Object.assign(proof.registration, { recordPath: 'D:\\fixture\\registration.json', nodePath: 'C:\\node\\node.exe', runnerPath: 'D:\\fixture\\runner.mjs' });
    const reseal = () => {
      for (const run of proof.runs) {
        run.trigger.kind = 'schtasks-run';
        Object.assign(run.receipt.executableIdentity, { registrationPath: proof.registration.recordPath,
          nodePath: proof.registration.nodePath, runnerPath: proof.registration.runnerPath });
        run.receiptSha256 = digest(run.receipt);
      }
      const { receiptSha256, ...body } = proof;
      proof.receiptSha256 = digest(body);
    };
    reseal();
    expect(validateNightlyProofReceipt(proof, expected).ok).toBe(true);
    proof.registration.nodePath = '/fixture/node';
    reseal();
    expect(validateNightlyProofReceipt(proof, expected).failures.join(' ')).toMatch(/executable identity/);
  });

  it.each(['platform', 'version', 'packageSha256', 'bundleSha256', 'sourceSha', 'workflowRunId'])('rejects wrong expected %s', (field) => {
    const { proof, expected } = proofFixture();
    expect(validateNightlyProofReceipt(proof, { ...expected, [field]: 'wrong' }).ok).toBe(false);
  });

  it('rejects altered envelope and embedded run hashes', () => {
    const { proof, expected } = proofFixture();
    proof.runs[0].receiptSha256 = '0'.repeat(64);
    expect(validateNightlyProofReceipt(proof, expected).failures).toEqual(expect.arrayContaining([
      'native proof receipt digest differs', 'embedded run identity or digest differs',
    ]));
  });

  it.each(['scope', 'imported-relabeled', 'stale-source', 'legacy', 'missing-executable', 'missing-projection', 'signature', 'trigger'])(
    'rejects installed update proof mutation %s despite optimistic validation', (mutation) => {
      const { proof, expected } = proofFixture();
      if (mutation === 'scope') proof.scope = 'corpus-build';
      if (mutation === 'imported-relabeled') proof.runs[0].receipt.phases[0].evidence.execution = { kind: 'executed', runId: 'one' };
      if (mutation === 'stale-source') proof.runs[0].receipt.phases[0].evidence.execution.sourceSnapshot = '0'.repeat(40);
      if (mutation === 'legacy') proof.runs[0].receipt.phases[0].evidence.execution.kind = 'validated-legacy';
      if (mutation === 'missing-executable') delete proof.runs[0].receipt.executableIdentity;
      if (mutation === 'missing-projection') delete proof.runs[0].installedCoverage;
      if (mutation === 'signature') proof.candidate.bundle.signatureBase64 = Buffer.alloc(64).toString('base64');
      if (mutation === 'trigger') proof.runs[0].trigger.kind = 'direct-exec';
      for (const run of proof.runs) run.receiptSha256 = digest(run.receipt);
      const { receiptSha256, ...body } = proof;
      proof.receiptSha256 = digest(body);
      expect(validateNightlyProofReceipt(proof, expected).ok).toBe(false);
    });
  it.each(['kb.install-preserved-old', 'kb.install-prior-crash', '.kb.install-stage-partial'])(
    'rejects bounded retention with observed installer copy %s', (name) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-extra-copy-'));
      roots.push(root);
      const live = path.join(root, 'kb');
      fs.mkdirSync(live);
      fs.writeFileSync(path.join(live, 'public.txt'), 'public');
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'private.txt'), 'retained private bytes');
      const measured = managedStorageInventory(live);
      const result = validateTwoRunEvidence({ first: receipt('one', 'applied'), second: receipt('two', 'noop'),
        inventoryBefore: measured, inventoryAfterFirst: measured, inventoryAfterSecond: measured,
        retention: { withinBudget: true, unsafe: [], before: { bytes: 0 }, after: { bytes: 0 } },
        validateEnvelope: envelope, identity: 'proof' });
      expect(result.ok).toBe(false);
      expect(result.failures.join(' ')).toContain('redundant corpus copies');
      expect(fs.readFileSync(path.join(root, name, 'private.txt'), 'utf8')).toBe('retained private bytes');
    });

  it.each(['imported-release', 'validated-legacy'])('does not promote old %s evidence into current-run execution', (kind) => {
    const first = receipt('one', 'applied');
    const second = receipt('two', 'noop');
    for (const run of [first, second]) {
      run.phases[0].evidence = { sourceObservationAt: '2020-01-01T00:00:00Z',
        execution: { kind, upstreamFreshness: 'UNKNOWN' } };
      expect(validateRefreshReceiptEnvelope(run).ok).toBe(true);
    }
    const result = validateTwoRunEvidence({ first, second,
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: validateRefreshReceiptEnvelope, identity: 'proof' });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/source-enumeration.*current.run execution/i);
  });

  it.each(['wrong-run', 'old-time', 'missing-evidence'])('rejects %s execution provenance', (mutant) => {
    const first = receipt('one', 'applied');
    if (mutant === 'wrong-run') first.phases[0].evidence.execution.runId = 'another-run';
    if (mutant === 'old-time') first.phases[0].at = '2020-01-01T00:00:00Z';
    if (mutant === 'missing-evidence') delete first.phases[0].evidence;
    expect(validateTwoRunEvidence({ first, second: receipt('two', 'noop'),
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: envelope, identity: 'proof' }).ok).toBe(false);
  });

  it('stages and cryptographically binds the exact regular candidate bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-proof-bundle-'));
    roots.push(root);
    const packageRoot = path.join(root, 'package');
    const bundle = path.join(root, 'candidate.zip');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(bundle, 'exact candidate bytes');

    const staged = stageExactBundle({ bundlePath: bundle, packageRoot });

    expect(staged.sourcePath).toBe(bundle);
    expect(staged.stagedPath).toBe(path.join(packageRoot, 'dist', 'ruvnet-brain.zip'));
    expect(staged.bytes).toBe(21);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(staged.stagedPath, 'utf8')).toBe('exact candidate bytes');
  });

  it('rejects a symlink or non-zip input instead of staging ambiguous bundle bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-proof-bundle-'));
    roots.push(root);
    const packageRoot = path.join(root, 'package');
    const target = path.join(root, 'target.zip');
    const link = path.join(root, 'link.zip');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(target, 'bytes');
    fs.symlinkSync(target, link);

    expect(() => stageExactBundle({ bundlePath: link, packageRoot })).toThrow(/regular candidate bundle/);
    expect(() => stageExactBundle({ bundlePath: target.replace(/\.zip$/, '.tgz'), packageRoot }))
      .toThrow(/regular candidate bundle/);
  });

  it('requires two distinct converged runs, a second-run no-op, no redundant corpus, and bounded evidence', () => {
    expect(validateTwoRunEvidence({ first: receipt('one', 'applied'), second: receipt('two', 'noop'),
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: envelope, identity: 'proof' })).toEqual({ ok: true, failures: [] });
  });

  it.each([
    ['same run', { second: receipt('one', 'noop') }],
    ['second applied', { second: receipt('two', 'applied') }],
    ['redundant copy', { inventoryAfterSecond: inventory(1) }],
    ['over budget', { retention: { withinBudget: false, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } } }],
    ['unsafe evidence', { retention: { withinBudget: true, unsafe: [{}], before: { bytes: 5 }, after: { bytes: 5 } } }],
  ])('rejects %s', (_label, override) => {
    const input = { first: receipt('one', 'applied'), second: receipt('two', 'noop'),
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: envelope, identity: 'proof', ...override };
    expect(validateTwoRunEvidence(input).ok).toBe(false);
  });
});


describe('native proof npm configuration across fresh processes', () => {
  it('suppresses initial reader shims while retaining npx execution and symlink rejection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-npm-config-')); roots.push(root);
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'proof-bin', version: '1.0.0', bin: { 'proof-bin': 'cli.js' } }));
    fs.writeFileSync(path.join(fixture, 'cli.js'), '#!/usr/bin/env node\nconsole.log("EXECUTED");\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
    for (const name of ['first', 'second']) {
      const prefix = path.join(root, name);
      const command = npmInvocation(['install', '--prefix', prefix, '--install-links', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', fixture]);
      const result = spawnSync(command.executable, command.args, { env: { ...env, npm_config_bin_links: 'false' }, encoding: 'utf8', timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(prefix, 'node_modules', 'proof-bin', 'cli.js'))).toBe(true);
      expect(fs.existsSync(path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'proof-bin.cmd' : 'proof-bin'))).toBe(false);
      expect(() => managedStorageInventory(prefix)).not.toThrow();
    }
    const pack = npmInvocation(['pack', '--ignore-scripts', '--pack-destination', root]);
    const packed = spawnSync(pack.executable, pack.args, { env, cwd: fixture, encoding: 'utf8', timeout: 30_000 });
    expect(packed.status, packed.stderr).toBe(0);
    const archive = path.join(root, 'proof-bin-1.0.0.tgz');
    const execute = npmInvocation(['exec', '--offline', '--yes', `--package=${archive}`, '--', 'proof-bin']);
    for (let i = 0; i < 2; i++) {
      const executed = spawnSync(execute.executable, execute.args, {
        env: { ...env, npm_config_cache: path.join(root, 'cache') }, cwd: home, encoding: 'utf8', timeout: 30_000 });
      expect(executed.status, executed.stderr).toBe(0);
      expect(executed.stdout).toContain('EXECUTED');
    }
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'second', 'unsafe'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => managedStorageInventory(path.join(root, 'second'))).toThrow(/symbolic link/);
  }, 65_000);
});


describe('production npm target identity', () => {
  it('rejects absent, duplicated, or changed cached package bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-identity-')); roots.push(root);
    const expectedRoot = path.join(root, 'expected'); fs.mkdirSync(expectedRoot);
    fs.writeFileSync(path.join(expectedRoot, 'package.json'), JSON.stringify({ name: 'ruvnet-brain', version: '9.9.9' }));
    fs.writeFileSync(path.join(expectedRoot, 'code.mjs'), 'public bytes');
    const expected = packageTreeObservation(expectedRoot);
    const cache = path.join(root, 'cache');
    expect(() => observeNpxPackage(cache, expected)).toThrow(/exactly one/);
    const target = path.join(cache, '_npx', 'one', 'node_modules', 'ruvnet-brain');
    fs.cpSync(expectedRoot, target, { recursive: true });
    expect(observeNpxPackage(cache, expected).treeSha256).toBe(expected.treeSha256);
    fs.writeFileSync(path.join(target, 'code.mjs'), 'changed');
    expect(() => observeNpxPackage(cache, expected)).toThrow(/differ/);
    fs.cpSync(expectedRoot, path.join(cache, '_npx', 'two', 'node_modules', 'ruvnet-brain'), { recursive: true });
    expect(() => observeNpxPackage(cache, expected)).toThrow(/exactly one/);
  });
  it('requires exact bytes and version observations bracketing both production runs', () => {
    const expected = { name: 'ruvnet-brain', version: '9.9.9', packageSha256: 'a'.repeat(64), treeSha256: 'b'.repeat(64), fileCount: 2 };
    const at = (second) => `2026-09-07T10:00:0${second}.000Z`;
    const proof = { candidate: { sha256: expected.packageSha256, version: expected.version },
      registration: { packageTarget: { spec: 'ruvnet-brain@latest', sha256: null } },
      observedAt: at(7),
      packageExecution: { policy: 'production-latest-exact-cache-v1', expected,
        observations: [0, 3, 6].map((second) => ({ ...expected, path: '/isolated/cache/package', observedAt: at(second) })) },
      runs: [1, 4].map((second) => ({ receipt: { desiredVersion: expected.version, startedAt: at(second), finishedAt: at(second + 1) } })) };
    expect(validateNpxObservations(proof)).toEqual([]);
    for (const mutate of [
      p => { p.packageExecution.observations[1].treeSha256 = 'c'.repeat(64); },
      p => { p.packageExecution.observations[1].observedAt = at(1); },
      p => { p.runs[1].receipt.desiredVersion = '9.9.10'; },
      p => { delete p.packageExecution; },
    ]) { const bad = structuredClone(proof); mutate(bad); expect(validateNpxObservations(bad).length).toBeGreaterThan(0); }
  });
});


describe('native installed storage accounting', () => {
  it('removes only empty owned installer scaffolds and preserves populated or linked directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-empty-scaffold-')); roots.push(root);
    const kb = path.join(root, 'kb'); fs.mkdirSync(kb);
    const empty = `${kb}.install-preserved-empty`; fs.mkdirSync(empty);
    const populated = `${kb}.install-preserved-data`; fs.mkdirSync(populated);
    fs.writeFileSync(path.join(populated, 'private.txt'), 'keep');
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    const linked = `${kb}.install-preserved-link`;
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(removeEmptyInstallerScaffolds(kb)).toEqual([empty]);
    expect(fs.readFileSync(path.join(populated, 'private.txt'), 'utf8')).toBe('keep');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  });
  it('allows only measured bounded receipt and log growth on the second no-op', () => {
    const input = { first: receipt('one', 'applied'), second: receipt('two', 'noop'),
      inventoryBefore: inventory(0, 100), inventoryAfterFirst: inventory(0, 100), inventoryAfterSecond: inventory(0, 160),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 20 }, after: { bytes: 40 },
        policy: { maxEvidenceBytes: 1000 },
        updateLog: { before: { bytes: 10, sha256: 'a'.repeat(64) }, after: { bytes: 50, sha256: 'b'.repeat(64) } } },
      validateEnvelope: envelope, identity: 'proof' };
    expect(validateTwoRunEvidence(input)).toEqual({ ok: true, failures: [] });
    input.inventoryAfterSecond.totalManagedBytes++;
    expect(validateTwoRunEvidence(input).ok).toBe(false);
    input.inventoryAfterSecond.totalManagedBytes--;
    input.retention.updateLog.after.bytes = 1001;
    expect(validateTwoRunEvidence(input).ok).toBe(false);
  });
});


it('does not treat a terminal receipt as process completion', async () => {
  const f = nativeFixture('darwin'); let polls = 0;
  f.options.stopped = () => ++polls > 1;
  const result = await triggerNativeRun(f.options);
  expect(result.receipt.status).toBe('SUCCEEDED');
  expect(polls).toBe(2);
});
