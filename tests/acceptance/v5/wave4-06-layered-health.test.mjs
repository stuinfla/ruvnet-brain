// Wave 4, test 6: the layered store's health is part of the one health signal.
//   - a good store: the self-test reports lane `layered` available and the health line is OK;
//   - a missing layered.db, a store that lost its L2 rows (fewer than its build recorded), a store of another format: the self-test reports
//     `layered` unavailable with the reason (checked in process, on pack copies reassembled so every
//     other file still matches);
//   - served: with layered.db removed from the installed pack, the health line is DEGRADED (not DOWN),
//     doctor names the layered store and why, and search still answers in normal mode.
// Break (breaks-wave4.mjs): the self-test leaves the layered check out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setup, waitFor } from './helpers.mjs';
import { built } from './wp5-helpers.mjs';
import { writeKit } from './wave4-helpers.mjs';

test('Wave 4: layered.db health degrades the one verdict and never takes search down', { timeout: 600_000 }, async (t) => {
  const ctx = setup(t, 'wave4-06');
  const tree = ctx.tree();
  const pack = built(ctx, tree, { sources: [writeKit(ctx)] });
  const engine = await import(pathToFileURL(path.join(tree.root, 'packages', 'engine', 'index.mjs')).href);
  const selfTest = (dir) => {
    const h = engine.open(dir);
    try {
      return engine.selfTest(h);
    } finally {
      engine.close(h);
    }
  };
  const layeredLane = (r) => r.lanes.find((l) => l.name === 'layered');
  assert.deepEqual(layeredLane(selfTest(pack)), { name: 'layered', available: true }, 'a good layered store is reported available');

  // Damaged copies, each reassembled so only the layered store is wrong.
  const variant = (edit) => {
    const dir = path.join(ctx.tmp('rb5-var-'), 'pack');
    fs.cpSync(pack, dir, { recursive: true });
    edit(dir);
    tree.reassemble(dir);
    return dir;
  };
  const sql = (dir, q) => {
    const db = new DatabaseSync(path.join(dir, 'layered.db'));
    db.exec(q);
    db.close();
  };
  const missing = path.join(ctx.tmp('rb5-var-'), 'pack');
  fs.cpSync(pack, missing, { recursive: true });
  fs.rmSync(path.join(missing, 'layered.db'));
  const cases = [
    ['missing', missing, /the layered store layered\.db is missing or has the wrong size/],
    ['no L2 rows', variant((d) => sql(d, 'DELETE FROM l2; VACUUM;')), /the layered store has 0 L2 rows; its build recorded \d+/],
    ['other format', variant((d) => sql(d, "UPDATE meta SET value='9' WHERE key='format'; VACUUM;")), /the layered store has format 9, which this engine does not read/],
  ];
  for (const [what, dir, why] of cases) {
    const r = selfTest(dir);
    assert.equal(r.ok, true, `${what}: the probes still pass (search is unaffected)`);
    const l = layeredLane(r);
    assert.equal(l?.available, false, `${what}: lane layered unavailable`);
    assert.match(l.reason, why);
  }

  // Served: install, see OK; remove the store, restart, see DEGRADED with search still normal.
  const home = ctx.tmp('rb5-home-');
  const inst = tree.cli(home, ['install', '--from', tree.release(pack)]);
  assert.equal(inst.status, 0, `install failed: ${inst.stdout}\n${inst.stderr}`);
  const srv = await ctx.server(tree, home);
  await waitFor(() => tree.hook(home).line.includes('RuvNet Brain OK'), 15_000, 'the OK health line with a good layered store');
  await srv.close();
  const ptr = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
  fs.rmSync(path.join(home, 'packs', ptr.pack, 'layered.db'));
  const srv2 = await ctx.server(tree, home);
  const line = await waitFor(() => {
    const l = tree.hook(home).line;
    return /RuvNet Brain (DEGRADED|DOWN|OK)/.test(l) && !l.includes('UNKNOWN') ? l : null;
  }, 15_000, 'a settled health line');
  assert.match(line, /RuvNet Brain DEGRADED/, `a missing layered store degrades the verdict: ${line}`);
  assert.match(line, /lane layered unavailable/);
  const doc = tree.cli(home, ['doctor']);
  assert.match(doc.stdout + doc.stderr, /lane layered unavailable: the layered store layered\.db is missing or has the wrong size/, 'doctor names the layered store and why');
  const s = await srv2.search('episodic memory key value');
  assert.equal(s.isError, false, s.text.slice(0, 300));
  assert.match(s.mode, /^MODE · normal$/, 'search is not in safe mode');
  await srv2.close();
});
