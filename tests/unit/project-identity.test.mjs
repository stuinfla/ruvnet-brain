import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, pathIdentity, sameLocation } from '../../plugin/scripts/project-identity.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'project-identity-'));
  dirs.push(d);
  return fs.realpathSync.native(d);
}

describe('project identity — one directory, one answer (issues #85, #107)', () => {
  // #107: ~/Code and ~/code are ONE directory on APFS/NTFS. A symlink reproduces "two names, one
  // directory" on EVERY filesystem, so this case does not silently pass on case-sensitive CI.
  it('two names for one directory collapse to one identity', () => {
    const root = tmp();
    const real = path.join(root, 'Code');
    fs.mkdirSync(real);
    const alias = path.join(root, 'code-alias');
    fs.symlinkSync(real, alias);

    expect(pathIdentity(alias)).toBe(pathIdentity(real));
    expect(sameLocation(alias, real)).toBe(true);
    // and the OS spelling wins, which is the whole of #107
    expect(canonicalPath(alias)).toBe(real);
  });

  // TEETH: without this, "always return the same key" would pass the test above.
  it('TEETH: two genuinely different directories stay different', () => {
    const root = tmp();
    const a = path.join(root, 'alpha');
    const b = path.join(root, 'beta');
    fs.mkdirSync(a); fs.mkdirSync(b);

    expect(pathIdentity(a)).not.toBe(pathIdentity(b));
    expect(sameLocation(a, b)).toBe(false);
  });

  it('a set keyed on identity counts one directory once — the #107 double-count', () => {
    const root = tmp();
    const real = path.join(root, 'Code');
    fs.mkdirSync(real);
    const alias = path.join(root, 'code-alias');
    fs.symlinkSync(real, alias);

    // the old guard was path.resolve(), which case-folds nothing and resolves no symlinks
    const naive = new Set([path.resolve(alias), path.resolve(real)]);
    expect(naive.size, 'path.resolve cannot dedupe these — this is the bug').toBe(2);

    const identified = new Set([pathIdentity(alias), pathIdentity(real)]);
    expect(identified.size, 'device+inode must see one directory').toBe(1);
  });

  it('answers null rather than guessing when a path does not exist', () => {
    expect(pathIdentity(path.join(tmp(), 'nope'))).toBeNull();
    expect(canonicalPath('')).toBeNull();
    expect(sameLocation(path.join(tmp(), 'a'), path.join(tmp(), 'b'))).toBe(false);
  });
});
