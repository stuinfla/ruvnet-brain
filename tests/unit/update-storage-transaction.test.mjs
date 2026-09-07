import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverIncompleteStorageTransactions, runStorageTransaction,
  managedStorageInventory, treeIdentity } from '../../kb/update-storage-transaction.mjs';

const MODULE = pathToFileURL(path.resolve(import.meta.dirname, '../../kb/update-storage-transaction.mjs')).href;

const roots = [];
function fixture({ same = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-storage-tx-'));
  roots.push(root);
  const live = path.join(root, 'kb');
  const source = path.join(root, 'incoming');
  fs.mkdirSync(live); fs.mkdirSync(source);
  fs.writeFileSync(path.join(live, 'public.txt'), 'old');
  fs.writeFileSync(path.join(source, 'public.txt'), same ? 'old' : 'new');
  return { root, live, source, before: treeIdentity(live) };
}

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('atomic KB storage transaction', () => {
  it('measures preserved and unresolved installer trees without making them cleanup eligible', () => {
    const f = fixture();
    const names = ['kb.install-preserved-old', 'kb.install-prior-crashed', '.kb.install-stage-partial'];
    for (const name of names) {
      const dir = path.join(f.root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'private.txt'), 'private bytes');
      fs.symlinkSync(f.source, path.join(dir, 'external-link'));
    }
    const external = path.join(f.root, 'kb.install-preserved-link');
    fs.symlinkSync(f.source, external);
    const inventory = managedStorageInventory(f.live);
    expect(inventory.additionalFullCorpusCopyCount).toBe(4);
    const observed = inventory.fullCorpusCopies.filter((row) => row.kind.startsWith('installer-'));
    expect(observed).toHaveLength(4);
    expect(observed.every((row) => row.automaticCleanupEligible === false)).toBe(true);
    expect(observed.reduce((sum, row) => sum + row.symlinkCount, 0)).toBe(4);
    expect(observed.reduce((sum, row) => sum + row.fileCount, 0)).toBe(3);
    expect(inventory.additionalFullCorpusBytes).toBe(3 * Buffer.byteLength('private bytes') + 4 * Buffer.byteLength(f.source));
    expect(fs.readFileSync(path.join(f.source, 'public.txt'), 'utf8')).toBe('new');
    expect(fs.lstatSync(external).isSymbolicLink()).toBe(true);
  });

  it('builds and validates off to the side, then commits one rename activation', () => {
    const f = fixture();
    const result = runStorageTransaction({ liveDir: f.live, sourceDir: f.source, transactionId: 'apply-1',
      prepareCandidate: ({ candidateDir }) => fs.writeFileSync(path.join(candidateDir, 'private.txt'), 'preserved'),
      validateCandidate: ({ dir }) => ({ valid: fs.readFileSync(path.join(dir, 'private.txt'), 'utf8') === 'preserved' }),
    });
    expect(result.terminalVerdict).toBe('applied');
    expect(result.storageDelta).toMatchObject({ redundantCopyCount: 0, redundantBytes: 0,
      cleanupPending: false });
    expect(fs.readFileSync(path.join(f.live, 'public.txt'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(f.live, 'private.txt'), 'utf8')).toBe('preserved');
    expect(fs.existsSync(result.paths.rollback)).toBe(false);
    expect(fs.existsSync(result.paths.candidate)).toBe(false);
  });

  it('returns an exact-byte noop without creating a rollback directory', () => {
    const f = fixture({ same: true });
    const result = runStorageTransaction({ liveDir: f.live, sourceDir: f.source, transactionId: 'noop-1' });
    expect(result.terminalVerdict).toBe('noop');
    expect(result.storageDelta).toMatchObject({ activeBytesDelta: 0, redundantCopyCount: 0 });
    expect(treeIdentity(f.live)).toEqual(f.before);
    expect(fs.existsSync(result.paths.rollback)).toBe(false);
  });

  it('leaves live byte-identical when candidate preparation or validation fails', () => {
    for (const [id, prepareCandidate, validateCandidate] of [
      ['prepare-fail', () => { throw new Error('overlay failed'); }, undefined],
      ['validate-fail', undefined, () => ({ valid: false, failures: ['coverage failed'] })],
    ]) {
      const f = fixture();
      expect(() => runStorageTransaction({ liveDir: f.live, sourceDir: f.source, transactionId: id,
        ...(prepareCandidate ? { prepareCandidate } : {}), ...(validateCandidate ? { validateCandidate } : {}) })).toThrow();
      expect(treeIdentity(f.live)).toEqual(f.before);
    }
  });

  it('restores and verifies prior bytes when activation or live verification fails', () => {
    for (const [id, checkpoint, validateLive] of [
      ['rename-fail', (phase) => { if (phase === 'OLD_RENAMED') throw new Error('injected rename boundary failure'); }, undefined],
      ['live-fail', undefined, () => ({ valid: false, failures: ['guard failed'] })],
    ]) {
      const f = fixture();
      expect(() => runStorageTransaction({ liveDir: f.live, sourceDir: f.source, transactionId: id,
        ...(checkpoint ? { checkpoint } : {}), ...(validateLive ? { validateLive } : {}) })).toThrow(/restored and verified/);
      expect(treeIdentity(f.live)).toEqual(f.before);
      expect(fs.readdirSync(f.root).filter((name) => /\.(?:next|rollback|failed)-/.test(name))).toEqual([]);
    }
  });

  it('rejects unsafe transaction identifiers before creating paths', () => {
    const f = fixture();
    expect(() => runStorageTransaction({ liveDir: f.live, sourceDir: f.source, transactionId: '../escape' }))
      .toThrow(/unsafe/);
    expect(treeIdentity(f.live)).toEqual(f.before);
  });

  it.each(['LOCKED', 'CANDIDATE_BUILDING', 'CANDIDATE_VERIFIED', 'OLD_RENAME_STARTED',
    'OLD_RENAMED', 'ACTIVATED_UNRECEIPTED', 'ACTIVATED', 'LIVE_VERIFIED', 'ROLLBACK_REMOVED'])
  ('recovers a process killed after %s before admitting another transaction', (killAt) => {
    const f = fixture();
    const script = `import {runStorageTransaction} from ${JSON.stringify(MODULE)};
runStorageTransaction({liveDir:${JSON.stringify(f.live)},sourceDir:${JSON.stringify(f.source)},transactionId:'killed-${killAt.toLowerCase()}',
checkpoint:(phase)=>{if(phase===${JSON.stringify(killAt)})process.exit(93);}});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child.status).toBe(93);
    const recovered = recoverIncompleteStorageTransactions(f.live);
    const preservesCandidate = ['LIVE_VERIFIED', 'ROLLBACK_REMOVED'].includes(killAt);
    const expectedVerdict = preservesCandidate ? 'applied' : 'interrupted-run-restored';
    expect(recovered).toHaveLength(1);
    const recoveredFrom = killAt === 'ROLLBACK_REMOVED' ? 'LIVE_VERIFIED'
      : killAt === 'ACTIVATED_UNRECEIPTED' ? 'OLD_RENAMED' : killAt;
    expect(recovered[0]).toMatchObject({ transactionId: `killed-${killAt.toLowerCase()}`, from: recoveredFrom,
      terminalVerdict: expectedVerdict, storageDelta: { redundantCopyCount: 0 } });
    if (preservesCandidate) {
      expect(fs.readFileSync(path.join(f.live, 'public.txt'), 'utf8')).toBe('new');
    } else expect(treeIdentity(f.live)).toEqual(f.before);
    expect(fs.readdirSync(f.root).filter((name) => /\.next-|\.rollback-|\.failed-/.test(name))).toEqual([]);
  });

  it('recovers a process killed after live was renamed but before OLD_RENAMED was receipted', () => {
    const f = fixture();
    const script = `import {runStorageTransaction} from ${JSON.stringify(MODULE)};
runStorageTransaction({liveDir:${JSON.stringify(f.live)},sourceDir:${JSON.stringify(f.source)},transactionId:'unreceipted-old-rename',
checkpoint:(phase)=>{if(phase==='OLD_RENAMED_UNRECEIPTED')process.exit(93);}});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child.status).toBe(93);

    expect(recoverIncompleteStorageTransactions(f.live)).toMatchObject([{
      transactionId: 'unreceipted-old-rename', from: 'OLD_RENAME_STARTED',
      terminalVerdict: 'interrupted-run-restored', storageDelta: { redundantCopyCount: 0 },
    }]);
    expect(treeIdentity(f.live)).toEqual(f.before);
    expect(fs.readdirSync(f.root).filter((name) => /\.next-|\.rollback-|\.failed-/.test(name))).toEqual([]);
  });

  it.each([
    ['CANDIDATE_BUILDING', 'candidate'],
    ['CANDIDATE_VERIFIED', 'candidate'],
    ['OLD_RENAME_STARTED', 'candidate'],
    ['OLD_RENAMED', 'candidate'],
    ['OLD_RENAMED', 'rollback'],
    ['ACTIVATED_UNRECEIPTED', 'live'],
    ['ACTIVATED', 'live'],
    ['LIVE_VERIFIED', 'rollback'],
  ])('preserves all trees when %s recovery finds changed %s bytes', (killAt, target) => {
    const f = fixture();
    const script = `import {runStorageTransaction} from ${JSON.stringify(MODULE)};
runStorageTransaction({liveDir:${JSON.stringify(f.live)},sourceDir:${JSON.stringify(f.source)},transactionId:'tampered',
checkpoint:(phase)=>{if(phase===${JSON.stringify(killAt)})process.exit(93);}});`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).status).toBe(93);
    const receipts = path.join(f.root, '.kb.update-transactions', 'tampered');
    const latest = JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts).sort().at(-1)), 'utf8'));
    fs.mkdirSync(latest.paths[target], { recursive: true });
    fs.writeFileSync(path.join(latest.paths[target], 'post-crash-private.txt'), 'must survive recovery');
    const before = Object.fromEntries(['live', 'candidate', 'rollback', 'failed'].map((name) => [name,
      fs.existsSync(latest.paths[name]) ? treeIdentity(latest.paths[name]) : null]));

    expect(() => recoverIncompleteStorageTransactions(f.live)).toThrow(/identity|sealed receipt/);
    for (const [name, identity] of Object.entries(before)) {
      expect(fs.existsSync(latest.paths[name])).toBe(identity !== null);
      if (identity) expect(treeIdentity(latest.paths[name])).toEqual(identity);
    }
    const final = JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts).sort().at(-1)), 'utf8'));
    expect(final.state).toBe('RECOVERY_REQUIRED');
  });

  it('preserves verified live bytes while rollback cleanup is pending and completes on recovery', () => {
    const f = fixture();
    const result = runStorageTransaction({ liveDir: f.live, sourceDir: f.source,
      transactionId: 'cleanup-pending', removeRollback: () => { throw new Error('busy'); } });
    expect(result).toMatchObject({ terminalVerdict: 'cleanup-pending', cleanupPending: true,
      storageDelta: { redundantCopyCount: 1, cleanupPending: true } });
    expect(fs.readFileSync(path.join(f.live, 'public.txt'), 'utf8')).toBe('new');
    expect(recoverIncompleteStorageTransactions(f.live)).toMatchObject([{
      transactionId: 'cleanup-pending', from: 'CLEANUP_PENDING', terminalVerdict: 'applied',
      storageDelta: { redundantCopyCount: 0, cleanupPending: false },
    }]);
    expect(fs.readFileSync(path.join(f.live, 'public.txt'), 'utf8')).toBe('new');
  });

  it('counts planted managed backups globally and rejects symbolic-link copies', () => {
    const f = fixture({ same: true });
    const backup = `${f.live}.bak-old`;
    fs.cpSync(f.live, backup, { recursive: true });
    expect(managedStorageInventory(f.live)).toMatchObject({ additionalFullCorpusCopyCount: 1,
      additionalFullCorpusBytes: f.before.bytes });
    const result = runStorageTransaction({ liveDir: f.live, sourceDir: f.source, transactionId: 'global-count' });
    expect(result.storageDelta).toMatchObject({ redundantCopyCount: 1, redundantBytes: f.before.bytes });
    fs.rmSync(backup, { recursive: true });
    fs.symlinkSync(f.live, backup);
    expect(() => managedStorageInventory(f.live)).toThrow(/not a trusted directory/);
  });
});
