// WP1 T2: the same question returns the same first five files in three separate processes for at
// least 99% of a 200-question sample. Run on a fixture built so that every question has exact score
// ties across the fifth place (so tie order decides the first five), and, where the retrieval run's
// corpus slice is on this machine, on 200 of its blind questions too.
// Break: an unordered (per-process random) order among equal scores.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXTERNAL, engineTree, exists, filePassages, firstFiveInProcesses, pilotPack, scratch, writePack } from './wp1-helpers.mjs';

const TOPICS = Array.from({ length: 40 }, (_, k) => `zorvex${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + Math.floor(k / 26))}q`);
const filler = (k, j) => Array.from({ length: 6 }, (_, w) => `fill${String.fromCharCode(97 + ((k * 8 + j + w * 3) % 26))}${String.fromCharCode(97 + ((k + w) % 26))}${String.fromCharCode(97 + j)}`);

/** 40 topics x 8 files: each file says its topic once in a body of equal length, so a question on a
 *  topic ties all 8 files exactly and only the tie order picks the first five. */
function tiedPassages() {
  const out = [];
  TOPICS.forEach((topic, k) => {
    for (let j = 0; j < 8; j++) {
      out.push(...filePassages(`repo${'abcd'[j % 4]}`, `docs/note${String.fromCharCode(97 + j)}${String.fromCharCode(97 + (k % 26))}.md`, [[`${topic} ${filler(k, j).join(' ')}`]]));
    }
  });
  return out;
}

const QUESTIONS = Array.from({ length: 200 }, (_, i) => (i < 40 ? `where is ${TOPICS[i]} described` : `${TOPICS[i % 40]} together with ${TOPICS[(i * 7 + 3) % 40]}`));

function agreement(runs) {
  let same = 0;
  for (let q = 0; q < runs[0].lists.length; q++) {
    const a = JSON.stringify(runs[0].lists[q]);
    if (runs.every((r) => JSON.stringify(r.lists[q]) === a)) same++;
  }
  return same;
}

test('WP1 T2 same first five files in three processes (tied fixture, 200 questions)', { timeout: 300_000 }, async (t) => {
  const tmp = scratch(t);
  const { engineDir, analyse, engine } = await engineTree(tmp, 'wp1-determinism');
  const pack = writePack(path.join(tmp(), 'pack'), analyse, { passages: tiedPassages() });

  // The fixture really has ties across fifth place: 8 files with one equal score per one-topic question.
  const h = engine.open(pack);
  const r = engine.search(h, QUESTIONS[0], { detail: 'full' });
  engine.close(h);
  assert.equal(r.sections[0].items.length, 5);
  assert.equal(new Set(r.sections[0].items.map((i) => i.score)).size, 1, 'the first five must tie exactly');

  const runs = await firstFiveInProcesses(3, engineDir, pack, QUESTIONS, tmp);
  assert.equal(new Set(runs.map((x) => x.pid)).size, 3, 'three separate processes');
  for (const run of runs) assert.ok(run.lists.every((l) => l.length === 5), 'every question returns five files');
  const same = agreement(runs);
  t.diagnostic(`identical first five in all three processes: ${same} of 200`);
  assert.ok(same >= 198, `only ${same} of 200 questions had the same first five files in three processes (need at least 198)`);
});

// The slice run asks 600 questions of a 1.4 GB index (measured 500 s at a load of 30), so it runs
// only when asked for: WP1_SLICE_DETERMINISM=1.
const realMissing = [EXTERNAL.pilotDb, ...EXTERNAL.questionSets.slice(1)].filter((p) => !exists(p));
const sliceSkip = realMissing.length ? 'the retrieval run corpus slice or blind sets are not on this machine'
  : process.env.WP1_SLICE_DETERMINISM === '1' ? false : 'long run; set WP1_SLICE_DETERMINISM=1 to run it';

test('WP1 T2 same first five files in three processes (corpus slice, 200 blind questions)', { skip: sliceSkip, timeout: 1_800_000 }, async (t) => {
  const tmp = scratch(t);
  const { engineDir } = await engineTree(tmp, 'wp1-determinism');
  const pack = await pilotPack(tmp);
  // 200 questions from the blind sets E, F, G, evenly spaced through them in file order (no randomness).
  const all = EXTERNAL.questionSets.slice(1).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).map((q) => q.question));
  const sample = Array.from({ length: 200 }, (_, j) => all[Math.floor((j * all.length) / 200)]);
  assert.equal(sample.length, 200);
  const runs = await firstFiveInProcesses(3, engineDir, pack, sample, tmp);
  const same = agreement(runs);
  t.diagnostic(`identical first five in all three processes: ${same} of 200`);
  assert.ok(same >= 198, `only ${same} of 200 questions had the same first five files in three processes (need at least 198)`);
});
