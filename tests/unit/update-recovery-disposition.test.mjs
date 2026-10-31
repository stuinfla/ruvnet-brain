// #335 follow-up (4.7.21 report): a transaction whose newest receipt is RECOVERY_REQUIRED had no supported
// way out. recoverIncompleteStorageTransactions() refuses it on every run (correctly: no receipt vouches for
// its trees), and --clean --archive never enters that path. These tests pin the operator route:
// a read-only preview, then an explicit keep-live disposition that preserves every byte and is terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeRecoveryRequired, previewRecoveryRequired, recoverIncompleteStorageTransactions,
  recoveredRootFor, TERMINAL_TRANSACTION_STATES, treeIdentity } from '../../kb/update-storage-transaction.mjs';
import { runRecoverUpdate } from '../../bin/install.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const ID = 'tx-20261021T013000Z-abc123';
const summary = (dir) => { const t = treeIdentity(dir); return { sha256: t.sha256, bytes: t.bytes, fileCount: t.fileCount }; };

/** The reporter's shape: kb.next-<id> left after CANDIDATE_BUILDING, live changed after LOCKED sealed it. */
function stuckFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-recovery-required-'));
  roots.push(root);
  const live = path.join(root, 'kb');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'public.txt'), 'sealed prior');
  const prior = summary(live);
  fs.writeFileSync(path.join(live, 'RUNTIME-IDENTITY.json'), '{"stamped":"after LOCKED"}');
  const candidate = path.join(root, `kb.next-${ID}`);
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, 'public.txt'), 'half-built candidate');
  fs.writeFileSync(path.join(candidate, 'unique.bin'), 'bytes nothing else holds');
  const receipts = path.join(root, '.kb.update-transactions', ID);
  fs.mkdirSync(receipts, { recursive: true });
  const paths = { live, candidate, rollback: path.join(root, `kb.rollback-${ID}`), failed: path.join(root, `kb.failed-${ID}`), receipts };
  const write = (n, state, extra = {}) => fs.writeFileSync(path.join(receipts, `${String(n).padStart(3, '0')}-${state}.json`),
    JSON.stringify({ schemaVersion: 1, kind: 'ruvnet-brain-storage-transaction-phase', transactionId: ID, sequence: n, state,
      recordedAt: '2026-10-21T01:30:04.423Z', paths, prior, ...extra }));
  write(1, 'LOCKED');
  write(2, 'CANDIDATE_BUILDING');
  write(3, 'RECOVERY_REQUIRED', { terminalVerdict: 'recovery-required', reason: 'interrupted live tree identity differs from its sealed receipt' });
  return { root, live, candidate, receipts, prior };
}

const snapshot = (root) => {
  const out = {};
  const walk = (dir) => { for (const n of fs.readdirSync(dir).sort()) { const f = path.join(dir, n); const st = fs.lstatSync(f);
    if (st.isDirectory()) walk(f); else out[path.relative(root, f)] = fs.readFileSync(f, 'utf8'); } };
  walk(root);
  return out;
};

