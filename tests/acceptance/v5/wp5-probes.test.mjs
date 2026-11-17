// WP5 probes (ROADMAP A4, WP 5): every probe the builder writes passes against the pack it was written
// for, and fails when the file it expects is removed from the pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { THREE, built, readJson, reassemble, repo, selfTest, setup } from './wp5-helpers.mjs';

test('WP5 every probe passes on its pack and fails without its file', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp5-probes');
  const tree = ctx.tree();
  const pack = built(ctx, tree, { sources: [...THREE, repo('delta-graph')] });
  const { probes } = readJson(path.join(pack, 'PROBES.json'));
  assert.equal(probes.length, 4, 'one probe per repository (recipe probes.perRepo = 1)');
  assert.deepEqual(probes.map((p) => p.repo), ['alpha-vectors', 'beta-memory', 'delta-graph', 'gamma-swarm']);
  const ok = selfTest(tree, pack);
  assert.equal(ok.ok, true, JSON.stringify(ok.results));
  assert.equal(ok.results.filter((r) => r.pass).length, 4);

  for (const p of probes) {
    const copy = path.join(ctx.tmp('rb5-pack-'), 'pack');
    fs.cpSync(pack, copy, { recursive: true });
    const db = new DatabaseSync(path.join(copy, 'lexical.db'));
    const ids = db.prepare('SELECT id FROM units WHERE repo || \'/\' || path = ?').all(p.expect).map((r) => r.id);
    assert.ok(ids.length >= 1, `${p.expect} is in the pack`);
    for (const id of ids) {
      db.prepare('DELETE FROM fts WHERE rowid = ?').run(id);
      db.prepare('DELETE FROM units WHERE id = ?').run(id);
    }
    db.close();
    reassemble(tree, copy);
    const r = selfTest(tree, copy);
    const mine = r.results.find((x) => x.question === p.question);
    assert.equal(mine.pass, false, `the probe for ${p.expect} must fail once that file is gone`);
    assert.equal(r.ok, false);
    assert.equal(r.results.filter((x) => x.pass).length, 3, 'only that probe fails');
  }
});
