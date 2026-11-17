// WP10-02 the in-file override. With search ok and no search in the session, a write naming a product
// is refused, and the refusal names the product and the exact line that lets it through. With that
// line in the file (a reason given) the write passes and is recorded in state/guard-overrides.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { TERM_TEXT, emptyTranscript, guard, okServer, writeMsg } from './wp10-helpers.mjs';

test('WP10-02 the in-file override lets the write through and is recorded', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp10-02');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  assert.equal(tree.cli(home, ['guard', 'on']).status, 0);
  const srv = await okServer(ctx, tree, home);
  const dir = ctx.tmp('rb5-session-');
  const tr = emptyTranscript(dir);
  const file = path.join(dir, 'adapter.ts');

  const no = guard(tree, home, writeMsg(file, TERM_TEXT, tr));
  assert.equal(no.status, 2, `refused without a search: ${no.stdout}`);
  assert.match(no.stderr, /this file names ruflo, and this session has no search_ruvnet result/);
  assert.match(no.stderr, /ruvnet-brain-guard: allow <your reason>/, 'the refusal names the override line');

  const bare = guard(tree, home, writeMsg(file, `// ruvnet-brain-guard: allow\n${TERM_TEXT}`, tr));
  assert.equal(bare.status, 2, 'an override without a reason does not count');

  const withLine = `// ruvnet-brain-guard: allow wrapping the store for a spike\n${TERM_TEXT}`;
  const yes = guard(tree, home, { ...writeMsg(file, '', tr), tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: withLine } });
  assert.equal(yes.status, 0, `the override line must let the write through: ${yes.stderr}`);
  assert.match(yes.msg ?? '', /override recorded for adapter\.ts: wrapping the store for a spike/);
  const logFile = path.join(home, 'state', 'guard-overrides.jsonl');
  assert.ok(fs.existsSync(logFile), 'the override must be recorded');
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1, 'the override is recorded once');
  assert.equal(log[0].file, file);
  assert.equal(log[0].term, 'ruflo');
  assert.equal(log[0].reason, 'wrapping the store for a spike');
  await srv.close();
});
