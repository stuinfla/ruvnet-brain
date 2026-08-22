import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertIsolatedMutationWorktree,
  assertPrimaryCheckoutUnchanged,
  inspectMutationWorktree,
  snapshotPrimaryCheckout,
} from '../../scripts/worktree-integrity.mjs';

const roots = [];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-worktree-'));
  roots.push(root);
  const primary = path.join(root, 'primary');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(primary);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.email', 'qe@example.test');
  git(primary, 'config', 'user.name', 'QE');
  fs.writeFileSync(path.join(primary, 'tracked.txt'), 'base\n');
  git(primary, 'add', 'tracked.txt');
  git(primary, 'commit', '-m', 'base');
  git(primary, 'worktree', 'add', '-b', 'automation/candidate', linked, 'HEAD');
  return { root, primary, linked };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('author automation mutation boundary', () => {
  it('refuses the primary checkout even when it is clean', () => {
    const f = fixture();
    const state = inspectMutationWorktree(f.primary);
    expect(state).toMatchObject({ allowed: false, primary: true, clean: true, reason: 'primary-checkout' });
    expect(() => assertIsolatedMutationWorktree(f.primary, 'nightly')).toThrow(/primary checkout is immutable/i);
  });

  it('accepts one clean linked worktree outside the primary checkout', () => {
    const f = fixture();
    expect(assertIsolatedMutationWorktree(f.linked, 'nightly')).toMatchObject({
      allowed: true,
      linked: true,
      primary: false,
      clean: true,
      reason: 'clean-linked-worktree',
    });
  });

  it('refuses a dirty linked worktree so automation cannot mix with an unfinished lane', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.linked, 'candidate.txt'), 'unfinished\n');
    expect(inspectMutationWorktree(f.linked)).toMatchObject({ allowed: false, reason: 'dirty-writer-worktree' });
  });

  it('wires every nightly source mutator through the same boundary', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    for (const file of ['scripts/self-update.mjs', 'scripts/ingest-new-repos.mjs']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source, file).toContain("from './worktree-integrity.mjs'");
      expect(source, file).toMatch(/if \(APPLY\) \{[\s\S]*?assertIsolatedMutationWorktree\(ROOT,/);
    }
  });

  it.each([
    ['HEAD', ({ primary }) => {
      fs.writeFileSync(path.join(primary, 'tracked.txt'), 'committed\n');
      git(primary, 'add', 'tracked.txt');
      git(primary, 'commit', '-m', 'unexpected');
    }],
    ['indexDigest', ({ primary }) => {
      fs.writeFileSync(path.join(primary, 'tracked.txt'), 'staged\n');
      git(primary, 'add', 'tracked.txt');
    }],
    ['trackedDigest', ({ primary }) => fs.writeFileSync(path.join(primary, 'tracked.txt'), 'dirty\n')],
    ['untracked', ({ primary }) => fs.writeFileSync(path.join(primary, 'unexpected.txt'), 'new\n')],
  ])('detects a primary-checkout %s change around an isolated run', (field, mutate) => {
    const f = fixture();
    const before = snapshotPrimaryCheckout(f.linked);
    mutate(f);
    expect(() => assertPrimaryCheckoutUnchanged(f.linked, before)).toThrow(new RegExp(field, 'i'));
  });

  it('accepts an unchanged primary checkout even when the isolated writer becomes dirty', () => {
    const f = fixture();
    const before = snapshotPrimaryCheckout(f.linked);
    fs.writeFileSync(path.join(f.linked, 'candidate.txt'), 'isolated output\n');
    expect(assertPrimaryCheckoutUnchanged(f.linked, before)).toEqual(before);
  });

  it('the executable boundary returns nonzero in the primary checkout and zero in the linked lane', () => {
    const f = fixture();
    const cli = path.resolve(import.meta.dirname, '../../scripts/worktree-integrity.mjs');
    const denied = spawnSync(process.execPath, [cli, f.primary, 'nightly'], { encoding: 'utf8' });
    const allowed = spawnSync(process.execPath, [cli, f.linked, 'nightly'], { encoding: 'utf8' });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toMatch(/primary checkout is immutable/i);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({
      allowed: true,
      worktreeRoot: fs.realpathSync(f.linked),
    });
  });
});
