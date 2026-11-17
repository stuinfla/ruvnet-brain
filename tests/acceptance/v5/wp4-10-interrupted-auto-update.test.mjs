// WP4 an automatic update killed part-way is put right by the next session: a server applying an
// update from inside itself is killed (the whole process, SIGKILL) right after the switch, before the
// check through the real server, and again in a second run after the commit, before the prune. A new
// session then sees the interrupted transaction, undoes or finishes it, applies the release through
// the full check, and answers from the new pack; no journal or lock is left.
// Break: the updater ignores an interrupted transaction (it only looks at release numbers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, KILL_STEP, pointerOf, serveRelease } from './wp4-helpers.mjs';
import { THREE, repo, setup, waitFor, writeConfig } from './helpers.mjs';

const Q = 'zephyrlattice mincut walker';
const stepsOf = (r) => r.stderr.split('\n').filter((l) => l.startsWith('wp4-step ')).map((l) => l.slice(9));

test('WP4-10 an automatic update killed part-way is finished by the next session', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp4-10');
  const tree = ctx.tree({ patches: [KILL_STEP] });
  const rel1 = tree.release(tree.build(THREE), { number: 1, version: '5.0.1' });
  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const gen2 = JSON.parse(fs.readFileSync(path.join(pack2, 'PACK.json'), 'utf8')).generation;
  const rel2 = tree.release(pack2, { number: 2, version: '5.0.2' });
  const web = await serveRelease(rel2);
  t.after(() => web.close());

  const probeHome = ctx.tmp('rb5-home-');
  assert.equal(tree.cli(probeHome, ['install', '--from', rel1]).status, 0);
  const steps = stepsOf(tree.cli(probeHome, ['update', '--from', rel2]));
  const journal = (home) => path.join(home, 'state', 'journal.json');

  for (const at of ['post-probe', 'prune']) {
    const home = ctx.tmp('rb5-home-');
    assertScratch(home);
    assert.equal(tree.cli(home, ['install', '--from', rel1]).status, 0);
    writeConfig(home, { updateIntervalMs: 200, updateUrl: web.url });
    const n = steps.indexOf(at) + 1;
    assert.ok(n > 0, `step ${at} exists: ${steps}`);
    const doomed = await ctx.server(tree, home, { env: { WP4_KILL_AT: String(n) } });
    const code = await new Promise((r) => doomed.child.on('exit', (c, sig) => r(sig ?? c)));
    assert.equal(code, 'SIGKILL', `the first session dies at step ${at}`);
    assert.ok(fs.existsSync(journal(home)), `killed at ${at}: the transaction is left interrupted`);
    assert.equal(pointerOf(home).releaseNumber, 2, `killed at ${at}: the pointer already names the new release`);

    const srv = await ctx.server(tree, home);
    await waitFor(() => !fs.existsSync(journal(home)) && fs.existsSync(path.join(home, 'state', 'update-check.json')) && JSON.parse(fs.readFileSync(path.join(home, 'state', 'update-check.json'), 'utf8')).applied, 60_000, `the next session to put the update killed at ${at} right`).catch((e) => {
      throw new Error(`killed at ${at}: the interrupted update was never put right (${e.message}); journal ${fs.existsSync(journal(home)) ? 'still there' : 'gone'}`);
    });
    const check = JSON.parse(fs.readFileSync(path.join(home, 'state', 'update-check.json'), 'utf8'));
    assert.equal(check.applied.ok, true, `killed at ${at}: ${check.applied.message}`);
    assert.equal(fs.existsSync(path.join(home, 'state', 'lock.json')), false, 'no lock is left');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state', 'update.json'), 'utf8')).result, 'installed');
    assert.deepEqual(pointerOf(home), { app: '5.0.2', pack: gen2, releaseNumber: 2, previous: pointerOf(home).previous });
    assert.equal(pointerOf(home).previous?.app, '5.0.1', 'the earlier generation is the one kept');
    const r = await srv.search(Q);
    assert.ok(r.header.includes(`pack ${gen2}`) && r.mode === 'MODE · normal', `killed at ${at}: the next session answers from the new pack: ${r.header} ${r.mode}`);
    await srv.close();
  }
});
