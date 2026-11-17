// Wave 3, item 4: the delivery guard counts everything one tool result puts on the wire (the text of
// every content block plus any structured content, serialized) against the 44,000-character and
// 20,000-estimated-token ceilings, because it is not known which part the host counts. No text goes
// out twice: a structured copy of the text is dropped. Over the wire the real server sends one text
// block and no structured copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';

const at = (tree, ...p) => import(pathToFileURL(path.join(tree.root, 'packages', ...p)).href);

test('Wave 3 everything on the wire for one tool result is held to the ceiling, and no text goes twice', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave3-05');
  const tree = ctx.tree();
  const { deliver, wireSize, toolResult } = await at(tree, 'server', 'wire.mjs');
  const { DELIVERY, estimateTokens } = await at(tree, 'contract', 'delivery.mjs');
  const within = (r, what) => {
    const s = wireSize(r);
    assert.ok(s.chars <= DELIVERY.maxChars, `${what}: ${s.chars} characters on the wire, over ${DELIVERY.maxChars}`);
    assert.ok(s.tokens <= DELIVERY.maxTokens, `${what}: ${s.tokens} estimated tokens on the wire, over ${DELIVERY.maxTokens}`);
  };
  const line = (i) => `${i}. alpha-vectors/src/hnsw_index.rs · lines ${i}-${i + 3} · the quillfeather index descends its layers`;
  const text = Array.from({ length: 400 }, (_, i) => line(i)).join('\n').slice(0, 30_000);
  assert.ok(text.length <= DELIVERY.maxChars && estimateTokens(text) <= DELIVERY.maxTokens, 'the text alone fits');

  // The count covers the structured part: text plus a structured copy is twice the text on the wire.
  const both = { content: [{ type: 'text', text }], structuredContent: { result: text } };
  assert.ok(wireSize(both).chars >= 2 * text.length, `the structured copy is counted: ${wireSize(both).chars} characters for a ${text.length}-character text`);
  const d = deliver(both);
  assert.equal(d.structuredContent, undefined, 'a structured copy of the text is not sent: no text goes twice');
  assert.equal(d.content[0].text, text, 'the text itself is untouched');
  within(d, 'text with a structured copy');
  const short = { content: [{ type: 'text', text: 'FILES (1)\n1. alpha-vectors/README.md · lines 1-4' }], structuredContent: { text: 'FILES (1)\n1. alpha-vectors/README.md · lines 1-4' } };
  assert.equal(deliver(short).structuredContent, undefined, 'a structured copy of the text is not sent, even when it fits');

  // Structured content that is not a copy but pushes the result over the ceiling is not sent either.
  const extra = { content: [{ type: 'text', text }], structuredContent: { rows: Array.from({ length: 2000 }, (_, i) => ({ i, note: 'row' })) } };
  assert.ok(wireSize(extra).chars > DELIVERY.maxChars, 'the fixture is over the ceiling only because of its structured part');
  within(deliver(extra), 'text with large structured content');
  const small = { content: [{ type: 'text', text }], structuredContent: { n: 1 } };
  assert.deepEqual(deliver(small).structuredContent, { n: 1 }, 'small structured content that repeats nothing and fits is kept');

  // Text over the ceiling (characters, or estimated tokens of dense punctuation) is cut, and says so.
  for (const [what, big] of [['characters', 'x'.repeat(80) + '\n'], ['tokens', '{};()[].,'.repeat(9) + '\n']]) {
    const r = toolResult(big.repeat(Math.ceil(60_000 / big.length)), false, null);
    within(r, `a ${what}-heavy result`);
    assert.match(r.content.at(-1).text, /\nCUT · this result was cut to stay within what the host delivers/, `a ${what}-heavy result says it was cut`);
  }

  // Over the wire: the real server sends one text block, no structured copy, within the ceiling.
  const { home } = ctx.installed(tree);
  const s = await ctx.server(tree, home);
  for (const detail of ['brief', 'full']) {
    const res = await s.call('tools/call', { name: 'search_ruvnet', arguments: { query: 'how does the quillfeather index descend its layers with marrowlight', detail } }, 30_000);
    assert.equal(res.structuredContent, undefined, `${detail}: the result must not carry a structured copy of its text`);
    assert.equal(res.content.length, 1, `${detail}: one text block`);
    within(res, `the served ${detail} result`);
  }
});
