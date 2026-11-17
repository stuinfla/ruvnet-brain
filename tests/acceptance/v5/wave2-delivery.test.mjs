// Wave 2: the delivery ceiling in the engine, and honest citations for trimmed excerpts.
// (a) A recipe that names result.delivery is held to it by the engine's own assembly: the excerpts of
//     one result stay within its characters and its estimated tokens (the server's guard, the last
//     step, is tested by wp2-08 with a recipe that names none, as a contract-v1 recipe does).
// (b) When the server trims an excerpt to fit, its citation names the lines actually shown, carries
//     the sha256 of the text actually shown, and says it was trimmed and from which passage lines.
// Breaks: the engine ignores result.delivery; a trimmed excerpt cites its untrimmed lines and hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { THREE, setup } from './helpers.mjs';
import { writeRepo } from './wp2-helpers.mjs';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tokens = (t) => Math.max(Math.ceil(t.length / 3), (t.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? []).length);
const numbered = (tag) => Array.from({ length: 600 }, (_, i) => `ledgerline L${i + 1} k${tag} quarrystone tally ${tag}${i} of a numbered wave two fixture`).join('\n') + '\n';

function bigRepo(ctx) {
  const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((tag) => [`docs/ledger-${tag}.md`, numbered(tag)]));
  return writeRepo(ctx.tmp('rb5-ledger-'), 'ledger-w2', files);
}

const roomy = (recipe, delivery) => ({
  sections: recipe.sections.map((s) => (s.name === 'FILES' ? { ...s, itemChars: 14_000, budgetChars: { brief: 20_000, full: 60_000 } } : s)),
  result: { capChars: { brief: 24_000, full: 60_000 }, delivery },
});

test('Wave 2: the engine holds a result to the recipe’s delivery numbers', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave2-delivery');
  const tree = ctx.tree();
  const base = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  const src = bigRepo(ctx);
  const engine = await import(pathToFileURL(path.join(tree.root, 'packages', 'engine', 'index.mjs')).href);
  const excerpts = (pack) => {
    const h = engine.open(pack);
    try {
      return engine.search(h, 'ledgerline quarrystone tally', { detail: 'full' }).sections.flatMap((s) => s.items.map((i) => i.excerpt));
    } finally {
      engine.close(h);
    }
  };
  const open = excerpts(tree.build([src], { recipe: roomy(base, undefined) }));
  assert.ok(open.join('\n').length > 30_000, `the fixture must exceed the delivery numbers without them: ${open.join('\n').length}`);
  const held = excerpts(tree.build([src], { recipe: roomy(base, { maxChars: 12_000, maxTokens: 3_000 }) }));
  const text = held.join('\n');
  assert.ok(held.length >= 3, `trimmed, not dropped: ${held.length} items`);
  const chars = held.reduce((n, x) => n + x.length, 0);
  assert.ok(chars <= 12_000, `the engine's excerpts are ${chars} characters, over the recipe's 12000 delivery`);
  assert.ok(tokens(text) <= 3_000, `the engine's excerpts are about ${tokens(text)} tokens, over the recipe's 3000 delivery`);
});

test('Wave 2: a trimmed excerpt cites the lines and the hash of the text it shows', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave2-delivery');
  const tree = ctx.tree();
  const base = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  const { home } = ctx.installed(tree, { sources: [...THREE, bigRepo(ctx)], recipe: roomy(base, undefined) });
  const srv = await ctx.server(tree, home);
  const r = await srv.search('ledgerline quarrystone tally', { detail: 'full' });
  assert.equal(r.mode, 'MODE · normal', r.text.slice(0, 300));
  assert.ok(r.text.length <= 44_000, `${r.text.length} characters`);
  const marker = /^<<<passage-(\S+)$/m.exec(r.text)[1];
  const lines = r.text.split('\n');
  let narrowed = 0;
  for (let i = 0; i < lines.length; i++) {
    const cite = /^\d+\. (\S+) · lines (\d+)-(\d+) · commit \S+ · standing \S+ · date \S+ · sha256 ([0-9a-f]{64})( · trimmed \d+ characters(?: \(passage lines (\d+)-(\d+)\))?)?$/.exec(lines[i]);
    if (!cite) continue;
    const open = lines.indexOf(`<<<passage-${marker}`, i);
    const close = lines.indexOf(`passage-${marker}>>>`, open);
    let body = lines.slice(open + 1, close);
    if (/^… \[trimmed \d+ characters/.test(body.at(-1) ?? '')) body = body.slice(0, -1);
    const shown = body.join('\n');
    assert.equal(sha(shown), cite[4], `${cite[1]}: the cited sha256 must be that of the text shown`);
    if (!cite[1].startsWith('ledger-w2/')) continue;
    const [s, e] = [Number(cite[2]), Number(cite[3])];
    if (cite[6]) {
      assert.ok(Number(cite[6]) === s && Number(cite[7]) >= e, `${cite[1]}: the passage range must start where the lines shown start and cover them: ${lines[i]}`);
      if (Number(cite[7]) > e) narrowed++;
    }
    if (!shown) continue;
    assert.equal(body.length, e - s + 1, `${cite[1]}: lines ${s}-${e} are cited but ${body.length} lines are shown`);
    assert.ok(body[0].startsWith(`ledgerline L${s} `), `${cite[1]}: the first line shown must be line ${s}: ${body[0].slice(0, 40)}`);
    const last = body.at(-1);
    assert.ok(`ledgerline L${e} `.startsWith(last) || last.startsWith(`ledgerline L${e} `), `${cite[1]}: the last line shown must be line ${e}: ${last.slice(0, 40)}`);
  }
  assert.ok(narrowed >= 1, 'the fixture must make the server trim at least one excerpt to fewer lines');
  t.diagnostic(`${narrowed} excerpt(s) trimmed by the server, each citing the lines it shows`);
});
