// WP7-08 the test guard and the opt-in. Under the test marker (RUVNET_BRAIN5_TEST=1, set by the shared
// harness) the host-registration code refuses, before it reads or writes anything, every host file and
// every brain home that lies under the real user's home folder. Each check here is aimed at a temporary
// folder named as an extra protected root (RUVNET_BRAIN5_PROTECTED_HOME, which can only add roots), so
// that with the guard broken the writes land in that temporary folder and never in the real home.
// The installer registers hosts only when asked with --register-hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { NOT_POSIX, bytesOf, fakeHosts, installedShim } from './wp7-helpers.mjs';

test('WP7-08 no test can write under the real home, and registration is opt-in', { skip: NOT_POSIX, timeout: 300_000 }, async (t) => {
  assert.equal(process.env.RUVNET_BRAIN5_TEST, '1', 'the shared harness sets the test marker');
  const ctx = setup(t, 'wp7-08');
  const tree = ctx.tree();
  const { home, api } = await installedShim(ctx, tree);

  // The real home is refused by path alone (a pure check: nothing is read or written).
  const real = os.userInfo().homedir;
  for (const f of [path.join(real, '.claude', 'settings.json'), path.join(real, '.claude.json'), path.join(real, '.codex', 'config.toml'), path.join(real, 'brain-home')]) {
    assert.throws(() => api.refuseProtected([f]), api.HostRefused, `a test run must refuse ${f}`);
  }
  assert.doesNotThrow(() => api.refuseProtected([path.join(real, '.claude', 'settings.json')], { RUVNET_BRAIN5_TEST: undefined }), 'outside a test run the user’s own install may write there');

  // A protected stand-in for the real home: registration, unregistration and the shim all refuse it.
  const guarded = ctx.tmp('rb5-protected-');
  const hosts = fakeHosts(path.join(guarded, 'hosts'));
  const before = bytesOf(guarded);
  const prev = process.env.RUVNET_BRAIN5_PROTECTED_HOME;
  process.env.RUVNET_BRAIN5_PROTECTED_HOME = guarded;
  t.after(() => (prev === undefined ? delete process.env.RUVNET_BRAIN5_PROTECTED_HOME : (process.env.RUVNET_BRAIN5_PROTECTED_HOME = prev)));
  assert.throws(() => api.registerHosts({ home, hosts }), (e) => e instanceof api.HostRefused && /test run/.test(e.message), 'registering into a protected home must refuse');
  assert.throws(() => api.unregisterHosts({ home, hosts }), api.HostRefused, 'unregistering from a protected home must refuse');
  assert.throws(() => api.installShim({ home: path.join(guarded, 'brain') }), api.HostRefused, 'a shim under a protected home must refuse');
  assert.deepEqual(bytesOf(guarded), before, 'a refused call must refuse before it writes anything');
  assert.equal(fs.existsSync(path.join(guarded, 'brain')), false, 'no brain home was made');

  // The installer: without --register-hosts no host file is touched; with it, the (temporary) host
  // files named by the environment get the entries.
  delete process.env.RUVNET_BRAIN5_PROTECTED_HOME;
  const user = ctx.tmp('rb5-user-');
  const fake = fakeHosts(user);
  fs.renameSync(path.join(user, 'claude'), path.join(user, '.claude'));
  fs.renameSync(path.join(user, 'codex'), path.join(user, '.codex'));
  const hostEnv = { HOME: user, CLAUDE_CONFIG_DIR: path.join(user, '.claude'), CODEX_HOME: path.join(user, '.codex') };
  fs.renameSync(fake.claude.state, path.join(user, '.claude', '.claude.json'));
  const userBefore = bytesOf(user);
  const rel = tree.release(tree.build(THREE), { number: 2, version: '5.0.8' });
  const brain = path.join(ctx.tmp('rb5-optin-'), 'brain');
  const plain = tree.cli(brain, ['install', '--from', rel], { env: hostEnv });
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(bytesOf(user), userBefore, 'install without --register-hosts must not touch any host file');
  const reg = tree.cli(brain, ['install', '--from', rel, '--register-hosts'], { env: hostEnv });
  assert.equal(reg.status, 0, reg.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(user, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 2, `--register-hosts must add the prompt hook: ${reg.stdout}`);
  const un = tree.cli(brain, ['uninstall'], { env: hostEnv });
  assert.equal(un.status, 0, `${un.stdout}\n${un.stderr}`);
  assert.deepEqual(bytesOf(user), userBefore, 'uninstall must put every host file back byte for byte');
  assert.equal(fs.existsSync(brain), false, `uninstall leaves nothing: ${un.stdout}`);
});
