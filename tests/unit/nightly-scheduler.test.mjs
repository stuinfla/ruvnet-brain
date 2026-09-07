import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  NIGHTLY_LABEL,
  NIGHTLY_ENV_ALLOWLIST,
  cronLine,
  installNightlyRunner,
  installScheduler,
  launchdPlist,
  nightlyCommand,
  removeScheduler,
  refreshRunHealth,
  resolveNightlyProofBundle,
  schedulerStatus,
  validateRefreshReceiptEnvelope,
  verifyNightlyExecutionIdentity,
} from '../../plugin/scripts/nightly-scheduler.mjs';
import { REQUIRED_REFRESH_PHASES } from '../../kb/refresh-run.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('nightly execution receipt projection', () => {
  it('validates the producer-declared phase envelope without owning its vocabulary', () => {
    const receipt = { schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', status: 'SUCCEEDED',
      terminalVerdict: 'applied', requiredPhaseOrder: ['producer-phase'],
      phases: [{ phase: 'producer-phase', required: true, status: 'PASS' }] };
    expect(validateRefreshReceiptEnvelope(receipt)).toEqual({ ok: true });
    for (const mutant of [
      { ...receipt, schemaVersion: 2 },
      { ...receipt, requiredPhaseOrder: [] },
      { ...receipt, requiredPhaseOrder: ['producer-phase', 'producer-phase'] },
      { ...receipt, requiredPhaseOrder: ['../unsafe'] },
      { ...receipt, phases: [{ phase: 'different', required: true, status: 'PASS' }] },
      { ...receipt, phases: [{ phase: 'producer-phase', required: true, status: 'SKIP' }] },
      { ...receipt, status: 'FAILED' },
      { ...receipt, terminalVerdict: 'failed' },
    ]) expect(validateRefreshReceiptEnvelope(mutant).ok).toBe(false);
  });

  it('distinguishes never-ran, required-phase failure, stale success, and fresh verified success', () => {
    const f = fixture();
    const now = Date.parse('2026-08-21T12:00:00Z');
    expect(refreshRunHealth({ brainHome: f.brainHome, now }).state).toBe('never-ran');
    const dir = path.join(f.brainHome, 'refresh-runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'run.json');
    const identity = { schedulerIdentity: NIGHTLY_LABEL, registrationPath: f.record.recordPath,
      nodePath: f.record.nodePath, runnerPath: f.record.runnerPath, runnerSha256: f.record.runnerSha256, argv: [] };
    const base = { schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', runId: 'run', action: 'nightly',
      schedulerIdentity: NIGHTLY_LABEL, executableIdentity: identity,
      status: 'SUCCEEDED', terminalVerdict: 'applied', startedAt: '2026-08-21T10:00:00Z',
      finishedAt: '2026-08-21T11:00:00Z', requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES],
      phases: REQUIRED_REFRESH_PHASES.map((phase) => ({ phase, required: true, status: 'PASS' })) };
    base.phases[0].status = 'FAIL';
    fs.writeFileSync(file, JSON.stringify(base));
    expect(refreshRunHealth({ brainHome: f.brainHome, now }).state).toBe('failed');
    base.phases[0].status = 'PASS';
    base.finishedAt = '2026-08-19T00:00:00Z';
    fs.writeFileSync(file, JSON.stringify(base));
    expect(refreshRunHealth({ brainHome: f.brainHome, now }).state).toBe('stale');
    base.finishedAt = '2026-08-21T11:00:00Z';
    fs.writeFileSync(file, JSON.stringify(base));
    expect(refreshRunHealth({ brainHome: f.brainHome, now })).toMatchObject({ state: 'ok', receipt: { runId: 'run' } });
  });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-scheduler-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = path.join(root, 'custom-kb');
  const source = path.join(root, 'nightly-refresh.mjs');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(source, '#!/usr/bin/env node\nprocess.exitCode = 0;\n');
  const record = installNightlyRunner({ brainHome, source, nodePath: '/absolute/node' });
  return { root, home, brainHome, kbDir, source, record, env: { HOME: home } };
}

