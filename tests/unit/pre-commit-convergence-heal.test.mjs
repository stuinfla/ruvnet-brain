import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const HOOK = path.join(ROOT, 'scripts', 'git-hooks', 'pre-commit');
const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT }); });

// Regression for 2026-09-27: twice in one release train (v4.3.30, v4.3.31), a commit landed with
// data/convergence-manifest.json stale relative to the rest of the tree in the SAME commit —
// once because a source fix was added in a later commit without regenerating the manifest, once
// because the manifest was regenerated BEFORE `git add` on a new file (so `git ls-files` could not
// see it yet). CI caught both, minutes later, in parallel across every OS — expensive to discover
// remotely, cheap to prevent locally. This hook must make a stale manifest impossible to commit by
// silently regenerating and re-staging it before the commit is created, whatever order the commit
// content was assembled in.
it('the pre-commit hook self-heals a manifest left stale by a same-commit source change, without blocking the commit', () => {
  expect(fs.existsSync(HOOK), 'scripts/git-hooks/pre-commit must exist').toBe(true);
  expect(fs.statSync(HOOK).mode & 0o111, 'the hook must be executable').toBeGreaterThan(0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-converge-'));
  roots.push(dir);
  execFileSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // NEVER `git config` here: a linked worktree shares the REAL repository's .git/config, so the
  // former `git config user.name Fixture` rewrote the owner's identity on every run (143 commits
  // authored as "Fixture" from 2026-09-27). Identity is passed per command instead, and
  // tests/unit/pre-commit-heal-identity-guard.test.mjs proves the shared config is untouched.
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];

  // Regenerate the manifest first (as if it had been written before a later change), THEN make an
  // additional source-tree change WITHOUT ever re-running convergence:write — reproducing the exact
  // staleness bug, inside a real checkout with every file convergence-manifest.mjs expects.
  execFileSync('node', ['scripts/convergence-manifest.mjs', '--write'], { cwd: dir });
  git('add', 'data/convergence-manifest.json');
  const marker = path.join(dir, 'scripts', 'precommit-heal-fixture-marker.mjs');
  fs.writeFileSync(marker, '// fixture-only file for pre-commit-convergence-heal.test.mjs\nexport const fixture = true;\n');
  git('add', 'scripts/precommit-heal-fixture-marker.mjs');

  expect(() => execFileSync('node', ['scripts/convergence-manifest.mjs'], { cwd: dir, stdio: 'pipe' }))
    .toThrow(); // sanity: the manifest really is stale at this point, or the fixture proves nothing

  // Bind THIS checkout's hook explicitly. Relying on ambient `core.hooksPath` made the test pass only on
  // a developer machine whose global config points at some checkout's hooks (here: the main checkout,
  // not the code under test) and fail on a clean CI runner, where no hook ran at all (2026-10-01,
  // canonical-qa full-suite on ubuntu: "manifest is stale").
  git(...identity, '-c', `core.hooksPath=${path.join(dir, 'scripts', 'git-hooks')}`, 'commit', '-qm', 'fixture: stale-manifest commit the hook must heal');

  // The hook must have re-generated and re-staged the manifest as part of that commit, not left it
  // for CI to catch.
  execFileSync('node', ['scripts/convergence-manifest.mjs'], { cwd: dir, stdio: 'pipe' }); // must not throw now
  const committedFiles = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  expect(committedFiles).toContain('data/convergence-manifest.json');
  expect(committedFiles).toContain('scripts/precommit-heal-fixture-marker.mjs');
});
