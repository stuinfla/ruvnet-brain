// WP4 / review F11 (installer part): (1) a generation a live search server still reports using is not
// pruned under it: two updates while an idle session is open on release 1 keep release 1's app and
// pack, and the next update after that session ends removes them. (2) An automatic update applied by
// the running server refreshes the shim, as `ruvnet-brain update` does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, repo, setup, waitFor, writeConfig } from './helpers.mjs';
import { serveRelease } from './wp4-helpers.mjs';

const ptr = (home) => JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));

test('WP4-16 a live reader keeps its generation, and an automatic update refreshes the shim (review F11)', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp4-16');
  const tree = ctx.tree();
  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const rel2 = tree.release(pack2, { number: 2, version: '5.0.2' });
  const rel3 = tree.release(tree.build(THREE), { number: 3, version: '5.0.3' });
  const rel4 = tree.release(pack2, { number: 4, version: '5.0.4' });

  // (1) An idle session open on release 1 while two updates land.
  const { home } = ctx.installed(tree);
  const one = ptr(home);
  const srv = await ctx.server(tree, home);
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'state', 'status', `${srv.pid}.json`), 'utf8')).app === one.app;
    } catch {
      return false;
    }
  }, 20_000, 'the server to report release 1');
  assert.equal(tree.cli(home, ['update', '--from', rel2]).status, 0);
  const doc = tree.cli(home, ['doctor']);
  assert.equal(doc.status, 0, `an idle session on the kept previous generation is healthy right after an update: ${doc.stdout}`);
  assert.equal(tree.cli(home, ['update', '--from', rel3]).status, 0);
  assert.equal(ptr(home).releaseNumber, 3);
  assert.ok(fs.existsSync(path.join(home, 'app', one.app)) && fs.existsSync(path.join(home, 'packs', one.pack)), 'the generation a live session reads must not be pruned');
  await srv.close();
  assert.equal(tree.cli(home, ['update', '--from', rel4]).status, 0);
  assert.ok(!fs.existsSync(path.join(home, 'app', one.app)), 'once that session has ended the next update prunes it');

  // (2) The automatic update refreshes the shim.
  const auto = ctx.installed(tree).home;
  const shimVersion = () => JSON.parse(fs.readFileSync(path.join(auto, 'shim', 'plugin', 'claude', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal(shimVersion(), ptr(auto).app, 'the installed shim is stamped with the installed app');
  const web = await serveRelease(rel2);
  t.after(() => web.close());
  writeConfig(auto, { updateIntervalMs: 200, updateUrl: web.url });
  const s2 = await ctx.server(tree, auto);
  t.after(() => s2.close().catch(() => {}));
  const applied = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(auto, 'state', 'update-check.json'), 'utf8')).applied;
    } catch {
      return null;
    }
  }, 120_000, 'the automatic update');
  assert.equal(applied.ok, true, applied.message);
  assert.equal(shimVersion(), '5.0.2', `the automatic update must refresh the shim (${applied.message})`);
});
