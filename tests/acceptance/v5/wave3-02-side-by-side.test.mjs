// Wave 3 (b): on a machine that also runs 4.7, version 5 registers its search server under its own
// name (ruvnet-brain-5) in both hosts, so 4.7's ruvnet-brain entries and version 5's sit side by side.
// When a host's server entry is refused anyway (another program holds ruvnet-brain-5), that host gets
// no hook at all, and the one health verdict is not OK while a registered host is not served by version 5.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, waitFor } from './helpers.mjs';

const j = (v) => JSON.stringify(v, null, 2) + '\n';

function hosts47(dir, { takeV5Name = false } = {}) {
  const user = path.join(dir, 'user');
  const claude = path.join(user, '.claude');
  const codex = path.join(user, '.codex');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  const servers = { 'ruvnet-brain': { type: 'stdio', command: '/x/4.7/server', args: [] }, ...(takeV5Name ? { 'ruvnet-brain-5': { type: 'stdio', command: '/someone/else', args: [] } } : {}) };
  fs.writeFileSync(path.join(claude, '.claude.json'), j({ numStartups: 2, mcpServers: servers }));
  fs.writeFileSync(path.join(claude, 'settings.json'), j({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/4.7/hook.mjs' }] }] } }));
  fs.writeFileSync(path.join(codex, 'config.toml'), `# --- ruvnet-brain (managed block, installer-rewritten) ---\n[mcp_servers.ruvnet-brain]\ncommand = "node"\nargs = ["/x/4.7/server.mjs"]\n# --- end ruvnet-brain ---\n${takeV5Name ? '\n[mcp_servers.ruvnet-brain-5]\ncommand = "/someone/else"\n' : ''}`);
  fs.writeFileSync(path.join(codex, 'hooks.json'), j({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/4.7/codex-hook.mjs' }] }] } }));
  return { user, claude, codex, env: { HOME: user, USERPROFILE: user, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } };
}

const read = (f) => fs.readFileSync(f, 'utf8');

test('Wave 3 version 5 serves every host beside 4.7, and a host it cannot serve is never reported OK', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave3-02');
  const tree = ctx.tree();
  const { home, rel } = ctx.installed(tree);
  const launcher = path.join(home, 'shim', 'plugin', 'claude', 'bin', 'rb5');

  // Beside 4.7: both hosts are served, under ruvnet-brain-5; 4.7's entries are kept.
  const a = hosts47(ctx.tmp('rb5-w3-47-'));
  const r = tree.cli(home, ['install', '--from', rel, '--register-hosts'], { env: a.env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const servers = JSON.parse(read(path.join(a.claude, '.claude.json'))).mcpServers;
  assert.equal(servers['ruvnet-brain'].command, '/x/4.7/server', "4.7's Claude Code server entry is kept");
  assert.equal(servers['ruvnet-brain-5']?.command, launcher, 'version 5 serves Claude Code as ruvnet-brain-5');
  assert.match(read(path.join(a.codex, 'config.toml')), /\[mcp_servers\.ruvnet-brain\]\ncommand = "node"/, "4.7's Codex server is kept");
  assert.ok(read(path.join(a.codex, 'config.toml')).includes(`[mcp_servers.ruvnet-brain-5]\ncommand = ${JSON.stringify(launcher)}`), 'version 5 serves Codex as ruvnet-brain-5');
  assert.equal(JSON.parse(read(path.join(a.codex, 'hooks.json'))).hooks.UserPromptSubmit.length, 2, "Codex runs 4.7's hook and version 5's");
  assert.deepEqual(JSON.parse(read(path.join(home, 'state', 'hosts.json'))).unserved, [], 'every registered host is served');

  // The name taken by another program: that host's server is refused, so its hook is not added either.
  const b = hosts47(ctx.tmp('rb5-w3-taken-'), { takeV5Name: true });
  const hooksBefore = [read(path.join(b.claude, 'settings.json')), read(path.join(b.codex, 'hooks.json'))];
  const r2 = tree.cli(home, ['install', '--from', rel, '--register-hosts'], { env: b.env });
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.deepEqual([read(path.join(b.claude, 'settings.json')), read(path.join(b.codex, 'hooks.json'))], hooksBefore, 'no hook is added for a host whose server entry was refused');
  assert.match(r2.stdout, /Codex is NOT served by version 5 \(a \[mcp_servers\.ruvnet-brain-5\] table outside the managed block\); no hook was added there/);
  assert.deepEqual(JSON.parse(read(path.join(home, 'state', 'hosts.json'))).unserved.map((u) => u.host), ['Claude Code', 'Codex']);

  // The verdict: OK while every registered host is served; DEGRADED, naming the host, while one is not.
  const { assessHome } = await import(pathToFileURL(path.join(tree.root, 'packages', 'health', 'assess.mjs')).href);
  await ctx.server(tree, home);
  const saved = read(path.join(home, 'state', 'hosts.json'));
  fs.writeFileSync(path.join(home, 'state', 'hosts.json'), j({ hosts: {}, unserved: [] }));
  await waitFor(() => assessHome(home).state === 'ok', 30_000, 'the verdict OK with every host served');
  fs.writeFileSync(path.join(home, 'state', 'hosts.json'), saved);
  const v = assessHome(home);
  assert.notEqual(v.state, 'ok', 'a host not served by version 5 must not be reported OK');
  assert.equal(v.cause, 'host-unserved');
  assert.match(v.reason, /Claude Code and Codex not served by version 5/);
  assert.match(tree.cli(home, ['status']).stdout, /RuvNet Brain DEGRADED .*not served by version 5/, 'status prints the same verdict');
});