describe('one immutable nightly executable across every scheduler', () => {
  it('separates proof jobs from production and rehashes their exact tarball on every read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-proof-'));
    roots.push(root);
    const brainHome = path.join(root, 'brain');
    const source = path.join(root, 'nightly-refresh.mjs');
    const tarball = path.join(root, 'candidate.tgz');
    const bundle = path.join(root, 'candidate.zip');
    fs.writeFileSync(source, '#!/usr/bin/env node\nprocess.exitCode = 0;\n');
    fs.writeFileSync(tarball, 'exact candidate');
    fs.writeFileSync(bundle, 'exact bundle');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const bundleDigest = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
    const identity = 'com.ruvnet.brain-update.proof-adr072';
    const record = installNightlyRunner({ brainHome, source, nodePath: '/absolute/node', identity,
      packageTarget: { spec: tarball, sha256: digest }, bundleTarget: { spec: bundle, sha256: bundleDigest } });
    expect(record).toMatchObject({ schemaVersion: 2, identity,
      packageTarget: { spec: tarball, sha256: digest }, bundleTarget: { spec: bundle, sha256: bundleDigest } });
    const proofEnv = {
      RUVNET_NIGHTLY_REGISTRATION: record.recordPath,
      RUVNET_NIGHTLY_IDENTITY: identity,
      RUVNET_NIGHTLY_NODE_PATH: record.nodePath,
      RUVNET_NIGHTLY_RUNNER_PATH: record.runnerPath,
      RUVNET_NIGHTLY_RUNNER_SHA256: record.runnerSha256,
    };
    expect(resolveNightlyProofBundle({ brainHome, env: { ...proofEnv, RUVNET_NIGHTLY: '1' } }))
      .toEqual({ spec: bundle, sha256: bundleDigest });
    expect(record.recordPath).not.toBe(path.join(brainHome, 'scheduler', 'registration.json'));
    expect(() => installNightlyRunner({ brainHome, source, identity: '../unsafe' })).toThrow(/unsafe/);
    const bundleLink = path.join(root, 'bundle-link.zip');
    fs.symlinkSync(bundle, bundleLink);
    expect(() => installNightlyRunner({ brainHome, source, identity,
      packageTarget: { spec: tarball, sha256: digest },
      bundleTarget: { spec: bundleLink, sha256: bundleDigest } })).toThrow(/regular .*ZIP/);
    fs.appendFileSync(tarball, 'tampered');
    expect(verifyNightlyExecutionIdentity({ brainHome, env: proofEnv }))
      .toMatchObject({ ok: false, why: expect.stringMatching(/package target digest mismatch/) });
    fs.writeFileSync(tarball, 'exact candidate');
    fs.appendFileSync(bundle, 'tampered');
    expect(verifyNightlyExecutionIdentity({ brainHome, env: proofEnv }))
      .toMatchObject({ ok: false, why: expect.stringMatching(/bundle target digest mismatch/) });
  });

  it('does not let production or an unregistered process select a local proof bundle', () => {
    const f = fixture();
    expect(resolveNightlyProofBundle({ brainHome: f.brainHome, env: process.env })).toBe(null);
    expect(() => resolveNightlyProofBundle({ brainHome: f.brainHome,
      env: { RUVNET_NIGHTLY: '1' } })).toThrow(/registration path/);
  });

  it('content-addresses the runner and rejects changed bytes at the registered path', () => {
    const f = fixture();
    expect(path.basename(f.record.runnerPath)).toMatch(/^nightly-refresh-[a-f0-9]{64}\.mjs$/);
    expect(nightlyCommand(f.record)).toBe(`'${f.record.nodePath}' '${f.record.runnerPath}' --registration '${f.record.recordPath}'`);
    fs.appendFileSync(f.record.runnerPath, '// tampered\n');
    expect(schedulerStatus({ platform: 'darwin', env: f.env, brainHome: f.brainHome,
      kbDir: f.kbDir, testMode: true }).evidence).toMatch(/runner digest mismatch/);
  });

  it('accepts only the exact registration, runner, digest, and node identity passed by the immutable runner', () => {
    const f = fixture();
    const env = { RUVNET_NIGHTLY_REGISTRATION: f.record.recordPath, RUVNET_NIGHTLY_IDENTITY: NIGHTLY_LABEL,
      RUVNET_NIGHTLY_NODE_PATH: f.record.nodePath, RUVNET_NIGHTLY_RUNNER_PATH: f.record.runnerPath,
      RUVNET_NIGHTLY_RUNNER_SHA256: f.record.runnerSha256 };
    expect(verifyNightlyExecutionIdentity({ brainHome: f.brainHome, env })).toMatchObject({ ok: true,
      identity: { runnerSha256: f.record.runnerSha256 } });
    expect(verifyNightlyExecutionIdentity({ brainHome: f.brainHome,
      env: { ...env, RUVNET_NIGHTLY_RUNNER_SHA256: '0'.repeat(64) } })).toMatchObject({ ok: false });
  });

  it('never reports a RUNNING receipt green unless its exact process incarnation is live', () => {
    const f = fixture();
    const dir = path.join(f.brainHome, 'refresh-runs');
    fs.mkdirSync(dir, { recursive: true });
    const identity = { schedulerIdentity: NIGHTLY_LABEL, registrationPath: f.record.recordPath,
      nodePath: f.record.nodePath, runnerPath: f.record.runnerPath, runnerSha256: f.record.runnerSha256, argv: [] };
    fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ schemaVersion: 3,
      kind: 'ruvnet-brain-refresh-run', runId: 'running', action: 'nightly', schedulerIdentity: NIGHTLY_LABEL,
      executableIdentity: identity, status: 'RUNNING', startedAt: '2026-08-21T11:00:00Z', ownerToken: { pid: 123 } }));
    expect(refreshRunHealth({ brainHome: f.brainHome, now: Date.parse('2026-08-21T12:00:00Z'),
      inspectOwner: () => 'live' }).state).toBe('running');
    expect(refreshRunHealth({ brainHome: f.brainHome, now: Date.parse('2026-08-21T12:00:00Z'),
      inspectOwner: () => 'dead' }).state).toBe('failed');
    expect(refreshRunHealth({ brainHome: f.brainHome, now: Date.parse('2026-08-21T12:00:00Z'),
      inspectOwner: () => 'unknown' }).state).toBe('unknown');
  });

  it('derives launchd and cron from the exact same node path and runner path', () => {
    const f = fixture();
    const plist = launchdPlist(f.record, { kbDir: f.kbDir, logPath: path.join(f.kbDir, 'update.log'), pathValue: '/bin' });
    const cron = cronLine(f.record, path.join(f.kbDir, 'update.log'));
    for (const value of [f.record.nodePath, f.record.runnerPath]) {
      expect(plist).toContain(value);
      expect(cron).toContain(value);
    }
    expect(plist).not.toContain('/bin/sh');
    expect(cron).toContain(`# ${NIGHTLY_LABEL}`);
    expect(plist).toContain('RUVNET_NIGHTLY_REGISTRATION');
    expect(plist).toContain('RUVNET_NIGHTLY_IDENTITY');
    expect(NIGHTLY_ENV_ALLOWLIST).not.toContain('NODE_OPTIONS');
  });
});

