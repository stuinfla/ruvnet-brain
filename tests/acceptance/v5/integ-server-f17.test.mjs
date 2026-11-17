// Review F17: private results merge under the section's rules, are cited unambiguously, and the same
// displayed text is never sent twice.
// - Six public files and five private files match one word: FILES still holds at most its maxItems (5)
//   items, one per file.
// - A private file with the same repo/path as a public file is cited as private:<pack>/<repo>/<path>,
//   and read_ruvnet of that citation returns the private text, not the public file.
// - Two different passages that trim to the same shown text (the FILES budget is made small) are shown
//   once: no sha256 appears twice in one answer.
// Breaks: private items are appended past maxItems; private items keep their bare repo name; the
// formatter deduplicates before trimming only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { installPrivate, section, writeRepo } from './wp2-helpers.mjs';

const filesOf = (stem, n, extra = '') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`docs/${stem}${i}.md`, `# ${stem} ${i}\n\nThe brindlecove rota, part ${i}${extra}, is written down here.\n`]));

test('F17 private items merge under the section rules and are cited with their pack', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'integ-server-f17');
  const tree = ctx.tree();
  const src = ctx.tmp('rb5-f17-');
  const shared = Array.from({ length: 18 }, (_, i) => `line ${i + 1}: the mirrowelk survey notes the same careful words in every copy.`).join('\n');
  const pub = [
    writeRepo(src, 'brindle-public', filesOf('pub', 6)),
    writeRepo(src, 'pub-notes', { 'NOTES.md': '# Notes\n\nThe quillfen schedule is public and posted weekly.\n' }),
    writeRepo(src, 'twin-notes', { 'a/SURVEY.md': `${shared}\nthe first copy ends here.\n`, 'b/SURVEY.md': `${shared}\nthe second copy ends differently.\n` }),
  ];
  const { home } = ctx.installed(tree, { sources: pub, recipe: { sections: JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8')).sections.map((s) => (s.name === 'FILES' ? { ...s, budgetChars: { brief: 3000, full: 36000 } } : s)) } });
  const listed = path.join(ctx.tmp('rb5-projects-'), 'client-work');
  fs.mkdirSync(listed, { recursive: true });
  const privSrc = ctx.tmp('rb5-f17-priv-');
  const priv = [
    writeRepo(privSrc, 'brindle-private', filesOf('own', 5, ' (private)')),
    writeRepo(privSrc, 'pub-notes', { 'NOTES.md': '# Notes\n\nThe quillfen schedule, private copy: the owner moves it to Thursdays.\n' }),
  ];
  installPrivate(home, tree.build(priv), 'notes', [listed]);
  const srv = await ctx.server(tree, home, { cwd: listed });

  // The section's item limit and one item per file hold with a private pack merged in.
  const many = await srv.search('brindlecove rota', { detail: 'full' });
  const files = section(many.text, 'FILES').files;
  assert.ok(files.length <= 5, `FILES must hold at most 5 items with a private pack merged in; it holds ${files.length}: ${JSON.stringify(files)}`);
  assert.equal(new Set(files).size, files.length, `one item per file: ${JSON.stringify(files)}`);

  // A private file is cited with its pack, and that citation reads the private file.
  const q = await srv.search('quillfen schedule');
  const cited = section(q.text, 'FILES').files;
  assert.ok(cited.includes('private:notes/pub-notes/NOTES.md'), `a private item must be cited as private:<pack>/<repo>/<path>: ${JSON.stringify(cited)}`);
  const res = await srv.call('tools/call', { name: 'read_ruvnet', arguments: { ref: 'private:notes/pub-notes/NOTES.md' } });
  const text = res.content.map((c) => c.text).join('');
  assert.equal(!!res.isError, false, text.slice(0, 300));
  assert.match(text, /private copy: the owner moves it to Thursdays/, `read_ruvnet of a private citation returns the private file: ${text.slice(0, 400)}`);
  assert.match(text, /^private:notes\/pub-notes\/NOTES\.md · lines /m, 'the read answer cites the private file');

  // Two passages that trim to the same shown text are shown once.
  const twin = await srv.search('mirrowelk survey');
  const hashes = [...twin.text.matchAll(/ · sha256 ([0-9a-f]{64})/g)].map((m) => m[1]);
  assert.ok(hashes.length >= 1, twin.text.slice(0, 400));
  assert.equal(new Set(hashes).size, hashes.length, `the same shown text was sent twice:\n${twin.text.split('\n').filter((l) => /sha256/.test(l)).join('\n')}`);
});
