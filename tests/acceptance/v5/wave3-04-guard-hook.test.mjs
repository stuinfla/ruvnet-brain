// Wave 3 (d): the optional write guard runs from the plug-in. Registration adds a tool-use hook to
// Claude Code whose first word is the launcher (`rb5 guard`), and the launcher's guard mode passes the
// hook message in and the guard's exit code out. The guard is OFF unless the user's configuration
// turns it on (contract DEFAULTS guard: false): then it prints nothing and allows everything. On, with
// the server stopped, it allows the write with one line; on, with search OK and no search in the
// session, it refuses with exit 2 through the exact registered command, run by the platform shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { NOT_POSIX, installedShim, runHost } from './wp7-helpers.mjs';
import { TERM_TEXT, emptyTranscript, okServer, writeMsg } from './wp10-helpers.mjs';

test('Wave 3 the guard runs through the registered tool-use hook, off by default', { skip: NOT_POSIX, timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave3-04');
  const tree = ctx.tree();
  const { home, api, shim } = await installedShim(ctx, tree);
  const { DEFAULTS } = await import(pathToFileURL(path.join(tree.root, 'packages', 'contract', 'constants.mjs')).href);
  assert.equal(DEFAULTS.guard, false, 'the contract default: the guard is off');

  const dir = ctx.tmp('rb5-w3-guard-hosts-');
  const hosts = { claude: { settings: path.join(dir, 'settings.json'), state: path.join(dir, '.claude.json') }, codex: { config: path.join(dir, 'config.toml'), hooks: path.join(dir, 'hooks.json') } };
  api.registerHosts({ home, hosts });
  const pre = JSON.parse(fs.readFileSync(hosts.claude.settings, 'utf8')).hooks.PreToolUse ?? [];
  assert.equal(pre.length, 1, 'one tool-use hook is registered in Claude Code');
  assert.match(pre[0].matcher, /\bWrite\b/);
  const cmd = pre[0].hooks[0].command;
  assert.equal(cmd, `"${shim.launcher}" guard`, 'the hook is the launcher by absolute path in guard mode, with no fallback that could hide a refusal');
  assert.equal(JSON.parse(fs.readFileSync(hosts.codex.hooks, 'utf8')).hooks.PreToolUse, undefined, 'Codex gets no tool-use hook (the guard reads Claude Code tool input)');

  const project = ctx.tmp('rb5-w3-project-');
  const env = { RUVNET_BRAIN5_HOME: home };
  const run = (msg) => runHost(cmd, { cwd: project, env, input: JSON.stringify(msg) });
  const msg = (tr) => writeMsg(path.join(project, 'adapter.ts'), TERM_TEXT, tr);
  const lines = (s) => s.split('\n').filter(Boolean);

  const off = run(msg(emptyTranscript(ctx.tmp('rb5-w3-tr-'))));
  assert.deepEqual([off.status, off.line, off.stderr], [0, '', ''], 'off (the default): no line, no refusal');

  const on = tree.cli(home, ['guard', 'on']);
  assert.equal(on.status, 0, on.stderr);
  const stopped = run(msg(emptyTranscript(ctx.tmp('rb5-w3-tr-'))));
  assert.equal(stopped.status, 0, `with the server stopped the guard fails open: ${stopped.stderr}`);
  assert.equal(lines(stopped.line).length, 1, 'exactly one line');
  assert.match(JSON.parse(stopped.line).systemMessage, /advisory only: search is (NOT RUNNING|DOWN)/, 'the one line says why the write was not checked');

  const s = await okServer(ctx, tree, home);
  const refused = run(msg(emptyTranscript(ctx.tmp('rb5-w3-tr-'))));
  assert.equal(refused.status, 2, `with search OK and no search in the session the registered hook refuses: ${refused.line} ${refused.stderr}`);
  assert.match(refused.stderr, /has no search_ruvnet result from the installed pack/);
  await s.close();

  const off2 = tree.cli(home, ['guard', 'off']);
  assert.equal(off2.status, 0);
  assert.equal(run(msg(emptyTranscript(ctx.tmp('rb5-w3-tr-')))).status, 0, 'turned off again, it allows everything');
});
