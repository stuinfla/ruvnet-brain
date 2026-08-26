import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootNeverMaterialized } from '../../kb/store-root.mjs';

/**
 * TEETH: `rootNeverMaterialized()` must treat a stray file or an unreadable directory the same way
 * it treats an absent path — because `storesAt()`/`cardsAt()` swallow ENOENT, ENOTDIR, and EACCES
 * identically into `[]`, and `brain-score.mjs`/`restore-local-ingests.mjs` both used to gate on
 * `fs.existsSync(root)`, which is `true` for the latter two. That let a stray file or an unreadable
 * directory read as "materialized," reintroducing the exact false-current-`0` / false-`WIPED`
 * ambiguity PR #143/#155 fixed for ENOENT — an accepted, unfixed gap those commits flagged in their
 * own text (Dream Cycle 2026-08-26, DEEP=brain-currency).
 */
describe('rootNeverMaterialized()', () => {
  let dir;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('a path that does not exist at all (ENOENT) is never-materialized', () => {
    const missing = path.join(os.tmpdir(), `nm-enoent-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missing)).toBe(false);
    expect(rootNeverMaterialized(missing)).toBe(true);
  });

  it('a real, existing directory — even empty — is materialized', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-real-dir-'));
    expect(rootNeverMaterialized(dir)).toBe(false);
  });

  it('a stray FILE where a directory belongs (ENOTDIR) is never-materialized, not "exists"', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-stray-file-'));
    const strayFile = path.join(dir, 'root-as-file');
    fs.writeFileSync(strayFile, 'x');
    expect(fs.existsSync(strayFile), 'fixture precondition: existsSync must see it as present').toBe(true);
    expect(rootNeverMaterialized(strayFile)).toBe(true);
  });

  it('an unreadable directory (EACCES) is never-materialized, not "exists"', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-eacces-'));
    const original = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (p === dir) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return original(p, ...rest);
    });
    try {
      expect(rootNeverMaterialized(dir)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('an unexpected error code (e.g. EMFILE) is NOT reported as never-materialized', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-other-errno-'));
    const original = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (p === dir) { const e = new Error('EMFILE: too many open files'); e.code = 'EMFILE'; throw e; }
      return original(p, ...rest);
    });
    try {
      expect(rootNeverMaterialized(dir)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
