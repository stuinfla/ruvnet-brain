// WP8 what CI does with a layer 2 result: it only verifies it. A set that declares layer 2 required
// passes with a bound result that meets the set's thresholds, and fails without one. A result is
// refused when it is for other bytes, for another question set, carries a failed or no judge
// calibration, records the same command in both roles, is older than the set allows, was edited
// after it was written, or holds numbers that do not follow from its own scores; each of these is
// fatal even when the set does not require layer 2. Thresholds are the set's data: a set requiring a
// share the result does not reach fails; the same numbers under a set that does not require layer 2
// are reported, not fatal.
// Breaks: the binding check removed; the age check removed; the calibration check removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { contentSha, gate, outFile, pin, questionSet, readJson, releaseOf, setHash, stubEnv } from './wp8-helpers.mjs';

test('WP8 CI verifies the answer-level result and applies the set\'s thresholds', { timeout: 400_000 }, async (t) => {
  const ctx = setup(t, 'wp8-06');
  const tree = ctx.tree();
  const rel = releaseOf(tree);
  const produce = (set) => {
    const out = outFile(ctx, 'answer.json');
    const r = gate(tree, ['answer', '--release', rel, '--questions', set, '--out', out], stubEnv(ctx).env);
    assert.equal(r.status, 0, `layer 2 run: ${r.out}`);
    return readJson(out);
  };
  const check = (set, answerValue) => {
    const out = outFile(ctx);
    const args = ['--release', rel, '--questions', set, '--out', out];
    if (answerValue) {
      const f = path.join(ctx.tmp('rb5-wp8-ans-'), 'answer.json');
      fs.writeFileSync(f, JSON.stringify(answerValue, null, 2));
      args.push('--answer', f);
    }
    const r = gate(tree, args);
    return { ...r, g: readJson(out) };
  };
  const forged = (file, edit) => {
    const f = structuredClone(file);
    edit(f.content, f);
    f.contentSha256 = contentSha(f.content);
    return f;
  };
  const fails = (res, why, label) => {
    assert.notEqual(res.status, 0, `${label} must fail the gate: ${res.out}`);
    assert.equal(res.g.passed, false, label);
    assert.match(res.g.reasons.join('\n'), why, `${label}: ${res.g.reasons.join(' | ')}`);
  };

  const required = questionSet(ctx, (m) => (m.layer2.required = true));
  pin(tree, setHash(tree, required));
  const good = produce(required);
  const ok = check(required, good);
  assert.equal(ok.status, 0, `a bound result meeting the thresholds passes: ${ok.out}`);
  assert.deepEqual([ok.g.layers.answer.bound, ok.g.layers.answer.met], [true, true]);
  assert.match(ok.stdout, /layer 2 · thresholds met · overall 3 of 6/);
  fails(check(required, null), /requires an answer-level result and none was given/, 'a required layer 2 with no result');

  fails(check(required, forged(good, (c) => (c.release = 'e'.repeat(64)))), /for different bytes than this release/, 'a result for other bytes');
  fails(check(required, forged(good, (c) => (c.pack = 'g-other'))), /for different bytes than this release/, 'a result for another pack');
  fails(check(required, forged(good, (c) => (c.questionSet.sha256 = 'b'.repeat(64)))), /measured on question set b{64}/, 'a result for another question set');
  fails(check(required, forged(good, (c) => (c.calibration.passed = false))), /its judge did not pass calibration/, 'a result whose judge failed calibration');
  fails(check(required, forged(good, (c) => delete c.calibration)), /carries no judge calibration record/, 'a result with no calibration record');
  fails(check(required, forged(good, (c) => (c.roles.judge = c.roles.answer))), /the same command answered and judged/, 'a result answered and judged by one command');
  fails(check(required, forged(good, (c) => (c.groups.practitioner.share = 1))), /does not follow from its own scores/, 'a result with edited numbers');
  fails(check(required, { ...good, content: { ...good.content, runs: 9 } }), /edited after it was written/, 'a result edited without recomputing its hash');
  fails(check(required, { ...good, producedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }), /is 30 days old; the set allows 14/, 'a result older than the set allows');

  // Thresholds are data frozen with the set.
  const strict = questionSet(ctx, (m) => Object.assign(m.layer2, { required: true, thresholds: { amateur: 0.5, practitioner: 0.5 } }));
  pin(tree, setHash(tree, strict));
  fails(check(strict, produce(strict)), /below the set's thresholds: group practitioner: 0 of 2 \(0\) below the threshold 0.5/, 'a result below a required threshold');
  const advisory = questionSet(ctx, (m) => (m.layer2.thresholds = { amateur: 0.5, practitioner: 0.5 }));
  pin(tree, setHash(tree, advisory));
  const adv = produce(advisory);
  const a = check(advisory, adv);
  assert.equal(a.status, 0, `below a threshold the set does not require: reported, not fatal: ${a.out}`);
  assert.match(a.stdout, /layer 2 · below thresholds \(not required by this question set\)/);
  fails(check(advisory, forged(adv, (c) => (c.release = 'e'.repeat(64)))), /does not bind to this release/, 'an unbound result under a set that does not require layer 2');
});
