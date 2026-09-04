// tests/unit/snapshot-freshness.test.mjs — the shared "a claimed backup is not a found backup"
// proof, extracted from distill-project.mjs (PR #192) so a second caller (health-repair.mjs's
// fleet distillation) can share it instead of re-deriving it. Pure filesystem function, no
// subprocess, no sqlite3 dependency — fully reproducible anywhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newestSnapshot, MTIME_GRACE_MS } from '../../scripts/snapshot-freshness.mjs';

let dir;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-freshness-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function touch(name, mtimeMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  if (mtimeMs !== undefined) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

describe('newestSnapshot()', () => {
  it('returns null for a directory with no matching files', () => {
    fs.mkdirSync(dir, { recursive: true });
    expect(newestSnapshot(dir)).toBeNull();
  });

  it('returns null for a directory that does not exist', () => {
    expect(newestSnapshot(path.join(dir, 'nope'))).toBeNull();
  });

  it('with no sinceMs floor, returns the newest snapshot ever (the --restore case)', () => {
    touch('memory-1.db', Date.now() - 100_000);
    const newer = touch('memory-2.db', Date.now() - 1_000);
    expect(newestSnapshot(dir)).toBe(newer);
  });

  it('rejects a snapshot older than sinceMs minus the grace window — the TEETH case', () => {
    // Simulates the exact failure this fix targets: `ruflo memory backup` reports success (exit 0)
    // but the file present in the directory is left over from a PRIOR run, not this one.
    const stale = touch('memory-old.db', Date.now() - 60_000);
    const backupStartedAt = Date.now();
    expect(newestSnapshot(dir, backupStartedAt)).toBeNull();
    // sanity: the stale file is genuinely there and would have been returned with no floor.
    expect(newestSnapshot(dir)).toBe(stale);
  });

  it('accepts a snapshot written at/after sinceMs — a genuinely fresh backup is not penalized', () => {
    const backupStartedAt = Date.now();
    const fresh = touch('memory-fresh.db', backupStartedAt + 50);
    expect(newestSnapshot(dir, backupStartedAt)).toBe(fresh);
  });

  it('tolerates mtime truncated to whole seconds within the grace window', () => {
    const backupStartedAt = Date.now();
    // One tick before sinceMs, but well within MTIME_GRACE_MS — a coarse-mtime filesystem should
    // not falsely reject a snapshot that landed this run.
    const truncated = touch('memory-trunc.db', backupStartedAt - Math.floor(MTIME_GRACE_MS / 2));
    expect(newestSnapshot(dir, backupStartedAt)).toBe(truncated);
  });

  it('still rejects a file older than sinceMs by more than the grace window', () => {
    touch('memory-toostale.db', Date.now() - (MTIME_GRACE_MS + 5_000));
    expect(newestSnapshot(dir, Date.now())).toBeNull();
  });

  it('picks the newest of several fresh candidates', () => {
    const backupStartedAt = Date.now();
    touch('memory-a.db', backupStartedAt + 10);
    const newest = touch('memory-b.db', backupStartedAt + 200);
    expect(newestSnapshot(dir, backupStartedAt)).toBe(newest);
  });

  it('ignores files that do not look like a snapshot', () => {
    touch('readme.txt', Date.now());
    expect(newestSnapshot(dir)).toBeNull();
  });
});
