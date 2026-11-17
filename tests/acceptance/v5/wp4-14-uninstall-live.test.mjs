// WP4 / review F12: (1) uninstall while a search server is still running in an open session: after
// "nothing listed remains", several heartbeats later the brain home has not been brought back by that
// server. (2) uninstall refused because another install holds the lock changes nothing, and the host
// registration in particular is still in place (the lock is taken before any host file is touched).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, sleep, sleeper, waitFor, writeConfig } from './helpers.mjs';
import { NOT_POSIX, fakeHosts, installedShim } from './wp7-helpers.mjs';

test('WP4-14 uninstall is one locked transaction and a live server never recreates the home (review F12)', { skip: NOT_POSIX, timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-14');
  const tree = ctx.tree();

  // (1) A live server outlives the uninstall.
  const { home } = ctx.installed(tree);
  writeConfig(home, { heartbeatMs: 150 });
  const srv = await ctx.server(tree, home);
  t.after(() => srv.close().catch(() => {}));
  await waitFor(() => fs.existsSync(path.join(home, 'state', 'status', `${srv.pid}.json`)), 20_000, 'the server status file');
  const un = tree.cli(home, ['uninstall']);
  assert.equal(un.status, 0, `${un.stdout}${un.stderr}`);
  assert.match(un.stdout, /nothing listed remains/);
  await sleep(1500);
  const back = fs.existsSync(home) ? fs.readdirSync(home, { recursive: true }) : [];
  assert.deepEqual(back, [], `a running server brought the uninstalled home back: ${back.join(', ')}`);

  // (2) A refused uninstall leaves the host registration in place.
  const shimmed = await installedShim(ctx, tree);
  const hosts = fakeHosts(ctx.tmp('rb5-hosts-'));
  shimmed.api.registerHosts({ home: shimmed.home, hosts });
  const { recordHosts } = await import(pathToFileURL(path.join(tree.root, 'packages', 'cli', 'hosts.mjs')).href);
  recordHosts(shimmed.home, hosts, { unserved: [] });
  const before = fs.readFileSync(hosts.claude.settings, 'utf8');
  assert.ok(before.includes(shimmed.shim.launcher), 'version 5 is registered');
  const holder = sleeper();
  t.after(() => holder.kill());
  fs.writeFileSync(path.join(shimmed.home, 'state', 'lock.json'), JSON.stringify({ pid: holder.pid, at: Date.now() }));
  const refused = tree.cli(shimmed.home, ['uninstall']);
  assert.notEqual(refused.status, 0, 'uninstall must be refused while another install holds the lock');
  assert.match(`${refused.stdout}${refused.stderr}`, /another install, update or uninstall is running/);
  assert.equal(fs.readFileSync(hosts.claude.settings, 'utf8'), before, 'a refused uninstall must not have removed the host registration');
  assert.ok(fs.existsSync(path.join(shimmed.home, 'current.json')), 'a refused uninstall removes nothing');
});
