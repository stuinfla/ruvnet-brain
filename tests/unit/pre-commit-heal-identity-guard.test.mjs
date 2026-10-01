// pre-commit-heal-identity-guard.test.mjs — the heal test must never rewrite the REAL repository's
// identity. It works in a linked worktree of this repo, and linked worktrees share the main
// repository's .git/config: its former `git config user.name Fixture` silently re-authored 143 owner
// commits as "Fixture <fixture@example.invalid>" (2026-09-27 .. 2026-10-01, all of 4.3.40 included).
// This runs the heal test in a separate process and compares the shared config before and after.
// If it ever changes, the owner's values are put back FIRST and only then does the test fail.
import { expect, it } from 'vitest';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const KEYS = ['user.name', 'user.email'];
const read = (key) => {
  const r = spawnSync('git', ['config', '--local', '--get-all', key], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, value: r.stdout };
};

it('running the pre-commit heal test leaves the real repository identity untouched', () => {
  const before = Object.fromEntries(KEYS.map((key) => [key, read(key)]));
  const run = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
    'tests/unit/pre-commit-convergence-heal.test.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, RUVNET_TURN_CAPTURE: 'off' } });
  const after = Object.fromEntries(KEYS.map((key) => [key, read(key)]));
  for (const key of KEYS) {
    if (JSON.stringify(after[key]) === JSON.stringify(before[key])) continue;
    // Restore before failing: a guard that leaves the owner mis-attributed is not a guard.
    spawnSync('git', ['config', '--local', '--unset-all', key], { cwd: ROOT });
    if (before[key].status === 0) {
      for (const value of before[key].value.split('\n').filter(Boolean)) {
        execFileSync('git', ['config', '--local', '--add', key, value], { cwd: ROOT });
      }
    }
  }
  expect(run.status, `${run.stdout}\n${run.stderr}`.slice(-1500)).toBe(0); // the heal test itself ran and passed
  expect(after, 'the heal test rewrote the shared .git/config identity').toEqual(before);
}, 240_000);
