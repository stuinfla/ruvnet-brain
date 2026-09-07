import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveGoverned, computeDigest } from '../../scripts/doc-currency.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-working-')); roots.push(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('config', 'core.hooksPath', '/dev/null'); git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const digest = () => computeDigest(root, 'docs/adr/a.md', '# Contract\n', resolveGoverned(root, ['src/a.mjs'])).digest;
  return { root, git, digest, file: path.join(root, 'src/a.mjs') };
}
describe('document evidence binds actual governed source', () => {
  it.each([false, true])('expires when governed bytes change (staged=%s)', (staged) => {
    const f = fixture(); const before = f.digest();
    fs.writeFileSync(f.file, 'export const a = 2;\n'); if (staged) f.git('add', 'src/a.mjs');
    expect(f.digest()).not.toBe(before);
  });
  it('preserves clean committed digest and ignores unrelated edits', () => {
    const f = fixture(); const before = f.digest();
    expect(resolveGoverned(f.root, ['src/a.mjs'])[0].sha).toBe(f.git('rev-parse', 'HEAD:src/a.mjs'));
    fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'not governed'); expect(f.digest()).toBe(before);
  });
  it.each(['deleted', 'leaf-symlink', 'parent-symlink'])('refuses %s instead of verifying HEAD bytes', (kind) => {
    const f = fixture(); fs.unlinkSync(f.file);
    if (kind !== 'deleted') {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-foreign-')); roots.push(outside);
      fs.writeFileSync(path.join(outside, 'a.mjs'), 'export const a = 1;\n');
      if (kind === 'leaf-symlink') fs.symlinkSync(path.join(outside, 'a.mjs'), f.file);
      else { fs.rmdirSync(path.dirname(f.file)); fs.symlinkSync(outside, path.dirname(f.file), 'dir'); }
    }
    expect(f.digest()).toBeNull();
  });
});
