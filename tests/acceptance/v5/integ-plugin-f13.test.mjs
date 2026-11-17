// Review F13 (host registration and uninstall): (a) uninstall removes only version 5's own hooks, so a
// hook the user later put in the same group stays; (b) a Codex managed block with no closing line is
// refused, by registration and by uninstall, and the file is left as it was; (c) every replace and
// restore keeps the host file's mode (0640 and 0600 here, which no common umask produces both of):
// registration, the byte-exact restore, and the surgical uninstall after a user edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NOT_POSIX, fakeHosts, pluginApi } from './wp7-helpers.mjs';

async function shimmed(t) {
  const ctx = setup(t, 'integ-plugin-f13');
  const tree = ctx.tree();
  const api = await pluginApi(tree);
  const home = ctx.tmp('rb5-home-');
  api.installShim({ home, appDir: path.join(tree.root, 'packages') });
  return { ctx, api, home };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

test('integ-plugin-f13 uninstall keeps a hook the user added to the group version 5 registered', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const { ctx, api, home } = await shimmed(t);
  const hosts = fakeHosts(ctx.tmp('rb5-hosts-'));
  api.registerHosts({ home, hosts });
  const s = readJson(hosts.claude.settings);
  const users = { type: 'command', command: '/usr/local/bin/added-later', timeout: 5 };
  s.hooks.UserPromptSubmit[1].hooks.push(users);
  fs.writeFileSync(hosts.claude.settings, JSON.stringify(s, null, 2) + '\n');
  api.unregisterHosts({ home, hosts });
  const after = readJson(hosts.claude.settings).hooks.UserPromptSubmit;
  const all = after.flatMap((g) => g.hooks);
  assert.ok(all.some((h) => h.command === users.command), `a hook the user added to the registered group must stay after uninstall: ${JSON.stringify(after)}`);
  assert.ok(!all.some((h) => h.command.includes(home)), 'version 5\'s own hook is removed');
  assert.equal(after.length, 2, 'the user\'s first group and the group holding the added hook both remain');
});

test('integ-plugin-f13 a Codex managed block with no closing line is refused, never cut to the end of the file', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const { ctx, api, home } = await shimmed(t);
  const hosts = fakeHosts(ctx.tmp('rb5-hosts-'));
  const text = 'model = "gpt-x"\n\n# --- ruvnet-brain 5 (managed block; the installer rewrites it, everything outside it is yours) ---\n[mcp_servers.ruvnet-brain-5]\ncommand = "/old"\n\n[profiles.mine]\nmodel = "keep-me"\n';
  fs.writeFileSync(hosts.codex.config, text);
  assert.throws(() => api.registerHosts({ home, hosts }), /not its last/, 'an unterminated managed block must be refused by registration');
  assert.equal(fs.readFileSync(hosts.codex.config, 'utf8'), text, 'an unterminated managed block: registration must leave config.toml as it was');
  assert.throws(() => api.unregisterHosts({ home, hosts }), /not its last/, 'an unterminated managed block must be refused by uninstall');
  assert.equal(fs.readFileSync(hosts.codex.config, 'utf8'), text, 'an unterminated managed block: uninstall must leave config.toml as it was');
});

test('integ-plugin-f13 registration, the byte-exact restore and the surgical uninstall keep each host file\'s mode', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const { ctx, api, home } = await shimmed(t);
  const set = (h) => {
    fs.chmodSync(h.claude.settings, 0o640);
    fs.chmodSync(h.claude.state, 0o600);
    fs.chmodSync(h.codex.config, 0o640);
  };
  const check = (h, when) => {
    assert.deepEqual([mode(h.claude.settings), mode(h.claude.state), mode(h.codex.config)], ['640', '600', '640'], `${when}: each host file keeps its mode`);
  };
  const exact = fakeHosts(ctx.tmp('rb5-hosts-'));
  set(exact);
  api.registerHosts({ home, hosts: exact });
  check(exact, 'registration');
  api.unregisterHosts({ home, hosts: exact });
  check(exact, 'the byte-exact restore');

  const edited = fakeHosts(ctx.tmp('rb5-hosts-'));
  set(edited);
  api.registerHosts({ home, hosts: edited });
  for (const f of [edited.claude.settings, edited.claude.state]) fs.writeFileSync(f, JSON.stringify({ ...readJson(f), userEdit: true }, null, 2) + '\n');
  fs.appendFileSync(edited.codex.config, '\n[profiles.later]\nmodel = "y"\n');
  api.unregisterHosts({ home, hosts: edited });
  assert.equal(readJson(edited.claude.settings).userEdit, true, 'the surgical uninstall keeps the user\'s edit');
  check(edited, 'the surgical uninstall');
});
