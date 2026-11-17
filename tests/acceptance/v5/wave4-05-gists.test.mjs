// Wave 4, test 5: rUv's gists as the `_gists` repository of the layered store (and of the lexical store).
// A small gist passage file in the Brain's format is written at test time and named in the builder's
// source list as { "gists": "<file>" }:
//   - each gist file is its chunks' text in chunk order, joined with one newline, without the Brain's
//     4-line header: exactly, character for character;
//   - one map row per gist file: kind gist, the gist's title, its date as version, its URL as entry, the
//     file's first sentence verbatim with its line; map_ruvnet finds it, source_ruvnet reads it by the
//     short name `gists`;
//   - a secret in a gist is screened; a passage without the header, or with a path outside the folder,
//     is skipped and counted, never written;
//   - the folder is the same bytes from the same passage file (no clock), and keyword search finds gist text.
// Break (breaks-wave4.mjs): the Brain's header kept in the gist text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { built, query } from './wp5-helpers.mjs';
import { openLayeredDirect } from './wave4-helpers.mjs';

const header = (title, date, id) => `SOURCE: GitHub gist by @ruvnet — "${title}"\nGIST STATUS: rUv's own notes / release announcement — may describe PROPOSED or UNRELEASED work.\nTreat as intent, not as confirmed shipped behavior: verify against repo source before asserting.\nupdated: ${date} · https://gist.github.com/ruvnet/${id}\n\n`;
const KEY = ['AKIA', 'GIST', 'TEST', 'KEY0', '0001'].join('');
const CHUNKS = [
  'The lanternwick swarm keeps every agent on one shared ledger. It was sketched in a weekend.\n\n## Setup\n\nRun the lanternwick init step first.',
  '## Limits\n\nThe default `fanout` is 12 agents per ledger.',
  `## Keys\n\nNever paste ${KEY} into a gist.\nEnd of the lanternwick notes.`,
];
const P = (id, n, title, text, date = '2026-10-20') => JSON.stringify({ id: `${id}-${n}`, path: `${id}/${title}#${n}`, title, text: header(title, date, `${id}full`) + text });
const LINES = [
  P('ab12cd34', 2, 'lanternwick.md', CHUNKS[2]),
  P('ab12cd34', 0, 'lanternwick.md', CHUNKS[0]),
  P('ab12cd34', 1, 'lanternwick.md', CHUNKS[1]),
  P('ef56ab78', 0, 'notes.txt', 'Plain notes about the copperfen relay, written before the release.', '2026-10-22'),
  JSON.stringify({ id: 'x-0', path: 'ef56ab78/stray.md#0', title: 'stray.md', text: 'No header here, so this is not a gist passage.' }),
  JSON.stringify({ id: 'y-0', path: '../escape.md#0', title: 'escape.md', text: header('escape.md', '2026-10-21', 'zz') + 'outside' }),
];

test('Wave 4: the gists are the _gists repository, verbatim and screened', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave4-05');
  const tree = ctx.tree();
  const dir = ctx.tmp('rb5-gists-in-');
  const jsonl = path.join(dir, 'gists.passages.jsonl');
  fs.writeFileSync(jsonl, LINES.join('\n') + '\n');
  const list = path.join(dir, 'sources.json');
  fs.writeFileSync(list, JSON.stringify({ sources: [{ gists: 'gists.passages.jsonl' }] }));

  // The folder itself, written twice: same bytes, header gone, chunks in order, bad passages skipped.
  const { materializeGists } = await import(pathToFileURL(path.join(tree.root, 'packages', 'builder', 'gists.mjs')).href);
  const a = materializeGists(jsonl, path.join(ctx.tmp('rb5-g1-'), '_gists'));
  const b = materializeGists(jsonl, path.join(ctx.tmp('rb5-g2-'), '_gists'));
  const want = `${CHUNKS.join('\n')}\n`;
  assert.equal(fs.readFileSync(path.join(a.dir, 'ab12cd34', 'lanternwick.md'), 'utf8'), want, 'verbatim gist text: chunks in order, one newline between, no Brain header');
  for (const f of ['.source.json', 'ab12cd34/lanternwick.md', 'ef56ab78/notes.txt']) assert.equal(fs.readFileSync(path.join(a.dir, f), 'utf8'), fs.readFileSync(path.join(b.dir, f), 'utf8'), `${f} is the same from the same passages`);
  assert.deepEqual(a.problems.map((x) => x.reason).sort(), ['Brain header not found; passage skipped', 'unsafe or malformed path ../escape.md#0'], 'bad passages are skipped and counted');
  assert.equal(fs.existsSync(path.join(path.dirname(a.dir), 'escape.md')), false, 'nothing is written outside the folder');
  const meta = JSON.parse(fs.readFileSync(path.join(a.dir, '.source.json'), 'utf8'));
  assert.equal(meta.repo, '_gists');
  assert.equal(meta.date, '2026-10-22', 'the knowledge date is the newest gist date, not the clock');
  assert.match(meta.commit, /^sha256:[0-9a-f]{64}$/);

  // Built through the source list: the layered store has the gist rows, screened.
  const pack = built(ctx, tree, { list });
  const L = await openLayeredDirect(tree, pack);
  t.after(() => L.close());
  const map = L.run('map', { query: 'lanternwick swarm ledger', cursor: 0 });
  const row = map.rows.find((r) => r.kind === 'gist' && r.name === 'lanternwick.md');
  assert.ok(row, `map finds the gist: ${JSON.stringify(map.rows.map((r) => r.name))}`);
  assert.equal(row.repo, '_gists');
  assert.equal(row.version, '2026-10-20');
  assert.equal(row.entry, 'https://gist.github.com/ruvnet/ab12cd34full');
  assert.equal(`${row.source_path}:${row.line}`, 'ab12cd34/lanternwick.md:1');
  assert.equal(row.source_line, CHUNKS[0].split('\n')[0]);
  const src = L.run('source', { repo: 'gists', path: 'ab12cd34/lanternwick.md', from: 1, to: null });
  assert.equal(src.repo, '_gists', 'the short name gists resolves to _gists');
  const shown = src.lines.map(([, x]) => x).join('\n');
  assert.equal(shown, want.slice(0, -1).replace(KEY, '[redacted]'), 'source_ruvnet reads the gist text, the key screened');
  assert.equal(fs.readFileSync(path.join(pack, 'layered.db')).includes(Buffer.from(KEY)), false, 'no key bytes in layered.db');
  const facts = L.run('facts', { target: 'lanternwick.md', kind: 'doc-number-line', repo: null, cursor: 0 });
  assert.deepEqual(facts.rows.map((r) => `${r.path}:${r.lines}`), [`ab12cd34/lanternwick.md:${want.split('\n').findIndex((l) => l.includes('`fanout` is 12')) + 1}-${want.split('\n').findIndex((l) => l.includes('`fanout` is 12')) + 1}`], 'the gist number line, with its line in the joined file');
  assert.ok(query(pack, 'lexical.db', "SELECT * FROM units WHERE repo='_gists' AND text LIKE '%copperfen%'").length === 1, 'the lexical store holds the gist text too');
});
