// S3 worker killed: the search worker thread ends abruptly during a search (simulated by a test-only
// patch that makes the thread exit mid-search once). That search answers in safe mode and says so;
// the next search is normal.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.mjs';

const DIE_ONCE = {
  file: 'packages/server/worker.mjs',
  find: 'else result = engine.search(handle, m.query, m.options);',
  replace: "else { const fs = process.getBuiltinModule('node:fs'); const mk = process.env.RB5_DIE_ONCE; if (mk && !fs.existsSync(mk)) { fs.writeFileSync(mk, 'x'); process.exit(1); } result = engine.search(handle, m.query, m.options); }",
};
const Q = 'thistledown queen hollowmere backoff';

test('S3 the worker is ended during a search', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's03');
  const tree = ctx.tree({ patches: [DIE_ONCE] });
  const { home } = ctx.installed(tree);
  const marker = path.join(ctx.tmp('rb5-mark-'), 'died');

  const srv = await ctx.server(tree, home, { env: { RB5_DIE_ONCE: marker } });
  const dying = await srv.search(Q);
  assert.equal(dying.isError, false, `search during the worker's death must still answer: ${dying.text.slice(0, 300)}`);
  assert.match(dying.mode, /^SAFE MODE · keyword only · the search worker stopped/, `must say it is in safe mode: ${dying.mode}`);
  assert.equal(dying.files[0]?.file, 'gamma-swarm/src/queen_coordinator.py');

  const next = await srv.search(Q);
  assert.equal(next.mode, 'MODE · normal', `the next search must be normal: ${next.mode}`);
  assert.equal(next.files[0]?.file, 'gamma-swarm/src/queen_coordinator.py');
});
