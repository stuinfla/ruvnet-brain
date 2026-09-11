// tests/unit/maintainer-repo-scope.test.mjs — unit-level coverage for
// plugin/scripts/session-start-repo-identity.mjs, the fix for the 2026-09-11 leak where a
// maintainer's open-issue alert surfaced in every UNRELATED project on the machine (the per-user
// entitlement file was never checked against the CURRENT project's identity).
//
// Reviewer correction #3: "Entitlement is defined as an exact remote-URL match against a fixed
// constant (stuinfla/ruvnet-brain, both https and ssh forms); test three cases: entitled remote,
// foreign remote, no remote/non-git." This file is the fast, direct-function form of that
// requirement; tests/unit/session-start-core-parity.test.mjs covers the same three cases end-to-end
// through the real hook (shell + core) for full-stack confidence.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MAINTAINER_REPO_SLUG,
  parseRepoSlugFromRemote,
  resolveProjectRepoSlug,
  isMaintainerRepo,
} from '../../plugin/scripts/session-start-repo-identity.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function gitDir(remoteUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-scope-'));
  roots.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (remoteUrl) spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  return dir;
}

describe('MAINTAINER_REPO_SLUG', () => {
  it('is the fixed constant, never a value read back from a cache or entitlement file', () => {
    expect(MAINTAINER_REPO_SLUG).toBe('stuinfla/ruvnet-brain');
  });
});

describe('parseRepoSlugFromRemote', () => {
  it('parses the https form (with and without .git)', () => {
    expect(parseRepoSlugFromRemote('https://github.com/stuinfla/ruvnet-brain.git')).toBe('stuinfla/ruvnet-brain');
    expect(parseRepoSlugFromRemote('https://github.com/stuinfla/ruvnet-brain')).toBe('stuinfla/ruvnet-brain');
  });
  it('parses the ssh form', () => {
    expect(parseRepoSlugFromRemote('git@github.com:stuinfla/ruvnet-brain.git')).toBe('stuinfla/ruvnet-brain');
  });
  it('returns null for a non-GitHub remote, empty, or garbage input', () => {
    expect(parseRepoSlugFromRemote('https://gitlab.com/stuinfla/ruvnet-brain.git')).toBeNull();
    expect(parseRepoSlugFromRemote('')).toBeNull();
    expect(parseRepoSlugFromRemote(undefined)).toBeNull();
    expect(parseRepoSlugFromRemote('not a url at all')).toBeNull();
  });
});

describe('resolveProjectRepoSlug / isMaintainerRepo — the three required cases', () => {
  it('CASE 1 — entitled remote (https): resolves and matches', () => {
    const dir = gitDir('https://github.com/stuinfla/ruvnet-brain.git');
    expect(resolveProjectRepoSlug(dir)).toBe('stuinfla/ruvnet-brain');
    expect(isMaintainerRepo(dir)).toBe(true);
  });

  it('CASE 1b — entitled remote (ssh): resolves and matches', () => {
    const dir = gitDir('git@github.com:stuinfla/ruvnet-brain.git');
    expect(resolveProjectRepoSlug(dir)).toBe('stuinfla/ruvnet-brain');
    expect(isMaintainerRepo(dir)).toBe(true);
  });

  it('CASE 2 — foreign remote: resolves to a DIFFERENT slug, does not match', () => {
    const dir = gitDir('https://github.com/someone/else.git');
    expect(resolveProjectRepoSlug(dir)).toBe('someone/else');
    expect(isMaintainerRepo(dir)).toBe(false);
  });

  it('CASE 3 — no remote / non-git checkout: resolves to null, does not match', () => {
    const gitNoRemote = gitDir(null);
    expect(resolveProjectRepoSlug(gitNoRemote)).toBeNull();
    expect(isMaintainerRepo(gitNoRemote)).toBe(false);

    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-scope-nongit-'));
    roots.push(nonGit);
    expect(resolveProjectRepoSlug(nonGit)).toBeNull();
    expect(isMaintainerRepo(nonGit)).toBe(false);
  });

  it('never runs a network call: a missing git binary fails closed, not open', () => {
    const dir = gitDir('https://github.com/stuinfla/ruvnet-brain.git');
    expect(resolveProjectRepoSlug(dir, { gitBin: '/nonexistent/git-binary-xyz' })).toBeNull();
    expect(isMaintainerRepo(dir, { gitBin: '/nonexistent/git-binary-xyz' })).toBe(false);
  });
});
