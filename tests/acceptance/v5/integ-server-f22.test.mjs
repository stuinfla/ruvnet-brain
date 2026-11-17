// Review F22: a protocol error never echoes a request value of any size. A tools/call with a 300,000
// character tool name, and a request whose method is 300,000 characters, are answered with errors that
// quote at most 200 characters of the value, and every protocol error is held to the same delivery
// ceiling as a tool result. Break: the unknown-tool error echoes the whole name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const BIG = 300_000;

test('F22 protocol errors echo at most 200 characters of a request value', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'integ-server-f22');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const srv = await ctx.server(tree, home);

  const name = `x${'n'.repeat(BIG)}`;
  const e1 = await srv.call('tools/call', { name, arguments: {} }).then(() => null, (e) => e);
  assert.ok(e1, 'an unknown tool must be a protocol error');
  assert.match(e1.message, /^unknown tool xnnn/, e1.message.slice(0, 200));
  assert.ok(e1.message.length < 400, `the unknown-tool error echoed ${e1.message.length} characters of a ${BIG + 1} character name`);

  const method = `m${'q'.repeat(BIG)}`;
  const e2 = await srv.call(method, {}).then(() => null, (e) => e);
  assert.ok(e2, 'an unknown method must be a protocol error');
  assert.match(e2.message, /^method not found: mqqq/, e2.message.slice(0, 200));
  assert.ok(e2.message.length < 400, `the method-not-found error echoed ${e2.message.length} characters of a ${BIG + 1} character method`);

  // The server still answers normally afterwards.
  const r = await srv.search('gloamwick journal');
  assert.equal(r.mode, 'MODE · normal', r.mode);
});