describe('#335 operator recovery for a RECOVERY_REQUIRED update transaction', () => {
  it('automatic recovery still refuses, and now names the read-only preview', () => {
    const f = stuckFixture();
    expect(() => recoverIncompleteStorageTransactions(f.live)).toThrow(/requires manual recovery.*--recover-update/);
  });

  it('the preview reports every tree and its relation to the sealed identities, changing nothing', () => {
    const f = stuckFixture();
    const before = snapshot(f.root);
    const [t, ...rest] = previewRecoveryRequired(f.live);
    expect(rest).toHaveLength(0);
    expect(t.transactionId).toBe(ID);
    expect(t.reason).toMatch(/differs from its sealed receipt/);
    expect(t.sealed.prior.sha256).toBe(f.prior.sha256);
    expect(t.sealed.candidate).toBeNull();
    expect(t.trees.live.identity.sha256).toBe(summary(f.live).sha256);
    expect(t.trees.live.matchesPrior).toBe(false); // never inferred: live was re-stamped after LOCKED
    expect(t.trees.candidate.exists).toBe(true);
    expect(t.trees.candidate.identity.fileCount).toBe(2);
    expect(t.trees.rollback.exists).toBe(false);
    expect(snapshot(f.root)).toEqual(before);
  });

  it('refuses a disposition that does not name the live tree exactly, changing nothing', () => {
    const f = stuckFixture();
    const before = snapshot(f.root);
    expect(() => disposeRecoveryRequired(f.live, ID, {})).toThrow(/exact sha256/);
    expect(() => disposeRecoveryRequired(f.live, ID, { keepLiveSha256: 'a'.repeat(64) })).toThrow(/changed since the preview/);
    expect(() => disposeRecoveryRequired(f.live, '../escape', { keepLiveSha256: 'a'.repeat(64) })).toThrow(/not a transaction id/);
    expect(snapshot(f.root)).toEqual(before);
  });

  it('keep-live moves the other trees intact, records a terminal DISPOSED receipt, and unblocks recovery', () => {
    const f = stuckFixture();
    const liveSha = previewRecoveryRequired(f.live)[0].trees.live.identity.sha256;
    const candidateBefore = summary(f.candidate);
    const result = disposeRecoveryRequired(f.live, ID, { keepLiveSha256: liveSha });
    expect(result.terminalVerdict).toBe('operator-kept-live');
    expect(result.liveMatchesPrior).toBe(false);
    expect(fs.existsSync(f.candidate)).toBe(false);
    const moved = path.join(recoveredRootFor(f.live), ID, 'candidate');
    expect(summary(moved)).toEqual(candidateBefore); // every byte preserved
    expect(fs.readFileSync(path.join(moved, 'unique.bin'), 'utf8')).toBe('bytes nothing else holds');
    expect(summary(f.live).sha256).toBe(liveSha); // live untouched
    const last = fs.readdirSync(f.receipts).sort().at(-1);
    expect(last).toBe('004-DISPOSED.json');
    const receipt = JSON.parse(fs.readFileSync(path.join(f.receipts, last), 'utf8'));
    expect(receipt.state).toBe('DISPOSED');
    expect(receipt.live.sha256).toBe(liveSha);
    expect(receipt.preserved[0]).toMatchObject({ tree: 'candidate', to: moved });
    expect(receipt.recoveredFrom.reason).toMatch(/differs from its sealed receipt/);
    expect(TERMINAL_TRANSACTION_STATES).toContain('DISPOSED');
    // The next update's recovery step no longer refuses, and the preview has nothing left.
    expect(recoverIncompleteStorageTransactions(f.live)).toEqual([]);
    expect(previewRecoveryRequired(f.live)).toEqual([]);
    // A second disposition is refused: the transaction is closed.
    expect(() => disposeRecoveryRequired(f.live, ID, { keepLiveSha256: liveSha })).toThrow(/not RECOVERY_REQUIRED/);
  });

  it('--recover-update prints the exact command, then performs it', () => {
    const f = stuckFixture();
    const lines = [];
    expect(runRecoverUpdate({ kbDir: f.live, keepLive: null, transaction: null, json: false, log: (l) => lines.push(l) })).toBe(1);
    const command = lines.find((l) => l.includes('--keep-live'));
    expect(command).toContain(`--transaction ${ID}`);
    expect(lines.at(-1)).toBe('Nothing was changed.');
    const sha = command.trim().split(' ').at(-1);
    const out = [];
    expect(runRecoverUpdate({ kbDir: f.live, keepLive: sha, transaction: ID, json: false, log: (l) => out.push(l) })).toBe(0);
    expect(out[0]).toMatch(/Closed update/);
    expect(runRecoverUpdate({ kbDir: f.live, keepLive: null, transaction: null, json: false, log: () => {} })).toBe(0);
  });
});
