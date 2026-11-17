// WP6: a version that does not match the single version source (packages/version.json) is refused:
// at seal (requested version, release branch name, the shim's second copy of the number) and at
// promote. A matching version seals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { REQUIRED_OS, appVersion, gateFor, rail, sealed, sha256File, writeJson } from './wp6-helpers.mjs';

test('WP6 a version that does not match the version source is refused', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-05');
  const tree = ctx.tree();
  const version = appVersion(tree);
  const pack = tree.build(THREE);
  const refused = (res, why, label) => {
    assert.notEqual(res.r.status, 0, `${label} must be refused: ${res.r.out}`);
    assert.match(res.r.stderr, why, `${label}: ${res.r.stderr}`);
    assert.equal(fs.existsSync(res.rel), false, `${label}: nothing may be signed`);
  };

  refused(sealed(ctx, tree, { pack, version: '9.9.9' }), /the requested version 9\.9\.9 does not match the version source/, 'a version that does not match the version source');
  refused(sealed(ctx, tree, { pack, extra: ['--branch', 'release/9.9.9'] }), /branch release\/9\.9\.9 does not name version/, 'a release branch that names another version');

  const ok = sealed(ctx, tree, { pack, extra: ['--branch', `release/${version}`] });
  assert.equal(ok.r.status, 0, `the matching version on its release branch seals: ${ok.r.out}`);
  const rel = JSON.parse(fs.readFileSync(path.join(ok.rel, 'release.json'), 'utf8'));
  assert.equal(rel.app.version, version);

  // Promote refuses a version other than the source's, even for correctly sealed bytes.
  const channel = ctx.tmp('rb5-wp6-ch-');
  const st = rail(tree, ['stage', '--release', ok.rel, '--channel', channel]);
  assert.equal(st.status, 0, st.out);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  const staged = path.join(channel, 'staged', tag);
  const receipts = ctx.tmp('rb5-wp6-rc-');
  for (const os of REQUIRED_OS) writeJson(path.join(receipts, `${os}.json`), { os, release: sha256File(path.join(staged, 'release.json')), ok: true });
  const gate = path.join(ctx.tmp('rb5-wp6-gate-'), 'gate.json');
  writeJson(gate, gateFor(staged));
  const p = rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', '9.9.9', '--receipts', receipts, '--gate', gate]);
  assert.notEqual(p.status, 0, `promote must refuse a version that does not match the version source: ${p.out}`);
  assert.match(p.stderr, /does not match the version source/);
  assert.equal(fs.existsSync(path.join(channel, 'latest.json')), false);

  // The shim's own copy of the number disagreeing with version.json is refused, not shipped as two numbers.
  const shim = path.join(tree.root, 'packages', 'plugin', 'claude', '.claude-plugin', 'plugin.json');
  fs.writeFileSync(shim, JSON.stringify({ ...JSON.parse(fs.readFileSync(shim, 'utf8')), version: '9.9.9' }, null, 2));
  refused(sealed(ctx, tree, { pack }), /packages\/version\.json says .* but the shim's plugin\.json says 9\.9\.9/, 'a shim version that disagrees with the version source');
});
