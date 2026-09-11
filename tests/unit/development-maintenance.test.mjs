import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'scripts/development-maintenance.mjs');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import('../../bin/install.mjs');
let temp, project, foreign;
function run(file, args = [], cwd = project, env = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd, env: { ...process.env, ...env }, input: '{}', encoding: 'utf8', timeout: 5000,
  });
}
function control(action, cwd = project) { return run(cli, [action, '--project', cwd]); }
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-maintenance-'));
  project = path.join(temp, 'project'); foreign = path.join(temp, 'foreign');
  for (const dir of [project, foreign]) {
    fs.mkdirSync(dir); spawnSync('git', ['init', '--quiet', dir]);
  }
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('reversible development maintenance', () => {
  it('suspends all linked worktrees, leaves another repository active, and resumes without settings edits', () => {
    const settings = path.join(project, 'settings.json');
    fs.writeFileSync(settings, '{"hooks":{"Stop":[]}}');
    const worktree = path.join(temp, 'linked'); fs.mkdirSync(worktree);
    const gitdir = path.join(project, '.git/worktrees/linked'); fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    expect(control('suspend').status).toBe(0);
    expect(JSON.parse(control('status', worktree).stdout).suspended).toBe(true);
    expect(JSON.parse(control('status', foreign).stdout).suspended).toBe(false);
    expect(control('resume', worktree).status).toBe(0);
    expect(JSON.parse(control('status').stdout).suspended).toBe(false);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"hooks":{"Stop":[]}}');
    const receipts = fs.readdirSync(path.join(project, '.git/ruvnet-brain-maintenance-receipts'));
    expect(receipts).toHaveLength(2);
  });

  it('stops real shim hooks including protection and continuation before any hook body executes', () => {
    const plugin = path.join(temp, 'plugin'); fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    const body = "process.stdout.write('BODY EXECUTED'); process.exit(2);";
    for (const name of ['decision-gate.mjs', 'continuation-gate.mjs', 'session-start-core.mjs', 'learn-flush.mjs']) {
      fs.writeFileSync(path.join(plugin, 'scripts', name), body);
    }
    const env = { CLAUDE_PLUGIN_ROOT: plugin, RUVNET_BRAIN_HOME: path.join(temp, 'spine'), RUVNET_BRAIN_STATE_DIR: path.join(temp, 'state') };
    expect(control('suspend').status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin/hooks/hooks.json'), 'utf8'));
    const ids = [...new Set(Object.values(manifest.hooks).flatMap(groups => groups.flatMap(group =>
      group.hooks.map(hook => /hook-shim\.mjs"\s+([\w-]+)/.exec(hook.command)?.[1]).filter(Boolean))))];
    // Derived from the policy module, not a literal: `['session-start','continuation-gate']` was the
    // Sep-7 two-handler plane and kept this file red once the continuity plane grew.
    expect(new Set(ids)).toEqual(new Set(continuityRegistrations('claude').map((r) => r.id)));
    for (const id of ids) {
      const result = run(path.join(root, 'plugin/scripts/hook-shim.mjs'), [id], project, env);
      expect([result.status, result.stdout, result.stderr]).toEqual([0, '', '']);
    }
    expect(run(path.join(root, 'plugin/scripts/hook-shim.mjs'), ['decision-gate'], foreign, env).stdout).toBe('BODY EXECUTED');
    expect(control('resume').status).toBe(0);
    expect(run(path.join(root, 'plugin/scripts/hook-shim.mjs'), ['decision-gate'], project, env).status).toBe(2);
  });

  it('stops Codex before adapter spawn, including detached learning work', () => {
    const spine = path.join(temp, 'spine'), plugin = path.join(spine, 'versions/1/plugin');
    fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(spine, 'active.json'), JSON.stringify({ codeRoot: plugin }));
    fs.writeFileSync(path.join(plugin, 'scripts/codex-hook-adapter.mjs'), "process.stdout.write('ADAPTER EXECUTED'); process.exit(2);");
    expect(control('suspend').status).toBe(0);
    const wrapper = path.join(root, 'plugin/scripts/codex-hook-wrapper.mjs');
    for (const id of ['decision-gate', 'learn-flush']) {
      const result = run(wrapper, [id], project, { RUVNET_BRAIN_HOME: spine });
      expect([result.status, result.stdout, result.stderr]).toEqual([0, '', '']);
    }
    expect(control('resume').status).toBe(0);
    expect(run(wrapper, ['decision-gate'], project, { RUVNET_BRAIN_HOME: spine }).status).toBe(2);
  });

  it('refuses missing projects and symlink state without writing outside repository metadata', () => {
    expect(control('suspend', temp).status).not.toBe(0);
    const outside = path.join(temp, 'outside'); fs.writeFileSync(outside, 'preserve');
    fs.symlinkSync(outside, path.join(project, '.git/ruvnet-brain-maintenance.json'));
    expect(control('suspend').status).not.toBe(0);
    expect(fs.readFileSync(outside, 'utf8')).toBe('preserve');
  });

  it.skipIf(process.platform === 'win32')('refuses state writable by other users', () => {
    expect(control('suspend').status).toBe(0);
    fs.chmodSync(path.join(project, '.git/ruvnet-brain-maintenance.json'), 0o666);
    expect(control('status').status).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('pre-push scans the exact unpublished commit range for secrets', () => {
    fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(project, 'plugin/scripts'), { recursive: true });
    fs.copyFileSync(cli, path.join(project, 'scripts/development-maintenance.mjs'));
    fs.copyFileSync(path.join(root, 'scripts/development-push-check.mjs'), path.join(project, 'scripts/development-push-check.mjs'));
    for (const dependency of serverDependencies(cli)) {
      const target = path.resolve(project, 'scripts', dependency.spec);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(dependency.from, target);
    }
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: project });
    const hook = () => spawnSync('sh', [path.join(root, 'scripts/git-hooks/pre-push')], { cwd: project, input: '', encoding: 'utf8', timeout: 5000 });
    expect(hook().status).toBe(0);
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout.trim();
    // Construct a deliberately synthetic match; never use a credential in a fixture.
    fs.writeFileSync(path.join(project, 'synthetic-secret.txt'), 'sk-' + 'proj-' + 'A'.repeat(30));
    spawnSync('git', ['add', 'synthetic-secret.txt'], { cwd: project });
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture secret'], { cwd: project });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout.trim();
    const result = spawnSync('sh', [path.join(root, 'scripts/git-hooks/pre-push')], {
      cwd: project, input: `refs/heads/main ${head} refs/heads/main ${base}\n`, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('credential-shaped');
  });
});
