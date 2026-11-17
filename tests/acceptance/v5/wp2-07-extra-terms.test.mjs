// WP2 T7: `extra_terms` (the calling model's technical phrasings) never replace or outrank the user's
// own words. Measured by the retrieval run: replacing the question with rewrites lowers results for
// practitioners and experts by 18 to 27 points; adding them beside it helps amateurs. The merging rule
// is not yet admitted, so it sits behind a recipe switch that is off in the shipped recipe:
// - switch off (shipped recipe): the answer is exactly the answer without extra terms, plus one note;
// - switch on (`query.extraTerms: "append"`): the question's items come first, in the same order and
//   byte for byte; extra items only fill free slots after them and say which term found them; the same
//   in two processes.
// Breaks: the switch is ignored; extra items are put first; the question is replaced by the terms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { section, unfenced } from './wp2-helpers.mjs';

const Q = 'hollowmere backoff';
const EXTRA = ['gloamwick journal', 'tidewrack episode store'];

/** Per item: citation line and excerpt, fence marker removed. */
const items = (text) => unfenced(section(text, 'FILES').block).split(/\n(?=\d+\. )/).slice(1).map((x) => x.trimEnd());

test('WP2 T7 extra terms are searched only beside the question', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-07');
  const tree = ctx.tree();

  // Switch off: the shipped recipe.
  const off = ctx.installed(tree);
  const s1 = await ctx.server(tree, off.home);
  const plain = await s1.search(Q);
  assert.ok(plain.files.length >= 1 && plain.files.length < 5, `the question alone must leave free slots: ${plain.files.length}`);
  const withExtra = await s1.search(Q, { extra_terms: EXTRA });
  assert.equal(unfenced(withExtra.text), `${unfenced(plain.text)}\nNOTE · extra_terms received and not searched: recipe r4-lplus searches the question as given.`, 'with the switch off, extra terms change nothing but one note');

  // Switch on.
  const on = ctx.installed(tree, { recipe: { query: { extraTerms: 'append' } } });
  const s2 = await ctx.server(tree, on.home);
  const base = await s2.search(Q);
  const merged = await s2.search(Q, { extra_terms: EXTRA });
  const n = base.files.length;
  assert.deepEqual(merged.files.slice(0, n).map((f) => f.file), base.files.map((f) => f.file), 'the question\'s own items come first, in their own order');
  assert.deepEqual(items(merged.text).slice(0, n), items(base.text), 'the question\'s own items are unchanged, byte for byte');
  assert.ok(merged.files.length > n && merged.files.length <= 5, `extra items fill the free slots: ${merged.files.length}`);
  const added = merged.files.slice(n).map((f) => f.file);
  assert.ok(added.includes('beta-memory/docs/DESIGN.md') || added.includes('beta-memory/src/episode_store.ts'), `an extra term's file is added: ${added}`);
  assert.equal((merged.text.match(/^ALSO · found by the extra term /gm) ?? []).length, merged.files.length - n, 'every added item says which extra term found it');
  const again = await (await ctx.server(tree, on.home)).search(Q, { extra_terms: EXTRA });
  assert.equal(unfenced(again.text), unfenced(merged.text), 'the same merged answer in a second process');
});
