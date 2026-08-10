import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO, 'plugin/scripts/swarm-slot-recycler.mjs');
const HOOKS = path.join(REPO, 'plugin/hooks/hooks.json');
const SHIM = path.join(REPO, 'plugin/scripts/hook-shim.mjs');
const PLAYBOOK = path.join(REPO, 'plugin/skills/ruvnet-brain/PLAYBOOK.md');
const CODEX_HOOKS = path.join(REPO, 'plugin/hooks/codex-hooks.json');

let home;
let tasksRoot;

function task(team, id, values = {}) {
  const dir = path.join(tasksRoot, team);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id: String(id),
    subject: `Task ${id}`,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...values,
  }));
}

function payload(values = {}) {
  return JSON.stringify({
    hook_event_name: 'TeammateIdle',
    session_id: 'session-recycle',
    cwd: REPO,
    teammate_name: 'worker-a',
    team_name: 'team-a',
    ...values,
  });
}

function run(input = payload()) {
  return spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      RUVNET_CLAUDE_TASKS_DIR: tasksRoot,
    },
  });
}

function recyclerRegistration() {
  const registry = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
  const groups = registry.hooks.TeammateIdle || [];
  const hooks = groups.flatMap((group) => group.hooks || []);
  expect(hooks).toHaveLength(1);
  return { groups, hook: hooks[0], registry };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-recycler-home-'));
  tasksRoot = path.join(home, '.claude', 'tasks');
  fs.mkdirSync(tasksRoot, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('automatic swarm slot recycling', () => {
  it('refuses idle when the shared ledger has ready unassigned work', () => {
    task('team-a', 1, { subject: 'Implement parser' });

    const result = run();

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/claim.*task 1.*Implement parser/is);
    expect(result.stderr).toMatch(/TaskUpdate/is);
  });

  it('chooses the first ready task deterministically and ignores owned work', () => {
    task('team-a', 9, { subject: 'Already assigned', owner: 'worker-b' });
    task('team-a', 12, { subject: 'Second ready task' });
    task('team-a', 3, { subject: 'First ready task' });

    const result = run();

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/task 3.*First ready task/is);
    expect(result.stderr).not.toContain('Already assigned');
  });

  it('allows idle when remaining work is dependency-blocked', () => {
    task('team-a', 1, { status: 'in_progress', owner: 'worker-b' });
    task('team-a', 2, { subject: 'Integrate', blockedBy: ['1'] });

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('recycles as soon as a dependency is complete', () => {
    task('team-a', 1, { status: 'completed', owner: 'worker-b' });
    task('team-a', 2, { subject: 'Integrate', blockedBy: ['1'] });

    const result = run();

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/task 2.*Integrate/is);
  });

  it('allows idle when all work is complete', () => {
    task('team-a', 1, { status: 'completed', owner: 'worker-a' });
    expect(run().status).toBe(0);
  });

  it.each([
    ['', 'empty input'],
    ['not-json', 'malformed input'],
    [payload({ hook_event_name: 'Stop' }), 'wrong event'],
    [payload({ team_name: '../escape' }), 'path traversal'],
  ])('fails open with no bytes for %s (%s)', (input) => {
    const result = run(input);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('does not modify the host-owned task ledger', () => {
    task('team-a', 1, { subject: 'Immutable queue entry' });
    const file = path.join(tasksRoot, 'team-a', '1.json');
    const before = fs.readFileSync(file);
    const beforeStat = fs.statSync(file);

    expect(run().status).toBe(2);

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('does not hang when a host writes the envelope but keeps stdin open', async () => {
    task('team-a', 1, { subject: 'Ready despite held-open stdin' });
    const child = spawn(process.execPath, [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, RUVNET_CLAUDE_TASKS_DIR: tasksRoot },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write(payload());

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('recycler waited for EOF instead of its bounded idle deadline'));
      }, 1_000);
      child.once('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Ready despite held-open stdin/);
  });

  it('registers exactly one synchronous TeammateIdle hook through the stable spine', () => {
    const { groups, hook } = recyclerRegistration();
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBeUndefined();
    expect(hook).toEqual({
      type: 'command',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" swarm-slot-recycler',
      timeout: 5,
    });

    const shim = fs.readFileSync(SHIM, 'utf8');
    expect(shim).toMatch(/'swarm-slot-recycler':\s*\{[^}]*file:\s*'swarm-slot-recycler\.mjs'[^}]*mode:\s*'blocking'/s);
  });

  it('preserves the recycler refusal through its registered stable-spine command', () => {
    task('team-a', 1, { subject: 'Registered path task' });
    const { hook } = recyclerRegistration();
    const result = spawnSync(process.execPath, [SHIM, 'swarm-slot-recycler'], {
      cwd: REPO,
      input: payload(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin'),
        RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
        RUVNET_CLAUDE_TASKS_DIR: tasksRoot,
      },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Registered path task/);
  });

  it('adds TeammateIdle WITHOUT reaching into any other event', () => {
    // THIS WAS A FROZEN SHA256 of the whole file minus TeammateIdle, and it is the restated-truth
    // failure ADR-065 is about: a digest cannot tell "someone broke an adjacent group" from "someone
    // legitimately edited one". Its only signal in practice was a FALSE RED on ADR-067 — the commit
    // that improved the registry — which is how a guard trains people to override it.
    //
    // The durable property is scope: this feature owns exactly one event, and its body is registered
    // nowhere else. That fails on the mistake the digest was reaching for (a stray registration in
    // another event) and stays quiet for edits that are none of its business.
    const reg = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
    expect(Object.keys(reg), 'the event this feature owns').toContain('TeammateIdle');
    expect(reg.TeammateIdle.flatMap((g) => g.hooks.map((h) => h.command)))
      .toEqual([`node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" swarm-slot-recycler`]);
    const elsewhere = Object.entries(reg)
      .filter(([event]) => event !== 'TeammateIdle')
      .flatMap(([event, gs]) => gs.flatMap((g) => g.hooks.map((h) => ({ event, cmd: h.command }))))
      .filter((h) => h.cmd.includes('swarm-slot-recycler'));
    expect(elsewhere, 'swarm-slot-recycler must be registered on TeammateIdle and nowhere else').toEqual([]);
  });

  it('teaches deterministic initial saturation and the completion-to-next-task transition', () => {
    const playbook = fs.readFileSync(PLAYBOOK, 'utf8');
    expect(playbook).toMatch(/before the first spawn.*create the complete shared task (list|ledger)/is);
    expect(playbook).toMatch(/fill.*available.*slots.*without asking/is);
    expect(playbook).toMatch(/unassigned.*unblocked.*pending task/is);
    expect(playbook).toMatch(/one writer.*worktree/is);
    expect(playbook).toMatch(/Ruflo.*coordinat.*native host.*execut/is);
  });

  it('reports the host boundary honestly: Claude enforces recycling; Codex is guidance-only', () => {
    const playbook = fs.readFileSync(PLAYBOOK, 'utf8');
    const codex = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));

    expect(playbook).toMatch(/Claude Code.*TeammateIdle.*enforc/is);
    expect(playbook).toMatch(/Codex.*no.*TeammateIdle.*TaskCompleted.*hook.*guidance/is);
    expect(codex.hooks.TeammateIdle).toBeUndefined();
    expect(codex.hooks.TaskCompleted).toBeUndefined();
  });
});
