import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSuiteUpdater, validUpdateChannel, coordinatorSourceIdentity } from '../../scripts/console-suite-update.mjs';
let home, brainHome, runner, configFile, receiptFile, child, invocation, count, lockState, adapter, enrolled, mirrored, events, enrollmentOk;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-coordinator-')); brainHome = path.join(home, '.cache/ruvnet-brain');
  runner = path.join(home, 'developer-update.mjs'); fs.writeFileSync(runner, '// fake runner never executed');
  for (const name of ['policy', 'lock', 'maintenance', 'cleanup']) fs.writeFileSync(path.join(home, `developer-update-${name}.mjs`), `// fake ${name}`);
  configFile = path.join(brainHome, 'developer-update-config.json'); receiptFile = path.join(brainHome, 'nightly-suite-update.json');
  write(configFile, { channel: 'latest', scope: 'ruvnet', cleanup: false, homebrew: false, managedCallback: 'preserved' });
  count = 0; enrolled = 0; mirrored = 0; events = []; enrollmentOk = true; lockState = 'idle'; child = new EventEmitter(); child.pid = 999999; child.unref = () => {};
  adapter = createSuiteUpdater({ home, brainHome, runner, processAlive: () => false,
    spawnChild: (...args) => { count++; events.push('spawn'); invocation = args; return child; },
    nightly: { status: () => ({ state: enrolled ? 'on' : 'off' }), enable: (enabled, options) => {
      expect(enabled).toBe(true); expect(options).toMatchObject({ identity: 'com.ruvnet.brain-update', brainHome, cwd: home });
      enrolled++; events.push('enroll'); return { ok: enrollmentOk, after: { state: enrollmentOk ? 'on' : 'off' } }; } },
    markNightly: () => { mirrored++; events.push('mirror'); return { ok: true }; },
    policy: { atomic: write, readDeveloperUpdateConfig: () => read(configFile), writeDeveloperUpdateConfig: value => write(configFile, value),
      readDeveloperUpdateReceipt: () => read(receiptFile), sharedLockStatus: () => ({ state: lockState }) } });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
function receipt(extra = {}) {
  return { kind: 'nightly-suite-update', pid: child.pid, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    mode: 'apply', state: 'succeeded', ok: true, ...coordinatorSourceIdentity(runner), ...extra };
}
describe('RNBC coordinated update adapter', () => {
  it('accepts only the two supported release policies before any mutation', () => {
    expect(validUpdateChannel('latest')).toBe(true); expect(validUpdateChannel('alpha')).toBe(true);
    for (const channel of ['', null, 'beta', 'latest;touch bad', {}]) {
      expect(adapter.start(channel).status).toBe(400); expect(count).toBe(0);
    }
    expect(read(configFile).channel).toBe('latest');
  });
  it('launches the shipped runner with the current Node and fixed user scope; preserves exclusions', () => {
    expect(adapter.start('alpha')).toMatchObject({ ok: true, started: true });
    expect(events).toEqual(['enroll', 'mirror', 'spawn']); expect(enrolled).toBe(1); expect(mirrored).toBe(1);
    expect(adapter.state().nightly).toBe(true);
    expect(invocation[0]).toBe(process.execPath); expect(invocation[1]).toEqual([runner, '--apply']);
    expect(invocation[2]).toMatchObject({ cwd: home, shell: false, detached: true, stdio: 'ignore' });
    expect(invocation[2].env).toMatchObject({ HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome });
    expect(invocation[2].env.RUVNET_DEVELOPER_UPDATE_TOKEN).toBeUndefined();
    expect(read(configFile)).toMatchObject({ channel: 'alpha', scope: 'all', homebrew: true, uv: true, cargo: true, native: true, cleanup: false, managedCallback: 'preserved' });
    expect(adapter.start('latest').status).toBe(409); expect(count).toBe(1);
  });
  it('refuses every non-idle shared owner before changing the policy', () => {
    for (const state of ['running', 'stale', 'unknown']) { lockState = state; expect(adapter.start('alpha').status).toBe(409); }
    expect(count).toBe(0); expect(read(configFile).channel).toBe('latest');
  });
  it('requires the launched PID and source hash to call a manual run successful', () => {
    adapter.start('latest'); write(receiptFile, receipt()); child.emit('exit', 0);
    expect(adapter.state()).toMatchObject({ status: 'succeeded', active: false, mode: 'apply' });
  });
  it('shows a source mismatch as failed even if the child claims success', () => {
    adapter.start('latest'); write(receiptFile, receipt({ sourceSha256: 'wrong-source' })); child.emit('exit', 0);
    expect(adapter.state()).toMatchObject({ status: 'failed', active: false });
    expect(adapter.state().error).toContain('source-bound');
  });
  it('keeps check-only, failed, interrupted and never-run outcomes distinct', () => {
    expect(adapter.state().status).toBe('never-run');
    write(receiptFile, receipt({ mode: 'check', state: 'checked' })); expect(adapter.state().status).toBe('checked');
    write(receiptFile, receipt({ state: 'failed', ok: false, error: 'Tool verification failed' })); expect(adapter.state().status).toBe('failed');
    write(receiptFile, receipt({ state: 'running', ok: false, finishedAt: null })); expect(adapter.state().status).toBe('interrupted');
  });
  it('does not attach an old failed receipt to a different active shared updater', () => {
    write(receiptFile, receipt({ pid: 888888, state: 'failed', ok: false, error: 'Previous run failed', steps: [{ name: 'Old tool', state: 'failed' }] }));
    lockState = 'running';
    expect(adapter.state()).toMatchObject({ status: 'running', active: true, error: null, finishedAt: null, steps: [] });
  });
  it('never enrolls on a read or an invalid policy, and refuses a failed nightly enrollment', () => {
    adapter.state(); adapter.start('beta'); expect(enrolled).toBe(0); expect(mirrored).toBe(0);
    enrollmentOk = false; expect(adapter.start('latest').status).toBe(503); expect(count).toBe(0); expect(mirrored).toBe(0);
  });
  it('refuses a helper-module mismatch even when the top-level source and PID match', () => {
    adapter.start('latest'); const result = receipt(); result.sourceSnapshot['developer-update-policy.mjs'] = 'changed-helper';
    write(receiptFile, result); child.emit('exit', 0); expect(adapter.state().status).toBe('failed');
  });
  it('records failed spawn without claiming the scheduled policy completed', () => {
    adapter.start('latest'); child.emit('error', Error('launch refused'));
    expect(adapter.state()).toMatchObject({ status: 'failed', error: 'launch refused', active: false });
  });
});
