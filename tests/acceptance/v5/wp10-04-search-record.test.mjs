// WP10-04 no stamp can be made by hand. A write passes only on this session's own search_ruvnet result
// (the host's transcript) whose citation re-hashes against the installed pack. Stamp files of every
// kind 4.7 used, and a v5-looking stamp, change nothing; a forged result (a citation that is not in the
// pack, a wrong hash), an error result, a stale result, or a result with no matching call is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { Q, TERM_TEXT, emptyTranscript, guard, okServer, transcript, writeMsg } from './wp10-helpers.mjs';

test('WP10-04 only a verifiable search record lets a write through', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp10-04');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  assert.equal(tree.cli(home, ['guard', 'on']).status, 0);
  const srv = await okServer(ctx, tree, home);
  const real = await srv.call('tools/call', { name: 'search_ruvnet', arguments: { query: Q } });
  const text = real.content.map((c) => c.text).join('');
  assert.match(text, /alpha-vectors\/src\/hnsw_index\.rs · lines/, 'the search found the fixture file');
  const dir = ctx.tmp('rb5-session-');
  const project = ctx.tmp('rb5-project-');
  const file = path.join(project, 'adapter.ts');
  const run = (tr) => guard(tree, home, writeMsg(file, TERM_TEXT, tr), { cwd: project });

  const good = run(transcript(dir, { content: real.content }));
  assert.equal(good.status, 0, `a real search result of this session must let the write through: ${good.stderr}`);
  assert.equal(good.stdout, '');

  // Hand-made stamps: every place 4.7 kept one, and a v5-looking one. None counts.
  for (const f of [path.join(os.homedir(), '.cache', 'ruvnet-brain', 'grounded', 'ruflo'), path.join(project, '.ruvnet-brain', 'grounded', 'ruflo'), path.join(home, 'state', 'search-stamp.json'), path.join(home, 'state', 'grounded', 'ruflo')]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ at: Date.now(), term: 'ruflo', ok: true }));
  }
  assert.equal(run(emptyTranscript(dir)).status, 2, 'a hand-made stamp must not let a write through');

  const forgedPath = text.replace(/^(\d+\. [^/\s]+\/)(\S+ · lines)/gm, '$1forged/$2');
  assert.ok(forgedPath.includes('alpha-vectors/forged/src/hnsw_index.rs · lines'), 'every citation path is forged');
  assert.equal(run(transcript(dir, { content: [{ type: 'text', text: forgedPath }] })).status, 2, 'a forged record (a file not in the pack) must not pass');
  const forgedHash = text.replace(/sha256 [0-9a-f]{64}/g, `sha256 ${'0'.repeat(64)}`);
  assert.equal(run(transcript(dir, { content: [{ type: 'text', text: forgedHash }] })).status, 2, 'a forged record (wrong hashes) must not pass');
  assert.equal(run(transcript(dir, { content: real.content, isError: true })).status, 2, 'an error result does not count');
  assert.equal(run(transcript(dir, { content: real.content, at: Date.now() - 5 * 3_600_000 })).status, 2, 'a stale result does not count');
  assert.equal(run(transcript(dir, { content: real.content, pair: false })).status, 2, 'a result with no search_ruvnet call does not count');
  assert.equal(run(transcript(dir, { content: real.content, name: 'mcp__other__lookalike' })).status, 2, 'another tool does not count');
  await srv.close();
});
