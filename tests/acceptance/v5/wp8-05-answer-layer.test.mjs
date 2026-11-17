// WP8 layer 2 on the maintainer's machine, with stub commands (no model is called): the judge must
// be a different command from the answerer, and both are recorded; the judge counts only after the
// seeded calibration set, with the mechanical caps applied in code; at least 3 runs; the owner's
// measure (graded 8 or better in at least 2 of 3 runs) per asker group, each with its n, interval and
// the set's hash; the answerer is given the installed release, the judge is not; the result holds no
// question or answer text and is the same, byte for byte apart from the time it was written, when run
// again on the same inputs.
// Breaks: the same command allowed in both roles; the caps removed; the calibration gate removed;
// the time written inside the hashed part.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { gate, noQuestionText, outFile, pin, questionSet, readJson, releaseOf, setHash, stubEnv } from './wp8-helpers.mjs';

test('WP8 layer 2 answers and judges through two different local commands', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp8-05');
  const tree = ctx.tree();
  const set = questionSet(ctx);
  const hash = setHash(tree, set);
  pin(tree, hash);
  const rel = releaseOf(tree);
  const answer = (env, extra = []) => {
    const out = outFile(ctx, 'answer.json');
    return { ...gate(tree, ['answer', '--release', rel, '--questions', set, '--out', out, ...extra], env), out };
  };

  const same = stubEnv(ctx);
  same.env.RUVNET_BRAIN5_GATE_JUDGE_CMD = same.env.RUVNET_BRAIN5_GATE_ANSWER_CMD;
  const s = answer(same.env);
  assert.notEqual(s.status, 0, `the same command answering and judging must be refused: ${s.out}`);
  assert.match(s.stderr, /the judge command is the answer command; the builder never grades its own work/, `the same command answering and judging must be refused, saying why: ${s.stderr}`);
  assert.equal(fs.existsSync(path.join(same.state, 'homes.log')), false, 'nothing is answered');
  const unset = answer({});
  assert.match(unset.stderr, /RUVNET_BRAIN5_GATE_ANSWER_CMD is not set/);
  const two = answer(stubEnv(ctx).env, ['--runs', '2']);
  assert.notEqual(two.status, 0);
  assert.match(two.stderr, /--runs 2 is below the 3 runs the question set requires/);

  // A judge that cannot reproduce the seeded scores is never trusted: nothing is answered.
  const blind = stubEnv(ctx, { judge: [process.execPath, '-e', "process.stdout.write('SCORE: 0')"] });
  const b = answer(blind.env);
  assert.notEqual(b.status, 0, `a judge that fails calibration must fail the run: ${b.out}`);
  const bc = readJson(b.out).content;
  assert.equal(bc.calibration.passed, false, 'a judge that scores everything 0 must fail calibration');
  assert.deepEqual(bc.questions, []);
  assert.equal(fs.existsSync(path.join(blind.state, 'homes.log')), false, 'no question is answered before the judge passes calibration');

  const stub = stubEnv(ctx);
  const r = answer(stub.env);
  assert.equal(r.status, 0, `layer 2 with two different commands: ${r.out}`);
  const file = readJson(r.out);
  const c = file.content;
  assert.equal(file.schema, 'ruvnet-brain/answer-gate-result');
  assert.deepEqual(c.calibration, { n: 10, withinOne: 10, minWithinOne: 9, planted: 4, plantedCapped: 4, passed: true });
  assert.equal(c.questionSet.sha256, hash);
  assert.equal(c.runs, 3);
  assert.deepEqual(c.roles.answer.slice(-2), ['--home', '{home}'], 'the answer command is recorded as configured');
  assert.match(c.roles.judge.at(-1), /judge\.mjs$/);
  const byId = Object.fromEntries(c.questions.map((q) => [q.id, q]));
  assert.deepEqual(byId['syn-04'].raw, [9, 9, 9], 'the judge liked the answer');
  assert.deepEqual(byId['syn-04'].scores, [3, 3, 3], 'but it cites a file the pack does not hold, so it is capped at 3');
  assert.deepEqual(byId['syn-06'].scores, [1, 1, 1], 'a must-not-claim item as the main recommendation is capped at 1');
  assert.deepEqual(byId['syn-03'].scores, [9, 9, 3], 'an answer with no citation is capped at 3');
  assert.deepEqual(byId['syn-02'].scores, [9, 4, 4]);
  const g = c.groups;
  assert.deepEqual([g.amateur.success, g.amateur.n, g.amateur.share], [2, 2, 1], 'syn-03 passes in 2 of 3 runs, which counts');
  assert.deepEqual([g.practitioner.success, g.practitioner.n], [0, 2], 'syn-02 passes in 1 of 3 runs, which does not');
  assert.deepEqual([g.expert.success, g.expert.n], [1, 2]);
  assert.deepEqual([c.overall.success, c.overall.n, c.overall.share], [3, 6, 0.5]);
  assert.ok(c.overall.ci[0] <= 0.5 && c.overall.ci[1] >= 0.5 && c.overall.ci[0] < c.overall.ci[1], `a bootstrap interval around the share: ${c.overall.ci}`);
  assert.match(r.stdout, new RegExp(`practitioner · 0 of 2 \\(0, 95% interval 0 to 0\\) · set ${hash.slice(0, 12)}`));
  assert.match(r.stdout, new RegExp(`overall · 3 of 6 \\(0.5, interval [0-9.]+ to [0-9.]+\\) · set ${hash.slice(0, 12)}`));

  const homes = fs.readFileSync(path.join(stub.state, 'homes.log'), 'utf8').trim().split('\n');
  assert.equal(homes.length, 18, 'six questions, three runs');
  for (const l of homes) {
    const [env, flag, arg] = l.split(' ');
    assert.ok(env && flag === '--home' && arg === env, `the answerer gets the installed release's home: ${l}`);
  }
  assert.ok(fs.readFileSync(path.join(stub.state, 'judge.log'), 'utf8').trim().split('\n').every((l) => l === 'no-home'), 'the judge is not given the brain');
  assert.deepEqual(noQuestionText(fs.readFileSync(r.out, 'utf8') + r.out), [], 'no question text in the result or the log');
  assert.ok(!fs.readFileSync(r.out, 'utf8').includes('cosine_brindlewort'), 'no answer text in the result');

  // Same inputs again: the same content and hash; only the time it was written differs.
  const again = answer(stubEnv(ctx).env);
  assert.equal(again.status, 0, again.out);
  const f2 = readJson(again.out);
  assert.equal(f2.contentSha256, file.contentSha256, 'the hashed part is the same on a second run');
  assert.deepEqual({ ...f2, producedAt: null }, { ...file, producedAt: null });
});
