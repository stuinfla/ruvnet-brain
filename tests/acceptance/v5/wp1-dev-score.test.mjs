// WP1 T1: the retrieval run's development questions, asked through engine.search on the same corpus
// slice the run measured its keyword lane on, find a gold file in the first five FILES for a number
// of questions within one of that run's own measured number (40 of 76, read from the run's scores).
// The slice (a 1.4 GB keyword index) and the questions live outside the product repository on the
// owner's machine, so this test skips, saying why, where they are absent. Break: change the analyser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EXTERNAL, engineTree, exists, pilotPack, scratch } from './wp1-helpers.mjs';

const missing = ['pilotDb', 'devQuestions', 'rigScores', 'rigRun'].filter((k) => !exists(EXTERNAL[k]));

// The run's file normalisation (its scorer's normRepo / normPath), so gold and results compare alike.
const normRepo = (r) => {
  const s = String(r || '').toLowerCase();
  return s === '_gists' ? 'ruv-gists' : s === '_xruvio' ? 'x-ruv-io' : s;
};
const normPath = (repo, p) => {
  let s = String(p || '').replace(/^\.?\//, '').replace(/#\d+$/, '');
  if (normRepo(repo) === 'ruv-gists') s = s.replace(/^files\//, '').replace(/^([0-9a-f]{8})[0-9a-f]*\//, '$1/');
  return s;
};
const key = (repo, p) => `${normRepo(repo)}|${normPath(repo, p)}`;
const jsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('WP1 T1 development questions score within one of the measured keyword lane', { skip: missing.length ? `not on this machine: ${missing.map((k) => EXTERNAL[k]).join(', ')}` : false, timeout: 900_000 }, async (t) => {
  const tmp = scratch(t);
  const { engine } = await engineTree(tmp, 'wp1-dev-score');

  // The measured number, from the run's own per-question scores (lane v2-bm25, gold file in first 5).
  const rig = jsonl(EXTERNAL.rigScores).filter((r) => r.lane === 'v2-bm25');
  const measured = rig.reduce((n, r) => n + r.any5, 0);
  assert.equal(rig.length, 76, 'the run scored its keyword lane on 76 development questions');
  assert.equal(measured, 40, 'the run measured 40 of 76 for its keyword lane');

  const pack = await pilotPack(tmp);
  const h = engine.open(pack);
  t.after(() => engine.close(h));
  const scored = new Set(rig.map((r) => r.id));
  const questions = JSON.parse(fs.readFileSync(EXTERNAL.devQuestions, 'utf8')).filter((q) => scored.has(q.id));
  assert.equal(questions.length, 76);
  const rigTop5 = new Map(jsonl(EXTERNAL.rigRun).map((r) => {
    const seen = [];
    for (const x of r.results) if (seen.length < 5 && !seen.includes(key(x.repo, x.path))) seen.push(key(x.repo, x.path));
    return [r.id, seen.join(',')];
  }));
  let found = 0;
  let sameTop5 = 0;
  const ms = [];
  for (const q of questions) {
    const res = engine.search(h, q.question, { detail: 'full' });
    ms.push(res.meta.ms);
    const files = res.sections.find((s) => s.name === 'FILES').items.map((i) => key(i.repo, i.path));
    assert.ok(files.length <= 5);
    const gold = new Set((q.sources || []).map((s) => key(s.repo, s.path)));
    if (files.some((f) => gold.has(f))) found++;
    if (files.join(',') === rigTop5.get(q.id)) sameTop5++;
  }
  ms.sort((a, b) => a - b);
  t.diagnostic(`engine: ${found} of 76 (measured ${measured}); first five identical to the run's lane for ${sameTop5} of 76; median ${ms[38]} ms, max ${ms.at(-1)} ms`);
  assert.ok(Math.abs(found - measured) <= 1, `dev questions found ${found} of 76 through engine.search, outside one of the measured ${measured}`);
});
