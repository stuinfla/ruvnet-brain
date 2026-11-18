// Wave 2 end to end, in temporary folders only (brain home, user home, host settings, projects):
// a pack built by the real builder (files and history), sealed and signed through the release rail
// with a throwaway key, installed by the real installer from a folder with --register-hosts into
// stand-in host settings, the search server started by its registered command (the absolute launcher),
// searches (a FILES and HISTORY hit, a result within both delivery ceilings, a private pack answering
// only its listed project), the prompt hook and `doctor` printing one verdict in three states (ok,
// server not running, pack damaged) with the owner page sent for the DOWN state, an update to a second
// release, a third release rolled back by its failing check through the real server, and an uninstall
// that leaves nothing in the brain home and every host file as it was.
// Breaks: one per claim, in breaks.mjs (wave2-e2e-*).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, setup, waitFor, writeConfig } from './helpers.mjs';
import { built } from './wp5-helpers.mjs';
import { installPrivate, writeRepo } from './wp2-helpers.mjs';
import { appVersion, rail } from './wp6-helpers.mjs';
import { NOT_POSIX, bytesOf, runHost } from './wp7-helpers.mjs';
import { denseFile, pageReceiver, registered, serveRegistered, tokens, userWithHosts } from './wave2-helpers.mjs';

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wp5-fixtures', 'history', 'beta-memory');
// S9's failing app: the worker answers every call with an error while the engine is unchanged, so the
// check before the switch passes and the check through the real server after it fails.
const BROKEN_WORKER = { file: 'packages/server/worker.mjs', find: "parentPort.on('message', (m) => {", replace: "parentPort.on('message', (m) => {\n  if (m) { parentPort.postMessage({ id: m.id, ok: false, error: 'this app build is broken (test fixture)' }); return; }" };
const PRIVATE_FILE = 'private:owner-notes/owner-notes/meetings/notes.md'; // F17: private items cite their pack

