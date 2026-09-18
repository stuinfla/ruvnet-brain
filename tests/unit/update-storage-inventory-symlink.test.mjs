/**
 * managedStorageInventory() threw on ANY symbolic link inside a managed tree. The installed brain
 * carries `node_modules/.bin/semver` — an npm tooling symlink that is always present — so
 * forge-update.mjs:1141 (the already-current path) died with "managed active tree contains a
 * symbolic link" on every machine, and the same link in a `kb.bak-*` sibling wedged the backup
 * inventory. Issues #130/#131 already settled the policy for the reclaimer: a symlink that cannot be
 * a store file is reported, not fatal; a symlinked `.rvf` still throws. This applies the same rule
 * to the transaction inventory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedStorageInventory } from '../../kb/update-storage-transaction.mjs';

const roots = [];
function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-inventory-symlink-'));
  roots.push(root);
  const live = path.join(root, 'kb');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'public.rvf'), 'vectors');
  return { root, live };
}
const npmLink = (dir) => {
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync('../semver/bin/semver.js', path.join(dir, 'node_modules', '.bin', 'semver'));
};
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('managed storage inventory and tooling symlinks', () => {
  it('reports an npm .bin symlink in the ACTIVE tree instead of throwing', () => {
    const { live } = layout();
    npmLink(live);
    const inventory = managedStorageInventory(live);
    expect(inventory.active).toMatchObject({ kind: 'active', fileCount: 1, symlinkCount: 1 });
    expect(inventory.active.bytes).toBe(Buffer.byteLength('vectors'));
  });

  it('reports the same link inside a kb.bak-* sibling, so the backup stays inventoried', () => {
    const { root, live } = layout();
    const backup = path.join(root, 'kb.bak-2026-09-04');
    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, 'public.rvf'), 'vectors');
    npmLink(backup);
    const inventory = managedStorageInventory(live);
    const row = inventory.fullCorpusCopies.find((copy) => copy.kind === 'backup');
    expect(row).toMatchObject({ path: backup, fileCount: 1, symlinkCount: 1 });
  });

  it('still refuses a symlinked store file in a managed tree (the case the hardening exists for)', () => {
    const { live } = layout();
    fs.symlinkSync('/usr/bin/true', path.join(live, 'evil.rvf'));
    expect(() => managedStorageInventory(live)).toThrow(/symbolic link.*evil\.rvf/);
  });

  it('does not inspect unrelated parent entries before classifying them', () => {
    const { root, live } = layout();
    const unrelated = path.join(root, 'continuity-temp');
    fs.mkdirSync(unrelated);
    const originalLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
      if (file === unrelated) throw Object.assign(new Error('unrelated entry disappeared'), { code: 'ENOENT' });
      return originalLstat.call(fs, file, ...args);
    });
    expect(managedStorageInventory(live).active).toMatchObject({ kind: 'active', fileCount: 1 });
  });

  it('still fails closed when a recognized managed entry disappears during inventory', () => {
    const { root, live } = layout();
    const backup = path.join(root, 'kb.bak-race');
    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, 'public.rvf'), 'backup');
    const originalLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
      if (file === backup) {
        fs.rmSync(backup, { recursive: true, force: true });
        throw Object.assign(new Error('managed entry disappeared'), { code: 'ENOENT' });
      }
      return originalLstat.call(fs, file, ...args);
    });
    expect(() => managedStorageInventory(live)).toThrow(/managed entry disappeared/);
  });
});
