// WP6: what ships is exactly a reviewed list. The app sealed into a release must equal
// packages/release/shipped-files.json path for path; a file planted in a shipped package is refused
// before anything is signed (4.7.28 shipped 377 maintainer scripts to customers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { rail, sealed } from './wp6-helpers.mjs';

test('WP6 the release ships exactly the reviewed file list', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-09');
  const tree = ctx.tree();
  const check = rail(tree, ['shipped-files', '--check']);
  assert.equal(check.status, 0, `the app matches the reviewed list: ${check.out}`);
  const ok = sealed(ctx, tree);
  assert.equal(ok.r.status, 0, ok.r.out);
  const rel = JSON.parse(fs.readFileSync(path.join(ok.rel, 'release.json'), 'utf8'));
  const listed = JSON.parse(fs.readFileSync(path.join(tree.root, 'packages', 'release', 'shipped-files.json'), 'utf8')).app;
  assert.deepEqual(rel.app.files.map((f) => f.path).sort(), listed, 'the signed app is exactly the reviewed list');

  fs.writeFileSync(path.join(tree.root, 'packages', 'engine', 'stray-maintainer-script.mjs'), "console.log('not for customers');\n");
  const bad = sealed(ctx, tree);
  assert.notEqual(bad.r.status, 0, `a file outside the reviewed list must be refused: ${bad.r.out}`);
  assert.match(bad.r.stderr, /engine\/stray-maintainer-script\.mjs would ship but is not on the reviewed list/);
  assert.equal(fs.existsSync(bad.rel), false, 'nothing may be signed');
});
