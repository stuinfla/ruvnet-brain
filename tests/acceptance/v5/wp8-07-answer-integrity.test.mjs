// WP8 / review F16: an answer-level result is checked against the frozen set, not against itself.
// (1) A calibration record that says passed while its own counts are below the set's minimum (re-hashed
// by a forger) is refused. (2) Questions moved to other groups, with the owner's measure recomputed
// and the result re-hashed, are refused. (3) The judge is given the text of the reference files from the
// pack under test, not only their names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { contentSha, gate, outFile, pin, questionSet, readJson, releaseOf, setHash, stubEnv } from './wp8-helpers.mjs';

test('WP8 an answer-level result is checked against the frozen set (review F16)', { timeout: 400_000 }, async (t) => {
  const ctx = setup(t, 'wp8-07');
  const tree = ctx.tree();
  const rel = releaseOf(tree);
  const required = questionSet(ctx, (m) => (m.layer2.required = true));
  pin(tree, setHash(tree, required));

  // A judge that keeps every prompt it is given, then grades as the synthetic judge does.
  const prompts = ctx.tmp('rb5-wp8-prompts-');
  const judge = path.join(ctx.tmp('rb5-wp8-judge-'), 'judge.mjs');
  fs.writeFileSync(judge, `import fs from 'node:fs';\nconst p = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(prompts)} + '/' + Date.now() + '-' + Math.random().toString(16).slice(2), p);\nconst refs = (p.split('REFERENCE FILES:\\n')[1] ?? '').split('\\nMUST NOT CLAIM:')[0].split('\\n').filter(Boolean);\nconst answer = p.split('ANSWER:\\n')[1] ?? '';\nprocess.stdout.write('SCORE: ' + (refs.some((r) => answer.includes(r)) ? 9 : 4) + '\\n');\n`);
  const out = outFile(ctx, 'answer.json');
  const made = gate(tree, ['answer', '--release', rel, '--questions', required, '--out', out], stubEnv(ctx, { judge: [process.execPath, judge] }).env);
  assert.equal(made.status, 0, made.out);
  const good = readJson(out);

  const check = (value) => {
    const f = path.join(ctx.tmp('rb5-wp8-ans-'), 'answer.json');
    fs.writeFileSync(f, JSON.stringify(value, null, 2));
    const o = outFile(ctx);
    const r = gate(tree, ['--release', rel, '--questions', required, '--out', o, '--answer', f]);
    return { ...r, g: readJson(o) };
  };
  const forged = (edit) => {
    const f = structuredClone(good);
    edit(f.content);
    f.contentSha256 = contentSha(f.content);
    return f;
  };
  const fails = (res, why, label) => {
    assert.notEqual(res.status, 0, `${label} must fail the gate: ${res.out}`);
    assert.match(res.g.reasons.join('\n'), why, `${label}: ${res.g.reasons.join(' | ')}`);
  };
  assert.equal(check(good).status, 0, 'the real result passes');

  // (1) passed:true over counts that do not reach the set's minimum.
  fails(check(forged((c) => Object.assign(c.calibration, { withinOne: 2, passed: true }))), /calibration record does not support "passed"/, 'a calibration below the minimum marked passed');
  fails(check(forged((c) => Object.assign(c.calibration, { planted: 0, plantedCapped: 0 }))), /calibration record does not support "passed"/, 'a calibration that dropped its planted answers');

  // (2) Groups reassigned and the measure recomputed with the tree's own code.
  const { ownersMeasure } = await import(pathToFileURL(path.join(tree.root, 'packages', 'release', 'gate', 'answer.mjs')).href);
  const set = JSON.parse(fs.readFileSync(path.join(required, 'MANIFEST.json'), 'utf8'));
  // The passing questions are shared between the two thresholded groups and the failing ones moved to
  // a group with no threshold: every threshold is then "met" by the result's own numbers.
  const l2 = set.layer2;
  const passes = (q) => q.scores.filter((x) => x >= l2.passGrade).length >= l2.minRunsPassing;
  assert.ok(good.content.questions.filter(passes).length >= 2, 'the fixture has two passing questions to share');
  fails(check(forged((c) => {
    let k = 0;
    for (const q of c.questions) q.group = passes(q) ? Object.keys(l2.thresholds)[k++ % 2] : 'unscored';
    Object.assign(c, ownersMeasure(c.questions, l2, c.questionSet.sha256));
  })), /not in the groups the frozen set gives them/, 'questions moved to other groups');

  // (3) The judge saw the reference files' text from the pack.
  const seen = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  assert.ok(seen.length > 0, 'the judge was called');
  const withText = seen.filter((p) => /REFERENCE TEXT \(from the pack under test\):\n--- \S+\n(?!\(not in the pack\))\S/.test(p));
  assert.ok(withText.length > 0, `the judge must be given the reference files' text; a prompt was:\n${seen[0].slice(0, 800)}`);
});
