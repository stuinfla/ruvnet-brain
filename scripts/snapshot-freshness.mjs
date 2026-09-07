#!/usr/bin/env node
/**
 * snapshot-freshness.mjs — "a claimed backup is not a found backup" as a shared, pure function.
 *
 * `distill-project.mjs` established this discipline (PR #192): `ruflo memory backup` exiting 0
 * proves nothing about whether a NEW file actually landed — a stale snapshot from a prior run
 * sitting in the same directory is otherwise indistinguishable from a genuine fresh one, and a
 * caller that trusts the exit code alone can proceed to mutate state on a false undo guarantee.
 * Extracted here so `health-repair.mjs`'s fleet distillation (a second, independent caller of
 * `ruflo memory backup` per store) can share the exact same proof instead of re-deriving it —
 * duplicating this logic once already cost a real, shipped defect (see the 2026-08-29 Dream Cycle
 * report, "Next steps #1").
 */
import fs from 'node:fs';
import path from 'node:path';

// Some filesystems truncate mtime to whole seconds (FAT32, some overlay/network mounts), so a file
// written a moment after `sinceMs` was captured can still report an mtime slightly before it. This
// grace window is tolerance for that truncation, not a loophole — it stays far smaller than the gap
// between one run and the next.
export const MTIME_GRACE_MS = 1500;

/**
 * The newest matching snapshot file in `dir`, or null. With `sinceMs`, only a file whose mtime is
 * no older than that moment (minus the grace window) counts. Mutating callers also provide a
 * pre-backup inventory, so an unchanged prior snapshot cannot count within that grace. Callers that
 * legitimately want the newest snapshot ever (e.g. a restore path) pass no `sinceMs`.
 */
export function snapshotInventory(dir) {
  let root;
  try { root = fs.lstatSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Backup destination is not a regular directory');
  const inventory = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(db|sqlite|bak)$/i.test(name) && !/memory.*\d/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) continue;
      inventory.set(file, {
        path: file, mtimeMs: stat.mtimeMs,
        identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'),
      });
    } catch { /* a disappearing candidate is not a located backup */ }
  }
  return inventory;
}

export function newestSnapshot(dir, sinceMs = 0, graceMs = MTIME_GRACE_MS, before = null) {
  try {
    const files = [...snapshotInventory(dir).values()]
      .filter(file => file.mtimeMs >= sinceMs - graceMs
        && (!before || before.get(file.path)?.identity !== file.identity))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.path ?? null;
  } catch { return null; }
}
