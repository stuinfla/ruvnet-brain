// WP4 large file: a pack file larger than 2 GiB (a sparse file, so the test needs little real disk
// to create it) installs, and the installed copy has the signed size and hash. Node cannot read a
// file that large into one buffer, so this fails if any step reads a file whole.
// Break: the folder source reads each file whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch } from './wp4-helpers.mjs';
import { THREE, setup } from './helpers.mjs';

const BIG = 2 ** 31 + 4096;

test('WP4-03 a file larger than 2 GiB installs', { timeout: 590_000 }, async (t) => {
  const ctx = setup(t, 'wp4-03');
  const tree = ctx.tree();
  const pack = tree.build(THREE);
  const big = path.join(pack, 'big.bin');
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, Buffer.from('start'), 0, 5, 0);
  fs.writeSync(fd, Buffer.from('end'), 0, 3, BIG - 3);
  fs.closeSync(fd);
  assert.equal(fs.statSync(big).size, BIG);
  assert.ok(BIG > 2 ** 31 - 1, 'larger than the biggest buffer a whole-file read can return');
  const rel = tree.release(pack, { number: 1 });
  const entry = JSON.parse(fs.readFileSync(path.join(rel, 'release.json'), 'utf8')).pack.files.find((f) => f.path === 'big.bin');
  assert.equal(entry.size, BIG);
  // The release folder's copy is not needed after signing; remove the pack folder's copy to save disk.
  fs.rmSync(big);

  const home = ctx.tmp('rb5-home-');
  assertScratch(home);
  const r = tree.cli(home, ['install', '--from', rel]);
  assert.equal(r.status, 0, `the >2 GiB release must install: ${r.stdout}\n${r.stderr}`);
  const pointer = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
  const installed = path.join(home, 'packs', pointer.pack, 'big.bin');
  assert.equal(fs.statSync(installed).size, BIG, 'the installed copy has the signed size');
  const tail = Buffer.alloc(3);
  const ifd = fs.openSync(installed, 'r');
  fs.readSync(ifd, tail, 0, 3, BIG - 3);
  fs.closeSync(ifd);
  assert.equal(tail.toString(), 'end', 'the last bytes arrived');
  t.diagnostic(`installed a ${BIG}-byte file`);
});
