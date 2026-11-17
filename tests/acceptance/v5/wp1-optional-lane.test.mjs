// WP1 T6: with the optional lane's file missing from a pack that still lists it, search still answers
// and reports the lane unavailable (in the result's lanes and in its section's reason). A pack that
// does not list the file at all has no history: the lane is not reported unavailable (a pack built
// without history is healthy) and its section says the pack has no history. A missing REQUIRED lane
// file still refuses the pack. Break: make a missing optional file refuse the pack again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { engineTree, filePassages, historyItem, manifest, scratch, writePack } from './wp1-helpers.mjs';

const Q = 'how is the tessellane quorum elected';

test('WP1 T6 the optional history lane can be missing', async (t) => {
  const tmp = scratch(t);
  const { analyse, engine } = await engineTree(tmp, 'wp1-optional-lane');
  const opts = {
    passages: filePassages('swarmkit', 'src/quorum.rs', [['// tessellane quorum election', 'fn elect() {}']]),
    history: [historyItem('swarmkit', 'release', 'v1.2.0', '2026-11-01', 'tessellane quorum release', 'quorum election rewritten for tessellane')],
  };
  const whole = writePack(path.join(tmp(), 'pack'), analyse, opts);
  const h0 = engine.open(whole);
  const r0 = engine.search(h0, Q);
  engine.close(h0);
  assert.equal(r0.sections.find((s) => s.name === 'HISTORY').items.length, 1, 'with its file the history lane answers');

  // (a) the file is gone but still listed; (b) the file and its manifest row are gone.
  const listed = writePack(path.join(tmp(), 'pack'), analyse, opts);
  fs.rmSync(path.join(listed, 'history.sqlite'));
  const unlisted = writePack(path.join(tmp(), 'pack'), analyse, opts);
  fs.rmSync(path.join(unlisted, 'history.sqlite'));
  const pk = JSON.parse(fs.readFileSync(path.join(unlisted, 'PACK.json'), 'utf8'));
  manifest(unlisted, Object.fromEntries(pk.files.filter((f) => f.role !== 'history-db').map((f) => [f.path, f.role])), { recipeText: fs.readFileSync(path.join(unlisted, 'RECIPE.json'), 'utf8'), sources: pk.sources });

  const cases = [
    [listed, /^lane history is not available: pack file history\.sqlite is missing or has the wrong size$/, [['lexical', true], ['history', false]]],
    [unlisted, /^this pack has no history$/, [['lexical', true]]],
  ];
  for (const [dir, why, lanes] of cases) {
    const h = engine.open(dir);
    const r = engine.search(h, Q);
    engine.close(h);
    const files = r.sections.find((s) => s.name === 'FILES');
    const hist = r.sections.find((s) => s.name === 'HISTORY');
    assert.deepEqual(files.items.map((i) => `${i.repo}/${i.path}`), ['swarmkit/src/quorum.rs'], 'search still answers from the keyword lane');
    assert.deepEqual(hist.items, []);
    assert.match(hist.empty.reason, why);
    assert.deepEqual(r.lanes.map((l) => [l.name, l.available]), lanes);
  }

  const noKeyword = writePack(path.join(tmp(), 'pack'), analyse, opts);
  fs.rmSync(path.join(noKeyword, 'passages.sqlite'));
  assert.throws(() => engine.open(noKeyword), /Pack file passages\.sqlite is missing or has the wrong size\./, 'a required lane file missing still refuses the pack');
});
