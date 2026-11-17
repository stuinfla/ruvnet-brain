// WP5 recipe is the only source of settings (ROADMAP A4, WP 5): a model name, revision or chunk size
// that is not in recipe/RECIPE.json fails the build. The builder has no default of its own: remove a
// setting and the build stops with one sentence naming it; name a model or token estimator the
// builder does not have and the build stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { THREE, build, recipeFile, setup } from './wp5-helpers.mjs';

const CASES = [
  ['the token cap is missing', (r) => delete r.units.passage.symbolChunker.maxTokens, /recipe has no units\.passage\.symbolChunker\.maxTokens/],
  ['the grouping target is missing', (r) => delete r.units.passage.symbolChunker.groupTarget, /recipe has no units\.passage\.symbolChunker\.groupTarget/],
  ['the history split size is missing', (r) => delete r.units.history.splitChars, /recipe has no units\.history\.splitChars/],
  ['a token estimator the builder does not have', (r) => (r.units.passage.symbolChunker.tokenEstimator = { name: 'Xenova/bge-base-en-v1.5', revision: 'main' }), /token estimator Xenova\/bge-base-en-v1\.5 .* is not one this builder has/],
  ['a model the builder does not load', (r) => r.models.push({ name: 'Xenova/all-MiniLM-L6-v2', revision: 'abc123' }), /recipe names model Xenova\/all-MiniLM-L6-v2@abc123, which this builder does not load/],
  ['a cap outside the allowed range', (r) => (r.units.passage.symbolChunker.maxTokens = 0), /maxTokens must be a whole number from 64 to 8192/],
];

test('WP5 every builder setting comes from the recipe', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp5-recipe');
  const tree = ctx.tree();
  const ok = build(ctx, tree, { sources: THREE });
  assert.equal(ok.status, 0, `the recipe of record builds: ${ok.stderr}`);
  for (const [what, edit, why] of CASES) {
    const r = build(ctx, tree, { sources: THREE, recipe: recipeFile(ctx, tree, edit) });
    assert.notEqual(r.status, 0, `${what}: the build must fail`);
    assert.match(r.stderr, why, `${what}: ${r.stderr}`);
    assert.equal(r.stderr.trim().split('\n').length, 1, `${what}: one sentence`);
    assert.equal(fs.existsSync(r.out), false, `${what}: nothing is written`);
  }
});
