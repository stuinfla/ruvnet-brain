// WP7-04 with no usable Node the hook prints the one DOWN line, exits 0, and runs nothing from the
// project. Part 1: nothing recorded and PATH holds only entries that may not be used (empty, relative,
// the project's own folder) while the project holds a planted `node`. Part 2, the safety net: when the
// launcher itself cannot be started (its file is missing), the hook command's own `|| echo` still
// prints the DOWN line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { DOWN, NOT_POSIX, marked, nodeDir, plantNode, runHost } from './wp7-helpers.mjs';

test('WP7-04 no usable Node: one DOWN line, exit 0, nothing from the project runs', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'wp7-04');
  const tree = ctx.tree();
  const home = ctx.tmp('rb5-home-');
  const project = ctx.tmp('rb5-project-');
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  plantNode(project, mark);
  plantNode(path.join(project, 'bin'), mark);
  const empty = ctx.tmp('rb5-empty-');
  const env = { RUVNET_BRAIN5_HOME: home };

  const r = runHost(tree.hookCommand(), { cwd: project, PATH: `:.:bin:${project}:${empty}`, env });
  assert.equal(marked(mark), false, `a program planted in the project ran (printed: ${r.line})`);
  assert.match(r.line, DOWN, `with no usable Node the hook must print the DOWN line; printed "${r.line}" ${r.stderr}`);
  assert.equal(r.line.split('\n').length, 1, 'exactly one line');
  assert.equal(r.status, 0, 'the DOWN line exits 0 so the host carries on');

  const control = runHost(tree.hookCommand(), { cwd: project, PATH: `${empty}:${nodeDir()}`, env });
  assert.doesNotMatch(control.line, DOWN, `control: with a Node on PATH the line is the verdict: ${control.line}`);

  fs.rmSync(path.join(tree.plugin, 'bin', 'rb5'));
  const net = runHost(tree.hookCommand(), { cwd: project, PATH: `${empty}:${nodeDir()}`, env });
  assert.match(net.line, DOWN, `with the launcher missing the hook command's own fallback must print the DOWN line; printed "${net.line}"`);
});
