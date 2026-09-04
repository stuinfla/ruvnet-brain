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
 * no older than that moment (minus the grace window) counts — so a stale snapshot left over from a
 * PRIOR run can never be mistaken for proof that THIS run's backup actually landed. Callers that
 * legitimately want the newest snapshot ever (e.g. a restore path) pass no `sinceMs`.
 */
export function newestSnapshot(dir, sinceMs = 0, graceMs = MTIME_GRACE_MS) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(db|sqlite|bak)$/i.test(f) || /memory.*\d/.test(f))
      .map((f) => ({ f, p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.t >= sinceMs - graceMs)
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].p : null;
  } catch { return null; }
}
