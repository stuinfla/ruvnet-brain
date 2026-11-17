// WP4 / review F06 (installer part): staging never writes or deletes through a link. A staging folder
// left as a link to another folder, and a staged file left as a link to a file outside the home, must
// leave their targets byte for byte unchanged; the install still completes from the signed bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { snapshot } from './wp4-helpers.mjs';

test('WP4-15 staging never writes or deletes through a link (review F06)', { skip: process.platform === 'win32' ? 'links need privileges on Windows' : false, timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-15');
  const tree = ctx.tree();
  const rel = tree.release(tree.build(THREE), { number: 1, version: '5.0.1' });
  const release = JSON.parse(fs.readFileSync(path.join(rel, 'release.json'), 'utf8'));
  const outside = ctx.tmp('rb5-protected-');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'the user\'s file\n');
  fs.writeFileSync(path.join(outside, 'target.mjs'), 'not the release\n');
  const before = snapshot(outside);

  // 1. The app staging folder is a link to the protected folder.
  const h1 = ctx.tmp('rb5-home-');
  fs.mkdirSync(path.join(h1, 'app'), { recursive: true });
  fs.symlinkSync(outside, path.join(h1, 'app', `${release.app.version}.partial`), 'dir');
  const r1 = tree.cli(h1, ['install', '--from', rel]);
  assert.deepEqual(snapshot(outside), before, `a linked staging folder: the folder it points at must be unchanged (${r1.stdout}${r1.stderr})`);
  assert.equal(r1.status, 0, `the install completes: ${r1.stderr}`);

  // 2. A staged file is a link to a file outside the home.
  const h2 = ctx.tmp('rb5-home-');
  const first = release.app.files[0].path;
  const staged = path.join(h2, 'app', `${release.app.version}.partial`, ...first.split('/'));
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.symlinkSync(path.join(outside, 'target.mjs'), staged);
  const r2 = tree.cli(h2, ['install', '--from', rel]);
  assert.deepEqual(snapshot(outside), before, `a linked staged file: its target must be unchanged (${r2.stdout}${r2.stderr})`);
  assert.equal(r2.status, 0, `the install completes: ${r2.stderr}`);
  assert.ok(!fs.lstatSync(path.join(h2, 'app', release.app.version, ...first.split('/'))).isSymbolicLink(), 'the installed file is a real file');
});