describe('scheduler adapters are symmetric and verify exact state', () => {
  it('macOS writes, validates, detects command drift, and removes its LaunchAgent', () => {
    const f = fixture();
    expect(installScheduler(f.record, { platform: 'darwin', env: f.env, kbDir: f.kbDir,
      testMode: true, pathValue: '/bin' }).ok).toBe(true);
    expect(schedulerStatus({ platform: 'darwin', env: f.env, brainHome: f.brainHome,
      kbDir: f.kbDir, testMode: true }).state).toBe('on');
    const plist = path.join(f.home, 'Library', 'LaunchAgents', `${NIGHTLY_LABEL}.plist`);
    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace(f.record.runnerPath, '/wrong/runner'));
    expect(schedulerStatus({ platform: 'darwin', env: f.env, brainHome: f.brainHome,
      kbDir: f.kbDir, testMode: true }).state).toBe('degraded');
    expect(removeScheduler({ platform: 'darwin', env: f.env, testMode: true }).ok).toBe(true);
    expect(fs.existsSync(plist)).toBe(false);
  });

  it('Linux preserves unrelated rows, replaces its managed row, verifies exact command, and removes only its row', () => {
    const f = fixture();
    let table = '0 5 * * * /someone/else\n47 3 * * * /stale # com.ruvnet.brain-update\n';
    const run = (cmd, args, opts = {}) => {
      expect(cmd).toBe('crontab');
      if (args[0] === '-l') return { status: 0, stdout: table };
      table = opts.input;
      return { status: 0, stdout: '' };
    };
    expect(installScheduler(f.record, { platform: 'linux', env: f.env, kbDir: f.kbDir, run }).ok).toBe(true);
    expect(table).toContain('/someone/else');
    expect(table).not.toContain('/stale');
    expect(schedulerStatus({ platform: 'linux', env: f.env, brainHome: f.brainHome,
      kbDir: f.kbDir, run }).state).toBe('on');
    expect(removeScheduler({ platform: 'linux', env: f.env, run }).ok).toBe(true);
    expect(table).toBe('0 5 * * * /someone/else\n');
  });

  it('Windows creates, queries, and deletes the canonical Task Scheduler identity', () => {
    const f = fixture();
    const calls = [];
    const run = (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '/Query') return { status: 0, stdout: `<Task><Actions><Exec><Command>${f.record.nodePath}</Command><Arguments>"${f.record.runnerPath}" --registration "${f.record.recordPath}"</Arguments></Exec></Actions></Task>` };
      return { status: 0, stdout: '' };
    };
    expect(installScheduler(f.record, { platform: 'win32', env: f.env, kbDir: f.kbDir, run }).ok).toBe(true);
    expect(calls[0]).toMatchObject({ cmd: 'schtasks', args: expect.arrayContaining(['/Create', '/TN', NIGHTLY_LABEL, '/F']) });
    expect(schedulerStatus({ platform: 'win32', env: f.env, brainHome: f.brainHome,
      kbDir: f.kbDir, run }).state).toBe('on');
    expect(removeScheduler({ platform: 'win32', env: f.env, run }).ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ cmd: 'schtasks', args: ['/Delete', '/TN', NIGHTLY_LABEL, '/F'] });
  });

  it('fails closed on unsupported platforms', () => {
    const f = fixture();
    expect(installScheduler(f.record, { platform: 'aix', env: f.env, kbDir: f.kbDir }).ok).toBe(false);
    expect(schedulerStatus({ platform: 'aix', env: f.env, brainHome: f.brainHome,
      kbDir: f.kbDir }).state).toBe('unsupported');
  });
});


