// WP1 T3: a pack whose recipe version is unknown is refused with one plain sentence (and so is one
// whose keyword analyser this engine does not have). Break: remove the version check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { engineTree, filePassages, manifest, scratch, wp1Recipe, writePack } from './wp1-helpers.mjs';

const ONE_SENTENCE = /^[A-Z][^\n]*\.$/;
const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/).length;

test('WP1 T3 an unknown recipe version is refused with one plain sentence', async (t) => {
  const tmp = scratch(t);
  const { analyse, engine } = await engineTree(tmp, 'wp1-refusals');
  const passages = filePassages('repoa', 'src/lib.rs', [['fn velvetroute() {}']]);

  const good = writePack(path.join(tmp(), 'pack'), analyse, { passages });
  const h = engine.open(good);
  assert.equal(engine.search(h, 'velvetroute').sections[0].items.length, 1, 'the same pack with a known version answers');
  engine.close(h);

  for (const version of [2, 99]) {
    const pack = writePack(path.join(tmp(), 'pack'), analyse, { passages, recipe: wp1Recipe({ version }) });
    let err = null;
    try {
      engine.close(engine.open(pack));
    } catch (e) {
      err = e;
    }
    assert.ok(err, `a pack made with recipe version ${version} must be refused, but it opened`);
    assert.equal(err.message, `This pack was made with recipe version ${version}, which this engine does not understand.`);
    assert.match(err.message, ONE_SENTENCE);
    assert.equal(sentences(err.message), 1);
  }

  // Same index, recipe rewritten to name an analyser the engine does not have.
  const odd = writePack(path.join(tmp(), 'pack'), analyse, { passages });
  const oddText = JSON.stringify(wp1Recipe({ analyser: { ...wp1Recipe().analyser, name: 'stemless-v9' } }));
  fs.writeFileSync(path.join(odd, 'RECIPE.json'), oddText);
  const pk = JSON.parse(fs.readFileSync(path.join(odd, 'PACK.json'), 'utf8'));
  manifest(odd, Object.fromEntries(pk.files.map((f) => [f.path, f.role])), { recipeText: oddText, sources: pk.sources });
  assert.throws(() => engine.open(odd), (e) => e.message === "This pack's recipe names keyword analyser stemless-v9, which this engine does not have." && sentences(e.message) === 1);
});
