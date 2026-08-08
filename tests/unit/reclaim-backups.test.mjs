/**
 * Issue #35 (Dr. Mark Allen / @mamd69): every update left a full ~2.5 GB rollback copy on disk and
 * never removed it. He accumulated seven — about 14 GB — before noticing.
 *
 * `reclaimBackups()` releases them once the new KB has verified. It DELETES MULTI-GIGABYTE
 * DIRECTORIES, so the safety property is tested directly with real files on disk, not mocked:
 * a backup holding a store the live KB lacks must SURVIVE. That is the private/local-store case,
 * where the backup is the only remaining copy and deleting it would destroy user data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclaimBackups } from '../../kb/forge-update.mjs';

let root;
const mk = (dir, files) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
  return dir;
};

const writeGenerations = (dir, stores) => {
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores }));
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('reclaimBackups (issue #35)', () => {
  it('deletes a rollback copy whose stores all exist in the new KB', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64, 'b.rvf': 64 });
    const bak = mk(path.join(root, 'kb.bak-2026-07-01'), { 'a.rvf': 2048, 'b.rvf': 2048 });

    const { removed, kept, freed } = reclaimBackups({ kbDir: kb, backupsMade: [bak], env: {} });

    expect(fs.existsSync(bak)).toBe(false);
    expect(removed).toEqual([bak]);
    expect(kept).toEqual([]);
    expect(freed).toBe(4096);
  });

  it('KEEPS a rollback copy holding a store the new KB lost (the private-store guard)', () => {
    // The exact scenario that makes a blind `rm` destructive: the public bundle does not ship
    // private stores, the update replaced the directory, and forge-guard still passed.
    const kb = mk(path.join(root, 'kb'), { 'public.rvf': 64 });
    const bak = mk(path.join(root, 'kb.bak-2026-07-01'), { 'public.rvf': 64, 'cognitum-seed.rvf': 4096 });

    const { removed, kept } = reclaimBackups({ kbDir: kb, backupsMade: [bak], env: {} });

    expect(fs.existsSync(bak), 'the only copy of a private store must never be deleted').toBe(true);
    expect(removed).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0][1]).toMatch(/cognitum-seed\.rvf/);
  });

  it('keeps only-copy stores declared with opaque or nested generation files', () => {
    const kb = mk(path.join(root, 'kb'), { 'public.rvf': 64 });
    writeGenerations(kb, { public: { file: 'public.rvf' } });
    const opaque = mk(path.join(root, 'kb.bak-2026-07-01'), {
      'public.rvf': 64,
      'opaque-store.bin': 128,
    });
    writeGenerations(opaque, {
      public: { file: 'public.rvf' },
      privateOpaque: { file: 'opaque-store.bin' },
    });
    const nested = mk(path.join(root, 'kb.bak-2026-07-02'), { 'public.rvf': 64 });
    fs.mkdirSync(path.join(nested, 'nested'));
    fs.writeFileSync(path.join(nested, 'nested', 'private.rvf'), Buffer.alloc(256, 2));
    writeGenerations(nested, {
      public: { file: 'public.rvf' },
      privateNested: { file: 'nested/private.rvf' },
    });

    const { removed, kept } = reclaimBackups({ kbDir: kb, backupsMade: [opaque, nested], env: {} });

    expect(removed).toEqual([]);
    expect(kept).toHaveLength(2);
    expect(kept.map(([, reason]) => reason).join('\n')).toContain('opaque-store.bin');
    expect(kept.map(([, reason]) => reason).join('\n')).toContain('nested/private.rvf');
    expect(fs.existsSync(opaque)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('reclaims an opaque generation only when its logical store is explicitly removed', () => {
    const kb = mk(path.join(root, 'kb'), { 'public.rvf': 64 });
    writeGenerations(kb, { public: { file: 'public.rvf' } });
    const backup = mk(path.join(root, 'kb.bak-2026-07-01'), {
      'public.rvf': 64,
      'opaque-store.bin': 128,
    });
    writeGenerations(backup, {
      public: { file: 'public.rvf' },
      privateOpaque: { file: 'opaque-store.bin' },
    });

    const { removed, kept } = reclaimBackups({
      kbDir: kb,
      backupsMade: [backup],
      env: {},
      intentionallyRemovedStores: ['privateOpaque'],
    });

    expect(removed).toEqual([backup]);
    expect(kept).toEqual([]);
  });

  it('reclaims public stores intentionally removed by a selected profile but still keeps private stores', () => {
    const kb = mk(path.join(root, 'kb'), { 'ruvector.rvf': 64 });
    const publicOnly = mk(path.join(root, 'kb.bak-2026-07-01'), {
      'ruvector.rvf': 64,
      'ruflo.rvf': 1024,
    });
    const withPrivate = mk(path.join(root, 'kb.bak-2026-07-02'), {
      'ruvector.rvf': 64,
      'ruflo.rvf': 1024,
      'private-research.rvf': 4096,
    });

    const { removed, kept } = reclaimBackups({
      kbDir: kb,
      backupsMade: [publicOnly, withPrivate],
      env: {},
      intentionallyRemovedStores: ['ruflo'],
    });

    expect(removed).toEqual([publicOnly]);
    expect(fs.existsSync(withPrivate)).toBe(true);
    expect(kept[0][1]).toMatch(/private-research\.rvf/);
  });

  it('sweeps copies stranded by EARLIER runs, not just this one (Mark had seven)', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 });
    const old1 = mk(path.join(root, 'kb.bak-2026-06-29'), { 'a.rvf': 1024 });
    const old2 = mk(path.join(root, 'kb.bak-2026-07-02'), { 'a.rvf': 1024 });
    const fresh = mk(path.join(root, 'kb.bak-2026-07-20'), { 'a.rvf': 1024 });

    // Only the newest was created by this run; the older two are stranded from prior updates.
    const { removed } = reclaimBackups({ kbDir: kb, backupsMade: [fresh], env: {} });

    expect(removed.sort()).toEqual([old1, old2, fresh].sort());
    for (const d of [old1, old2, fresh]) expect(fs.existsSync(d)).toBe(false);
  });

  it('RUVNET_KEEP_BACKUP=1 keeps everything, for anyone who wants the old behaviour', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 });
    const bak = mk(path.join(root, 'kb.bak-2026-07-01'), { 'a.rvf': 1024 });

    const { removed, kept } = reclaimBackups({ kbDir: kb, backupsMade: [bak], env: { RUVNET_KEEP_BACKUP: '1' } });

    expect(fs.existsSync(bak)).toBe(true);
    expect(removed).toEqual([]);
    expect(kept[0][1]).toMatch(/RUVNET_KEEP_BACKUP/);
  });

  it('never touches anything that is not a kb.bak-* sibling', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 });
    const unrelated = mk(path.join(root, 'my-important-data'), { 'a.rvf': 64 });
    const alsoNot = mk(path.join(root, 'kb-notes'), { 'a.rvf': 64 });

    reclaimBackups({ kbDir: kb, backupsMade: [], env: {} });

    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(alsoNot)).toBe(true);
    expect(fs.existsSync(kb)).toBe(true);
  });

  it('is a no-op when there is nothing to reclaim', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 });
    const { removed, kept, freed } = reclaimBackups({ kbDir: kb, backupsMade: [], env: {} });
    expect(removed).toEqual([]); expect(kept).toEqual([]); expect(freed).toBe(0);
  });

  it('keeps a backup when generation metadata is corrupt and an opaque artifact is unclassified', () => {
    const kb = mk(path.join(root, 'kb'), { 'public.rvf': 64 });
    const backup = mk(path.join(root, 'kb.bak-2026-07-01'), {
      'public.rvf': 64,
      'private-opaque.bin': 128,
    });
    fs.writeFileSync(path.join(backup, 'RVF-GENERATIONS.json'), '{not-json');

    const { removed, kept } = reclaimBackups({ kbDir: kb, backupsMade: [backup], env: {} });

    expect(removed).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(fs.existsSync(path.join(backup, 'private-opaque.bin'))).toBe(true);
  });
});
