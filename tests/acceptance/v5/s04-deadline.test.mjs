// S4 deadline: a lane is made to sleep past the deadline (test-only patch: the lexical lane spins for
// 60 s inside the worker thread when the question contains "slowlane"); the answer arrives within
// the deadline plus one second, marked safe mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, setup, waitFor } from './helpers.mjs';

const SLOW_LANE = {
  file: 'packages/engine/lanes/lexical.mjs',
  find: 'const terms = queryTerms(query, lane.analyser);',
  replace: "if (!process.getBuiltinModule('node:worker_threads').isMainThread && process.getBuiltinModule('node:worker_threads').workerData?.role !== 'safe' && query.includes('slowlane')) { const end = Date.now() + 60_000; while (Date.now() < end) {} }\n  const terms = queryTerms(query, lane.analyser);",
};
const DEADLINE = 1500;

test('S4 a lane sleeps past the deadline', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's04');
  const tree = ctx.tree({ patches: [SLOW_LANE] });
  const { home } = ctx.installed(tree, { recipe: { deadlineMs: DEADLINE } });

  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 20_000, 'the start-up self-test');
  const r = await srv.search('slowlane gloamwick journal', {}, 8_000);
  assert.ok(r.ms <= DEADLINE + 1000, `answer took ${r.ms} ms; deadline ${DEADLINE} ms`);
  assert.match(r.mode, new RegExp(`^SAFE MODE · keyword only · the search ran past its ${DEADLINE} ms deadline`), r.mode);
  assert.equal(r.files[0]?.file, 'beta-memory/docs/DESIGN.md');

  const next = await srv.search('gloamwick journal');
  assert.equal(next.mode, 'MODE · normal', next.mode);
});
