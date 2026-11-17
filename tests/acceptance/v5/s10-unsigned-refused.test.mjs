// S10 unsigned refused: a release with one byte changed, or a manifest signed with another key, is not
// installed. Case (c) changes an app file AND rewrites its hash in release.json, so only the
// signature can catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, newKeys, setup } from './helpers.mjs';

test('S10 a changed or wrongly signed release is not installed', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's10');
  const tree = ctx.tree();
  const pack = tree.build(THREE);
  const good = tree.release(pack, { number: 1 });
  const copy = (from) => {
    const to = path.join(ctx.tmp('rb5-rel-'), 'release');
    fs.cpSync(from, to, { recursive: true });
    return to;
  };
  const refuse = (rel, label, why) => {
    const home = ctx.tmp('rb5-home-');
    const r = tree.cli(home, ['install', '--from', rel]);
    assert.notEqual(r.status, 0, `${label} must not install: ${r.stdout}`);
    assert.match(r.stderr, why, `${label}: ${r.stderr}`);
    assert.equal(fs.existsSync(path.join(home, 'current.json')), false, `${label} must leave no pointer`);
  };

  const flipped = copy(good);
  const db = path.join(flipped, 'pack', 'lexical.db');
  const bytes = fs.readFileSync(db);
  bytes[bytes.length - 10] ^= 0xff;
  fs.writeFileSync(db, bytes);
  refuse(flipped, 'a pack with one byte changed', /pack file lexical\.db does not match the signed release/);

  const otherKey = tree.release(pack, { number: 1, keyPem: newKeys().privatePem });
  refuse(otherKey, 'a release signed with another key', /not signed by the RuvNet Brain release key/);

  const rewritten = copy(good);
  const file = path.join(rewritten, 'app', 'engine', 'index.mjs');
  fs.appendFileSync(file, '\n// one more line\n');
  const rel = JSON.parse(fs.readFileSync(path.join(rewritten, 'release.json'), 'utf8'));
  const entry = rel.app.files.find((f) => f.path === 'engine/index.mjs');
  entry.size = fs.statSync(file).size;
  entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(rewritten, 'release.json'), JSON.stringify(rel));
  refuse(rewritten, 'a changed app file with its hash rewritten under the old signature', /not signed by the RuvNet Brain release key/);

  const home = ctx.tmp('rb5-home-');
  const ok = tree.cli(home, ['install', '--from', good]);
  assert.equal(ok.status, 0, `the untouched release installs: ${ok.stderr}`);
});
