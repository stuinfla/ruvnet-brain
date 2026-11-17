// Review F06 (host registration): a host file is never read or written through a symbolic link below
// the host folder. A skills folder whose `ruvnet-brain` entry links to a protected home is refused
// naming that home, and one that links to an ordinary folder is refused too; nothing is written in
// either target or in any host file. A host folder that is itself a link (a dotfiles ~/.claude) still
// registers. The installed shim's own install module is used, as the installer does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NOT_POSIX, fakeHosts, pluginApi } from './wp7-helpers.mjs';

/** Every entry under dir: a file's bytes, a link's target (links are not followed). */
function bytesOf(dir, rel = '', out = {}) {
  for (const e of fs.existsSync(path.join(dir, rel)) ? fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) : []) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(path.join(dir, r))}`;
    else if (e.isDirectory()) bytesOf(dir, r, out);
    else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
  }
  return out;
}

test('integ-plugin-f06 registration refuses a nested link below a host folder and accepts a linked host folder', { skip: NOT_POSIX, timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'integ-plugin-f06');
  const tree = ctx.tree();
  const api = await pluginApi(tree);
  const home = ctx.tmp('rb5-home-');
  api.installShim({ home, appDir: path.join(tree.root, 'packages') });

  // (1) skills/ruvnet-brain -> a protected home (a root the test marker protects).
  const prot = ctx.tmp('rb5-protected-');
  fs.mkdirSync(path.join(prot, 'inner'));
  fs.writeFileSync(path.join(prot, 'inner', 'keep.txt'), 'mine\n');
  const was = process.env.RUVNET_BRAIN5_PROTECTED_HOME;
  process.env.RUVNET_BRAIN5_PROTECTED_HOME = prot;
  t.after(() => (was === undefined ? delete process.env.RUVNET_BRAIN5_PROTECTED_HOME : (process.env.RUVNET_BRAIN5_PROTECTED_HOME = was)));
  const a = ctx.tmp('rb5-hosts-');
  const hostsA = fakeHosts(a);
  fs.mkdirSync(hostsA.claude.skills, { recursive: true });
  fs.symlinkSync(path.join(prot, 'inner'), path.join(hostsA.claude.skills, 'ruvnet-brain'));
  const beforeA = bytesOf(a);
  const beforeProt = bytesOf(prot);
  assert.throws(() => api.registerHosts({ home, hosts: hostsA }), (e) => e.message.includes(fs.realpathSync(prot)), 'a nested link into a protected home must be refused naming that home');
  assert.deepEqual(bytesOf(prot), beforeProt, 'a nested link into a protected home: nothing may be written there');
  assert.deepEqual(bytesOf(a), beforeA, 'a nested link into a protected home: no host file may be written');

  // (2) skills/ruvnet-brain -> an ordinary folder elsewhere; the link itself is refused, marker or not.
  const other = ctx.tmp('rb5-other-');
  const b = ctx.tmp('rb5-hosts-');
  const hostsB = fakeHosts(b);
  fs.mkdirSync(hostsB.claude.skills, { recursive: true });
  fs.symlinkSync(other, path.join(hostsB.claude.skills, 'ruvnet-brain'));
  const beforeB = bytesOf(b);
  assert.throws(() => api.registerHosts({ home, hosts: hostsB }), /symbolic link/, 'a nested link to an ordinary folder must be refused: written through a link');
  assert.deepEqual(bytesOf(other), {}, 'a nested link to an ordinary folder: nothing may be written through it');
  assert.deepEqual(bytesOf(b), beforeB, 'a nested link to an ordinary folder: no host file may be written');

  // (3) dotfiles: the Claude Code folder itself is a link to a real folder elsewhere; that is accepted.
  const dot = ctx.tmp('rb5-dotfiles-');
  const c = ctx.tmp('rb5-hosts-');
  const hostsC = fakeHosts(c);
  fs.cpSync(path.join(c, 'claude'), dot, { recursive: true });
  fs.rmSync(path.join(c, 'claude'), { recursive: true });
  fs.symlinkSync(dot, path.join(c, 'claude'));
  let r;
  assert.doesNotThrow(() => (r = api.registerHosts({ home, hosts: hostsC })), 'a linked host folder (dotfiles) must still register');
  assert.ok(fs.existsSync(path.join(dot, 'skills', 'ruvnet-brain', 'SKILL.md')), `a linked host folder (dotfiles) must still register: ${JSON.stringify(r)}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dot, 'settings.json'), 'utf8')).hooks.UserPromptSubmit.length, 2, 'a linked host folder gets its hook');
  assert.ok(fs.lstatSync(path.join(c, 'claude')).isSymbolicLink(), 'the dotfiles link itself is kept');
  api.unregisterHosts({ home, hosts: hostsC });
  assert.ok(!fs.existsSync(path.join(dot, 'skills', 'ruvnet-brain')), 'unregistering through a linked host folder removes the skill');
});
