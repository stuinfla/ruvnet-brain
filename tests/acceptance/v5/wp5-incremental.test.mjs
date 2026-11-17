// WP5 reproducible and incremental builds (ROADMAP A4, WP 5):
// - the same sources at the same commits, built twice in separate processes, give byte-identical packs;
// - changing one file in one repository rebuilds only that repository (and the result equals a clean build);
// - changing the recipe rebuilds everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THREE, built, copyRepo, fileHashes, readJson, recipeFile, repo, setup } from './wp5-helpers.mjs';

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wp5-fixtures', 'history', 'beta-memory');

test('WP5 builds are reproducible and incremental by content hash', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp5-incremental');
  const tree = ctx.tree();
  const srcs = [...THREE, repo('delta-graph')].map((d) => copyRepo(ctx, d));
  const list = path.join(ctx.tmp('rb5-list-'), 'sources.json');
  fs.writeFileSync(list, JSON.stringify({ sources: srcs.map((dir) => (path.basename(dir) === 'beta-memory' ? { dir, history: { owner: 'stellarowner', recorded: RECORDED } } : { dir })) }));

  // two clean builds, separate processes, different output folders: identical bytes
  const a = built(ctx, tree, { list });
  const b = built(ctx, tree, { list });
  const ha = fileHashes(a);
  assert.deepEqual(Object.keys(ha), ['PACK.json', 'PROBES.json', 'RECIPE.json', 'history.db', 'layered-coverage.json', 'layered.db', 'lexical.db', 'manifest.json']);
  assert.deepEqual(fileHashes(b), ha, 'same sources, same recipe: byte-identical pack');

  // a cached build equals the clean build, and reports every source rebuilt the first time
  const cache = ctx.tmp('rb5-cache-');
  const c1 = built(ctx, tree, { list, cache });
  assert.deepEqual(fileHashes(c1), ha, 'a build through the cache is the same bytes as a clean build');
  const r1 = readJson(path.join(cache, 'build-report.json'));
  assert.deepEqual(r1.rebuilt, ['alpha-vectors', 'beta-memory', 'delta-graph', 'gamma-swarm']);
  assert.deepEqual(r1.reused, []);

  // nothing changed: nothing rebuilt
  const c2 = built(ctx, tree, { list, cache });
  assert.deepEqual(readJson(path.join(cache, 'build-report.json')).rebuilt, []);
  assert.deepEqual(fileHashes(c2), ha);

  // one file in one repository changes: only that repository is rebuilt
  const beta = srcs.find((d) => path.basename(d) === 'beta-memory');
  fs.appendFileSync(path.join(beta, 'docs', 'DESIGN.md'), '\nCompaction runs nightly under the duskhollow schedule.\n');
  const c3 = built(ctx, tree, { list, cache });
  const r3 = readJson(path.join(cache, 'build-report.json'));
  assert.deepEqual(r3.rebuilt, ['beta-memory'], 'only the changed repository is rebuilt');
  assert.deepEqual(r3.reused, ['alpha-vectors', 'delta-graph', 'gamma-swarm']);
  const clean3 = built(ctx, tree, { list });
  assert.deepEqual(fileHashes(c3), fileHashes(clean3), 'the incremental result equals a clean build of the changed sources');
  assert.notDeepEqual(fileHashes(c3)['lexical.db'], ha['lexical.db']);

  // the recipe changes (one more stop word): everything is rebuilt
  const recipe = recipeFile(ctx, tree, (r) => r.analyser.stopwords.push('zzwp5'));
  built(ctx, tree, { list, cache, recipe });
  const r4 = readJson(path.join(cache, 'build-report.json'));
  assert.deepEqual(r4.rebuilt, ['alpha-vectors', 'beta-memory', 'delta-graph', 'gamma-swarm'], 'a new recipe hash rebuilds everything');
  assert.deepEqual(r4.reused, []);
});
