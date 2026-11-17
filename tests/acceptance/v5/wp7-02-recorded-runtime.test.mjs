// WP7-02 the launcher starts Node from the absolute path recorded at install, and checks that path
// again on every start. The registered hook and server commands are run with a PATH that holds no Node
// at all (a host started from a desktop menu can have such a PATH), so only the recorded path can work.
// Then the recorded program is made unusable three ways (deleted, older than the minimum, inside the
// current project): the launcher must not use it, falls back to the first Node on an absolute PATH
// entry, and with none prints the one DOWN line and exits 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { setup } from './helpers.mjs';
import { DOWN, NOT_POSIX, VERDICT, fakeHosts, installedShim, marked, nodeDir, oldNode, plantNode, runHost } from './wp7-helpers.mjs';

function serverSearch(command, args, { cwd, PATH, query }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NODE_NO_WARNINGS: '1', PATH };
    delete env.RUVNET_BRAIN5_HOME;
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => (child.kill('SIGKILL'), reject(new Error(`no answer from the registered server; stderr: ${err}`))), 60_000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.id === 2) {
        clearTimeout(t);
        child.stdin.end();
        resolve(m.result?.content?.[0]?.text ?? '');
      }
    });
    child.on('exit', (code) => (clearTimeout(t), resolve(`exit ${code}: ${err}`)));
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wp7', version: '1' } } });
    send({ id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query } } });
  });
}

test('WP7-02 the recorded runtime is used, and re-checked on every start', { skip: NOT_POSIX, timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp7-02');
  const tree = ctx.tree();
  const { home, api, shim } = await installedShim(ctx, tree);
  const hosts = fakeHosts(ctx.tmp('rb5-hosts-'));
  api.registerHosts({ home, hosts });
  const settings = JSON.parse(fs.readFileSync(hosts.claude.settings, 'utf8'));
  const hook = settings.hooks.UserPromptSubmit.at(-1).hooks[0].command;
  const server = JSON.parse(fs.readFileSync(hosts.claude.state, 'utf8')).mcpServers['ruvnet-brain-5'];
  const project = ctx.tmp('rb5-project-');
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  const noNode = ctx.tmp('rb5-nonode-');
  const recorded = fs.readFileSync(shim.runtime, 'utf8').trim();
  assert.ok(path.isAbsolute(recorded), `the recorded runtime is an absolute path: ${recorded}`);

  // 1. No Node on PATH at all: the recorded path starts the hook and the server. The registered
  //    commands carry no brain-home variable; the launcher finds its home from where it is installed.
  const ok = runHost(hook, { cwd: project, PATH: `${noNode}::.`, env: { RUVNET_BRAIN5_HOME: '' } });
  assert.match(ok.line, VERDICT, `the recorded runtime must print the verdict line: "${ok.line}" ${ok.stderr}`);
  assert.doesNotMatch(ok.line, /NOT INSTALLED/, 'the launcher must read the brain home it is installed in');
  const [probe] = JSON.parse(fs.readFileSync(path.join(home, 'packs', JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8')).pack, 'PROBES.json'), 'utf8')).probes;
  const text = await serverSearch(server.command, server.args, { cwd: project, PATH: `${noNode}::.`, query: probe.question });
  assert.match(text, new RegExp(`\\. ${probe.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · lines`), `the registered server must answer through the recorded runtime: ${text.slice(0, 300)}`);

  const record = (p) => fs.writeFileSync(shim.runtime, `${p}\n`);
  const cases = [
    ['the recorded program was deleted', () => record(path.join(ctx.tmp('rb5-gone-'), 'node'))],
    ['the recorded program is older than the minimum', () => record(oldNode(ctx.tmp('rb5-old-')))],
    ['the recorded program is inside the current project', () => record(plantNode(path.join(project, 'tools'), mark))],
  ];
  for (const [what, make] of cases) {
    make();
    const fallback = runHost(hook, { cwd: project, PATH: `${noNode}:${nodeDir()}` });
    assert.match(fallback.line, VERDICT, `${what}: with a Node on PATH the hook must fall back to it; printed "${fallback.line}" ${fallback.stderr}`);
    const none = runHost(hook, { cwd: project, PATH: `${noNode}::.` });
    assert.match(none.line, DOWN, `${what}: with no other Node the hook must print the DOWN line; printed "${none.line}"`);
    assert.equal(none.status, 0, `${what}: the DOWN line exits 0`);
    const srv = await serverSearch(server.command, server.args, { cwd: project, PATH: `${noNode}::.`, query: probe.question });
    assert.match(srv, /^exit [1-9]\d*: .*DOWN: Node could not run/s, `${what}: the server launcher must not start it; got ${srv.slice(0, 200)}`);
    assert.equal(marked(mark), false, `${what}: a program inside the project was run`);
  }
  record(recorded);
});