describe('scheduler fixture isolation and failure honesty', () => {
  it.each(['darwin', 'linux', 'win32'])('never invokes machine scheduler in %s test mode', platform => {
    const f = fixture();
    const run = () => { throw new Error('real scheduler must not be invoked'); };
    const options = { platform, env: f.env, brainHome: f.brainHome, kbDir: f.kbDir, run, testMode: true };
    expect(installScheduler(f.record, options).ok).toBe(true);
    expect(schedulerStatus(options).state).toBe('on');
    expect(removeScheduler(options).ok).toBe(true);
    expect(schedulerStatus(options).state).toBe('off');
  });
  it('does not treat cron permission errors as an empty table or overwrite it', () => {
    const f = fixture(); const calls = [];
    const run = (...args) => { calls.push(args); return { status: 1, stdout: '', stderr: 'permission denied' }; };
    const options = { platform: 'linux', env: f.env, brainHome: f.brainHome, kbDir: f.kbDir, run };
    expect(installScheduler(f.record, options).ok).toBe(false);
    expect(removeScheduler(options).ok).toBe(false);
    expect(schedulerStatus(options).state).toBe('degraded');
    expect(calls.every(([, args]) => args[0] === '-l')).toBe(true);
  });
  it('preserves proof and similarly prefixed cron rows during production removal', () => {
    const f = fixture();
    const foreign = '0 1 * * * foreign # com.ruvnet.brain-update.proof-fixture';
    let table = foreign + '\n' + cronLine(f.record, '/log') + '\n';
    const run = (_cmd, args, opts) => args[0] === '-l' ? { status: 0, stdout: table }
      : (table = opts.input, { status: 0 });
    expect(removeScheduler({ platform: 'linux', env: f.env, run }).ok).toBe(true);
    expect(table).toBe(foreign + '\n');
  });
  it('persists only allowlisted environment and prevents production proof cadence', () => {
    const f = fixture();
    const record = installNightlyRunner({ brainHome: f.brainHome, source: f.source,
      env: { RUVNET_BRAIN_HOME: f.brainHome, RUVNET_BRAIN_KB: f.kbDir, SystemRoot: 'C:\\Windows', TEMP: f.root, SECRET_TOKEN: 'excluded' } });
    expect(record.environment).toEqual({ RUVNET_BRAIN_HOME: f.brainHome, RUVNET_BRAIN_KB: f.kbDir, SystemRoot: 'C:\\Windows', TEMP: f.root });
    expect(() => cronLine(record, '/log', { proofTick: true })).toThrow(/proof identity/);
  });
});

