import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSuiteUpdater, validUpdateChannel } from '../../scripts/console-suite-update.mjs';
let home, brainHome, runner, configFile, receiptFile, child, invocation, count, lockState, adapter;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-coordinator-')); brainHome = path.join(home, '.cache/ruvnet-brain');
  runner = path.join(home, 'shipped-developer-update.mjs'); fs.writeFileSync(runner, '// fake runner never executed');
  configFile = path.join(brainHome, 'developer-update-config.json'); receiptFile = path.join(brainHome, 'nightly-suite-update.json');
  write(configFile, { channel: 'latest', scope: 'ruvnet', cleanup: false, homebrew: false, managedCallback: 'preserved' });
  count = 0; lockState = 'idle'; child = new EventEmitter(); child.pid = 999999; child.unref = () => {};
  adapter = createSuiteUpdater({ home, brainHome, runner, processAlive: () => false,
    spawnChild: (...args) => { count++; invocation = args; return child; },
    policy: { atomic: write, readDeveloperUpdateConfig: () => read(configFile), writeDeveloperUpdateConfig: value => write(configFile, value),
      readDeveloperUpdateReceipt: () => read(receiptFile), sharedLockStatus: () => ({ state: lockState }) } });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
function receipt(extra = {}) {
  return { kind: 'nightly-suite-update', pid: child.pid, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    mode: 'apply', state: 'succeeded', ok: true, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(runner)).digest('hex'), ...extra };
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
  it('records failed spawn without claiming the scheduled policy completed', () => {
    adapter.start('latest'); child.emit('error', Error('launch refused'));
    expect(adapter.state()).toMatchObject({ status: 'failed', error: 'launch refused', active: false });
  });
});
