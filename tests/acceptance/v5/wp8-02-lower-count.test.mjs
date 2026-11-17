// WP8 layer 1 against the frozen baseline: a damaged pack (one of the three repositories missing)
// serves a gold file for fewer questions than the baseline in the set's manifest, and the gate fails,
// still writing a result (passed false) that promotion refuses. The tolerance is data in the frozen
// set: the same damaged pack within a set whose tolerance covers the drop passes layer 1.
// Break: the comparison with the baseline is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { repo, setup } from './helpers.mjs';
import { REQUIRED_OS, appVersion, rail, sha256File, writeJson } from './wp6-helpers.mjs';
import { gate, outFile, pin, questionSet, readJson, releaseOf, setHash } from './wp8-helpers.mjs';

test('WP8 a lower retrieval count than the baseline fails the gate', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp8-02');
  const tree = ctx.tree();
  const set = questionSet(ctx);
  pin(tree, setHash(tree, set));
  const rel = releaseOf(tree, ['alpha-vectors', 'beta-memory'].map(repo));
  const out = outFile(ctx);
  const r = gate(tree, ['--release', rel, '--questions', set, '--out', out]);
  assert.notEqual(r.status, 0, `a damaged pack must fail the gate: ${r.out}`);
  assert.match(r.stderr, /refused: the gate did not pass/);
  const g = readJson(out);
  assert.equal(g.passed, false, 'a lower count than the baseline must not pass');
  assert.deepEqual(g.score, { hit: 4, of: 6 });
  assert.match(g.reasons.join('\n'), /4 of 6 questions served a gold file, below the baseline 5 of 6 by more than the tolerance 0/);

  const channel = ctx.tmp('rb5-wp8-ch-');
  const st = rail(tree, ['stage', '--release', rel, '--channel', channel]);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  const receipts = ctx.tmp('rb5-wp8-rc-');
  for (const os of REQUIRED_OS) writeJson(path.join(receipts, `${os}.json`), { os, release: sha256File(path.join(rel, 'release.json')), ok: true });
  const p = rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', appVersion(tree), '--receipts', receipts, '--gate', out]);
  assert.notEqual(p.status, 0, 'promotion must refuse the failed gate');
  assert.match(p.stderr, /the answer gate did not pass \(4 of 6/);

  // A frozen set whose tolerance covers one question lets the same pack through layer 1.
  const tolerant = questionSet(ctx, (m) => (m.layer1.tolerance = 1));
  pin(tree, setHash(tree, tolerant));
  const out2 = outFile(ctx);
  const r2 = gate(tree, ['--release', rel, '--questions', tolerant, '--out', out2]);
  assert.equal(r2.status, 0, `within the frozen tolerance the gate passes: ${r2.out}`);
  assert.equal(readJson(out2).layers.retrieval.tolerance, 1);
});
