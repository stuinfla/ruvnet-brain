// S9 rollback: an update that passes before the switch (its engine answers the probes in process) and
// fails after it (its server's worker is broken, test-only patch) puts the pointer back by itself,
// and the health line reports it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPointerRaw, readStatus, setup, waitFor } from './helpers.mjs';

const BROKEN_WORKER = {
  file: 'packages/server/worker.mjs',
  find: "parentPort.on('message', (m) => {",
  replace: "parentPort.on('message', (m) => {\n  if (m) { parentPort.postMessage({ id: m.id, ok: false, error: 'this app build is broken (test fixture)' }); return; }",
};

test('S9 an update that fails after the switch is rolled back', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's09');
  const tree = ctx.tree();
  const { home, pack } = ctx.installed(tree);
  const before = readPointerRaw(home);

  const broken = ctx.tree({ patches: [BROKEN_WORKER], keys: tree.keys });
  const rel2 = broken.release(pack, { number: 2, version: '5.0.0-skeleton.2' });
  const u = tree.cli(home, ['update', '--from', rel2]);
  assert.notEqual(u.status, 0, `an update that fails after the switch must exit non-zero: ${u.stdout}`);
  assert.match(u.stderr, /after the switch .* the previous version was put back/);
  assert.equal(readPointerRaw(home), before, 'the pointer must be back to the previous version, byte for byte');
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'state', 'update.json'), 'utf8'));
  assert.equal(rec.rolledBack, true);
  assert.equal(fs.existsSync(path.join(home, 'app', '5.0.0-skeleton.2')), false, 'the failed app is removed');

  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 20_000, 'the restored version to pass its self-test');
  const line = tree.hook(home).line;
  assert.match(line, /^\[RuvNet Brain DEGRADED since .* · update to 5\.0\.0-skeleton\.2 failed its check after the switch and was rolled back/, line);
  const r = await srv.search('gloamwick journal');
  assert.equal(r.mode, 'MODE · normal', `the restored version answers normally: ${r.mode}`);
});
