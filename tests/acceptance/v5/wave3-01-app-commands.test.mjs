// Wave 3 (a): the two commands added in wave 3 (`guard`, and `migrate` with `rollback-to-4`) run from
// an INSTALLED app, not only from the repository: the release seals the guard and migrate packages
// into the app, and the reviewed shipped-file list names them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

test('Wave 3 an installed app runs guard, migrate and rollback-to-4', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave3-01');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const app = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8')).app;
  const cli = path.join(home, 'app', app, 'cli', 'ruvnet-brain.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000, cwd: ctx.tmp('rb5-w3-cwd-'), env: { ...process.env, NODE_NO_WARNINGS: '1', RUVNET_BRAIN5_HOME: home } });

  const g = run('guard', 'status');
  assert.equal(g.status, 0, `the installed app runs guard: ${g.stdout}${g.stderr}`);
  assert.equal(g.stdout.trim(), 'guard off', 'the installed guard is off by default');
  const m = run('migrate', '--help');
  assert.equal(m.status, 0, `the installed app runs migrate: ${m.stdout}${m.stderr}`);
  assert.match(m.stdout, /ruvnet-brain rollback-to-4/);
  const b = run('rollback-to-4', '--help');
  assert.equal(b.status, 0, `the installed app runs rollback-to-4: ${b.stdout}${b.stderr}`);

  const shipped = JSON.parse(fs.readFileSync(path.join(tree.root, 'packages', 'release', 'shipped-files.json'), 'utf8')).app;
  for (const p of ['guard/guard.mjs', 'guard/command.mjs', 'migrate/migrate.mjs', 'migrate/layout47.json', 'plugin/claude/guard-hook.mjs']) {
    assert.ok(shipped.includes(p), `the reviewed shipped-file list names ${p}`);
    assert.ok(fs.existsSync(path.join(home, 'app', app, ...p.split('/'))), `the installed app holds ${p}`);
  }
});
