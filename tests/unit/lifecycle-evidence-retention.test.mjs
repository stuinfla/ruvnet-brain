import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('fits three protected inventory-heavy transactions without deleting any evidence or changing tokens', () => {
    const f = fixture();
    const originals = new Map();
    const inventories = Array.from({ length: 500 }, (_, index) => ({ path: `private/store-${index}.rvf`,
      bytes: 12345, sha256: 'a'.repeat(64), note: 'spaces  stay\nwith \\"escapes" and unicode ☃' }));
    const transactions = ['failed', 'update', 'current'].map((id) => {
      const dir = transaction(f, id, { at: '2026-02-01T00:00:00Z' });
      const file = path.join(dir, '001-COMMITTED.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const raw = JSON.stringify({ ...value, prior: { entries: inventories }, candidate: { entries: inventories } }, null, 2)
        .replace('"sequence": 1', '"sequence": 1, "precise": 9007199254740993');
      fs.writeFileSync(file, raw, { mode: 0o600 });
      originals.set(file, { raw, value: JSON.parse(raw), stat: fs.statSync(file) });
      return dir;
    });
    refresh(f, 'failed', { at: '2026-02-01T00:00:00Z', action: 'update', status: 'FAILED',
      extra: { transactionReceipts: transactions[0] } });
    refresh(f, 'update', { at: '2026-02-02T00:00:00Z', action: 'update', extra: { transactionReceipts: transactions[1] } });
    const options = { ...f, preserveTransactionPaths: [transactions[2]], policy: policy({ maxEvidenceBytes: 600_000 }) };
    expect(assessLifecycleEvidence(options).withinBudget).toBe(false); // Negative control: original formatting exceeds budget.
    const result = pruneLifecycleEvidence(options);
    expect(result.withinBudget).toBe(true);
    expect(result.removed).toEqual({ refresh: [], transactions: [] });
    expect(result.compacted).toHaveLength(3);
    for (const [file, original] of originals) {
      const raw = fs.readFileSync(file, 'utf8');
      expect(JSON.parse(raw)).toEqual(original.value);
      expect(raw).toContain('9007199254740993'); // sync-version-ignore: this fixture integer exceeds safe JS precision to prove byte preservation
      expect(fs.statSync(file).mode).toBe(original.stat.mode);
      expect(fs.statSync(file).uid).toBe(original.stat.uid);
      expect(fs.statSync(file).gid).toBe(original.stat.gid);
      expect(fs.statSync(file).mtimeMs).toBeCloseTo(original.stat.mtimeMs, 2);
    }
    expect(pruneLifecycleEvidence(options).compacted).toEqual([]);
  });

  it('leaves active and malformed earlier phases byte-exact even above budget', () => {
    const f = fixture();
    const active = transaction(f, 'active', { at: '2026-02-01T00:00:00Z', state: 'CLEANUP_PENDING' });
    const file = path.join(active, '001-CLEANUP_PENDING.json');
    const raw = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2);
    fs.writeFileSync(file, raw);
    expect(pruneLifecycleEvidence({ ...f, policy: policy({ maxEvidenceBytes: 0 }) }).compacted).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    fs.writeFileSync(path.join(active, '002-COMMITTED.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'ruvnet-brain-storage-transaction-phase', transactionId: 'active', sequence: 2,
      state: 'COMMITTED', recordedAt: '2026-02-02T00:00:00Z' }));
    fs.writeFileSync(file, raw.replace('"sequence": 1', '"sequence": 3'));
    const result = pruneLifecycleEvidence({ ...f, policy: policy({ maxEvidenceBytes: 0 }) });
    expect(result.unsafe).toHaveLength(1);
    expect(result.compacted).toEqual([]);
  });

  it('keeps the original complete phase when atomic replacement fails', () => {
    const f = fixture();
    const dir = transaction(f, 'protected', { at: '2026-02-01T00:00:00Z' });
    const file = path.join(dir, '001-COMMITTED.json');
    const raw = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2);
    fs.writeFileSync(file, raw);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected rename failure'); });
    try {
      expect(() => pruneLifecycleEvidence({ ...f, preserveTransactionPaths: [dir], policy: policy({ maxEvidenceBytes: 0 }) }))
        .toThrow('injected rename failure');
    } finally { rename.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(fs.readdirSync(dir)).toEqual(['001-COMMITTED.json']);
  });

  it('refuses to compact a phase that shares its inode with another evidence copy', () => {
    const f = fixture();
    const dir = transaction(f, 'shared', { at: '2026-02-01T00:00:00Z' });
    const file = path.join(dir, '001-COMMITTED.json');
    const raw = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2);
    fs.writeFileSync(file, raw);
    const originalCopy = path.join(f.brainHome, 'original.json');
    fs.linkSync(file, originalCopy);
    expect(() => pruneLifecycleEvidence({ ...f, preserveTransactionPaths: [dir], policy: policy({ maxEvidenceBytes: 0 }) }))
      .toThrow('exclusive regular file');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(fs.readFileSync(originalCopy, 'utf8')).toBe(raw);
  });

  it('preserves malformed UTF-8 bytes rather than rewriting them as replacement characters', () => {
    const f = fixture();
    const dir = transaction(f, 'invalid-utf8', { at: '2026-02-01T00:00:00Z' });
    const file = path.join(dir, '001-COMMITTED.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const text = JSON.stringify({ ...value, note: 'marker' }, null, 2);
    const split = text.indexOf('marker');
    const raw = Buffer.concat([Buffer.from(text.slice(0, split)), Buffer.from([0xff]), Buffer.from(text.slice(split + 6))]);
    fs.writeFileSync(file, raw);
    const result = pruneLifecycleEvidence({ ...f, policy: policy({ maxEvidenceBytes: 0 }) });
    expect(result.withinBudget).toBe(false);
    expect(result.unsafe[0].reason).toBe('evidence is not valid UTF-8');
    expect(result.compacted).toEqual([]);
    expect(result.removed).toEqual({ refresh: [], transactions: [] });
    expect(fs.readFileSync(file).equals(raw)).toBe(true);
  });

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

  it('accepts a brain home that IS a symlink (the brain moved to another disk) and its real-path references', () => {
    // MEASURED 2026-09-30 (scripts/customer-state-matrix.mjs, location=symlinked-brain-home): with
    // ~/.cache/ruvnet-brain -> /Volumes/<disk>/ruvnet-brain, the installer passes the link spelling while the
    // updater records real-path transaction references; the parent-is-a-symlink check and the reference
    // containment check then both fail a perfectly ordinary layout and every update ends recovery-required.
    const f = fixture();
    const link = `${f.brainHome}-link`;
    fs.symlinkSync(f.brainHome, link);
    roots.push(link);
    const tx = transaction(f, 'applied', { at: '2026-02-01T00:00:00Z' });
    refresh(f, 'update', { at: '2026-02-02T00:00:00Z', action: 'update', extra: { detail: { transactionReceipts: fs.realpathSync(tx) } } });
    const result = pruneLifecycleEvidence({ brainHome: link, kbDir: path.join(link, 'kb'), policy: policy() });
    expect(result.unsafe).toEqual([]);
    expect(result.withinBudget).toBe(true);
    // A symlinked evidence ROOT is still refused.
    fs.rmSync(path.join(f.brainHome, 'refresh-runs'), { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(f.brainHome, 'refresh-runs'));
    expect(assessLifecycleEvidence({ brainHome: link, kbDir: path.join(link, 'kb') }).withinBudget).toBe(false);
  });

  // Only the brain home (the evidence roots' PARENT) may be a link. An evidence ROOT that is itself a link
  // could aim pruning at any directory, so it stays refused — through a real or a linked brain home.
  it.each([['a real brain home', false], ['a symlinked brain home', true]])('TEETH: a symlinked evidence ROOT is refused via %s, and nothing behind it is pruned', (_label, linked) => {
    for (const rootName of ['refresh-runs', '.kb.update-transactions']) {
      const f = fixture();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-elsewhere-'));
      roots.push(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'old.json'), JSON.stringify({ schemaVersion: 3, kind: 'ruvnet-brain-refresh-run',
        runId: 'old', action: 'manual', startedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:00:00Z', status: 'SUCCEEDED' }));
      fs.rmSync(path.join(f.brainHome, rootName), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(f.brainHome, rootName));
      let home = f.brainHome;
      if (linked) { home = `${f.brainHome}-link`; fs.symlinkSync(f.brainHome, home); roots.push(home); }
      const result = pruneLifecycleEvidence({ brainHome: home, kbDir: path.join(home, 'kb'),
        policy: policy({ maxRefreshReceipts: 0, maxTransactionDirectories: 0, maxEvidenceBytes: 0 }) });
      expect(result.withinBudget, rootName).toBe(false);
      expect(result.unsafe, rootName).toEqual([{ path: path.join(home, rootName),
        reason: 'evidence root is not a trusted directory (symbolic or special entry)' }]);
      expect(fs.readdirSync(elsewhere), rootName).toEqual(['old.json']);
    }
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

  describe('abandoned atomic-write temporaries (#434)', () => {
    const now = () => '2026-10-20T12:00:00Z';
    const temp = ({ brainHome }, runId, { content = '', ageMs = 2 * 60 * 60 * 1000, suffix = '2756628-1574d1f1' } = {}) => {
      const file = path.join(brainHome, 'refresh-runs', `${runId}.json.tmp-${suffix}`);
      fs.writeFileSync(file, content, { mode: 0o600 });
      const at = (Date.parse(now()) - ageMs) / 1000;
      fs.utimesSync(file, at, at);
      return file;
    };

    it('reclaims the reported pair of empty stale temps beside their canonical receipt, reported, not silent', () => {
      const f = fixture();
      const runId = '1791258423435-ea78236a066a7f72';
      refresh(f, runId, { at: '2026-10-19T03:00:00Z', status: 'ABANDONED' });
      const a = temp(f, runId);
      const b = temp(f, runId, { suffix: '2756628-4401e88f' });
      const assessed = assessLifecycleEvidence({ ...f, now });
      expect(assessed.unsafe).toEqual([]);
      expect(assessed.withinBudget).toBe(true);
      expect(assessed.abandonedTemporaries.map(({ path: p }) => p)).toEqual([a, b]);
      const result = pruneLifecycleEvidence({ ...f, now });
      expect(result.unsafe).toEqual([]);
      expect(result.withinBudget).toBe(true);
      expect(result.reclaimedTemporaries).toEqual([a, b].map((p) => expect.objectContaining({ path: p, runId, writerPid: 2756628,
        bytes: 0, canonicalReceipt: true, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' })));
      expect(fs.readdirSync(path.join(f.brainHome, 'refresh-runs'))).toEqual([`${runId}.json`]);
      expect(result.removed).toEqual({ refresh: [], transactions: [] });
    });

    it('leaves a young (in-flight) temp alone without blocking retention', () => {
      const f = fixture();
      refresh(f, 'live', { at: '2026-10-20T11:59:00Z', status: 'RUNNING' });
      const young = temp(f, 'live', { content: '{"partial"', ageMs: 1000 });
      const result = pruneLifecycleEvidence({ ...f, now });
      expect(result.unsafe).toEqual([]);
      expect(result.withinBudget).toBe(true);
      expect(result.reclaimedTemporaries).toEqual([]);
      expect(fs.readFileSync(young, 'utf8')).toBe('{"partial"');
    });

    it('preserves a stale temp with content but no canonical receipt (ambiguous) and still reports it unsafe', () => {
      const f = fixture();
      const orphan = temp(f, 'orphan', { content: '{"runId":"orphan"}' });
      const result = pruneLifecycleEvidence({ ...f, now });
      expect(result.unsafe).toEqual([{ path: orphan, reason: expect.stringMatching(/no canonical receipt; preserved/) }]);
      expect(result.reclaimedTemporaries).toEqual([]);
      expect(fs.readFileSync(orphan, 'utf8')).toBe('{"runId":"orphan"}');
    });

    it('a temp that vanishes between the snapshot and its re-check is already gone, not a failed prune', () => {
      const f = fixture();
      const runId = '1791258423435-ea78236a066a7f72';
      refresh(f, runId, { at: '2026-10-19T03:00:00Z', status: 'ABANDONED' });
      const a = temp(f, runId);
      const b = temp(f, runId, { suffix: '2756628-4401e88f' });
      const real = fs.lstatSync;
      // Another sweep removes `a` after this prune's snapshot listed it, just before the identity re-check.
      const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(function (file, ...rest) {
        const caller = String(new Error().stack).split('\n').find((line) => line.includes('lifecycle-evidence-retention.mjs')) || '';
        if (file === a && /at pruneLifecycleEvidence /.test(caller)) fs.rmSync(a, { force: true });
        return real.call(this, file, ...rest);
      });
      let result;
      try { result = pruneLifecycleEvidence({ ...f, now }); } finally { spy.mockRestore(); }
      expect(fs.existsSync(a)).toBe(false);
      expect(result.reclaimedTemporaries.map(({ path: p }) => p)).toEqual([b]);
      expect(fs.readdirSync(path.join(f.brainHome, 'refresh-runs'))).toEqual([`${runId}.json`]);
    });

    it('a temp that vanishes between its re-check and the quarantine rename is already gone too', () => {
      const f = fixture();
      const runId = '1791258423435-ea78236a066a7f72';
      refresh(f, runId, { at: '2026-10-19T03:00:00Z', status: 'ABANDONED' });
      const a = temp(f, runId);
      const b = temp(f, runId, { suffix: '2756628-4401e88f' });
      const real = fs.renameSync;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation(function (from, ...rest) {
        if (from === a) fs.rmSync(a, { force: true });
        return real.call(this, from, ...rest);
      });
      let result;
      try { result = pruneLifecycleEvidence({ ...f, now }); } finally { spy.mockRestore(); }
      expect(result.reclaimedTemporaries.map(({ path: p }) => p)).toEqual([b]);
    });

    it('refuses a stale temp that is a symlink or hard link', () => {
      const f = fixture();
      refresh(f, 'linked', { at: '2026-10-19T03:00:00Z' });
      const target = path.join(f.brainHome, 'outside.txt');
      fs.writeFileSync(target, '');
      fs.linkSync(target, path.join(f.brainHome, 'refresh-runs', 'linked.json.tmp-1-aaaaaaaa'));
      const result = pruneLifecycleEvidence({ ...f, now });
      expect(result.unsafe.map(({ reason }) => reason)).toEqual(['atomic-write temporary is not an exclusive regular file']);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});


// Review r2 (4.7.21): an entry that "vanishes" on every rename while the snapshot keeps listing it must not spin the
// prune loop forever. The mock stops vanishing after 1000 attempts so the unbounded (pre-fix) loop still terminates.
describe('the vanished-entry retry loop is bounded', () => {
  it('stops after MAX_VANISHED_RETRIES, removes nothing further, and says why', async () => {
    const { MAX_VANISHED_RETRIES } = await import('../../kb/lifecycle-evidence-retention.mjs');
    const f = fixture();
    for (const [i, id] of ['1791258423435-aaaaaaaaaaaaaaaa', '1791258423436-bbbbbbbbbbbbbbbb', '1791258423437-cccccccccccccccc'].entries()) {
      refresh(f, id, { at: `2026-10-1${i}T03:00:00Z` });
    }
    const runs = path.join(f.brainHome, 'refresh-runs');
    const before = fs.readdirSync(runs).sort();
    const real = fs.renameSync; let attempts = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(function (from, ...rest) {
      if (path.dirname(String(from)) === runs && attempts < 1000) {
        attempts += 1;
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), { code: 'ENOENT' });
      }
      return real.call(this, from, ...rest);
    });
    let result;
    try { result = pruneLifecycleEvidence({ ...f, policy: policy({ maxRefreshReceipts: 1 }) }); } finally { spy.mockRestore(); }
    expect(MAX_VANISHED_RETRIES).toBeGreaterThan(0);
    expect(attempts).toBe(MAX_VANISHED_RETRIES + 1);
    expect(result.stopped).toMatch(/pruning stopped: lifecycle evidence vanished \d+ times/);
    expect(result.removed).toEqual({ refresh: [], transactions: [] });
    expect(result.withinBudget).toBe(false);
    expect(fs.readdirSync(runs).sort()).toEqual(before);
  });
});

// 4.7.21 (RC2.3): one `.DS_Store`, or a `.prune-*` quarantine our own time-limit kill left behind, made the state
// unsafe forever, and the updater turned EVERY outcome (even a no-op) into recovery-required + a 745 MB reinstall.
describe('volume metadata, foreign files and abandoned quarantines', () => {
  const now = () => '2026-10-20T12:00:00Z';
  // Quarantine age is measured from the entry's own mtime/ctime (a rename sets ctime), which is wall-clock:
  // three hours from now makes every entry this test creates older than ABANDONED_TEMP_AGE_MS.
  const later = () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  it('.DS_Store and ._ shadows are ignored and removed; a stray note is foreign (kept, reported), never unsafe', () => {
    const f = fixture();
    refresh(f, 'r1', { at: '2026-10-19T03:00:00Z' });
    const tx = transaction(f, 't1', { at: '2026-10-19T03:00:00Z' });
    const runs = path.join(f.brainHome, 'refresh-runs');
    for (const file of [path.join(runs, '.DS_Store'), path.join(runs, '._r1.json'), path.join(tx, '.DS_Store'),
      path.join(f.brainHome, '.kb.update-transactions', 'Thumbs.db')]) fs.writeFileSync(file, 'finder');
    fs.writeFileSync(path.join(runs, 'notes.txt'), 'mine');
    const assessed = assessLifecycleEvidence({ ...f, now });
    expect(assessed.unsafe).toEqual([]);
    expect(assessed.withinBudget).toBe(true);
    expect(assessed.foreign).toEqual([{ path: path.join(runs, 'notes.txt'), bytes: 4 }]);
    expect(assessed.before).toEqual({ refreshReceipts: 1, transactionDirectories: 1, bytes: assessed.before.bytes });
    const result = pruneLifecycleEvidence({ ...f, now });
    expect(result.withinBudget).toBe(true);
    expect(result.removedVolumeMetadata).toHaveLength(4);
    expect(fs.readdirSync(runs).sort()).toEqual(['notes.txt', 'r1.json']);
    expect(fs.readdirSync(tx)).toEqual(['001-COMMITTED.json']);
    expect(result.removed).toEqual({ refresh: [], transactions: [] });
  });

  it('compaction over budget skips a .DS_Store inside a transaction directory instead of failing', () => {
    const f = fixture();
    const dir = transaction(f, 'big', { at: '2026-02-01T00:00:00Z' });
    const file = path.join(dir, '001-COMMITTED.json');
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 8));
    fs.writeFileSync(path.join(dir, '.DS_Store'), Buffer.alloc(64));
    const result = pruneLifecycleEvidence({ ...f, preserveTransactionPaths: [dir], policy: policy({ maxEvidenceBytes: 150 }) });
    expect(result.unsafe).toEqual([]);
    expect(result.compacted).toEqual([file]);
  });

  it('an abandoned .prune-* receipt quarantine (>1 h, run terminal or gone) is reclaimed and retention fits again', () => {
    const f = fixture();
    const runs = path.join(f.brainHome, 'refresh-runs');
    refresh(f, 'kept', { at: '2026-10-19T03:00:00Z' });
    const stranded = path.join(runs, '.prune-old-0123456789abcdef');
    fs.writeFileSync(stranded, JSON.stringify({ schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', runId: 'old', status: 'SUCCEEDED' }));
    const txQuarantine = path.join(f.brainHome, '.kb.update-transactions', '.prune-gone-fedcba9876543210');
    fs.mkdirSync(txQuarantine); fs.writeFileSync(path.join(txQuarantine, '001-COMMITTED.json'), '{}');
    expect(assessLifecycleEvidence({ ...f }).withinBudget, 'young: a prune may still be between rename and delete').toBe(false);
    const result = pruneLifecycleEvidence({ ...f, now: later });
    expect(result.unsafe).toEqual([]);
    expect(result.withinBudget).toBe(true);
    expect(result.reclaimedQuarantines.map(({ path: p }) => p).sort()).toEqual([stranded, txQuarantine].sort());
    expect(fs.existsSync(stranded)).toBe(false);
    expect(fs.existsSync(txQuarantine)).toBe(false);
    expect(fs.readdirSync(runs)).toEqual(['kept.json']);
  });

  it('an old quarantine whose run is live again, or that is not the shape we quarantine, is still preserved as unsafe', () => {
    const f = fixture();
    const runs = path.join(f.brainHome, 'refresh-runs');
    refresh(f, 'live', { at: '2026-10-20T14:00:00Z', status: 'RUNNING' });
    const liveQuarantine = path.join(runs, '.prune-live-0123456789abcdef');
    fs.writeFileSync(liveQuarantine, '{}');
    const dirQuarantine = path.join(runs, '.prune-private-0123456789abcdef'); // a directory under refresh-runs: never ours
    fs.mkdirSync(dirQuarantine); fs.writeFileSync(path.join(dirQuarantine, 'private.txt'), 'private original');
    const result = pruneLifecycleEvidence({ ...f, now: later });
    expect(result.withinBudget).toBe(false);
    expect(result.unsafe.map(({ path: p }) => p).sort()).toEqual([dirQuarantine, liveQuarantine].sort());
    expect(result.reclaimedQuarantines).toEqual([]);
    expect(fs.readFileSync(path.join(dirQuarantine, 'private.txt'), 'utf8')).toBe('private original');
    expect(fs.existsSync(liveQuarantine)).toBe(true);
  });
});
