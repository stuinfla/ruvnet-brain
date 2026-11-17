// Wave 4, test 7: the layered tools answer byte for byte as they did before the store was compacted
// (file text deflated, extract text cut from the file at read time) and before the builder streamed.
// A fixed set of calls runs over a fixture pack (the kit, the paging fixture, a gist source); the sha256
// and length of every answer must equal fixtures/wave4-golden.json, which was written by the code at
// 79e3508d (before the change) with WAVE4_WRITE_GOLDEN=1.
// Break (breaks-wave4.mjs): an extract's text cut one line short at read time.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './helpers.mjs';
import { built } from './wp5-helpers.mjs';
import { openLayeredDirect, writeKit } from './wave4-helpers.mjs';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wave4-golden.json');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

const EXTRA = {
  'src/mcp/pagefill.ts': `export const pagefillTools = [\n${Array.from({ length: 120 }, (_, i) => `  {\n    name: 'pagefill_tool_${i}',\n    description: 'Pagefill tool number ${i} persists a vector shard and reports its pagefill checksum',\n    inputSchema: { type: 'object', properties: { shard: { type: 'string' } } },\n  },`).join('\n')}\n];\n`,
  'src/consts.ts': Array.from({ length: 900 }, (_, i) => `export const PAGEFILL_LIMIT_${i} = ${i * 7}; // ünïcode 🙂 ${i}`).join('\n') + '\n',
  'docs/LONG.md': Array.from({ length: 1500 }, (_, i) => `Line ${i + 1} of the long pagefill document, with a number 42 and \`ttl\` setting.`).join('\n') + '\n',
  'src/long.ts': `export const PAGEFILL_BLOB = '${'x'.repeat(7000)}';\n${Array.from({ length: 60 }, (_, i) => `// ordinary comment line ${i}`).join('\n')}\n`,
  'docs/adr/ADR-012-paging.md': '# ADR-012: Paging\n\n**Status:** Proposed\n\nSee src/consts.ts and docs/LONG.md. Supersedes ADR-007.\n',
};
const GIST = (n, title, text) => JSON.stringify({ id: `g${n}`, path: `cafe${n}/${title}#0`, title, text: `SOURCE: GitHub gist by @ruvnet — "${title}"\nGIST STATUS: notes.\nTreat as intent, not as confirmed shipped behavior.\nupdated: 2026-10-0${n} · https://gist.github.com/ruvnet/cafe${n}\n\n${text}` });

/** The fixed call set: [tool, args]. Cursors and ranges reach later pages. */
const CALLS = [
  ['map', { query: 'memory store' }], ['map', { query: 'pagefill checksum' }], ['map', { query: 'pagefill checksum', cursor: 40 }],
  ['map', { query: 'lplus' }], ['map', { query: 'lanternwick' }], ['map', { query: 'zzzz nothing' }],
  ['facts', { target: 'lplus-kit' }], ['facts', { target: 'lplus-kit', cursor: 60 }], ['facts', { target: 'lplus-kit', cursor: 400 }],
  ['facts', { target: 'memory_store' }], ['facts', { target: 'src/config.ts' }], ['facts', { target: 'src' , kind: 'const' }],
  ['facts', { target: 'PAGEFILL_BLOB' }], ['facts', { target: 'HnswConfig' }], ['facts', { target: 'lplus-kit', kind: 'status' }],
  ['facts', { target: 'lplus-kit', kind: 'doc-number-line', cursor: 3 }], ['facts', { target: '1' }], ['facts', { target: '_gists' }],
  ['facts', { target: 'docs/adr/ADR-012-paging.md' }], ['facts', { target: 'nonexistent_thing' }],
  ['find', { words: 'max agents' }], ['find', { words: 'pagefill' }], ['find', { words: 'pagefill', cursor: 30 }], ['find', { words: 'ttl 3600' }],
  ['find', { words: 'ünïcode' }], ['find', { words: 'lanternwick swarm' }], ['find', { words: 'quillshard' }],
  ['context', { repo: 'lplus-kit', path: 'src/config.ts' }], ['context', { repo: 'lplus-kit', path: 'docs/adr/ADR-007-memory-ttl.md' }],
  ['context', { repo: 'lplus-kit', path: 'docs/adr/ADR-012-paging.md' }], ['context', { repo: 'lplus-kit', path: 'docs/LONG.md' }],
  ['context', { repo: 'gists', path: 'cafe1/notes.md' }], ['context', { repo: 'nope', path: 'x.md' }],
  ['source', { repo: 'lplus-kit', path: 'src/config.ts' }], ['source', { repo: 'lplus-kit', path: 'docs/LONG.md', from: 1, to: 1500 }],
  ['source', { repo: 'lplus-kit', path: 'docs/LONG.md', from: 700, to: 1500 }], ['source', { repo: 'lplus-kit', path: 'src/long.ts' }],
  ['source', { repo: 'lplus-kit', path: 'src/consts.ts', from: 850 }], ['source', { repo: 'lplus-kit', path: 'docs/NOTES.md' }],
  ['source', { repo: 'lplus-kit', path: 'packages/big/package.json', from: 1, to: 50 }], ['source', { repo: '_gists', path: 'cafe2/tune.md' }],
  ['source', { repo: 'lplus-kit', path: 'src/config.ts', from: 99 }],
];
const BIG = JSON.stringify({ name: '@lplus/big', version: '0.0.1', keywords: Array.from({ length: 900 }, (_, i) => `keyword-number-${i}`), description: 'Past the truncation point' }, null, 2) + '\n';
const withDefaults = (tool, a) => ({ map: { cursor: 0 }, find: { cursor: 0 }, facts: { kind: null, repo: null, cursor: 0 }, source: { from: 1, to: null }, context: {} })[tool] && { ...({ map: { cursor: 0 }, find: { cursor: 0 }, facts: { kind: null, repo: null, cursor: 0 }, source: { from: 1, to: null }, context: {} })[tool], ...a };

test('Wave 4: layered answers are byte-identical to the golden set', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave4-07');
  const tree = ctx.tree();
  const kit = writeKit(ctx, { ...EXTRA, 'packages/big/package.json': BIG });
  const gdir = ctx.tmp('rb5-g-');
  fs.writeFileSync(path.join(gdir, 'g.jsonl'), [GIST(1, 'notes.md', 'Lanternwick swarm notes. The default `fanout` is 12.\nTODO: more.'), GIST(2, 'tune.md', 'Tuning the copperfen relay.\nSet ef_search to 64.')].join('\n') + '\n');
  const list = path.join(gdir, 'sources.json');
  fs.writeFileSync(list, JSON.stringify({ sources: [{ dir: kit }, { gists: 'g.jsonl' }] }));
  const pack = built(ctx, tree, { list });
  const L = await openLayeredDirect(tree, pack);
  t.after(() => L.close());
  const got = {};
  for (const [tool, a] of CALLS) {
    const out = L.raw(tool, withDefaults(tool, a));
    got[`${tool} ${JSON.stringify(a)}`] = { sha256: sha(out), chars: out.length };
  }
  if (process.env.WAVE4_WRITE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    return;
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(got), Object.keys(want), 'the same call set as the golden file');
  for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], `answer differs from the golden set: ${k}`);
});
