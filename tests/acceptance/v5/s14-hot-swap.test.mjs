// S14 hot swap: while the server runs, a new pack is installed; the next search on the SAME server
// process answers from it without a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, repo, setup } from './helpers.mjs';

const Q = 'zephyrlattice mincut walker';

test('S14 a new pack is picked up without a restart', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's14');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const srv = await ctx.server(tree, home);
  const r1 = await srv.search(Q);
  assert.match(r1.text, /FILES \(0\) · no match/, 'generation 1 has no delta-graph');

  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const gen2 = JSON.parse(fs.readFileSync(path.join(pack2, 'PACK.json'), 'utf8')).generation;
  const u = tree.cli(home, ['update', '--from', tree.release(pack2, { number: 2 })]);
  assert.equal(u.status, 0, u.stdout + u.stderr);

  const r2 = await srv.search(Q);
  assert.equal(srv.child.exitCode, null, 'same server process');
  assert.equal(r2.mode, 'MODE · normal', r2.mode);
  assert.ok(r2.header.includes(`pack ${gen2}`) && r2.files[0]?.file === 'delta-graph/src/mincut_walker.rs', `the next search must answer from the new pack ${gen2}: ${r2.header} ${JSON.stringify(r2.files.map((f) => f.file))}`);
});
