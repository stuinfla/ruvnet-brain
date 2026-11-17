// S12 on POSIX with an empty PATH entry (a trailing or doubled ':' means "the current folder"): the
// shim's exact prompt-hook command, run from a project that holds a planted `node`, must not run it.
// This is the POSIX form of the Windows risk (cmd.exe searches the current folder first). It fails
// today: the hook command starts a bare `node`. The hook command belongs to work package 7, so the
// test is marked todo until the shim's launcher stops looking up `node` through the current folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './wp4-helpers.mjs';
import { setup } from './helpers.mjs';

test('WP4-12 the prompt hook never runs a node planted in the project, even with an empty PATH entry', {
  skip: process.platform === 'win32' ? 'POSIX form only; the cmd.exe form needs a Windows run' : false,
  todo: false, // closed by WP7: the hook's first word is the absolute launcher, which skips empty, relative and project PATH entries
}, async (t) => {
  const ctx = setup(t, 'wp4-12');
  const tree = ctx.tree();
  const home = ctx.tmp('rb5-home-');
  const project = ctx.tmp('rb5-project-');
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  fs.writeFileSync(path.join(project, 'node'), `#!/bin/sh\necho ran > '${mark}'\nexit 1\n`);
  fs.chmodSync(path.join(project, 'node'), 0o755);
  const control = tree.hook(home, { cwd: project });
  assert.match(control.line, /^\[RuvNet Brain NOT INSTALLED/, 'control: with a clean PATH the real node prints the verdict');
  assert.equal(fs.existsSync(mark), false);
  const r = tree.hook(home, { cwd: project, env: { PATH: `:${process.env.PATH}` } });
  assert.equal(fs.existsSync(mark), false, `the planted project node ran (the hook printed: ${r.line})`);
});
