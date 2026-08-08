import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'ground-ruvnet.sh');
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function git(cwd, args) {
  // Disposable repositories must not inherit the operator's user-level hooks. Those hooks test
  // real commits, while this fixture is only constructing topology for ground-ruvnet.
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe.skipIf(!hasGit || !hasBash || process.platform === 'win32')(
  'ground-ruvnet shared AgentDB detection in linked git worktrees',
  () => {
    it('does not claim memory is off when the primary worktree owns the canonical store', () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-worktree-memory-'));
      const primary = path.join(temp, 'primary');
      const linked = path.join(temp, 'linked');
      const home = path.join(temp, 'home');
      fs.mkdirSync(primary, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      git(primary, ['init']);
      git(primary, ['config', 'user.email', 'test@example.com']);
      git(primary, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(primary, 'package.json'), '{"name":"ruflo-worktree-fixture"}\n');
      git(primary, ['add', 'package.json']);
      git(primary, ['commit', '-m', 'fixture']);
      git(primary, ['worktree', 'add', linked, '-b', 'linked-fixture']);
      fs.mkdirSync(path.join(primary, '.swarm'), { recursive: true });
      fs.writeFileSync(path.join(primary, '.swarm', 'memory.db'), 'canonical AgentDB fixture');

      const result = spawnSync('bash', [HOOK], {
        cwd: linked,
        input: JSON.stringify({ prompt: 'hello' }),
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: path.join(home, '.cache'),
          RUVNET_BRAIN_METER: '0',
          RUVNET_FLYWHEEL_DATE: '2026-07-28',
          CLAUDE_PROJECT_DIR: linked,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('persistent project memory is NOT set up');
      expect(result.stdout).not.toContain("doesn't have persistent memory turned on");
    });
  },
);
