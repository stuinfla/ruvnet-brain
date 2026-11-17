// Wave 3, item 6: the release candidate's gate job fetches the frozen question set from OUTSIDE the
// repository first (a placeholder that fails closed, naming what the owner must provide: a private
// source and a secret, and naming no source, address, path or credential), then runs
// `gate.mjs --release <staged> --questions "$RUNNER_TEMP/question-set" --out <file>`. With no frozen set
// pinned in rail.json the gate cannot pass a real release. All four v5 workflows stay inert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, setup } from './helpers.mjs';
import { workflows } from './wp6-helpers.mjs';

test('Wave 3 the gate job fetches the question set from outside the repository, fails closed, and stays inert', { timeout: 60_000 }, async (t) => {
  const ctx = setup(t, 'wave3-07');
  const { files } = workflows(ctx, 'wave3-07');
  assert.deepEqual(Object.keys(files), ['v5-nightly-dispatch.yml', 'v5-pack-build.yml', 'v5-release-candidate.yml', 'v5-watchdog.yml']);
  for (const [name, { doc }] of Object.entries(files)) {
    const triggers = Object.keys(doc.on).sort();
    assert.ok(triggers.every((x) => ['workflow_dispatch', 'push', 'workflow_call'].includes(x)), `${name} is inert: triggers ${triggers}`);
    assert.equal(doc.on.schedule, undefined, `${name} has no schedule`);
    if (doc.on.push) assert.deepEqual(doc.on.push, { branches: ['release/5.*'] }, `${name}: push only to release/5.*`);
    if (doc.on.push) assert.equal(name, 'v5-release-candidate.yml', 'only the release candidate runs on a push');
  }

  const steps = files['v5-release-candidate.yml'].doc.jobs.gate.steps;
  const g = steps.findIndex((s) => /gate\/gate\.mjs/.test(s.run ?? ''));
  assert.ok(g > 0, 'the gate job runs gate.mjs');
  assert.match(steps[g].run, /node packages\/release\/gate\/gate\.mjs --release "\$RUNNER_TEMP\/channel\/staged\/\$TAG" --questions "\$RUNNER_TEMP\/question-set" --out "\$RUNNER_TEMP\/gate\/gate\.json"/, 'the gate is given the fetched question set');
  const fetch = steps[g - 1];
  assert.match(fetch.name, /question set from outside the repository/i, 'the step before the gate fetches the question set');
  const lines = fetch.run.trim().split('\n').map((l) => l.trim());
  assert.equal(lines.at(-1), 'exit 1', 'the placeholder fails closed');
  assert.match(fetch.run, /private source/);
  assert.match(fetch.run, /\bsecret\b/);
  const text = files['v5-release-candidate.yml'].text;
  assert.doesNotMatch(text, /:\/\/|secrets\.(?!RUVNET_BRAIN5_SIGNING_KEY\b)|\bquestions?\.json\b|\/Users\//, 'no address, other secret, question file or machine path is named');

  const rail = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'release', 'rail.json'), 'utf8'));
  assert.equal(rail.answerGate.questionSetSha256, '', 'no frozen set is pinned yet');
  const { pinProblem } = await import(path.join(ROOT, 'packages', 'release', 'gate', 'question-set.mjs'));
  assert.match(String(pinProblem(rail.answerGate.questionSetSha256, { sha256: 'a'.repeat(64) })), /no frozen/, 'with no set pinned the gate fails closed for a real release');
});
