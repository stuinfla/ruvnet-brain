// tests/unit/version-bump-gate.test.mjs — the gate that makes every push carry a version bump.
//
// WHY (2026-07-13). Stuart: "Every single commit to GitHub should come with a version increment…
// When other things are looking to read a change in version to know that there's something they
// need to be aware of, that's not negotiable." The incident: a push under an unchanged 2.5.2 made
// a restarted session load the stale plugin without /savings — the cache compared versions,
// saw no change, and was RIGHT to serve stale. The load-bearing test re-introduces that exact miss.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/version-bump-gate.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
}

// A real repo pair: bare "origin" + working clone with plugin.json at v1.0.0, pushed.
function fixtureRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-'));
  const bare = path.join(base, 'origin.git'); const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', bare, work], { encoding: 'utf8' });
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(work, 'plugin/.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(work, 'plugin/.claude-plugin/plugin.json'), '{\n  "version": "1.0.0"\n}\n');
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'v1.0.0'); git(work, 'push', '-u', 'origin', 'main');
  return { base, work };
}

function runGate(cwd, command, { optedIn = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-home-'));
  if (optedIn) {
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
  }
  const r = spawnSync('bash', [GATE], {
    cwd, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

describe.skipIf(!hasBash || !hasGit || process.platform === 'win32')('version-bump-gate.sh — every push carries a bump', () => {
  it('BLOCKS the exact 2026-07-13 miss: outgoing commits, version unchanged', () => {
    const { work } = fixtureRepo();
    fs.writeFileSync(path.join(work, 'feature.mjs'), 'export const shipped = true;\n');
    git(work, 'add', '-A'); git(work, 'commit', '-m', 'new feature, no bump');
    const r = runGate(work, 'git push origin main');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/NO version increment/);
    expect(r.stderr).toMatch(/sync-version/); // teaches the remedy
  });

  // field()'s regex extracted a quoted JSON value with `"([^"]*)"` — no concept of a JSON-escaped
  // `\"`, which is still a literal `"` byte in the raw payload text. A real compound command whose
  // command string embeds a quote BEFORE "git push" (routine: `-m "…"`, `echo "…"`) truncated CMD at
  // that first quote, so the later `[[ $CMD == *"git push"* ]]` substring check silently missed a
  // push it should have caught — the same class of bug issue #13/design-wall.sh already fixed once
  // (see hook-input.mjs's header), reintroduced here because this file kept its own inline field().
  it('BLOCKS a git push even when the command string has an embedded quote before it', () => {
    const { work } = fixtureRepo();
    fs.writeFileSync(path.join(work, 'feature.mjs'), 'export const shipped = true;\n');
    git(work, 'add', '-A'); git(work, 'commit', '-m', 'new feature, no bump');
    const r = runGate(work, 'git commit -m "wip" && git push origin main');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/NO version increment/);
  });

  it('OPENS when the outgoing commits include a bump', () => {
    const { work } = fixtureRepo();
    fs.writeFileSync(path.join(work, 'feature.mjs'), 'export const shipped = true;\n');
    fs.writeFileSync(path.join(work, 'plugin/.claude-plugin/plugin.json'), '{\n  "version": "1.0.1"\n}\n');
    git(work, 'add', '-A'); git(work, 'commit', '-m', 'feature + bump');
    expect(runGate(work, 'git push origin main').status).toBe(0);
  });

  it('ignores everything that is not a git push, and pushes with nothing outgoing', () => {
    const { work } = fixtureRepo();
    expect(runGate(work, 'git status').status).toBe(0);
    expect(runGate(work, 'npm test').status).toBe(0);
    expect(runGate(work, 'git push origin main').status).toBe(0); // 0 commits ahead
  });

  it('passes untouched in a repo with no version manifest (not version-managed)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-nv-'));
    execFileSync('git', ['init', '-b', 'main', base]);
    git(base, 'config', 'user.email', 't@t'); git(base, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(base, 'x.txt'), 'x');
    git(base, 'add', '-A'); git(base, 'commit', '-m', 'x');
    expect(runGate(base, 'git push origin main').status).toBe(0);
  });

  it('never touches a user who did not opt in, and FAILS OPEN on garbage stdin', () => {
    const { work } = fixtureRepo();
    fs.writeFileSync(path.join(work, 'f.mjs'), 'x');
    git(work, 'add', '-A'); git(work, 'commit', '-m', 'no bump');
    expect(runGate(work, 'git push origin main', { optedIn: false }).status).toBe(0);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-g-'));
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
    const r = spawnSync('bash', [GATE], { cwd: work, input: 'not json', env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});
