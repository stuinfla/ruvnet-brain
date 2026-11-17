// Review F02 (POSIX launcher): a `node` in a PATH folder outside the project that is a symbolic link
// into the project is never run, however many hops the link chain has; and a Homebrew-style chain of
// links outside the project that ends at a real Node outside it is still used. The hook command is run
// exactly as a host runs it, through /bin/sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NOT_POSIX, VERDICT, marked, nodeDir, plantNode, runHost } from './wp7-helpers.mjs';

test('integ-plugin-f02 the launcher follows a node link to its end and refuses one into the project', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'integ-plugin-f02');
  const tree = ctx.tree();
  const home = ctx.tmp('rb5-home-');
  const project = fs.realpathSync(ctx.tmp('rb5-project-'));
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  const planted = plantNode(path.join(project, 'tools'), mark);
  const env = { RUVNET_BRAIN5_HOME: home };
  const hook = (PATH, cwd = project, extra = {}) => runHost(tree.hookCommand(), { cwd, PATH, env: { ...env, ...extra } });

  // One hop: <outside>/node -> <project>/tools/node (absolute).
  const one = fs.realpathSync(ctx.tmp('rb5-outside-'));
  fs.symlinkSync(planted, path.join(one, 'node'));
  // Two hops, the second relative: <outside2>/bin/node -> ../lib/node -> <project>/tools/node.
  const two = fs.realpathSync(ctx.tmp('rb5-outside2-'));
  fs.mkdirSync(path.join(two, 'bin'));
  fs.mkdirSync(path.join(two, 'lib'));
  fs.symlinkSync(planted, path.join(two, 'lib', 'node'));
  fs.symlinkSync('../lib/node', path.join(two, 'bin', 'node'));

  const cases = [
    ['a one-hop link into the project', one, project, {}],
    ['a two-hop link (relative second hop) into the project', path.join(two, 'bin'), project, {}],
    ['a link into CLAUDE_PROJECT_DIR while the hook runs elsewhere', one, fs.realpathSync(ctx.tmp('rb5-elsewhere-')), { CLAUDE_PROJECT_DIR: project }],
  ];
  for (const [what, dir, cwd, extra] of cases) {
    const r = hook(`${dir}:${nodeDir()}`, cwd, extra);
    assert.equal(marked(mark), false, `${what}: a node linked into the project ran (the hook printed: ${r.line})`);
    assert.match(r.line, VERDICT, `${what}: the real Node after it must print the verdict line; printed "${r.line}" ${r.stderr}`);
  }

  // Homebrew style, all outside the project: <brew>/bin/node -> ../Cellar/node/9/bin/node -> the real
  // Node. PATH holds only that bin folder, so the hook can print a verdict only by running the chain.
  const brew = fs.realpathSync(ctx.tmp('rb5-brew-'));
  fs.mkdirSync(path.join(brew, 'bin'));
  fs.mkdirSync(path.join(brew, 'Cellar', 'node', '9', 'bin'), { recursive: true });
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(brew, 'Cellar', 'node', '9', 'bin', 'node'));
  fs.symlinkSync('../Cellar/node/9/bin/node', path.join(brew, 'bin', 'node'));
  const ok = hook(path.join(brew, 'bin'));
  assert.match(ok.line, VERDICT, `a Homebrew-style link chain outside the project must still run; printed "${ok.line}" ${ok.stderr}`);
  assert.equal(marked(mark), false, 'nothing inside the project ran');
});
