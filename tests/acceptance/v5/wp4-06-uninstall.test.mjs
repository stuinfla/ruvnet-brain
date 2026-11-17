// WP4 uninstall: private/ is left byte for byte, everything else it owns is removed, and its final
// report comes from looking at the folder again: a file it does not own and (on Unix, not as root) a
// file it cannot remove are both listed, with exit code 1. Once those are gone it reports nothing
// left and exits 0; --purge-private removes private/ too and the home folder with it.
// Breaks: private/ is deleted; the report says "nothing remains" without looking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, snapshot } from './wp4-helpers.mjs';
import { setup } from './helpers.mjs';

test('WP4-06 uninstall keeps private/, removes the rest and reports what is really left', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-06');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  assertScratch(home);
  const priv = path.join(home, 'private', 'meetings');
  fs.mkdirSync(priv, { recursive: true });
  fs.writeFileSync(path.join(priv, 'notes.txt'), 'the owner private text\n');
  fs.writeFileSync(path.join(priv, 'index.db'), Buffer.alloc(4096, 7));
  const privBefore = snapshot(path.join(home, 'private'));
  const stray = path.join(home, 'not-ours.txt');
  fs.writeFileSync(stray, 'a file the installer never wrote');
  const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;
  const locked = path.join(home, 'state', 'locked');
  if (canLock) {
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'stuck.txt'), 'x');
    fs.chmodSync(locked, 0o555);
  }

  let u;
  try {
    u = tree.cli(home, ['uninstall']);
  } finally {
    // Restored before any assertion can fail, so the harness can always remove the folder.
    if (canLock) fs.chmodSync(locked, 0o755);
  }
  assert.match(u.stdout, /will remove:/);
  assert.deepEqual(snapshot(path.join(home, 'private')), privBefore, 'private/ must be left byte for byte');
  for (const gone of ['current.json', 'app', 'packs']) assert.equal(fs.existsSync(path.join(home, gone)), false, `${gone} must be removed`);
  assert.equal(u.status, 1, `with files left the exit code must be 1: ${u.stdout}`);
  assert.match(u.stdout, /still present after removal \(checked again\):/, `the report must list what is left: ${u.stdout}`);
  assert.ok(u.stdout.includes(stray), `the file it does not own must be listed: ${u.stdout}`);
  if (canLock) assert.ok(u.stdout.includes(path.join(locked, 'stuck.txt')), `the file it could not remove must be listed: ${u.stdout}`);
  assert.doesNotMatch(u.stdout, /nothing listed remains/);
  assert.ok(!u.stdout.includes(path.join(priv, 'notes.txt')), 'kept private files are not reported as left over');

  fs.rmSync(stray);
  const u2 = tree.cli(home, ['uninstall']);
  assert.equal(u2.status, 0, u2.stdout);
  assert.match(u2.stdout, /checked again: nothing listed remains\. Kept .*private/);
  assert.deepEqual(fs.readdirSync(home), ['private'], 'only private/ is left');
  assert.deepEqual(snapshot(path.join(home, 'private')), privBefore);

  const u3 = tree.cli(home, ['uninstall', '--purge-private']);
  assert.equal(u3.status, 0, u3.stdout);
  assert.equal(fs.existsSync(home), false, '--purge-private removes the whole brain home');
});
