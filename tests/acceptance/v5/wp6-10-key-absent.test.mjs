// WP6: the trusted public key is provisioned by the lead (ROADMAP A1 step 0.4) at
// packages/contract/keys/release-public.pem and is not in the repository yet. Without it the rail
// seals nothing and the installer installs nothing, and no environment variable stands in for it.
// A signing key that is not the trusted key's pair is refused before signing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, newKeys, setup } from './helpers.mjs';
import { rail, sealed } from './wp6-helpers.mjs';

test('WP6 without the trusted key nothing is sealed or installed; another key is refused', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-10');
  const tree = ctx.tree();
  const pack = tree.build(THREE);

  const other = path.join(ctx.tmp('rb5-wp6-rel-'), 'release');
  const wrong = rail(tree, ['seal', '--pack', pack, '--out', other, '--version', JSON.parse(fs.readFileSync(path.join(tree.root, 'packages', 'version.json'), 'utf8')).app, '--release-number', '1'], { key: newKeys().privatePem });
  assert.notEqual(wrong.status, 0, wrong.out);
  assert.match(wrong.stderr, /is not the trusted release key/);
  assert.equal(fs.existsSync(other), false);
  const none = sealed(ctx, tree, { pack, extra: [] });
  assert.equal(none.r.status, 0, none.r.out);

  const signed = tree.release(pack, { number: 2 });
  fs.rmSync(path.join(tree.root, 'packages', 'contract', 'keys', 'release-public.pem'));
  // An override in the environment must change nothing (4.7's verify script accepted one, L5).
  const env = { RUVNET_BRAIN5_PUBLIC_KEY: tree.keys.publicPem, RUVNET_BRAIN_PUBLIC_KEY: tree.keys.publicPem };

  const s = sealed(ctx, tree, { pack, number: 3 });
  assert.notEqual(s.r.status, 0, `seal must refuse without the trusted key: ${s.r.out}`);
  assert.match(s.r.stderr, /carries no trusted release key/);
  const v = rail(tree, ['verify', '--release', signed], { env });
  assert.notEqual(v.status, 0, `verify must refuse without the trusted key: ${v.out}`);
  assert.match(v.stderr, /carries no trusted release key/);

  const home = ctx.tmp('rb5-home-');
  const inst = tree.cli(home, ['install', '--from', signed], { env });
  assert.notEqual(inst.status, 0, `install must refuse without the trusted key: ${inst.stdout}`);
  assert.match(`${inst.stdout}${inst.stderr}`, /no trusted release key/);
  assert.equal(fs.existsSync(path.join(home, 'current.json')), false);
});
