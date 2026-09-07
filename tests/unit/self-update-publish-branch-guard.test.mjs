// self-update is a rebuild mechanism, never publication authority. These subprocess tests execute
// the real entrypoint in a disposable repository and prove --publish dies before registry reads,
// network probes, version writes, npm, GitHub, or git mutation. The mutant removes the denial and
// must fail for an unrelated missing-authority path, proving the guard is load-bearing.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SELF_UPDATE_SRC = path.join(REPO_ROOT, 'scripts/self-update.mjs');
const FULL_HINTS_SRC = path.join(REPO_ROOT, 'scripts/full-hints.mjs');
const GIT_CLONE_REFRESH_SRC = path.join(REPO_ROOT, 'scripts/git-clone-refresh.mjs');
const WORKTREE_INTEGRITY_SRC = path.join(REPO_ROOT, 'scripts/worktree-integrity.mjs');

const hasGit = spawnSync('git', ['--version']).status === 0;

function git(cwd, ...args) {
  // These repos exercise self-update's publication guard, not the operator's global Git hooks.
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
}

// A throwaway repo with self-update.mjs and its relative imports copied in, so ROOT — derived
// inside the script from its OWN file location, not the caller's cwd — resolves to this disposable
// directory and never anywhere near the real ruvnet-brain checkout. An empty-but-valid
// registry.tiers.json lets a no-publish run proceed and lets the denial mutant reach later code.
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-branch-guard-'));
  execFileSync('git', ['init', '-b', 'main', dir]);
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.copyFileSync(SELF_UPDATE_SRC, path.join(dir, 'scripts/self-update.mjs'));
  for (const source of [FULL_HINTS_SRC, GIT_CLONE_REFRESH_SRC, WORKTREE_INTEGRITY_SRC]) {
    fs.copyFileSync(source, path.join(dir, 'scripts', path.basename(source)));
  }
  fs.writeFileSync(path.join(dir, 'data/registry.tiers.json'),
    JSON.stringify({ tiers: { T0: { repos: [] }, T1: { repos: [] }, T2: { repos: [] }, T3: { repos: [] } } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'test(update): seed disposable fixture');
  return dir;
}

function runSelfUpdate(dir, args) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts/self-update.mjs'), ...args], {
    encoding: 'utf8', timeout: 15_000,
  });
}

const DENIAL = /DENIED: self-update is rebuild-only/;

describe.skipIf(!hasGit || process.platform === 'win32')('self-update.mjs — publication authority is denied locally and on schedules', () => {
  let dir;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('rejects --apply --publish before touching a feature-branch checkout', () => {
    dir = fixtureRepo();
    git(dir, 'checkout', '-b', 'feat/meta-proxy-passthrough');
    const commitsBefore = git(dir, 'rev-list', '--count', 'HEAD').trim();

    const r = runSelfUpdate(dir, ['--apply', '--publish']);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(DENIAL);
    expect(r.stderr).toMatch(/protected release workflow/);
    expect(r.stdout).toBe('');
    expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe(commitsBefore);
    expect(git(dir, 'branch', '--show-current').trim()).toBe('feat/meta-proxy-passthrough');
  });

  it('rejects --apply --publish on main too — branch identity cannot grant authority', () => {
    dir = fixtureRepo(); // fixtureRepo() leaves `main` checked out
    const r = runSelfUpdate(dir, ['--apply', '--publish']);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(DENIAL);
    expect(r.stdout).toBe('');
  });

  it('refuses a plain --apply rebuild from a primary feature-branch checkout', () => {
    dir = fixtureRepo();
    git(dir, 'checkout', '-b', 'feat/some-work');

    const r = runSelfUpdate(dir, ['--apply']);

    expect(r.status).toBe(2);
    expect(r.stderr).not.toMatch(DENIAL);
    expect(r.stderr).toMatch(/primary checkout is immutable/i);
  });

  it('rejects --publish even without --apply so the flag never implies latent authority', () => {
    dir = fixtureRepo();
    git(dir, 'checkout', '-b', 'feat/some-work');

    const r = runSelfUpdate(dir, ['--publish']);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(DENIAL);
    expect(r.stdout).toBe('');
  });

  it('MUTANT: deleting the denial reaches later code instead of the authority failure', () => {
    dir = fixtureRepo();
    const script = path.join(dir, 'scripts/self-update.mjs');
    const source = fs.readFileSync(script, 'utf8');
    const guarded = source.replace(
      /if \(has\('--publish'\)\) \{[\s\S]*?process\.exit\(2\);\n\}/,
      '',
    );
    expect(guarded).not.toBe(source);
    fs.writeFileSync(script, guarded);

    const r = runSelfUpdate(dir, ['--apply', '--publish']);

    expect(r.status).toBe(2);
    expect(r.stderr).not.toMatch(DENIAL);
    expect(r.stderr).toMatch(/primary checkout is immutable/i);
  });
});
