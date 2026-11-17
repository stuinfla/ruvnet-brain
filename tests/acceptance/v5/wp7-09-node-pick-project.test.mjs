// WP7 / review F02: the installer's Node selector (packages/cli/node-pick.mjs, which starts the
// installer's real-server check and the release probes) never runs a program inside the current
// project. When the running Node is gone, it must refuse (1) an absolute PATH entry inside the
// project, (2) an outside `node` that is a link into the project, (3) the same under
// CLAUDE_PROJECT_DIR with another current folder, and (4) a "running" Node that really lives inside the
// project. Each planted program reports a good version and leaves a mark when run, so the old selector
// would both run it and return it. An outside link to the real Node is still used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { NOT_POSIX } from './wp7-helpers.mjs';

function liar(dir, mark) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node');
  fs.writeFileSync(file, `#!/bin/sh\necho ran >> '${mark}'\necho 24.22.3\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A private copy of the Node installation (the program, plus libnode beside it when it uses one, as s02). */
function nodeCopy(dir) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const copy = path.join(dir, 'bin', 'node');
  fs.copyFileSync(process.execPath, copy);
  const lib = path.join(path.dirname(path.dirname(fs.realpathSync(process.execPath))), 'lib');
  for (const n of fs.existsSync(lib) ? fs.readdirSync(lib).filter((x) => x.startsWith('libnode.')) : []) {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(lib, n), path.join(dir, 'lib', n));
  }
  fs.chmodSync(copy, 0o755);
  return copy;
}

test('WP7-09 the installer never runs a Node from inside the project (review F02)', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'wp7-09');
  const tree = ctx.tree();
  const pickUrl = pathToFileURL(path.join(tree.root, 'packages', 'cli', 'node-pick.mjs')).href;
  const project = fs.realpathSync(ctx.tmp('rb5-project-'));
  const elsewhere = fs.realpathSync(ctx.tmp('rb5-elsewhere-'));
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  const planted = liar(path.join(project, 'tools'), mark);
  const outside = fs.realpathSync(ctx.tmp('rb5-outside-'));
  fs.symlinkSync(planted, path.join(outside, 'node'));
  // The selector runs in its own process, on a Node copy that deletes itself first (a package manager
  // replacing Node), with the current folder and PATH given; it prints what it chose.
  const pick = (PATH, { cwd = project, env = {}, keep = null } = {}) => {
    const node = keep ?? nodeCopy(ctx.tmp('rb5-node-'));
    const code = `${keep ? '' : 'require("fs").unlinkSync(process.execPath);'} import(${JSON.stringify(pickUrl)}).then((m) => { try { console.log(m.pickNode(process.env)); } catch (e) { console.log('refused: ' + e.message); } });`;
    const r = spawnSync(node, ['-e', code], { cwd, encoding: 'utf8', env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '', PATH, ...env } });
    return (r.stdout || r.stderr).trim();
  };
  const never = (got, label) => {
    assert.ok(!fs.existsSync(mark), `${label}: a program inside the project was run (${got})`);
    assert.ok(got && !got.startsWith(project) && !(got.startsWith('/') && fs.existsSync(got) && fs.realpathSync(got).startsWith(project + path.sep)), `${label}: a Node inside the project was chosen: ${got}`);
  };

  never(pick(path.join(project, 'tools')), 'an absolute PATH entry inside the project');
  never(pick(outside), 'an outside node that links into the project');
  never(pick(outside, { cwd: elsewhere, env: { CLAUDE_PROJECT_DIR: project } }), 'a link into CLAUDE_PROJECT_DIR');
  never(pick('', { keep: nodeCopy(path.join(project, 'runtime')) }), 'a running Node that lives inside the project');

  // An outside link to the real Node is used, and nothing in the project ran.
  const good = fs.realpathSync(ctx.tmp('rb5-good-'));
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(good, 'node'));
  assert.equal(pick(`${path.join(project, 'tools')}:${good}`), path.join(good, 'node'), 'the first usable Node outside the project is chosen');
  assert.ok(!fs.existsSync(mark), 'nothing inside the project ran');
});
