// WP7-05 host registration, against temporary files that stand in for each host's own settings
// (Claude Code: settings.json, the user-scope server list, skills, commands; Codex: config.toml and
// hooks.json). Registering adds one hook and one search server per host whose command's first word is
// the absolute launcher under the brain home, keeps every byte of the user's own settings, is the same
// when run twice, refuses a damaged file without writing anything, never takes over a server entry the
// user wrote, and unregistering puts every file back exactly as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NOT_POSIX, VERDICT, bytesOf, fakeHosts, installedShim, runHost } from './wp7-helpers.mjs';

const firstWord = (cmd) => (/^"([^"]+)"/.exec(cmd) ?? /^(\S+)/.exec(cmd))[1];

test('WP7-05 host registration adds exactly the shim entries and removes exactly them', { skip: NOT_POSIX, timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp7-05');
  const tree = ctx.tree();
  const { home, api, shim } = await installedShim(ctx, tree);
  const dir = ctx.tmp('rb5-hosts-');
  const hosts = fakeHosts(dir);
  const before = bytesOf(dir);
  const shimRoot = fs.realpathSync(path.join(home, 'shim'));

  const res = api.registerHosts({ home, hosts });
  const after = bytesOf(dir);
  const settings = JSON.parse(after['claude/settings.json']);
  const ups = settings.hooks.UserPromptSubmit;
  assert.equal(ups.length, 2, 'the user hook stays and exactly one is added');
  assert.deepEqual(ups[0], JSON.parse(before['claude/settings.json']).hooks.UserPromptSubmit[0], "the user's own hook is unchanged");
  const codexHooks = JSON.parse(after['codex/hooks.json']);
  const servers = JSON.parse(after['claude.json']).mcpServers;
  const toml = after['codex/config.toml'];
  const commands = [ups[1].hooks[0].command, codexHooks.hooks.UserPromptSubmit[0].hooks[0].command];
  for (const cmd of [...commands, servers['ruvnet-brain-5'].command]) {
    const w = firstWord(cmd);
    assert.ok(path.isAbsolute(w), `the first word of "${cmd}" must be an absolute path`);
    assert.ok(fs.realpathSync(w).startsWith(shimRoot + path.sep), `the first word of "${cmd}" must be the launcher under the brain home`);
  }
  assert.deepEqual(servers['ruvnet-brain-5'].args, ['server']);
  assert.deepEqual(servers.other, JSON.parse(before['claude.json']).mcpServers.other, "the user's other server is unchanged");
  assert.ok(toml.startsWith(before['codex/config.toml']), "the user's config.toml bytes are kept in front of the managed block");
  assert.match(toml, new RegExp(`\\[mcp_servers\\.ruvnet-brain-5\\]\\ncommand = ${JSON.stringify(shim.launcher).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nargs = \\["server"\\]`));
  assert.ok(fs.existsSync(path.join(dir, 'claude', 'skills', 'ruvnet-brain', 'SKILL.md')) && fs.statSync(path.join(dir, 'claude', 'skills', 'ruvnet-brain', 'SKILL.md')).size < 4096, 'one short skill');
  assert.ok(fs.existsSync(path.join(dir, 'claude', 'commands', 'brain.md')), 'the /brain command');
  assert.ok(res.written.length >= 4, `the paths written are returned: ${res.written}`);
  for (const cmd of commands) {
    const r = runHost(cmd, { cwd: ctx.tmp('rb5-project-') });
    assert.match(r.line, VERDICT, `the registered hook runs: "${r.line}" ${r.stderr}`);
  }

  api.registerHosts({ home, hosts });
  assert.deepEqual(bytesOf(dir), after, 'registering twice gives the same bytes');

  const damaged = fakeHosts(ctx.tmp('rb5-hosts-bad-'));
  fs.writeFileSync(damaged.claude.state, '{"numStartups": 7,');
  const damagedBefore = bytesOf(path.dirname(damaged.claude.state));
  assert.throws(() => api.registerHosts({ home, hosts: damaged }), (e) => /is not valid JSON/.test(e.message) && e.message.split('. ').length <= 2);
  assert.deepEqual(bytesOf(path.dirname(damaged.claude.state)), damagedBefore, 'a damaged file means nothing at all is written');

  const owned = fakeHosts(ctx.tmp('rb5-hosts-own-'));
  const userServer = { type: 'stdio', command: '/home/me/my-brain', args: ['x'] };
  const state = JSON.parse(fs.readFileSync(owned.claude.state, 'utf8'));
  fs.writeFileSync(owned.claude.state, JSON.stringify({ ...state, mcpServers: { ...state.mcpServers, 'ruvnet-brain-5': userServer } }, null, 2) + '\n');
  fs.appendFileSync(owned.codex.config, '\n[mcp_servers.ruvnet-brain-5]\ncommand = "/home/me/my-brain"\n');
  const ownedToml = fs.readFileSync(owned.codex.config, 'utf8');
  const ownedHooks = [owned.claude.settings, owned.codex.hooks].map((f) => fs.readFileSync(f, 'utf8'));
  const r2 = api.registerHosts({ home, hosts: owned });
  assert.deepEqual(JSON.parse(fs.readFileSync(owned.claude.state, 'utf8')).mcpServers['ruvnet-brain-5'], userServer, "a server entry the user wrote is never replaced");
  assert.equal(fs.readFileSync(owned.codex.config, 'utf8'), ownedToml, "a Codex server table the user wrote is never touched");
  assert.equal(r2.conflicts.length, 2, `both conflicts are reported: ${JSON.stringify(r2.conflicts)}`);
  assert.deepEqual([owned.claude.settings, owned.codex.hooks].map((f) => fs.readFileSync(f, 'utf8')), ownedHooks, 'a host whose server entry was refused gets no hook');
  assert.deepEqual(r2.unserved.map((u) => u.host), ['Claude Code', 'Codex'], 'both hosts are reported as not served by version 5');

  // 4.7's own server name (ruvnet-brain) is no clash: version 5 serves beside it as ruvnet-brain-5.
  const beside = fakeHosts(ctx.tmp('rb5-hosts-47-'));
  const st47 = JSON.parse(fs.readFileSync(beside.claude.state, 'utf8'));
  fs.writeFileSync(beside.claude.state, JSON.stringify({ ...st47, mcpServers: { ...st47.mcpServers, 'ruvnet-brain': userServer } }, null, 2) + '\n');
  fs.appendFileSync(beside.codex.config, '\n[mcp_servers.ruvnet-brain]\ncommand = "/home/me/my-brain"\n');
  const r3 = api.registerHosts({ home, hosts: beside });
  assert.deepEqual([r3.conflicts, r3.unserved], [[], []], `version 5 sits beside a ruvnet-brain entry: ${JSON.stringify(r3)}`);
  assert.equal(JSON.parse(fs.readFileSync(beside.claude.state, 'utf8')).mcpServers['ruvnet-brain-5'].command, shim.launcher);

  api.unregisterHosts({ home, hosts });
  assert.deepEqual(bytesOf(dir), before, 'unregistering puts every host file back byte for byte and removes the skill and command');
});
