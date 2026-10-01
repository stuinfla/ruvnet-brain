/**
 * managedStorageInventory() listed the live tree's PARENT and lstat'ed every entry in it. That parent
 * (~/.cache/ruvnet-brain on a real install) also holds hook stamps and logs that are created and
 * deleted constantly, so an unrelated sibling vanishing between readdir and lstat threw ENOENT and
 * aborted the update (4.3.40 review; also the flake in the overlay rollback test, which shared
 * os.tmpdir() as its parent). The race is reproduced deterministically by having readdir report
 * entries that are already gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedStorageInventory } from '../../kb/update-storage-transaction.mjs';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function layoutWithGhosts(ghosts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-inventory-race-'));
  roots.push(root);
  const live = path.join(root, 'kb');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'public.rvf'), 'vectors');
  const realReaddir = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
    const listed = realReaddir.call(fs, dir, ...rest);
    return path.resolve(String(dir)) === path.resolve(root) ? [...listed, ...ghosts] : listed;
  });
  return { live };
}

describe('managed storage inventory under concurrent sibling churn', () => {
  it('an unrelated sibling that vanished after readdir does not abort the inventory', () => {
    const { live } = layoutWithGhosts(['grounded-stamp-123', 'hook.log.tmp-99']);
    const inventory = managedStorageInventory(live);
    expect(inventory.active).toMatchObject({ kind: 'active', fileCount: 1 });
    expect(inventory.fullCorpusCopies).toHaveLength(1);
  });

  it('a MANAGED sibling that vanished after readdir is treated as absent, not as an error', () => {
    const { live } = layoutWithGhosts(['kb.rollback-gone', 'kb.next-gone', 'refresh-runs']);
    const inventory = managedStorageInventory(live);
    expect(inventory.fullCorpusCopies.map(({ kind }) => kind)).toEqual(['active']);
    expect(inventory.evidence).toEqual([]);
  });
});