it('retains launchd file if bootout did not establish absence', () => {
  const f = fixture();
  const options = { platform: 'darwin', env: f.env, kbDir: f.kbDir };
  const installed = installScheduler(f.record, { ...options, testMode: true });
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 });
  const calls = [];
  const run = (command, args) => { calls.push([command, args]); return { status: 0, stdout: 'still loaded' }; };
  try {
    expect(removeScheduler({ ...options, run }).ok).toBe(false);
    expect(fs.existsSync(installed.artifact.path)).toBe(true);
    expect(calls).toEqual([
      ['launchctl', ['bootout', `gui/501/${NIGHTLY_LABEL}`]],
      ['launchctl', ['print', `gui/501/${NIGHTLY_LABEL}`]],
    ]);
  } finally {
    if (uid) Object.defineProperty(process, 'getuid', uid);
    else delete process.getuid;
  }
});
it('uses explicit dated cron cadence only for isolated proof identities', () => {
  const f = fixture(); const at = new Date(2030, 1, 3, 4, 5);
  const record = { ...f.record, identity: NIGHTLY_LABEL + '.proof-fixture' };
  expect(cronLine(record, '/log', { proofTick: true, proofAt: at.getTime() })).toMatch(/^5 4 3 2 \* /);
  expect(() => cronLine(record, '/log', { proofTick: true })).toThrow(/proofAt/);
});

it.each(['darwin', 'win32'])('rejects wrong registration and extra arguments on %s', platform => {
  const f = fixture();
  const options = { platform, env: f.env, brainHome: f.brainHome, kbDir: f.kbDir, testMode: true };
  const installed = installScheduler(f.record, options);
  const file = platform === 'darwin' ? installed.artifact.path
    : path.join(f.home, '.ruvnet-scheduler-test', `${platform}-${NIGHTLY_LABEL}.json`);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace(f.record.recordPath, '/wrong/registration.json'));
  expect(schedulerStatus(options).state).toBe('degraded');
  const extra = platform === 'darwin' ? original.replace('</array>', '<string>--unexpected</string></array>')
    : original.replace('</Arguments>', ' --unexpected</Arguments>');
  fs.writeFileSync(file, extra);
  expect(schedulerStatus(options).state).toBe('degraded');
});
