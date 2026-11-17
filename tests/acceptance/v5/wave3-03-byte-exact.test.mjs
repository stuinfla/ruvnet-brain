// Wave 3 (c): uninstall restores exactly the bytes that were there before registration. Four starting
// states for every shared host file (Claude Code settings.json and .claude.json, Codex config.toml and
// hooks.json): absent, an empty object, other entries, and an existing unrelated hook. Registering
// twice must not capture version 5's own entries as "before". The copy is kept in the brain home with
// its hash, mode 0600. A file the host or the user changed after registration is never rolled back to
// old bytes: only version 5's entries are removed from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NOT_POSIX, bytesOf, installedShim } from './wp7-helpers.mjs';

const j = (v) => JSON.stringify(v, null, 4) + '\n';
const STATES = {
  absent: null,
  'empty object': { settings: '{}', state: '{}', config: '', hooks: '{}' },
  'other entries': { settings: j({ model: 'x', permissions: { allow: ['Bash(ls)'] } }), state: j({ numStartups: 3, mcpServers: { other: { command: '/opt/o' } } }), config: 'model = "m"\n\n[mcp_servers.other]\ncommand = "/opt/o"\n', hooks: j({ note: 'kept' }) },
  'unrelated hook': { settings: j({ hooks: {} }), state: j({ hooks: {}, mcpServers: {} }), config: '# mine\n', hooks: j({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/bin/true' }] }] } }) },
};

function hostsIn(dir, files) {
  const h = {
    claude: { settings: path.join(dir, 'claude', 'settings.json'), state: path.join(dir, 'claude.json'), skills: path.join(dir, 'claude', 'skills'), commands: path.join(dir, 'claude', 'commands') },
    codex: { config: path.join(dir, 'codex', 'config.toml'), hooks: path.join(dir, 'codex', 'hooks.json') },
  };
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  if (files) {
    fs.writeFileSync(h.claude.settings, files.settings);
    fs.writeFileSync(h.claude.state, files.state);
    fs.writeFileSync(h.codex.config, files.config);
    fs.writeFileSync(h.codex.hooks, files.hooks);
  }
  return h;
}

test('Wave 3 uninstall puts every host file back byte for byte, from four starting states', { skip: NOT_POSIX, timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave3-03');
  const tree = ctx.tree();
  const { home, api, shim } = await installedShim(ctx, tree);
  const backups = path.join(home, 'state', 'host-backup');
  const shimHooks = path.join(home, 'shim', 'plugin', 'claude', 'hooks', 'hooks.json');
  const hooksText = fs.readFileSync(shimHooks, 'utf8');
  assert.ok(hooksText.includes('"timeout": 5'), 'the installed prompt hook has its timeout');

  for (const [name, files] of Object.entries(STATES)) {
    const dir = ctx.tmp('rb5-w3-hosts-');
    const hosts = hostsIn(dir, files);
    const before = bytesOf(dir);
    api.registerHosts({ home, hosts });
    const registered = bytesOf(dir);
    for (const f of [hosts.claude.settings, hosts.claude.state, hosts.codex.config, hosts.codex.hooks]) {
      assert.ok(fs.readFileSync(f, 'utf8').includes(shim.launcher), `${name}: ${path.basename(f)} names version 5 after registration`);
    }
    for (const b of fs.readdirSync(backups)) assert.equal(fs.statSync(path.join(backups, b)).mode & 0o777, 0o600, `${name}: a pre-registration copy is readable by its owner only`);
    api.registerHosts({ home, hosts });
    assert.deepEqual(bytesOf(dir), registered, `${name}: registering twice gives the same bytes`);
    // An update whose hook entry differs re-registers over version 5's own entries: the copy taken
    // first must survive it (a copy taken now would hold version 5's entries as "before").
    fs.writeFileSync(shimHooks, hooksText.replace('"timeout": 5', '"timeout": 6'));
    api.registerHosts({ home, hosts });
    assert.notDeepEqual(bytesOf(dir), registered, `${name}: the changed hook entry was written`);
    fs.writeFileSync(shimHooks, hooksText);
    api.unregisterHosts({ home, hosts });
    assert.deepEqual(bytesOf(dir), before, `${name}: uninstall restores exactly the bytes from before registration`);
    assert.deepEqual(fs.existsSync(backups) ? fs.readdirSync(backups) : [], [], `${name}: no pre-registration copy is left behind`);
  }

  // A file changed after registration keeps that change; only version 5's entries leave it.
  const dir = ctx.tmp('rb5-w3-edited-');
  const hosts = hostsIn(dir, STATES['other entries']);
  api.registerHosts({ home, hosts });
  const state = JSON.parse(fs.readFileSync(hosts.claude.state, 'utf8'));
  fs.writeFileSync(hosts.claude.state, JSON.stringify({ ...state, numStartups: 4, tipsHistory: { a: 1 } }, null, 2) + '\n');
  api.unregisterHosts({ home, hosts });
  const after = JSON.parse(fs.readFileSync(hosts.claude.state, 'utf8'));
  assert.equal(after.numStartups, 4, 'a change made after registration is kept by uninstall');
  assert.deepEqual(after.tipsHistory, { a: 1 }, 'a change made after registration is kept by uninstall');
  assert.equal(JSON.stringify(after).includes(shim.launcher), false, 'version 5 entries are removed from a file changed after registration');
  assert.equal(fs.readFileSync(hosts.claude.settings, 'utf8'), STATES['other entries'].settings, 'an unchanged file still gets its exact bytes back');
});
