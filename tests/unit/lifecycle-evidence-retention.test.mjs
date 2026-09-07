import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessLifecycleEvidence, pruneLifecycleEvidence } from '../../kb/lifecycle-evidence-retention.mjs';

const roots = [];
const fixture = () => {
  const brainHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-retention-'));
  roots.push(brainHome);
  const kbDir = path.join(brainHome, 'kb');
  fs.mkdirSync(kbDir);
  fs.mkdirSync(path.join(brainHome, 'refresh-runs'));
  fs.mkdirSync(path.join(brainHome, '.kb.update-transactions'));
  return { brainHome, kbDir };
};
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function refresh({ brainHome }, id, { at, action = 'nightly', status = 'SUCCEEDED', extra = {} } = {}) {
  const receipt = { schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', runId: id, action,
    startedAt: at, ...(status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABANDONED' ? { finishedAt: at } : {}),
    status, terminalVerdict: status === 'SUCCEEDED' ? 'noop' : status.toLowerCase(), ...extra };
  fs.writeFileSync(path.join(brainHome, 'refresh-runs', `${id}.json`), JSON.stringify(receipt));
}

function transaction({ brainHome }, id, { at, state = 'COMMITTED' } = {}) {
  const dir = path.join(brainHome, '.kb.update-transactions', id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `001-${state}.json`), JSON.stringify({ schemaVersion: 1,
    kind: 'ruvnet-brain-storage-transaction-phase', transactionId: id, sequence: 1, state, recordedAt: at }));
  return dir;
}

const policy = (overrides = {}) => ({ schemaVersion: 1, policyId: 'test-policy', maxRefreshReceipts: 99,
  maxTransactionDirectories: 99, maxEvidenceBytes: 1_000_000, ...overrides });

