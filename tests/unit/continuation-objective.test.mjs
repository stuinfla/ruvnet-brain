import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/continuation-gate.mjs');
const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-objective-')));
  roots.push(root);
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  const ledger = path.join(root, 'ledger.json');
  const objective = { schemaVersion: 1, kind: 'continuation-preferences', authoritative: false,
    id: 'objective-1', text: 'finish the authorized fixture task', state: 'active',
    projectId: `git-sha256:${hash(path.join(repo, '.git'))}`, worktreeIds: [hash(repo)], sessionIds: ['session-1'],
    authorization: { kind: 'user', reference: 'user-turn-fixture-1' }, at: new Date().toISOString() };
  return { root, repo, ledger, objective };
}
function run(f, { objective = f.objective, cwd = f.repo, payload = {}, items, args = [] } = {}) {
  fs.writeFileSync(f.ledger, JSON.stringify({ objective, items: items || [
    { text: 'legacy unscoped promise', done: false, at: new Date().toISOString() },
  ] }));
  return spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-1', cwd, ...payload }),
    env: { ...process.env, RUVNET_WORK_LEDGER: f.ledger, RUVNET_CONTINUATION_COOLDOWN_MS: '0',
      RUVNET_OPEN_ISSUES_FILE: path.join(f.root, 'absent-open.json'),
      RUVNET_CI_STATUS_FILE: path.join(f.root, 'absent-ci.json') } });
}
describe('explicit continuation objective authority', () => {
  it('requests work on only the authorized objective, without routine reconfirmation', () => {
    const result = run(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('finish the authorized fixture task');
    expect(result.stdout).not.toContain('legacy unscoped promise');
    expect(result.stdout).toContain('without routine reconfirmation');
  });
  it.each(['cancelled', 'completed', 'blocked'])('does not restart a %s objective or mark unfinished items done', (state) => {
    const f = fixture(); f.objective.state = state; f.objective.reason = 'explicit fixture reason';
    const result = run(f);
    expect(result.stdout).toBe('');
    expect(JSON.parse(fs.readFileSync(f.ledger)).items[0].done).toBe(false);
  });
  it('does not derive authority from an old global or project ledger', () => {
    expect(run(fixture(), { objective: null }).stdout).toBe('');
  });
  it('rejects a different session or observed authorization', () => {
    const f = fixture();
    expect(run(f, { payload: { session_id: 'other-session' } }).stdout).toBe('');
    f.objective.authorization.kind = 'observed';
    expect(run(f).stdout).toBe('');
  });
  it.each([{ hook_event_name: 'SessionEnd' }, { session_id: null }, { cwd: null }, { cwd: '.' }, { interrupted: true },
    { stop_hook_active: true }])('never requests continuation for unsupported payload %j', (payload) => {
    expect(run(fixture(), { payload }).stdout).toBe('');
  });
  it('separates same-basename repositories despite an explicitly shared ledger path', () => {
    const f = fixture();
    const other = path.join(f.root, 'other', 'repo');
    execFileSync('git', ['init', '--quiet', other]);
    expect(run(f, { cwd: other }).stdout).toBe('');
  });
  it('uses distinct portable default ledger filenames for colliding repository basenames', () => {
    const f = fixture();
    const other = path.join(f.root, 'other', 'repo');
    execFileSync('git', ['init', '--quiet', other]);
    for (const cwd of [f.repo, other]) {
      const result = spawnSync(process.execPath, [GATE, '--commit-to', 'diagnostic legacy item'], {
        cwd, encoding: 'utf8', env: { ...process.env, HOME: f.root, USERPROFILE: f.root, RUVNET_WORK_LEDGER: '' },
      });
      expect(result.status).toBe(0);
    }
    const names = fs.readdirSync(path.join(f.root, '.config', 'ruvnet-brain', 'work-ledgers'));
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[a-z0-9.-]+\.json$/.test(name))).toBe(true);
  });
  it('shares canonical project identity across worktrees but requires explicit worktree binding', () => {
    const f = fixture();
    const worktree = path.join(f.root, 'linked');
    const gitdir = path.join(f.repo, '.git', 'worktrees', 'linked');
    fs.mkdirSync(worktree); fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    fs.copyFileSync(path.join(f.repo, '.git', 'HEAD'), path.join(gitdir, 'HEAD'));
    expect(run(f, { cwd: worktree }).stdout).toBe('');
    f.objective.worktreeIds.push(hash(worktree));
    expect(run(f, { cwd: worktree }).stdout).toContain(f.objective.text);
  });
});
