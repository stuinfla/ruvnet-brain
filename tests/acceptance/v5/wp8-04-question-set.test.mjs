// WP8 where the question set comes from and which one counts. A set inside the repository (directly,
// or one file linked into it) is refused before anything is measured; no set at all is refused (the
// release-candidate workflow fails closed until it passes one). With no set pinned in rail.json the
// gate still measures but never passes ("no frozen set pinned"); a set other than the pinned one, or
// the pinned set with one threshold edited after it was frozen, never passes either.
// Breaks: the inside-the-repository check removed; an empty pin treated as no problem.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { gate, outFile, pin, questionSet, readJson, releaseOf, setHash } from './wp8-helpers.mjs';

test('WP8 the question set must come from outside the repository and be the pinned one', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp8-04');
  const tree = ctx.tree();
  const rel = releaseOf(tree);
  const run = (set) => {
    const out = outFile(ctx);
    const args = ['--release', rel, '--out', out];
    if (set) args.push('--questions', set);
    return { ...gate(tree, args), out };
  };
  const refused = (r, why, label) => {
    assert.notEqual(r.status, 0, `${label} must be refused: ${r.out}`);
    assert.match(r.stderr, why, `${label} must be refused with the reason: ${r.stderr}`);
    assert.equal(fs.existsSync(r.out), false, `${label}: nothing is measured, so no result is written`);
  };

  refused(run(null), /no question set was given .*the gate fails closed/, 'a run with no question set');
  const insideSet = questionSet(ctx, null, path.join(tree.root, 'evals', 'frozen-set'));
  refused(run(insideSet), /is inside the repository .*the gate refuses it/, 'a question set inside the repository');
  // A file link needs a privilege on Windows; the folder check above covers that platform.
  if (process.platform !== 'win32') {
    const linked = questionSet(ctx);
    fs.copyFileSync(path.join(linked, 'questions.json'), path.join(tree.root, 'questions-copy.json'));
    fs.rmSync(path.join(linked, 'questions.json'));
    fs.symlinkSync(path.join(tree.root, 'questions-copy.json'), path.join(linked, 'questions.json'));
    refused(run(linked), /question-set file questions\.json is inside the repository/, 'a question file linked into the repository');
  }

  const set = questionSet(ctx);
  const unpinned = run(set);
  assert.notEqual(unpinned.status, 0, `with no set pinned the gate must not pass: ${unpinned.out}`);
  const g = readJson(unpinned.out);
  assert.equal(g.passed, false, 'an empty pin fails closed');
  assert.deepEqual(g.score, { hit: 5, of: 6 }, 'the run still measures');
  assert.equal(g.questionSet.pinned, false);
  assert.match(g.reasons[0], /no frozen question set is pinned in packages\/release\/rail\.json/);

  pin(tree, 'a'.repeat(64));
  const other = readJson(run(set).out);
  assert.equal(other.passed, false, 'a set other than the pinned one never passes');
  assert.match(other.reasons[0], /is not the pinned a{64}/);

  pin(tree, setHash(tree, set));
  assert.equal(run(set).status, 0, 'the pinned set passes');
  const edited = questionSet(ctx, (m) => (m.layer1.tolerance = 2));
  const e = readJson(run(edited).out);
  assert.equal(e.passed, false, 'a threshold edited after the set was frozen changes its hash, so it never passes');
  assert.match(e.reasons[0], /is not the pinned/);
});
