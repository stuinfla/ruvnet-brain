// Review F11 (server half): when an update installs a new app, a server that is already running hands
// over to the new app's formatter, delivery guard, tool definitions and health code at its next call,
// and only then reports the new app version. Release 2's app (scratch copy) marks its formatter and its
// search_ruvnet description; the same server process must show both after the update.
// Break: the server keeps the modules it started with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, setup, waitFor } from './helpers.mjs';

const V2 = '5.0.1-handover';
const FORMAT_MARK = { file: 'packages/server/format.mjs', find: "  if (result.closing) out.push(`NOTE · ${result.closing}`);\n", replace: "  if (result.closing) out.push(`NOTE · ${result.closing}`);\n  out.push('NOTE · formatted by the release 2 app');\n" };
const TOOLS_MARK = { file: 'packages/server/tools.mjs', find: "    \"Search RuvNet Brain's signed knowledge pack", replace: "    '[release 2 tools] ' +\n    \"Search RuvNet Brain's signed knowledge pack" };

test('F11 a running server hands over to the new app\'s modules', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'integ-server-f11');
  const tree = ctx.tree();
  const { home, pack } = ctx.installed(tree);
  const srv = await ctx.server(tree, home);
  const r1 = await srv.search('gloamwick journal');
  assert.equal(r1.mode, 'MODE · normal', r1.mode);
  assert.doesNotMatch(r1.text, /release 2 app/);
  const app1 = readStatus(home, srv.pid).app;

  const tree2 = ctx.tree({ patches: [FORMAT_MARK, TOOLS_MARK], keys: tree.keys });
  const u = tree.cli(home, ['update', '--from', tree2.release(pack, { number: 2, version: V2 })]);
  assert.equal(u.status, 0, u.stdout + u.stderr);

  const r2 = await srv.search('gloamwick journal');
  assert.equal(srv.child.exitCode, null, 'the same server process answers');
  assert.equal(r2.mode, 'MODE · normal', r2.mode);
  assert.match(r2.text, /^NOTE · formatted by the release 2 app$/m, `the answer must come from the new app's formatter:\n${r2.text.split('\n').filter((l) => l.startsWith('NOTE')).join('\n')}`);
  const list = await srv.call('tools/list', {});
  assert.match(list.tools.find((x) => x.name === 'search_ruvnet').description, /^\[release 2 tools\] /, 'tools/list must describe the new app\'s tools');
  await waitFor(() => readStatus(home, srv.pid)?.app === V2, 10_000, `the status file to name app ${V2} (was ${app1})`);
});
