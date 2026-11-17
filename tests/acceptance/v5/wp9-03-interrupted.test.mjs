// WP9-03 migration interrupted at each step. The migration is killed (SIGKILL, no cleanup code runs) at
// every one of its steps. After each kill 4.7 is whole (every file of its home and job byte-identical,
// its host entries present), and version 5 is either not installed or answers. Running the same
// command again finishes the migration, and version 5 answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { make47, runCli, searchV5, world47 } from './wp9-helpers.mjs';

const Q = 'how does the quillfeather index descend its layers with marrowlight';
const KILL = {
  file: 'packages/migrate/migrate.mjs',
  find: 'function step(home, rec, name) {',
  replace: "function step(home, rec, name) {\n  process.stderr.write(`wp9-step ${name}\\n`);\n  globalThis.__wp9n = (globalThis.__wp9n ?? 0) + 1;\n  if (globalThis.__wp9n === Number(process.env.WP9_KILL_AT)) process.kill(process.pid, 'SIGKILL');",
};
const stepsOf = (r) => r.stderr.split('\n').filter((l) => l.startsWith('wp9-step ')).map((l) => l.slice(9));

function hosts47(s) {
  const settings = JSON.parse(fs.readFileSync(path.join(s.claude, 'settings.json'), 'utf8'));
  return settings.enabledPlugins?.['ruvnet-brain@ruvnet-brain'] === true && fs.readFileSync(s.codexToml, 'utf8').includes('[mcp_servers.ruvnet-brain]');
}

test('WP9-03 a kill at any step of migration leaves a working 4.7 or a working version 5', { timeout: 590_000 }, async (t) => {
  const ctx = setup(t, 'wp9-03');
  const tree = ctx.tree({ patches: [KILL] });
  const rel = tree.release(tree.build(THREE));
  const args = ['migrate', '--apply', '--from', rel, '--register-hosts'];
  const whole = make47(ctx);
  const r0 = runCli(tree, whole, args);
  assert.equal(r0.status, 0, r0.stderr);
  const steps = stepsOf(r0);
  assert.ok(steps.length >= 6, `steps: ${steps}`);

  for (let n = 1; n <= steps.length; n++) {
    const s = make47(ctx);
    const before = world47(s);
    const k = runCli(tree, s, args, { WP9_KILL_AT: String(n) });
    const at = `killed at step ${n} (${steps[n - 1]})`;
    assert.ok(k.signal === 'SIGKILL' || (process.platform === 'win32' && k.status !== 0), `${at}: the run must die by the kill (status ${k.status})`);
    assert.deepEqual(world47(s), before, `${at}: 4.7 must still be whole after a kill`);
    assert.ok(hosts47(s), `${at}: the 4.7 host entries must still be there`);
    if (fs.existsSync(path.join(s.home5, 'current.json'))) {
      const res = await searchV5(ctx, tree, s.home5, Q);
      assert.equal(res.files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', `${at}: an installed version 5 must answer`);
    }
    const again = runCli(tree, s, args);
    assert.equal(again.status, 0, `${at}: running it again must finish the migration: ${again.stdout}\n${again.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.home5, 'state', 'migration.json'), 'utf8')).step, 'done', `${at}: the record ends done`);
    assert.equal(JSON.parse(runCli(tree, s, ['config', 'show']).stdout).autoUpdate, false, `${at}: the "no" is carried`);
    const res = await searchV5(ctx, tree, s.home5, Q);
    assert.equal(res.files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', `${at}: version 5 answers after the rerun`);
    assert.deepEqual(world47(s), before, `${at}: 4.7 is unchanged after the rerun`);
  }
});