describe('lifecycle evidence retention', () => {
  it('prunes oldest semantic refresh timestamp and is idempotent', () => {
    const f = fixture();
    refresh(f, 'z-old', { at: '2026-01-01T00:00:00Z' });
    refresh(f, 'a-new', { at: '2026-02-01T00:00:00Z' });
    const first = pruneLifecycleEvidence({ ...f, policy: policy({ maxRefreshReceipts: 1 }) });
    expect(first.removed.refresh).toEqual([path.join(f.brainHome, 'refresh-runs', 'z-old.json')]);
    expect(first.withinBudget).toBe(true);
    const second = pruneLifecycleEvidence({ ...f, policy: policy({ maxRefreshReceipts: 1 }) });
    expect(second.removed.refresh).toEqual([]);
    expect(second.withinBudget).toBe(true);
  });

  it('preserves active, newest action, failure, abandonment, explicit, referenced, and nonterminal evidence', () => {
    const f = fixture();
    const oldTx = transaction(f, 'referenced', { at: '2026-01-01T00:00:00Z' });
    transaction(f, 'nonterminal', { at: '2026-01-02T00:00:00Z', state: 'CLEANUP_PENDING' });
    refresh(f, 'active', { at: '2026-01-01T00:00:00Z', status: 'RUNNING' });
    refresh(f, 'latest-nightly', { at: '2026-02-01T00:00:00Z', extra: { detail: { transactionReceipts: oldTx } } });
    refresh(f, 'latest-update', { at: '2026-02-02T00:00:00Z', action: 'update' });
    refresh(f, 'latest-failed', { at: '2026-02-03T00:00:00Z', action: 'manual', status: 'FAILED' });
    refresh(f, 'latest-abandoned', { at: '2026-02-04T00:00:00Z', action: 'manual', status: 'ABANDONED' });
    refresh(f, 'explicit', { at: '2026-01-03T00:00:00Z', action: 'manual' });
    const result = pruneLifecycleEvidence({ ...f, preserveRefreshRunIds: ['explicit'],
      policy: policy({ maxRefreshReceipts: 0, maxTransactionDirectories: 0, maxEvidenceBytes: 0 }) });
    expect(result.withinBudget).toBe(false);
    expect(result.removed.refresh).toEqual([]);
    expect(result.removed.transactions).toEqual([]);
    expect(fs.existsSync(oldTx)).toBe(true);
  });

  it('fails closed on malformed entries, symlinks, and forged external transaction references', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.brainHome, 'refresh-runs', 'bad.json'), '{');
    fs.symlinkSync('/tmp', path.join(f.brainHome, '.kb.update-transactions', 'linked'));
    refresh(f, 'nightly', { at: '2026-02-01T00:00:00Z', extra: { detail: { transactionReceipts: '/tmp/elsewhere' } } });
    const result = assessLifecycleEvidence({ ...f });
    expect(result.withinBudget).toBe(false);
    expect(result.unsafe.map(({ reason }) => reason).join('\n')).toMatch(/Unexpected end|malformed transaction|forged external/);
  });

  it('counts quarantine bytes but never infers cleanup ownership from its name', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.brainHome, 'refresh-runs', '.prune-old-0123456789abcdef'), 'stranded');
    const before = assessLifecycleEvidence({ ...f });
    expect(before.withinBudget).toBe(false);
    expect(before.before.bytes).toBe(Buffer.byteLength('stranded'));
    const after = pruneLifecycleEvidence({ ...f });
    expect(after.withinBudget).toBe(false);
    expect(fs.readFileSync(path.join(f.brainHome, 'refresh-runs', '.prune-old-0123456789abcdef'), 'utf8')).toBe('stranded');
    expect(after.removed).toEqual({ refresh: [], transactions: [] });
  });

  it('leaves a measured quarantine after interruption and refuses unproven deletion on the next run', () => {
    const f = fixture();
    refresh(f, 'old', { at: '2026-01-01T00:00:00Z' });
    refresh(f, 'new', { at: '2026-02-01T00:00:00Z' });
    expect(() => pruneLifecycleEvidence({ ...f, policy: policy({ maxRefreshReceipts: 1 }),
      afterQuarantine: () => { throw new Error('injected interruption'); } })).toThrow(/interruption/);
    expect(assessLifecycleEvidence({ ...f }).withinBudget).toBe(false);
    const recovered = pruneLifecycleEvidence({ ...f, policy: policy({ maxRefreshReceipts: 1 }) });
    expect(recovered.withinBudget).toBe(false);
    expect(recovered.unsafe.some(({ reason }) => /quarantine/.test(reason))).toBe(true);
  });

  it.each(['refresh-runs', '.kb.update-transactions'])('rejects symlinked %s roots without touching their targets', (name) => {
    const f = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-external-'));
    roots.push(external);
    const quarantine = path.join(external, '.prune-private-0123456789abcdef');
    fs.mkdirSync(quarantine);
    fs.writeFileSync(path.join(quarantine, 'private.txt'), 'private original');
    fs.rmdirSync(path.join(f.brainHome, name));
    fs.symlinkSync(external, path.join(f.brainHome, name));
    const result = pruneLifecycleEvidence({ ...f, policy: policy({ maxEvidenceBytes: 0 }) });
    expect(result.withinBudget).toBe(false);
    expect(result.unsafe.some(({ reason }) => /root.*symbolic|trusted.*root/.test(reason))).toBe(true);
    expect(fs.readFileSync(path.join(quarantine, 'private.txt'), 'utf8')).toBe('private original');
  });

  it('preserves an unowned quarantine directory and counts its private bytes', () => {
    const f = fixture();
    const quarantine = path.join(f.brainHome, 'refresh-runs', '.prune-private-0123456789abcdef');
    fs.mkdirSync(quarantine);
    fs.writeFileSync(path.join(quarantine, 'private.txt'), 'private original');
    const result = pruneLifecycleEvidence(f);
    expect(result.withinBudget).toBe(false);
    expect(result.after.bytes).toBe(Buffer.byteLength('private original'));
    expect(fs.readFileSync(path.join(quarantine, 'private.txt'), 'utf8')).toBe('private original');
  });

  it('still prunes a validated terminal transaction within this invocation', () => {
    const f = fixture();
    const old = transaction(f, 'old', { at: '2026-01-01T00:00:00Z' });
    const result = pruneLifecycleEvidence({ ...f, policy: policy({ maxTransactionDirectories: 0 }) });
    expect(result.removed.transactions).toEqual([old]);
    expect(result.withinBudget).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });
});
