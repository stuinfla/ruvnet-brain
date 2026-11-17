// WP2 T8: what the host delivers. Measured on the host real users run: tool results of 51,000 to
// 60,000 characters were rejected 95-97% of the time; up to 47,000 were delivered 463 of 463. So the
// whole text of one result is at most 44,000 characters AND at most 20,000 estimated tokens (the larger
// of characters / 3 and the count of word and punctuation pieces), whatever the recipe's budgets allow.
// A worst-case dense pack (long lines of short code-like tokens), with a recipe whose budgets would let
// the result reach 60,000 characters, must come out under both; the lowest-ranked excerpts are trimmed
// first; headers, "no match" reasons and the closing line stay; the header says how much was trimmed;
// the result is the same in two processes; a normal result is not trimmed.
// Breaks: the ceiling is removed; tokens are estimated from characters alone; the best item is trimmed first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { section, unfenced, writeRepo } from './wp2-helpers.mjs';

const MAX_CHARS = 44_000;
const MAX_TOKENS = 20_000;
const tokens = (t) => Math.max(Math.ceil(t.length / 3), (t.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? []).length);
const CLOSING = /^NOTE · When sources disagree: code that exists outranks/m;

function denseFile(k) {
  const L = 'abcdefghijklmnopqrstuvwxyz';
  const rows = [`// dendrafax kernel ${k}: ${['zorvane', 'quillmarsh', 'tethrin'][k % 3]}${k} vexbloom${k}a wrenfold${k}b`];
  for (let i = 0; i < 160; i++) {
    let s = '';
    for (let j = 0; s.length < 110; j++) s += `${L[(i + j) % 26]}${(i * j) % 10}=${L[(i * 3 + j) % 26]}${j % 10}+${L[(j * 7) % 26]};`;
    rows.push(`let r${i}_${k}=[${s}];`);
  }
  return rows.join('\n') + '\n';
}

test('WP2 T8 a result never exceeds what the host delivers', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-08');
  const tree = ctx.tree();
  const files = Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [`src/kernel_${k}.js`, denseFile(k)]));
  const dense = writeRepo(ctx.tmp('rb5-dense-'), 'dense-kernels', files);
  const recipe = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  const sections = recipe.sections.map((s) => (s.name === 'FILES' ? { ...s, itemChars: 14_000, budgetChars: { brief: 20_000, full: 60_000 } } : s));
  // No result.delivery (as in a contract-v1 recipe), so the server's guard is the only thing that holds
  // the text to what the host delivers; the engine's own use of delivery is tested in wave2-delivery.
  const { home } = ctx.installed(tree, { sources: [...THREE, dense], recipe: { sections, result: { capChars: { brief: 24_000, full: 60_000 }, delivery: undefined } } });

  const srv = await ctx.server(tree, home);
  const r = await srv.search('dendrafax kernel', { detail: 'full' });
  assert.equal(r.mode, 'MODE · normal', r.text.slice(0, 300));
  const shed = Number(/· trimmed (\d+) characters to fit what the host delivers$/.exec(r.header)?.[1]);
  assert.ok(r.text.length <= MAX_CHARS, `result is ${r.text.length} characters, over the ${MAX_CHARS} the host delivers`);
  assert.ok(tokens(r.text) <= MAX_TOKENS, `result is about ${tokens(r.text)} tokens, over the ${MAX_TOKENS} the host delivers`);
  assert.ok(shed > 0, `the header must say the result was trimmed and by how much: ${r.header}`);
  assert.ok(r.text.length + shed >= 55_000, `the fixture must be worst case: untrimmed about ${r.text.length + shed} characters`);

  t.diagnostic(`delivered ${r.text.length} characters, about ${tokens(r.text)} tokens; trimmed ${shed}`);
  // Nothing structural is dropped: every item keeps its citation, every section its header or reason.
  const f = section(r.text, 'FILES');
  assert.equal(f.files.length, 5, `all five FILES items keep their citation lines: ${f.header}`);
  assert.match(r.text, /^HISTORY \(0\) · no match: this pack has no history$/m);
  assert.match(r.text, CLOSING, 'the closing line stays');
  // Lowest-ranked first: the best item keeps the most text.
  const excerpts = f.block.split(/^<<<passage-\S+$/m).slice(1).map((x) => x.split(/^passage-\S+>>>$/m)[0].length);
  assert.ok(excerpts[0] >= excerpts.at(-1) && excerpts[0] > 2000, `the best item must keep the most text; excerpt sizes ${excerpts.join(', ')}`);

  // The same answer in a second process.
  const srv2 = await ctx.server(tree, home);
  assert.equal(unfenced((await srv2.search('dendrafax kernel', { detail: 'full' })).text), unfenced(r.text), 'the same result in two processes');

  // A normal result is not trimmed.
  const normal = await srv.search('thistledown queen hollowmere backoff', { detail: 'full' });
  assert.doesNotMatch(normal.header, /trimmed/, normal.header);
  assert.ok(normal.text.length < MAX_CHARS);
});