test('Wave 2 end to end: build, seal, install, serve, one verdict, update, roll back, uninstall', { skip: NOT_POSIX, timeout: 900_000 }, async (t) => {
  const ctx = setup(t, 'wave2-end-to-end');
  const tree = ctx.tree();
  const seal = (tr, pack, number) => {
    const rel = path.join(ctx.tmp('rb5-e2e-rel-'), 'release');
    const r = rail(tr, ['seal', '--pack', pack, '--out', rel, '--version', appVersion(tr), '--release-number', String(number)]);
    assert.equal(r.status, 0, `the rail must seal release ${number}: ${r.out}`);
    return rel;
  };
  const dense = writeRepo(ctx.tmp('rb5-e2e-dense-'), 'stormglass-dense', Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [`src/kernel_${k}.js`, denseFile(k)])));
  const sourcesList = (extra) => {
    const list = path.join(ctx.tmp('rb5-e2e-list-'), 'sources.json');
    const sources = [{ dir: repo('alpha-vectors') }, { dir: repo('beta-memory'), history: { owner: 'stellarowner', recorded: RECORDED } }, { dir: repo('gamma-swarm') }, { dir: dense }, ...extra.map((dir) => ({ dir }))];
    fs.writeFileSync(list, JSON.stringify({ sources }));
    return list;
  };

  // Build and seal release 1 (files, history, the dense kernels).
  const pack1 = built(ctx, tree, { list: sourcesList([]) });
  const rel1 = seal(tree, pack1, 1);

  // Install it from the folder, registering the stand-in hosts.
  const u = userWithHosts(ctx);
  const userBefore = bytesOf(u.user);
  const home = path.join(ctx.tmp('rb5-e2e-'), 'brain');
  const page = await pageReceiver(t);
  writeConfig(home, { probeIntervalMs: 500, heartbeatMs: 200, pageTopic: page.url, pageAfterMs: 0 });
  const cli = (args) => tree.cli(home, args, { env: u.env });
  const inst = cli(['install', '--from', rel1, '--register-hosts']);
  assert.equal(inst.status, 0, `install: ${inst.stdout}\n${inst.stderr}`);
  const signed = JSON.parse(fs.readFileSync(path.join(rel1, 'release.json'), 'utf8'));
  const pointer = () => JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
  assert.equal(pointer().minShim, signed.minShim, 'current.json records the release’s minShim');
  const reg = registered(u);
  assert.ok(reg.hook && reg.server, `the hook and the server are registered: ${inst.stdout}`);
  assert.equal(fs.realpathSync(reg.server.command), fs.realpathSync(path.join(home, 'shim', 'plugin', 'claude', 'bin', 'rb5')), 'the server command is the absolute launcher');

  // Private pack, listed for one project only.
  const projects = ctx.tmp('rb5-e2e-proj-');
  const listed = path.join(projects, 'client-work');
  const elsewhere = path.join(projects, 'side-project');
  for (const d of [listed, elsewhere]) fs.mkdirSync(d, { recursive: true });
  const notes = writeRepo(ctx.tmp('rb5-e2e-notes-'), 'owner-notes', { 'meetings/notes.md': '# Meeting\n\nThe saltmarrow pricing was agreed with the client on Tuesday.\n' });
  installPrivate(home, built(ctx, tree, { sources: [notes] }), 'owner-notes', [listed]);

  // Search through the registered server.
  let srv = await serveRegistered(t, reg.server, { cwd: listed, env: u.env });
  const both = await srv.search('harborwisp hnsw index');
  assert.equal(both.mode, 'MODE · normal', both.text.slice(0, 300));
  assert.ok(/^FILES \([1-9]/m.test(both.text) && /^HISTORY \([1-9]/m.test(both.text), `FILES and HISTORY must both answer: ${both.text.slice(0, 600)}`);
  const full = await srv.search('stormglass kernel', { detail: 'full' });
  assert.ok(full.text.length <= 44_000, `the result is ${full.text.length} characters, over the 44000 the host delivers`);
  assert.ok(tokens(full.text) <= 20_000, `the result is about ${tokens(full.text)} tokens, over the 20000 the host delivers`);
  assert.match(full.text, /trimmed \d+ characters/, 'the dense fixture must need trimming to fit');
  assert.ok((await srv.search('saltmarrow pricing')).files.some((f) => f.file === PRIVATE_FILE), 'the private pack answers its listed project');
  const other = await serveRegistered(t, reg.server, { cwd: elsewhere, env: u.env });
  assert.ok(!(await other.search('saltmarrow pricing')).text.includes('owner-notes'), 'a private pack must not answer an unlisted project');
  await other.close();

  // One verdict from the hook and doctor: ok, not running, pack damaged (with the owner page).
  const hookLine = () => runHost(reg.hook.command, { cwd: listed, env: u.env }).line;
  const agree = (state, ok) => {
    const line = hookLine();
    const doc = cli(['doctor']);
    assert.equal(doc.stdout.split('\n')[0], line, `doctor and the hook must agree in state ${state}:\n${doc.stdout}`);
    assert.equal(doc.status === 0, ok, `doctor's exit code in state ${state}: ${doc.status}, line ${line}`);
    return line;
  };
  await waitFor(() => /^\[RuvNet Brain OK /.test(hookLine()), 20_000, 'the OK line');
  agree('ok', true);
  await srv.close();
  await waitFor(() => /^\[RuvNet Brain NOT RUNNING/.test(hookLine()), 10_000, 'the NOT RUNNING line');
  agree('not running', false);
  srv = await serveRegistered(t, reg.server, { cwd: listed, env: u.env });
  await waitFor(() => /^\[RuvNet Brain OK /.test(hookLine()), 20_000, 'the OK line again');
  assert.ok(!page.got.some((m) => /DOWN/.test(m)), 'no page while healthy');
  const db = path.join(home, 'packs', pointer().pack, 'lexical.db');
  const fd = fs.openSync(db, 'r+');
  fs.writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0);
  fs.closeSync(fd);
  await waitFor(() => /^\[RuvNet Brain DOWN/.test(hookLine()), 20_000, 'the DOWN line');
  agree('pack damaged', false);
  await waitFor(() => page.got.some((m) => /RuvNet Brain DOWN/.test(m)), 20_000, 'the owner page for the DOWN state').catch(() => {});
  assert.ok(page.got.some((m) => /RuvNet Brain DOWN/.test(m)), `the owner page must be sent while DOWN: ${JSON.stringify(page.got)}`);
  await srv.close();

  // Update to release 2 (a fourth repository), then the registered server answers from it.
  const pack2 = built(ctx, tree, { list: sourcesList([repo('delta-graph')]) });
  const rel2 = seal(tree, pack2, 2);
  const up = cli(['update', '--from', rel2]);
  assert.equal(up.status, 0, `update to the second release: ${up.stdout}\n${up.stderr}`);
  assert.equal(pointer().releaseNumber, 2);
  const probe = JSON.parse(fs.readFileSync(path.join(rel2, 'pack', 'PROBES.json'), 'utf8')).probes.find((p) => p.expect.startsWith('delta-graph/'));
  srv = await serveRegistered(t, reg.server, { cwd: listed, env: u.env });
  assert.ok((await srv.search(probe.question)).files.some((f) => f.file === probe.expect), 'the updated pack answers through the registered server');
  await srv.close();

  // Release 3: its app fails through the real server after the switch, so it is rolled back.
  const broken = ctx.tree({ keys: tree.keys, patches: [BROKEN_WORKER, { file: 'packages/version.json', create: '{ "app": "5.0.0-e2e.3" }\n' }] });
  const rel3 = seal(broken, pack2, 3);
  const before = fs.readFileSync(path.join(home, 'current.json'));
  const bad = cli(['update', '--from', rel3]);
  assert.notEqual(bad.status, 0, `a release failing its check through the real server must be rolled back: ${bad.stdout}`);
  assert.match(`${bad.stdout}${bad.stderr}`, /the previous version was put back/);
  assert.deepEqual(fs.readFileSync(path.join(home, 'current.json')), before, 'the pointer is back byte for byte');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state', 'update.json'), 'utf8')).result, 'rolled-back');

  // Uninstall: nothing left in the brain home, every host file as it was.
  const un = cli(['uninstall', '--purge-private']);
  assert.equal(un.status, 0, `uninstall leaves nothing: ${un.stdout}\n${un.stderr}`);
  assert.equal(fs.existsSync(home), false, `uninstall leaves nothing: ${un.stdout}`);
  assert.deepEqual(bytesOf(u.user), userBefore, 'every host file is back byte for byte');
});
