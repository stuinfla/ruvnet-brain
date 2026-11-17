// WP7-03 the POSIX launcher looks up none of its own commands through the caller's PATH. A folder of
// stand-ins for every program a shell script commonly calls is put first on PATH; the installed hook
// and the installed server launcher both run, and not one stand-in may run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { NOT_POSIX, VERDICT, fakeHosts, installedShim, nodeDir, runHost } from './wp7-helpers.mjs';

const NAMES = ['basename', 'dirname', 'cat', 'readlink', 'realpath', 'uname', 'sed', 'awk', 'grep', 'head', 'tail', 'tr', 'cut', 'expr',
  'env', 'which', 'whereis', 'ls', 'find', 'stat', 'test', '[', 'printf', 'echo', 'pwd', 'cd', 'true', 'false', 'sh', 'bash', 'id', 'date', 'mktemp', 'xargs', 'sort'];

test('WP7-03 the launcher runs no program found through PATH except the Node it chose', { skip: NOT_POSIX, timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp7-03');
  const tree = ctx.tree();
  const { home, api } = await installedShim(ctx, tree);
  const hosts = fakeHosts(ctx.tmp('rb5-hosts-'), { content: false });
  api.registerHosts({ home, hosts });
  const hook = JSON.parse(fs.readFileSync(hosts.claude.settings, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  const server = JSON.parse(fs.readFileSync(hosts.claude.state, 'utf8')).mcpServers['ruvnet-brain'];
  const fakes = ctx.tmp('rb5-fakes-');
  const marks = ctx.tmp('rb5-marks-');
  for (const n of NAMES) {
    fs.writeFileSync(path.join(fakes, n), `#!/bin/sh\n: > '${path.join(marks, encodeURIComponent(n))}'\nexit 0\n`);
    fs.chmodSync(path.join(fakes, n), 0o755);
  }
  // Control: a stand-in does leave a mark when PATH finds it.
  spawnSync('/bin/sh', ['-c', 'dirname /x >/dev/null'], { env: { PATH: fakes } });
  assert.deepEqual(fs.readdirSync(marks), ['dirname'], 'the stand-ins work');
  fs.rmSync(path.join(marks, 'dirname'));

  const PATH = `${fakes}:${nodeDir()}`;
  const project = ctx.tmp('rb5-project-');
  for (const [what, cmd] of [['the source plug-in hook', tree.hookCommand()], ['the installed hook', hook]]) {
    const r = runHost(cmd, { cwd: project, PATH, env: { RUVNET_BRAIN5_HOME: home } });
    assert.match(r.line, VERDICT, `${what} must still print the verdict line: "${r.line}" ${r.stderr}`);
  }
  fs.writeFileSync(path.join(home, 'shim', 'node-runtime'), '/nonexistent-rb5/node\n');
  const fallback = runHost(hook, { cwd: project, PATH });
  assert.match(fallback.line, VERDICT, `the PATH fallback must print the verdict line: "${fallback.line}" ${fallback.stderr}`);
  const s = spawnSync(server.command, [...server.args], { cwd: project, input: '', env: { ...process.env, PATH }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(s.status, 0, `the server launcher started and ended with its input: ${s.stderr}`);
  const ran = fs.readdirSync(marks).map(decodeURIComponent);
  assert.deepEqual(ran, [], `the launcher ran programs found through PATH: ${ran.join(', ')}`);
});
