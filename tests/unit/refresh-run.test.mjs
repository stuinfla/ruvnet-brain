import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRefreshLock, beginRefreshSettlement, openRefreshReceipt, recordRefreshPhase,
  recordRefreshAdvisory, releaseRefreshLock, REFRESH_PHASE_CONTRACT, REQUIRED_REFRESH_PHASES,
  settleRefreshRun, UPDATE_REFRESH_PHASES } from '../../kb/refresh-run.mjs';

const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-run-'));
  roots.push(root);
  const kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir);
  return { root, kbDir };
};
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('whole refresh transaction', () => {
  it('owns one frozen grouped phase contract and derives the compatibility order exactly once', () => {
    expect(Object.isFrozen(REFRESH_PHASE_CONTRACT)).toBe(true);
    expect(Object.isFrozen(UPDATE_REFRESH_PHASES)).toBe(true);
    expect(Object.isFrozen(REQUIRED_REFRESH_PHASES)).toBe(true);
    expect(new Set(REQUIRED_REFRESH_PHASES).size).toBe(REQUIRED_REFRESH_PHASES.length);
    expect(REQUIRED_REFRESH_PHASES.every((phase) => /^[A-Za-z0-9._-]+$/.test(phase))).toBe(true);
    expect(REQUIRED_REFRESH_PHASES).toEqual([
      ...UPDATE_REFRESH_PHASES,
      REFRESH_PHASE_CONTRACT.hostConvergence,
      REFRESH_PHASE_CONTRACT.cleanup,
    ]);
  });

  it('keeps one lock owner across a reentrant child and releases only in the parent', () => {
    const { kbDir } = fixture();
    const parent = acquireRefreshLock({ kbDir, pid: 101, isAlive: () => true });
    const child = acquireRefreshLock({ kbDir, env: { RUVNET_REFRESH_RUN_TOKEN: parent.token }, pid: 202 });
    expect(child).toMatchObject({ runId: parent.runId, token: parent.token, owned: false });
    expect(() => acquireRefreshLock({ kbDir, pid: 303, isAlive: () => true })).toThrow(/another refresh run is active/);
    expect(releaseRefreshLock(child)).toBe(false);
    expect(releaseRefreshLock(parent)).toBe(true);
  });

  it('publishes owner metadata atomically so a contender cannot steal an in-progress acquisition', () => {
    const { kbDir } = fixture();
    let contender;
    expect(() => acquireRefreshLock({ kbDir, pid: 101, isAlive: () => true,
      afterStage: () => { contender = acquireRefreshLock({ kbDir, pid: 202, isAlive: () => true }); } }))
      .toThrow(/another refresh run is active/);
    expect(contender).toMatchObject({ owned: true });
    expect(releaseRefreshLock(contender)).toBe(true);
  });

  it('distinguishes PID reuse by process-start identity and refuses ambiguous remote ownership', () => {
    const { root, kbDir } = fixture();
    const first = acquireRefreshLock({ kbDir, pid: 101, processStart: 'old-start', executable: process.execPath,
      hostname: 'host-a' });
    const successor = acquireRefreshLock({ kbDir, pid: 101, processStart: 'new-start', executable: process.execPath,
      hostname: 'host-a', inspectProcess: () => ({ state: 'live', processStart: 'new-start', executable: process.execPath }) });
    expect(successor.runId).not.toBe(first.runId);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'refresh-runs', `${first.runId}.json`), 'utf8')))
      .toMatchObject({ runId: first.runId, status: 'ABANDONED', terminalVerdict: 'abandoned',
        detail: { reason: 'exact-dead-owner' } });
    expect(releaseRefreshLock(first)).toBe(false);
    expect(() => acquireRefreshLock({ kbDir, pid: 303, processStart: 'third', executable: process.execPath,
      hostname: 'host-b' })).toThrow(/owner is ambiguous/);
    expect(releaseRefreshLock(successor)).toBe(true);
  });

  it('quarantines the old lock before deletion so release cannot remove a successor', () => {
    const { kbDir } = fixture();
    const first = acquireRefreshLock({ kbDir, pid: 101, isAlive: () => true });
    let successor;
    first.afterQuarantine = () => { successor = acquireRefreshLock({ kbDir, pid: 202, isAlive: () => true }); };
    expect(releaseRefreshLock(first)).toBe(true);
    expect(successor).toMatchObject({ owned: true });
    expect(() => acquireRefreshLock({ kbDir, pid: 303, isAlive: () => true })).toThrow(/another refresh run is active/);
    expect(releaseRefreshLock(successor)).toBe(true);
  });

  it('writes an append-only phase ledger and exactly one terminal state', () => {
    const { root, kbDir } = fixture();
    const lock = acquireRefreshLock({ kbDir, pid: 101, isAlive: () => true });
    const handle = openRefreshReceipt({ brainHome: root, lock, action: 'nightly', desiredVersion: '4.2.3-dev',
      now: () => '2026-08-21T12:00:00Z' });
    for (const phase of REQUIRED_REFRESH_PHASES) {
      recordRefreshPhase(handle, phase, 'PASS', { coverageGeneration: 'abc' }, () => '2026-08-21T12:01:00Z');
    }
    recordRefreshAdvisory(handle, 'managed-catalog', 'PASS', { action: 'unchanged' });
    const { receipt: done } = settleRefreshRun({ handle, lock, status: 'SUCCEEDED', detail: { verified: true },
      now: () => '2026-08-21T12:02:00Z' });
    expect(done).toMatchObject({
      schemaVersion: 3,
      kind: 'ruvnet-brain-refresh-run',
      runId: lock.runId,
      ownerToken: { token: lock.token },
      status: 'SUCCEEDED',
      terminalVerdict: 'applied',
    });
    expect(done.phases.map(({ phase }) => phase)).toEqual(REQUIRED_REFRESH_PHASES);
    expect(() => recordRefreshPhase(handle, 'cleanup', 'PASS')).toThrow(/not active/);
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it('cannot rewrite a required phase failure or skip into a green terminal receipt', () => {
    const { root, kbDir } = fixture();
    const lock = acquireRefreshLock({ kbDir, pid: 101, isAlive: () => true });
    const handle = openRefreshReceipt({ brainHome: root, lock, action: 'nightly' });
    recordRefreshPhase(handle, 'source-enumeration', 'PASS');
    recordRefreshPhase(handle, 'ingestion', 'SKIP', { reason: 'not run' });
    expect(() => beginRefreshSettlement(handle, lock, 'SUCCEEDED')).toThrow(/required refresh phase ingestion is SKIP/);
    const { receipt: failed } = settleRefreshRun({ handle, lock, status: 'FAILED',
      detail: { terminalVerdict: 'recovery-required' } });
    expect(failed).toMatchObject({ status: 'FAILED', terminalVerdict: 'recovery-required' });
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it('rejects missing, duplicate, and out-of-order required phases', () => {
    const { root, kbDir } = fixture();
    const lock = acquireRefreshLock({ kbDir, pid: 101, isAlive: () => true });
    const handle = openRefreshReceipt({ brainHome: root, lock, action: 'nightly' });
    expect(() => recordRefreshPhase(handle, 'update', 'PASS')).toThrow(/out of order/);
    recordRefreshPhase(handle, 'source-enumeration', 'PASS');
    expect(() => recordRefreshPhase(handle, 'source-enumeration', 'PASS')).toThrow(/out of order/);
    expect(() => beginRefreshSettlement(handle, lock, 'SUCCEEDED')).toThrow(/incomplete or out of order/);
    settleRefreshRun({ handle, lock, status: 'FAILED' });
  });
});
