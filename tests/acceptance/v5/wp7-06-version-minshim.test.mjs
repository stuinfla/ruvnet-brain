// WP7-06 one version number, and the smallest shim version enforced.
// (a) The installed plug-in manifest carries the version of the app it was installed from, and the
//     shipped plug-in has no version number of its own: a release made with another app version gives
//     an installed plug-in with that version.
// (b) A release signed with a `minShim` above the shim version this installer carries is refused with
//     one sentence that names both numbers, and nothing is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { THREE, setup } from './helpers.mjs';
import { pluginApi } from './wp7-helpers.mjs';

test('WP7-06 one plug-in version source, and minShim refused when too high', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp7-06');
  const tree = ctx.tree();
  const pack = tree.build(THREE);
  const rel = tree.release(pack, { number: 1, version: '5.9.1-wp7' });
  const home = ctx.tmp('rb5-home-');
  const r = tree.cli(home, ['install', '--from', rel]);
  assert.equal(r.status, 0, `install failed: ${r.stdout}\n${r.stderr}`);
  const api = await pluginApi(tree);
  const shim = api.installShim({ home });
  const manifest = JSON.parse(fs.readFileSync(path.join(shim.plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '5.9.1-wp7', 'the installed plug-in version is the installed app version');
  const shipped = JSON.parse(fs.readFileSync(path.join(home, 'app', '5.9.1-wp7', 'plugin', 'claude', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(shipped.version, undefined, 'the shipped plug-in carries no second version number');

  const { SHIM_VERSION } = await import(pathToFileURL(path.join(tree.root, 'packages', 'contract', 'constants.mjs')).href);
  const { sign } = await import(pathToFileURL(path.join(tree.root, 'packages', 'contract', 'signature.mjs')).href);
  const rel2 = tree.release(pack, { number: 2 });
  const body = JSON.parse(fs.readFileSync(path.join(rel2, 'release.json'), 'utf8'));
  delete body.signature;
  fs.writeFileSync(path.join(rel2, 'release.json'), JSON.stringify(sign({ ...body, minShim: SHIM_VERSION + 1 }, tree.keys.privatePem), null, 2));
  const fresh = ctx.tmp('rb5-home-');
  const refused = tree.cli(fresh, ['install', '--from', rel2]);
  assert.notEqual(refused.status, 0, `a release needing shim ${SHIM_VERSION + 1} must be refused: ${refused.stdout}`);
  assert.match(`${refused.stdout}${refused.stderr}`, new RegExp(`needs shim version ${SHIM_VERSION + 1}.*carries version ${SHIM_VERSION}`), 'the refusal names both numbers');
  assert.equal(fs.existsSync(path.join(fresh, 'current.json')), false, 'nothing is installed');
});
