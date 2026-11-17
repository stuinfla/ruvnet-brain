// WP4 disk-space check: a correctly signed release that needs more disk than is free (it declares one
// file 1 TiB larger than the free space) is refused before anything is written, and the message names
// the shortfall in bytes. Checked for a first install (the brain home is not even created) and for an
// update (the home is unchanged, byte for byte). Break: the disk check is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertScratch, snapshot } from './wp4-helpers.mjs';
import { THREE, setup } from './helpers.mjs';

const TIB = 2 ** 40;

test('WP4-04 too little free disk: nothing is written and the shortfall is named', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-04');
  const tree = ctx.tree();
  const { sign } = await import(pathToFileURL(path.join(tree.root, 'packages', 'contract', 'signature.mjs')).href);
  const pack = tree.build(THREE);
  const good = tree.release(pack, { number: 1 });
  const free = Number(fs.statfsSync(ctx.tmp()).bavail) * Number(fs.statfsSync(ctx.tmp()).bsize);
  const huge = path.join(ctx.tmp('rb5-rel-'), 'release');
  fs.cpSync(good, huge, { recursive: true });
  const { signature, ...body } = JSON.parse(fs.readFileSync(path.join(huge, 'release.json'), 'utf8'));
  body.releaseNumber = 2;
  body.pack.files.push({ path: 'huge.bin', size: free + TIB, sha256: '0'.repeat(64) });
  fs.writeFileSync(path.join(huge, 'release.json'), JSON.stringify(sign(body, tree.keys.privatePem)));

  const fresh = path.join(ctx.tmp('rb5-parent-'), 'brain');
  assertScratch(fresh);
  const r = tree.cli(fresh, ['install', '--from', huge]);
  assert.notEqual(r.status, 0, `a release bigger than the disk must be refused: ${r.stdout}`);
  const m = /not enough free disk: .* short by (\d+) bytes/.exec(r.stderr);
  assert.ok(m, `the refusal must name the shortfall: ${r.stderr}`);
  assert.ok(Number(m[1]) >= TIB && Number(m[1]) <= TIB + 2 ** 30, `the shortfall ${m[1]} must be about 1 TiB (the excess plus headroom)`);
  assert.equal(fs.existsSync(fresh), false, 'nothing may be written: the brain home must not exist');

  const home = ctx.tmp('rb5-home-');
  assert.equal(tree.cli(home, ['install', '--from', good]).status, 0);
  const before = snapshot(home);
  const u = tree.cli(home, ['update', '--from', huge]);
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /not enough free disk: .* short by \d+ bytes/);
  assert.deepEqual(snapshot(home), before, 'nothing may be written: an update refused for disk space leaves the home byte for byte');
  t.diagnostic(`free ${free} bytes; shortfall reported ${m[1]}`);
});
