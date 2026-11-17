// WP2 T1: fifty searches fired at once all answer; none is lost; memory returns to its idle level.
// Fifty files each hold one made-up word; question i asks for word i, so a crossed or lost answer is
// seen. A test-only patch makes each search in a worker thread take 200 ms (questions with "slowish"),
// so the calls really overlap. Break: drop the queue (start a worker for every call that finds none free).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, setup, sleep, waitFor, writeConfig } from './helpers.mjs';
import { word, writeRepo } from './wp2-helpers.mjs';

const N = 50;
const SLOW = {
  file: 'packages/engine/lanes/lexical.mjs',
  find: 'const terms = queryTerms(query, lane.analyser);',
  replace: "if (!process.getBuiltinModule('node:worker_threads').isMainThread && query.includes('slowish')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);\n  const terms = queryTerms(query, lane.analyser);",
};

test('WP2 T1 fifty searches at once', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-01');
  const tree = ctx.tree({ patches: [SLOW] });
  const files = Object.fromEntries(Array.from({ length: N }, (_, i) => [`notes/n${String(i).padStart(2, '0')}.md`, `# Note ${i}\n\nThe ${word(i)} procedure, with ${word(i + N)} and ${word(i + 2 * N)}, is written down here.\n`]));
  const many = writeRepo(ctx.tmp('rb5-many-'), 'many-notes', files);
  const { home } = ctx.installed(tree, { sources: [many] });
  // Probes every 300 ms: each takes a fresh worker, so several land during the burst and the idle wait.
  writeConfig(home, { heartbeatMs: 200, probeIntervalMs: 300 });

  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 30_000, 'the start-up self-test');
  // Idle means the pool is up: a few overlapping searches first, so every pool worker exists.
  for (const warm of await Promise.all([0, 1, 2, 3].map((i) => srv.search(`slowish ${word(i)}`)))) assert.equal(warm.mode, 'MODE · normal', warm.text.slice(0, 300));
  await sleep(1000);
  const idle = readStatus(home, srv.pid).load;

  const t0 = Date.now();
  const answers = await Promise.all(Array.from({ length: N }, (_, i) => srv.search(`slowish ${word(i)}`, {}, 60_000)));
  const took = Date.now() - t0;
  assert.equal(answers.length, N);
  answers.forEach((r, i) => {
    assert.equal(r.isError, false, `search ${i} failed: ${r.text.slice(0, 200)}`);
    assert.equal(r.mode, 'MODE · normal', `search ${i} must not fall back to safe mode: ${r.mode}`);
    assert.equal(r.files[0]?.file, `many-notes/notes/n${String(i).padStart(2, '0')}.md`, `search ${i} answered with another question's file`);
  });
  // Two workers at 200 ms a search: about 5 s for fifty; well inside 30 s even on a loaded machine.
  assert.ok(took < 30_000, `fifty searches took ${took} ms`);

  await sleep(1500);
  const after = readStatus(home, srv.pid).load;
  assert.ok(after.peakWorkers <= 2, `at most a small pool of workers may run at once; ${after.peakWorkers} were started`);
  assert.ok(after.workers <= 2, `the workers return to the pool size; ${after.workers} are alive`);
  assert.equal(after.queued, 0, 'nothing is left waiting');
  assert.ok(after.running <= 1, `nothing is left running but, at most, a probe: ${after.running}`);
  const grew = (after.rssBytes - idle.rssBytes) / 2 ** 20;
  t.diagnostic(`fifty searches in ${took} ms; memory ${Math.round(idle.rssBytes / 2 ** 20)} MB idle, ${Math.round(after.rssBytes / 2 ** 20)} MB after; peak workers ${after.peakWorkers}`);
  assert.ok(grew < 48, `memory returns to its idle level: ${Math.round(idle.rssBytes / 2 ** 20)} MB idle, ${Math.round(after.rssBytes / 2 ** 20)} MB after the burst`);
  const line = tree.hook(home).line;
  assert.match(line, /RuvNet Brain OK/, `health after the burst: ${line}`);
});
