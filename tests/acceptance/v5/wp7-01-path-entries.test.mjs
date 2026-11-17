// WP7-01 the prompt hook never starts a `node` from the project. The shim's exact hook command is run
// from a project holding a planted `node` (and `bin/node`), with every PATH form that can reach the
// project: an empty entry, `.`, a relative `bin`, the project's own folder by absolute path (as given
// and as the real path behind a symlink), and a project named by CLAUDE_PROJECT_DIR while the hook
// runs elsewhere. Each time the real Node prints the verdict line and the planted program never runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NOT_POSIX, VERDICT, marked, nodeDir, plantNode, runHost } from './wp7-helpers.mjs';

test('WP7-01 no PATH form makes the hook run a node planted in the project', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'wp7-01');
  const tree = ctx.tree();
  const home = ctx.tmp('rb5-home-');
  const project = ctx.tmp('rb5-project-');
  const realProject = fs.realpathSync(project);
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  plantNode(project, mark);
  plantNode(path.join(project, 'bin'), mark);
  const elsewhere = ctx.tmp('rb5-elsewhere-');
  const real = nodeDir();
  const env = { RUVNET_BRAIN5_HOME: home };

  const control = runHost(`'${path.join(project, 'node')}'`, { cwd: project, PATH: real });
  assert.ok(marked(mark), 'control: the planted program leaves a mark when it is run');
  fs.rmSync(mark);

  const cases = [
    ['an empty entry first', { cwd: project, PATH: `:${real}` }],
    ['an empty entry in the middle', { cwd: project, PATH: `/nonexistent-rb5::${real}` }],
    ['a trailing empty entry only before node', { cwd: project, PATH: `/nonexistent-rb5:${real}:` }],
    ['the current folder as "."', { cwd: project, PATH: `.:${real}` }],
    ['a relative "bin"', { cwd: project, PATH: `bin:${real}` }],
    ['the project folder by absolute path', { cwd: project, PATH: `${project}:${real}` }],
    ['the project folder by its real path', { cwd: project, PATH: `${realProject}/bin:${real}` }],
    ['the project named by CLAUDE_PROJECT_DIR', { cwd: elsewhere, PATH: `${project}/bin:${real}`, env: { CLAUDE_PROJECT_DIR: project } }],
  ];
  for (const [what, c] of cases) {
    const r = runHost(tree.hookCommand(), { cwd: c.cwd, PATH: c.PATH, env: { ...env, ...c.env } });
    assert.equal(marked(mark), false, `${what}: the planted project node ran (the hook printed: ${r.line})`);
    assert.match(r.line, VERDICT, `${what}: the real node must print the verdict line; printed "${r.line}" ${r.stderr}`);
    assert.equal(r.status, 0, `${what}: the hook exits 0`);
  }
  t.diagnostic(`${cases.length} PATH forms; control status ${control.status}`);
});
