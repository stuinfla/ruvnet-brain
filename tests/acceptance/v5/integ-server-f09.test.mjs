// Review F09: the deadline is end to end, and nothing blocks the server's own thread.
// A test-only patch makes the keyword lane stall for 6 s on any thread when the question contains
// "stallward", so the search and its safe-mode fallback both run out of time. With a 1,500 ms deadline:
// - three such searches at once (the pool has two workers, so one waits in the queue) all answer
//   within the deadline plus one second, as DOWN, naming the deadline;
// - a ping sent while they are being answered gets its answer at once (no search runs on the server's
//   own thread);
// - the next ordinary search is normal.
// Breaks: safe mode searches on the server's thread; the run gets a full deadline after its wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, setup, sleep, waitFor } from './helpers.mjs';

const STALL = {
  file: 'packages/engine/lanes/lexical.mjs',
  find: 'const terms = queryTerms(query, lane.analyser);',
  replace: "if (query.includes('stallward')) { const end = Date.now() + 6000; while (Date.now() < end) {} }\n  const terms = queryTerms(query, lane.analyser);",
};
const DEADLINE = 1500;

test('F09 one deadline covers queue, search and fallback; the server thread never searches', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'integ-server-f09');
  const tree = ctx.tree({ patches: [STALL] });
  const { home } = ctx.installed(tree, { recipe: { deadlineMs: DEADLINE } });
  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 20_000, 'the start-up self-test');

  const t0 = Date.now();
  const stalled = ['one', 'two', 'three'].map((w) => srv.search(`stallward gloamwick ${w}`, {}, 20_000).then((r) => ({ ...r, at: Date.now() - t0 })));
  await sleep(DEADLINE + 200);
  const p0 = Date.now();
  await srv.call('ping', {}, 20_000);
  const pingMs = Date.now() - p0;
  const answers = await Promise.all(stalled);

  for (const r of answers) {
    assert.ok(r.at <= DEADLINE + 1000, `a stalled search answered after ${r.at} ms; the deadline is ${DEADLINE} ms plus one second`);
    assert.match(r.text, new RegExp(`^RuvNet Brain DOWN · search failed: .*${DEADLINE} ms deadline`), r.text.slice(0, 300));
  }
  assert.ok(pingMs < 500, `a ping during the fallback took ${pingMs} ms: a search is running on the server's own thread`);

  const next = await srv.search('gloamwick journal');
  assert.equal(next.mode, 'MODE · normal', next.mode);
  assert.equal(next.files[0]?.file, 'beta-memory/docs/DESIGN.md');
});
