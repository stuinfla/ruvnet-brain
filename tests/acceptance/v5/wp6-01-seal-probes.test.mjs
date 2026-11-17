// WP6: a release whose pack fails its probes is not signed. The rail's seal runs the pack's own
// probes through the engine before signing; a pack with its keyword index emptied (then reassembled,
// so its hashes are consistent) is refused and nothing is written. A good pack is sealed and verifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { THREE, setup } from './helpers.mjs';
import { rail, sealed } from './wp6-helpers.mjs';

test('WP6 a pack that fails its probes is not signed', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-01');
  const tree = ctx.tree();

  const good = sealed(ctx, tree);
  assert.equal(good.r.status, 0, `a good pack must be sealed: ${good.r.out}`);
  assert.match(good.r.stdout, /probes passed/);
  const v = rail(tree, ['verify', '--release', good.rel]);
  assert.equal(v.status, 0, `the sealed release verifies: ${v.out}`);

  const pack = tree.build(THREE);
  const db = new DatabaseSync(path.join(pack, 'lexical.db'));
  db.exec('DELETE FROM fts');
  db.close();
  tree.reassemble(pack);
  const bad = sealed(ctx, tree, { pack });
  assert.notEqual(bad.r.status, 0, `a pack that fails its probes must not be signed: ${bad.r.out}`);
  assert.match(bad.r.stderr, /failed its probes .*it is not signed/, bad.r.stderr);
  assert.equal(fs.existsSync(bad.rel), false, 'a refused seal must write nothing');
});
