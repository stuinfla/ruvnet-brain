// WP4 footprint: install, then two updates, leaves exactly two generations on disk (the active one and
// one earlier), both complete, and the pointer names the earlier one as `previous`. Reinstalling the
// active release does not throw away the earlier generation. Break: older generations are not pruned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, pointerOf } from './wp4-helpers.mjs';
import { THREE, repo, setup } from './helpers.mjs';

const gen = (pack) => JSON.parse(fs.readFileSync(path.join(pack, 'PACK.json'), 'utf8')).generation;

test('WP4-07 install then two updates keeps exactly one earlier generation', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-07');
  const tree = ctx.tree();
  const packs = [tree.build(THREE), tree.build([...THREE, repo('delta-graph')]), tree.build(THREE.slice(0, 2))];
  const gens = packs.map(gen);
  assert.equal(new Set(gens).size, 3, 'three different generations');
  const rels = packs.map((p, i) => tree.release(p, { number: i + 1, version: `5.0.${i + 1}` }));
  const home = ctx.tmp('rb5-home-');
  assertScratch(home);
  for (const [i, rel] of rels.entries()) {
    const r = tree.cli(home, [i ? 'update' : 'install', '--from', rel]);
    assert.equal(r.status, 0, r.stderr);
  }
  const list = (d) => fs.readdirSync(path.join(home, d)).sort();
  assert.deepEqual(list('app'), ['5.0.2', '5.0.3'], 'app folders: the active version and exactly one earlier');
  assert.deepEqual(list('packs'), [gens[1], gens[2]].sort(), 'pack folders: the active generation and exactly one earlier');
  assert.deepEqual(pointerOf(home), { app: '5.0.3', pack: gens[2], releaseNumber: 3, previous: { app: '5.0.2', pack: gens[1], releaseNumber: 2 } });

  const again = tree.cli(home, ['install', '--from', rels[2]]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(pointerOf(home).previous, { app: '5.0.2', pack: gens[1], releaseNumber: 2 }, 'reinstalling the active release keeps the real earlier generation');
  assert.deepEqual(list('packs'), [gens[1], gens[2]].sort());
});
