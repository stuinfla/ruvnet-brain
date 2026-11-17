// Integration-owner fix in the contract (docs/REVIEW-FIXES.md, Codex review F24): a release whose
// signature names a key id other than the trusted key's is not installed, even though the signature
// value itself verifies (the key id sits outside the signed body).
// Break: breaks-integration.mjs (integ-contract-keyid).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';

test('F24 a signature naming another key id is refused', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'integ-contract');
  const tree = ctx.tree();
  const good = tree.release(tree.build(THREE), { number: 1 });
  const bad = path.join(ctx.tmp('rb5-rel-'), 'release');
  fs.cpSync(good, bad, { recursive: true });
  const rel = JSON.parse(fs.readFileSync(path.join(bad, 'release.json'), 'utf8'));
  rel.signature.keyId = '0123456789abcdef';
  fs.writeFileSync(path.join(bad, 'release.json'), JSON.stringify(rel));
  const home = ctx.tmp('rb5-home-');
  const r = tree.cli(home, ['install', '--from', bad]);
  assert.notEqual(r.status, 0, `a release with a foreign key id must not install: ${r.stdout}`);
  assert.match(r.stderr, /not signed by the RuvNet Brain release key/, r.stderr);
  assert.equal(fs.existsSync(path.join(home, 'current.json')), false, 'no pointer is written');
  const ok = tree.cli(ctx.tmp('rb5-home-'), ['install', '--from', good]);
  assert.equal(ok.status, 0, `the untouched release installs: ${ok.stderr}`);
});
