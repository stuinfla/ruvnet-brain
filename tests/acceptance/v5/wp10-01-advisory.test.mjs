// WP10-01 the guard fails OPEN. With health not ok, a write the guard would refuse is allowed with one
// advisory line naming the state. And it has one failure mode: whatever it cannot decide (a session
// record it cannot read, a message it cannot parse) allows the write with one line; it never exits
// non-zero except to refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { TERM_TEXT, emptyTranscript, guard, okServer, writeMsg } from './wp10-helpers.mjs';

test('WP10-01 with search not ok the guard only advises, and it has one failure mode', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp10-01');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  assert.equal(tree.cli(home, ['guard', 'on']).status, 0);
  const dir = ctx.tmp('rb5-session-');
  const msg = writeMsg(path.join(dir, 'adapter.ts'), TERM_TEXT, emptyTranscript(dir));

  // No server is running: the verdict is NOT RUNNING, so the write is allowed with one line.
  const down = guard(tree, home, msg);
  assert.equal(down.status, 0, `with search not ok the write must be allowed: ${down.stderr}`);
  assert.match(down.msg ?? '', /^\[RuvNet Brain guard\] advisory only: search is NOT RUNNING \(.*\), so this write is not checked; it names ruflo/);
  assert.equal(down.stdout.trim().split('\n').length, 1, 'exactly one line');

  // With search ok, the same write and no search is refused (so the advisory above was the health rule).
  const srv = await okServer(ctx, tree, home);
  const ok = guard(tree, home, msg);
  assert.equal(ok.status, 2, `with search ok and no search in the session the write is refused: ${ok.stdout}`);

  // One failure mode: what the guard cannot decide is allowed, with one line, exit 0.
  const unreadable = guard(tree, home, writeMsg(path.join(dir, 'a.ts'), TERM_TEXT, dir));
  assert.equal(unreadable.status, 0, 'an unreadable session record must allow the write');
  assert.match(unreadable.msg ?? '', /advisory only: the guard could not decide/);
  const garbage = guard(tree, home, null, { raw: '{not json' });
  assert.equal(garbage.status, 0, 'a message the guard cannot parse must allow the write');
  assert.match(garbage.msg ?? '', /advisory only: the guard could not decide/);
  await srv.close();
});
