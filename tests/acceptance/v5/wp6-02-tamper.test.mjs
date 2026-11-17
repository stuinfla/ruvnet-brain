// WP6: a byte changed after signing is refused: by the rail's own check (verify, stage, and promote,
// which re-hashes the staged bytes), and by the real installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { REQUIRED_OS, appVersion, gateFor, rail, sealed, sha256File, writeJson } from './wp6-helpers.mjs';

const flip = (file) => {
  const b = fs.readFileSync(file);
  b[b.length - 10] ^= 0xff;
  fs.writeFileSync(file, b);
};

test('WP6 a byte changed after signing is refused by the rail and the installer', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-02');
  const tree = ctx.tree();
  const { rel, r } = sealed(ctx, tree);
  assert.equal(r.status, 0, r.out);

  const copy = path.join(ctx.tmp('rb5-wp6-copy-'), 'release');
  fs.cpSync(rel, copy, { recursive: true });
  flip(path.join(copy, 'pack', 'lexical.db'));
  const v = rail(tree, ['verify', '--release', copy]);
  assert.notEqual(v.status, 0, `rail verify must refuse a changed byte: ${v.out}`);
  assert.match(v.stderr, /pack file lexical\.db does not match the signed release/);
  const s = rail(tree, ['stage', '--release', copy, '--channel', ctx.tmp('rb5-wp6-ch-')]);
  assert.notEqual(s.status, 0, `stage must refuse a changed byte: ${s.out}`);

  const home = ctx.tmp('rb5-home-');
  const inst = tree.cli(home, ['install', '--from', copy]);
  assert.notEqual(inst.status, 0, `the installer must refuse a changed byte: ${inst.stdout}`);
  assert.match(inst.stderr, /does not match the signed release/);
  assert.equal(fs.existsSync(path.join(home, 'current.json')), false);

  // Staged intact, then changed in the channel: promote re-hashes the staged bytes and refuses.
  const channel = ctx.tmp('rb5-wp6-ch-');
  const st = rail(tree, ['stage', '--release', rel, '--channel', channel]);
  assert.equal(st.status, 0, st.out);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  const staged = path.join(channel, 'staged', tag);
  const sha = sha256File(path.join(staged, 'release.json'));
  const receipts = ctx.tmp('rb5-wp6-rc-');
  for (const os of REQUIRED_OS) writeJson(path.join(receipts, `${os}.json`), { os, release: sha, ok: true });
  const gate = path.join(ctx.tmp('rb5-wp6-gate-'), 'gate.json');
  writeJson(gate, gateFor(staged));
  flip(path.join(staged, 'app', 'engine', 'index.mjs'));
  const p = rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', appVersion(tree), '--receipts', receipts, '--gate', gate]);
  assert.notEqual(p.status, 0, `promote must refuse staged bytes changed after signing: ${p.out}`);
  assert.match(p.stderr, /app file engine\/index\.mjs does not match the signed release/);
  assert.equal(fs.existsSync(path.join(channel, 'latest.json')), false, 'nothing may be promoted');
});
