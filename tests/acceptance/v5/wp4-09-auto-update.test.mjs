// WP4 update from inside the server: a running server, started with a private copy of Node that is
// then deleted (what a package manager does when it upgrades Node), finds a newer signed release at
// its update address, downloads, checks and switches to it by itself, and its next search answers
// from the new pack. The installer's real-server check picks a working Node at that moment instead
// of the deleted one (defect C1 in a new place), and never a `node` planted in the session's current
// folder, even with an empty and a `.` entry on PATH (POSIX; on Windows only the first part runs).
// Breaks: the check starts the remembered Node path; the PATH search accepts relative entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, pointerOf, serveRelease } from './wp4-helpers.mjs';
import { THREE, repo, setup, waitFor, writeConfig } from './helpers.mjs';

function privateNode(dir) {
  fs.mkdirSync(path.join(dir, 'bin'));
  const copy = path.join(dir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, copy);
  const realLib = path.join(path.dirname(path.dirname(fs.realpathSync(process.execPath))), 'lib');
  for (const n of fs.existsSync(realLib) ? fs.readdirSync(realLib).filter((x) => x.startsWith('libnode.')) : []) {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(realLib, n), path.join(dir, 'lib', n));
  }
  fs.chmodSync(copy, 0o755);
  return copy;
}

test('WP4-09 the running server applies a newer release by itself, after Node was replaced', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-09');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  assertScratch(home);
  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const gen2 = JSON.parse(fs.readFileSync(path.join(pack2, 'PACK.json'), 'utf8')).generation;
  const web = await serveRelease(tree.release(pack2, { number: 2, version: '5.0.2' }));
  t.after(() => web.close());

  const nodeDir = ctx.tmp('rb5-node-');
  const nodeCopy = privateNode(nodeDir);
  writeConfig(home, { updateIntervalMs: 200 });
  const project = ctx.tmp('rb5-project-');
  const mark = path.join(ctx.tmp('rb5-mark-'), 'planted-node-ran');
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const env = { [pathKey]: ['', '.', process.env[pathKey]].join(path.delimiter) };
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(project, 'node'), `#!/bin/sh\necho ran > '${mark}'\n`);
    fs.chmodSync(path.join(project, 'node'), 0o755);
  }
  const srv = await ctx.server(tree, home, { node: nodeCopy, cwd: project, env });
  const first = await srv.search('gloamwick journal');
  assert.equal(first.mode, 'MODE · normal');
  if (process.platform === 'win32') fs.renameSync(nodeCopy, `${nodeCopy}.old`);
  else fs.rmSync(nodeDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(nodeCopy), false, 'the Node program the server started with is gone');
  writeConfig(home, { updateUrl: web.url });

  const check = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'state', 'update-check.json'), 'utf8')).applied;
    } catch {
      return null;
    }
  }, 120_000, 'the automatic update to finish').catch((e) => {
    const show = (f) => (fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f), 'utf8') : 'absent');
    throw new Error(`${e.message}; update-check: ${show('state/update-check.json')}; journal: ${show('state/journal.json')}; requests: ${web.requests.length}; server stderr: ${srv.stderr().slice(-800)}`);
  });
  assert.equal(check.ok, true, `the automatic update must be applied, not refused or rolled back: ${check.message}`);
  assert.equal(pointerOf(home).releaseNumber, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state', 'update.json'), 'utf8')).result, 'installed');
  const r = await srv.search('zephyrlattice mincut walker');
  assert.ok(r.header.includes(`pack ${gen2}`) && r.files[0]?.file === 'delta-graph/src/mincut_walker.rs', `the same session must answer from the new pack without a restart: ${r.header}`);
  assert.equal(r.mode, 'MODE · normal');
  assert.equal(fs.existsSync(mark), false, 'a node program planted in the session folder ran');
  assert.ok(web.requests.some((q) => q.url === '/release.json') && web.requests.some((q) => q.url.startsWith('/pack/')), 'the release was fetched from the update address');
});
