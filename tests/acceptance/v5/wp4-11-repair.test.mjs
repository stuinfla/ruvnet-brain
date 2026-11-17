// WP4 the health line's own fix works: install from a web address (recorded as the update address),
// update from it with no --from, damage the active pack's index in place, read the fix command from
// `doctor` and run it exactly as printed. The damaged copy is set aside and fetched again, the check
// passes, the line is OK again, no damaged copy is left, and the earlier generation is still kept.
// Break: an installed copy of the release is trusted without re-checking its hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, cliAsync, pointerOf, serveRelease } from './wp4-helpers.mjs';
import { THREE, readStatus, repo, setup, waitFor } from './helpers.mjs';

test('WP4-11 the fix printed on the DOWN line repairs a damaged pack', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp4-11');
  const tree = ctx.tree();
  const rel1 = tree.release(tree.build(THREE), { number: 1, version: '5.0.1' });
  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const gen2 = JSON.parse(fs.readFileSync(path.join(pack2, 'PACK.json'), 'utf8')).generation;
  const rel2 = tree.release(pack2, { number: 2, version: '5.0.2' });
  let serving = rel1;
  const web = await serveRelease(() => serving);
  t.after(() => web.close());
  const home = ctx.tmp('rb5-home-');
  assertScratch(home);

  const i = await cliAsync(tree, home, ['install', '--from', web.url]);
  assert.equal(i.status, 0, i.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state', 'config.json'), 'utf8')).updateUrl, web.url, 'a first install from a web address records it as the update address');
  serving = rel2;
  const u = await cliAsync(tree, home, ['update']);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(pointerOf(home).releaseNumber, 2, 'update with no --from used the recorded address');

  const db = path.join(home, 'packs', gen2, 'lexical.db');
  const fd = fs.openSync(db, 'r+');
  fs.writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0);
  fs.closeSync(fd);
  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe && !readStatus(home, srv.pid).probe.ok, 20_000, 'the damaged pack to fail its self-test');
  const doc = tree.cli(home, ['doctor']);
  assert.equal(doc.status, 1);
  const fix = /· fix: ruvnet-brain ([^\]]+)\]/.exec(doc.stdout.split('\n')[0]);
  assert.ok(fix && /DOWN/.test(doc.stdout), `doctor must say DOWN with a fix: ${doc.stdout}`);
  await srv.close();

  const repair = await cliAsync(tree, home, fix[1].trim().split(/\s+/));
  assert.equal(repair.status, 0, `the printed fix "ruvnet-brain ${fix[1]}" must work: ${repair.stdout}\n${repair.stderr}`);
  const after = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, after.pid)?.probe, 20_000, 'the repaired pack to be probed');
  assert.equal(readStatus(home, after.pid).probe.ok, true, 'the repaired pack passes its self-test');
  assert.match(tree.hook(home).line, /^\[RuvNet Brain OK/);
  const packs = fs.readdirSync(path.join(home, 'packs')).sort();
  assert.ok(!packs.some((n) => n.includes('.damaged-') || n.endsWith('.partial')), `no damaged or partial copy is left: ${packs}`);
  assert.equal(packs.length, 2, `the earlier generation is still kept: ${packs}`);
  assert.equal(pointerOf(home).previous?.releaseNumber, 1);
  t.diagnostic(`fix run as printed: ruvnet-brain ${fix[1]}`);
});
