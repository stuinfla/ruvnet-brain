// WP2 T6: in safe mode (keyword lane only) the HISTORY section says the history lane was not run,
// not that it is unavailable: the lane is healthy, safe mode left it out. A pack with no history
// still says so. Safe mode is forced the way S4 does it (a test-only patch makes the keyword lane spin
// for 60 s in the worker thread when the question contains "slowlane"; the deadline is 1.5 s).
// Break: the engine's "is not available" reason is passed through in safe mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStatus, setup, waitFor } from './helpers.mjs';
import { built, recipeFile, repo } from './wp5-helpers.mjs';
import { section } from './wp2-helpers.mjs';

const SLOW_LANE = {
  file: 'packages/engine/lanes/lexical.mjs',
  find: 'const terms = queryTerms(query, lane.analyser);',
  replace: "if (!process.getBuiltinModule('node:worker_threads').isMainThread && process.getBuiltinModule('node:worker_threads').workerData?.role !== 'safe' && query.includes('slowlane')) { const end = Date.now() + 60_000; while (Date.now() < end) {} }\n  const terms = queryTerms(query, lane.analyser);",
};
const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wp5-fixtures', 'history', 'beta-memory');
const DEADLINE = 1500;

test('WP2 T6 safe mode says the history lane was not run', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-06');
  const tree = ctx.tree({ patches: [SLOW_LANE] });
  const list = path.join(ctx.tmp('rb5-list-'), 'sources.json');
  fs.writeFileSync(list, JSON.stringify({ sources: [{ dir: repo('alpha-vectors') }, { dir: repo('beta-memory'), history: { owner: 'stellarowner', recorded: RECORDED } }] }));
  const pack = built(ctx, tree, { list, recipe: recipeFile(ctx, tree, (r) => (r.deadlineMs = DEADLINE)) });
  const home = ctx.tmp('rb5-home-');
  const inst = tree.cli(home, ['install', '--from', tree.release(pack)]);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);

  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 20_000, 'the start-up self-test');
  const normal = await srv.search('journal replay episode');
  assert.equal(normal.mode, 'MODE · normal');
  assert.ok(section(normal.text, 'HISTORY').files.length >= 1, 'the history lane works in normal mode');

  const safe = await srv.search('slowlane journal replay episode', {}, 10_000);
  assert.match(safe.mode, /^SAFE MODE · keyword only · the search ran past its 1500 ms deadline/, safe.mode);
  assert.ok(safe.files.length >= 1, 'safe mode still answers FILES');
  const h = section(safe.text, 'HISTORY').header;
  assert.equal(h, 'HISTORY (0) · no match: lane history was not run: safe mode searches the keyword lane only', `safe mode must say the lane was not run: ${h}`);

  // A pack built with no history: safe mode does not pretend there is a history lane.
  const { home: home2 } = ctx.installed(tree, { recipe: { deadlineMs: DEADLINE } });
  const srv2 = await ctx.server(tree, home2);
  await waitFor(() => readStatus(home2, srv2.pid)?.probe?.ok, 20_000, 'the start-up self-test');
  const safe2 = await srv2.search('slowlane gloamwick journal', {}, 10_000);
  assert.match(safe2.mode, /^SAFE MODE/);
  assert.equal(section(safe2.text, 'HISTORY').header, 'HISTORY (0) · no match: this pack has no history');
});
