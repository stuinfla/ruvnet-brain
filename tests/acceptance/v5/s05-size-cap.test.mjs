// S5 size cap: a fixture with very large files (made at test time, about 150,000 characters of
// matching text, one file duplicated in a second repository) is searched; the delivered result is
// at or under the cap for brief and full, and no text appears twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const big = (tag, n) => Array.from({ length: n }, (_, i) => `q${tag}n${i} sprawlquartz shard ${tag} line ${i} of an oversized fixture passage`).join('\n') + '\n';

function makeRepos(dir) {
  const a = path.join(dir, 'huge-a');
  const b = path.join(dir, 'huge-b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, '.source.json'), JSON.stringify({ repo: 'huge-a', commit: 'e5e5e5e5e5e5', date: '2026-11-15' }));
  fs.writeFileSync(path.join(b, '.source.json'), JSON.stringify({ repo: 'huge-b', commit: 'f6f6f6f6f6f6', date: '2026-11-15' }));
  for (const tag of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(a, `big-${tag}.md`), big(tag, 500));
  fs.writeFileSync(path.join(b, 'copy-of-big-a.md'), big('a', 500));
  fs.writeFileSync(path.join(b, 'big-e.md'), big('e', 500));
  return [a, b];
}

function assertDelivered(r, cap, filesBudget) {
  assert.equal(r.isError, false, r.text.slice(0, 300));
  const block = r.text.slice(r.text.indexOf('\nFILES (') + 1, r.text.indexOf('\n\nNOTE ·'));
  assert.ok(block.length <= filesBudget, `FILES section is ${block.length} characters, over its own ${filesBudget} budget`);
  assert.equal(r.raw.content.length, 1, 'one text block');
  assert.equal(r.raw.structuredContent, undefined, 'no second structured copy of the text');
  assert.ok(r.text.length <= cap, `result is ${r.text.length} characters, over the ${cap} cap`);
  assert.ok(r.files.length >= 3, `excerpts must be trimmed, not dropped: ${r.files.length} files`);
  const counts = new Map();
  for (const id of r.text.match(/\bq[a-e]n\d+\b/g) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const twice = [...counts].filter(([, n]) => n > 1);
  assert.deepEqual(twice, [], 'no text may appear twice');
  assert.equal(r.files.filter((f) => f.hash === r.files[0].hash).length, 1, 'duplicate file content is cited once');
}

test('S5 the result is capped and sent once', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's05');
  const tree = ctx.tree();
  const sources = makeRepos(ctx.tmp('rb5-huge-'));
  const { home } = ctx.installed(tree, { sources, recipe: { units: { passage: { chunker: { maxLines: 100000, maxChars: 100000 }, symbolChunker: { maxTokens: 8192 } } } } });
  const srv = await ctx.server(tree, home);

  const full = await srv.search('sprawlquartz shard oversized', { detail: 'full' });
  assertDelivered(full, 60_000, 56_000);
  assert.match(full.text, /\[trimmed \d+ characters\]/);
  const brief = await srv.search('sprawlquartz shard oversized');
  assertDelivered(brief, 24_000, 22_000);
});
