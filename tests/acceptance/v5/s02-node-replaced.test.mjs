// S2 Node replaced: the server runs on a private copy of the Node program; the copy is deleted while
// the server runs (what a package manager does when it upgrades Node); a new search worker is then
// created (the probe interval restarts it) and the next search still answers normally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStatus, setup, waitFor, writeConfig } from './helpers.mjs';

const Q = 'tidewrack episode store recallbylantern';

test('S2 the Node program is replaced while the server runs', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's02');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  writeConfig(home, { probeIntervalMs: 400 });

  // A private copy of the Node installation: the program, plus a shared libnode beside it when the
  // installation uses one (Homebrew does: bin/node loads ../lib/libnode.*).
  const copyDir = ctx.tmp('rb5-node-');
  fs.mkdirSync(path.join(copyDir, 'bin'));
  const nodeCopy = path.join(copyDir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, nodeCopy);
  const realLib = path.join(path.dirname(path.dirname(fs.realpathSync(process.execPath))), 'lib');
  for (const n of fs.existsSync(realLib) ? fs.readdirSync(realLib).filter((x) => x.startsWith('libnode.')) : []) {
    fs.mkdirSync(path.join(copyDir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(realLib, n), path.join(copyDir, 'lib', n));
  }
  fs.chmodSync(nodeCopy, 0o755);
  const v = spawnSync(nodeCopy, ['--version'], { encoding: 'utf8' });
  assert.equal(v.stdout.trim(), process.version, 'the private Node copy must run');

  const srv = await ctx.server(tree, home, { node: nodeCopy });
  const before = await srv.search(Q);
  assert.equal(before.mode, 'MODE · normal', `first search must be normal: ${before.mode}`);
  assert.equal(before.files[0]?.file, 'beta-memory/src/episode_store.ts');

  // A package manager upgrade removes the whole old installation. Windows cannot delete a running
  // program; moving it away has the same effect on its path.
  const deletedAt = Date.now();
  if (process.platform === 'win32') fs.renameSync(nodeCopy, `${nodeCopy}.old`);
  else fs.rmSync(copyDir, { recursive: true });
  assert.equal(fs.existsSync(nodeCopy), false);
  // A new worker has been started after the deletion: a probe (each runs in a fresh worker) has run since.
  await waitFor(() => (readStatus(home, srv.pid)?.probe?.at ?? 0) > deletedAt + 50, 10_000, 'a probe in a new worker after the deletion');

  const after = await srv.search(Q);
  assert.equal(after.isError, false, after.text);
  assert.equal(after.mode, 'MODE · normal', `search after the Node program was deleted fell back to safe mode: ${after.mode}`);
  assert.equal(after.files[0]?.file, 'beta-memory/src/episode_store.ts');
  const line = tree.hook(home).line;
  assert.match(line, /RuvNet Brain OK/, `health after the deletion: ${line}`);
});
