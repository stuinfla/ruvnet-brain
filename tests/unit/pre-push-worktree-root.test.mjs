import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'git-hooks', 'pre-push');
const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pre-push gate worktree routing', () => {
  it('validates the repository being pushed even when the hook file lives in another checkout', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-repo-'));
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-foreign-'));
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-remote-'));
    temps.push(repo, foreign, remote);
    const foreignHook = path.join(foreign, 'scripts', 'git-hooks', 'pre-push');
    fs.mkdirSync(path.dirname(foreignHook), { recursive: true });
    fs.copyFileSync(HOOK, foreignHook);
    fs.chmodSync(foreignHook, 0o755);
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'scripts', 'verify-channels.mjs'),
      'process.stdout.write(`verified:${process.cwd()}`);',
    );
    fs.writeFileSync(path.join(repo, 'scripts', 'doc-currency.mjs'), 'process.exit(0);');
    fs.writeFileSync(path.join(repo, 'scripts', 'sync-census.mjs'),
      'process.stdout.write(`census:${process.cwd()}`); process.exit(Number(process.env.CENSUS_EXIT || 0));');
    fs.writeFileSync(path.join(repo, 'scripts', 'sync-commands.mjs'),
      'process.stdout.write(`commands:${process.cwd()}`); process.exit(Number(process.env.COMMANDS_EXIT || 0));');

    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'fixture\n');
    expect(spawnSync('git', ['add', 'tracked.txt'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'test(git): create pre-push fixture',
    ], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['init', '--bare', '-q'], { cwd: remote }).status).toBe(0);
    expect(spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'core.hooksPath', path.dirname(foreignHook)], { cwd: repo }).status).toBe(0);

    // Drive the hook through Git itself. Manually guessing `sh` is not the user path and failed on
    // Windows runners where Git for Windows can execute hooks but does not expose `sh.exe` on PATH.
    const result = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], {
      cwd: repo,
      encoding: 'utf8',
    });

    expect(result.status, result.error?.message || result.stderr).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(`verified:${fs.realpathSync(repo)}`);
    expect(output).toContain(`census:${fs.realpathSync(repo)}`);
    expect(output).toContain(`commands:${fs.realpathSync(repo)}`);

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'second fixture\n');
    expect(spawnSync('git', ['add', 'tracked.txt'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'test(git): exercise generated-surface failures',
    ], { cwd: repo }).status).toBe(0);

    const censusFailure = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CENSUS_EXIT: '1' },
    });
    expect(censusFailure.status).not.toBe(0);
    expect(`${censusFailure.stdout}${censusFailure.stderr}`).toMatch(/public census claims have drifted/i);

    const commandsFailure = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, COMMANDS_EXIT: '1' },
    });
    expect(commandsFailure.status).not.toBe(0);
    expect(`${commandsFailure.stdout}${commandsFailure.stderr}`).toMatch(/command aliases no longer share one body/i);
  });
});
