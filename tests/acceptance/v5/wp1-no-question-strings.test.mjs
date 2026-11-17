// WP1 T5: no string from the question sets appears in packages/engine/ (the retrieval run's rule 9:
// no code recognises the wording of a particular question). A "string" here is any run of four
// consecutive words of a question, at least two of them content words (four letters or more, not a
// stop word), compared after lower-casing and reducing everything else to single spaces.
// This test reads engine source as text, which the roadmap's A0.4 otherwise forbids; the roadmap
// names this check explicitly (A4, WP 1). The question sets live outside the product repository;
// without them the test skips, saying so. Break: add a recogniser for one question.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXTERNAL, STOPWORDS, engineTree, exists, scratch } from './wp1-helpers.mjs';

const sets = EXTERNAL.questionSets.filter(exists);
const STOP = new Set(STOPWORDS);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const content = (w) => w.length >= 4 && !STOP.has(w);

function shingles(words) {
  const out = [];
  for (let i = 0; i + 4 <= words.length; i++) {
    const g = words.slice(i, i + 4);
    if (g.filter(content).length >= 2) out.push(g.join(' '));
  }
  return out;
}

const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('WP1 T5 no string from the question sets appears in the engine', { skip: sets.length ? false : 'no question set is on this machine' }, async (t) => {
  const tmp = scratch(t);
  const { engineDir } = await engineTree(tmp, 'wp1-no-question-strings');
  const grams = new Map();
  let questions = 0;
  for (const f of sets) {
    for (const q of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      questions++;
      for (const g of shingles(norm(q.question))) grams.set(g, q.id);
    }
  }
  assert.ok(questions >= 100 && grams.size > 1000, `too few questions read (${questions}) to make this check mean anything`);
  const hits = [];
  const files = sourceFiles(engineDir);
  assert.ok(files.length >= 3, 'the engine source was found');
  for (const file of files) {
    const words = norm(fs.readFileSync(file, 'utf8'));
    for (let i = 0; i + 4 <= words.length; i++) {
      const g = words.slice(i, i + 4).join(' ');
      if (grams.has(g)) hits.push(`${path.relative(engineDir, file)}: "${g}" (question ${grams.get(g)})`);
    }
  }
  t.diagnostic(`${questions} questions, ${grams.size} word runs, ${files.length} engine files checked`);
  assert.deepEqual(hits, [], 'question wording found in engine code');
});
