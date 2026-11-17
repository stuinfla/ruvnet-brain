// WP5 carry rule (ROADMAP A4, WP 5; architecture 2.4): one fixture source made unreadable, the pack
// is built, that source is carried at its last good bytes and named in the manifest. Four of four
// made unreadable: the build fails. "Unreadable" is the folder gone, which every system can do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, build, built, copyRepo, readJson, repo, setup, units } from './wp5-helpers.mjs';

test('WP5 an unreadable source is carried at its last good state; all unreadable fails', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp5-carry');
  const tree = ctx.tree();
  const srcs = [...THREE, repo('delta-graph')].map((d) => copyRepo(ctx, d));
  const cache = ctx.tmp('rb5-cache-');
  const good = built(ctx, tree, { sources: srcs, cache });
  const before = units(good, "repo = 'gamma-swarm'").map(({ id, ...u }) => u);
  assert.ok(before.length >= 2, 'gamma-swarm has passages to carry');

  // with the cache: carried, named, same passages, and the pack still passes its probes at build time
  const gamma = srcs.find((d) => path.basename(d) === 'gamma-swarm');
  fs.renameSync(gamma, `${gamma}-gone`);
  const r = build(ctx, tree, { sources: srcs, cache });
  assert.equal(r.status, 0, `one unreadable source of four must not stop the build: ${r.stderr}`);
  const m = readJson(path.join(r.out, 'manifest.json'));
  const carried = m.sources.filter((s) => s.carried);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].repo, 'gamma-swarm');
  assert.equal(carried[0].commit, 'c3a7f2d9e1b5', 'carried at the commit it was last read at');
  assert.match(carried[0].carried.reason, /cannot be read/);
  assert.deepEqual(m.carried, ['gamma-swarm']);
  assert.deepEqual(units(r.out, "repo = 'gamma-swarm'").map(({ id, ...u }) => u), before, 'carried at its last good bytes');
  assert.deepEqual(readJson(path.join(cache, 'build-report.json')).carried, ['gamma-swarm']);
  assert.equal(readJson(path.join(r.out, 'PACK.json')).sources.length, 4);

  // without a cache there is no last good state, so the unreadable source fails the build by name
  const noCache = build(ctx, tree, { sources: srcs });
  assert.notEqual(noCache.status, 0, 'no last good state: the build must fail');
  assert.match(noCache.stderr, /source gamma-swarm cannot be read: .* no last good state to carry/);

  // two of four: over the bound (a quarter), the build fails
  const alpha = srcs.find((d) => path.basename(d) === 'alpha-vectors');
  fs.renameSync(alpha, `${alpha}-gone`);
  const two = build(ctx, tree, { sources: srcs, cache });
  assert.notEqual(two.status, 0, 'two of four unreadable is over the carry bound');
  assert.match(two.stderr, /2 of 4 sources cannot be read/);

  // four of four: the build fails, even though every one has a last good state
  for (const d of srcs) if (fs.existsSync(d)) fs.renameSync(d, `${d}-gone`);
  const four = build(ctx, tree, { sources: srcs, cache });
  assert.notEqual(four.status, 0, 'four of four unreadable must fail');
  assert.match(four.stderr, /4 of 4 sources cannot be read/);
  assert.equal(fs.existsSync(path.join(four.out, 'PACK.json')), false, 'a failed build leaves no pack');
});
