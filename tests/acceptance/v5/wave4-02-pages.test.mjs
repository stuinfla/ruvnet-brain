// Wave 4 (L+ port), test 2: every layered answer stays under the page cap, and paging is exact.
// A fixture big enough to need many pages (400 MCP tools, 3,000 constants, a 5,000-line document and
// one 7,000-character row) is built by the real builder and read through the real reader:
//   - map, facts, find, context and source: every page is JSON of at most 20,000 characters;
//   - following `next` from the first page visits every row exactly once (none skipped, none twice),
//     for facts and find, and source's pages put the file back together line for line;
//   - a row longer than layered.rowMaxChars comes back as a pointer with the source_ruvnet call that
//     reads it, never cut;
//   - a recipe with a lower delivery ceiling gets pages within it; a row size that could fill a page
//     is refused by the builder.
// Breaks (breaks-wave4.mjs): the page cap removed; a cursor that skips a row.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { build, built, recipeFile } from './wp5-helpers.mjs';
import { fileLines, openLayeredDirect, writeKit } from './wave4-helpers.mjs';

const CAP = 20_000;
const tools = Array.from({ length: 400 }, (_, i) => [
  '  {',
  `    name: 'pagefill_tool_${i}',`,
  `    description: 'Pagefill tool number ${i} persists a vector shard and reports its pagefill checksum for replica ${i}',`,
  "    inputSchema: { type: 'object', properties: { shard: { type: 'string' } } },",
  '  },',
].join('\n'));
const EXTRA = {
  'src/mcp/pagefill.ts': `export const pagefillTools = [\n${tools.join('\n')}\n];\n`,
  'src/consts.ts': Array.from({ length: 3000 }, (_, i) => `export const PAGEFILL_LIMIT_${i} = ${i * 7};`).join('\n') + '\n',
  'docs/LONG.md': Array.from({ length: 5000 }, (_, i) => `Line ${i + 1} of the long pagefill document, padded so each line has some length to it.`).join('\n') + '\n',
  // Padded with ordinary lines so discover's minified-file rule (one long line, long average) keeps it.
  'src/long.ts': `export const PAGEFILL_BLOB = '${'x'.repeat(7000)}';\n${Array.from({ length: 60 }, (_, i) => `// ordinary comment line ${i}`).join('\n')}\n`,
};

/** Follows `next` from cursor 0; returns every row and the length of every page. */
function walk(L, tool, args) {
  const rows = [];
  const sizes = [];
  let cursor = 0;
  for (let guard = 0; guard < 500; guard++) {
    const raw = L.raw(tool, { ...args, cursor });
    sizes.push(raw.length);
    const p = JSON.parse(raw);
    rows.push(...p.rows);
    if (p.next === undefined) return { rows, sizes, total: Number(p.shown.split(' of ')[1]) };
    assert.ok(p.next > cursor, 'next moves forward');
    cursor = p.next;
  }
  throw new Error('paging did not end');
}

test('Wave 4: every layered page is under the cap and paging visits every row once', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave4-02');
  const tree = ctx.tree();
  const kit = writeKit(ctx, EXTRA);
  const pack = built(ctx, tree, { sources: [kit] });
  const L = await openLayeredDirect(tree, pack);
  t.after(() => L.close());

  // map: hundreds of matching capabilities, each with links: the first page is full but within the cap.
  const m = L.raw('map', { query: 'pagefill checksum', cursor: 0 });
  assert.ok(m.length <= CAP, `map page is ${m.length} characters, over ${CAP}`);
  const mp = JSON.parse(m);
  assert.ok(mp.rows.length >= 10 && mp.next > 0, `map pages (${mp.rows.length} rows, next ${mp.next})`);
  assert.ok(m.length > CAP * 0.7, `the map page is filled toward the cap (${m.length})`);

  // facts and find: walk every page.
  for (const [tool, args] of [['facts', { target: 'lplus-kit', kind: null, repo: null }], ['find', { words: 'pagefill' }]]) {
    const w = walk(L, tool, args);
    for (const s of w.sizes) assert.ok(s <= CAP, `${tool} page is ${s} characters, over ${CAP}`);
    assert.ok(w.sizes.length >= 3, `${tool} needs several pages (${w.sizes.length})`);
    const ids = w.rows.map((r) => `${r.level}:${r.id}`);
    assert.equal(new Set(ids).size, ids.length, `${tool}: no row is shown twice`);
    assert.equal(ids.length, w.total, `${tool}: following next shows every row once (${ids.length} shown of ${w.total}); a row was skipped`);
  }

  // A row longer than rowMaxChars: a pointer that reads it, not a cut text.
  const blob = walk(L, 'facts', { target: 'PAGEFILL_BLOB', kind: null, repo: null }).rows.find((r) => r.symbol === 'PAGEFILL_BLOB');
  assert.equal(blob.text, null);
  assert.ok(blob.too_long > 7000);
  assert.equal(blob.read, 'source_ruvnet {"repo":"lplus-kit","path":"src/long.ts","from":1,"to":1}');

  // source: pages of the 5,000-line document put the file back together exactly.
  const want = fileLines(path.join(kit, 'docs', 'LONG.md'));
  const got = [];
  let from = 1;
  let pages = 0;
  for (; pages < 200; pages++) {
    const raw = L.raw('source', { repo: 'lplus-kit', path: 'docs/LONG.md', from, to: 5000 });
    assert.ok(raw.length <= CAP, `source page is ${raw.length} characters, over ${CAP}`);
    const p = JSON.parse(raw);
    assert.equal(p.from, from);
    for (const [n, text] of p.lines) got.push([n, text]);
    if (!p.next) break;
    from = JSON.parse(p.next.replace(/^source_ruvnet /, '')).from;
    assert.equal(from, p.to + 1, 'the next page starts on the line after this one');
  }
  assert.ok(pages >= 2, 'the document needs several pages');
  assert.deepEqual(got.map(([n]) => n), want.map((_, i) => i + 1), 'every line number once, in order');
  assert.deepEqual(got.map(([, x]) => x), want, 'source pages are the file, line for line');

  // context: within the cap.
  const c = L.raw('context', { repo: 'lplus-kit', path: 'src/config.ts' });
  assert.ok(c.length <= CAP, `context page is ${c.length} characters`);
  assert.equal(JSON.parse(c).adrs_naming_file[0]?.adr, 'docs/adr/ADR-007-memory-ttl.md');

  // A recipe that lowers the delivery ceiling lowers the layered pages with it.
  const recipe = recipeFile(ctx, tree, (r) => {
    r.result.delivery.maxChars = 12000;
  });
  const low = await openLayeredDirect(tree, built(ctx, tree, { sources: [kit], recipe }));
  t.after(() => low.close());
  const lowPage = low.raw('facts', { target: 'lplus-kit', kind: null, repo: null, cursor: 0 });
  assert.ok(lowPage.length <= 12000 && lowPage.length > 8000, `with a 12,000-character delivery ceiling a page is ${lowPage.length} characters`);
  // The builder refuses a row size that could fill a page.
  const badRecipe = recipeFile(ctx, tree, (r) => {
    r.layered.rowMaxChars = 15000;
  });
  const bad = build(ctx, tree, { sources: [kit], recipe: badRecipe });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /layered\.rowMaxChars 15000 must be at most half of the page cap \(20000 characters\)/);
});
