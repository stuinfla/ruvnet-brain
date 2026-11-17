// WP10-03 a fresh install has the guard off: with search ok and no search in the session, a write naming
// a product passes silently. `ruvnet-brain guard on` turns it on (the same write is refused) and
// `guard off` turns it off again.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { TERM_TEXT, emptyTranscript, guard, okServer, writeMsg } from './wp10-helpers.mjs';

test('WP10-03 a fresh install has the guard off', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp10-03');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const srv = await okServer(ctx, tree, home);
  const dir = ctx.tmp('rb5-session-');
  const msg = writeMsg(path.join(dir, 'adapter.ts'), TERM_TEXT, emptyTranscript(dir));

  assert.match(tree.cli(home, ['guard', 'status']).stdout, /^guard off/, 'a fresh install reports the guard off');
  const fresh = guard(tree, home, msg);
  assert.equal(fresh.status, 0, `a fresh install must not refuse: ${fresh.stderr}`);
  assert.equal(fresh.stdout + fresh.stderr, '', 'and says nothing');

  assert.equal(tree.cli(home, ['guard', 'on']).status, 0);
  assert.equal(guard(tree, home, msg).status, 2, 'switched on, the same write is refused');
  assert.equal(tree.cli(home, ['guard', 'off']).status, 0);
  const off = guard(tree, home, msg);
  assert.equal(off.status, 0, 'switched off again, it passes');
  assert.equal(off.stdout + off.stderr, '');
  await srv.close();
});
