// WP5 history store (RECIPE-FINAL 2.1): one unit per commit (any author, bots included), and per
// owner-written issue, pull request, comment and release note, split at 1,600 characters, header
// `repo › history › kind ref › date › title`, in its own index. The reader runs against recorded
// hosting-API pages in wp5-fixtures/history (no network). An issue, comment or release by anyone but
// the owner never reaches the pack; a commit by anyone else is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEP, built, query, readJson, repo, setup } from './wp5-helpers.mjs';

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wp5-fixtures', 'history');
const STRANGERS = ['strangerbloom', 'outsiderfen', 'outsiderglint'];
const OTHER_COMMITS = ['intruderquill', 'phantomreed'];

test('WP5 history: all commits, owner-only discussion, split at 1,600 characters, own index', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp5-history');
  const tree = ctx.tree();
  const list = path.join(ctx.tmp('rb5-list-'), 'sources.json');
  fs.writeFileSync(list, JSON.stringify({ sources: [
    { dir: repo('alpha-vectors') },
    { dir: repo('beta-memory'), history: { owner: 'stellarowner', recorded: path.join(RECORDED, 'beta-memory') } },
  ] }));
  const pack = built(ctx, tree, { list });
  const h = query(pack, 'history.db', 'SELECT * FROM units ORDER BY id');

  const kinds = h.map((u) => `${u.kind}:${u.ref}`);
  assert.deepEqual(kinds, [
    'commit:c0ffee1234567890abcdef1234567890abcdef12', 'commit:c0ffee1234567890abcdef1234567890abcdef12',
    'commit:badd00d234567890abcdef1234567890abcdef12', 'commit:9905751234567890abcdef1234567890abcdef12',
    'issue:3', 'pr:5', 'comment:3#901',
    'release:v0.3.0', 'release:v0.3.0', 'release:v0.3.0', 'release:v0.3.0',
  ], 'every commit, owner-written discussion only, the long ones split');
  for (const u of h) assert.ok(u.text.length > 0 && u.text.length <= 1600, `${u.path} piece ${u.piece} is ${u.text.length} characters`);
  assert.deepEqual(h.filter((u) => u.kind === 'release').map((u) => u.text.length), [24, 1594, 1594, 307]);

  const c = h[0];
  assert.equal(c.header, `beta-memory${SEP}history${SEP}commit c0ffee1234${SEP}2026-11-01${SEP}Rework the gloamwick journal compaction`);
  assert.equal(c.path, 'history/commit/c0ffee1234567890abcdef1234567890abcdef12');
  assert.equal(c.repo, 'beta-memory');
  assert.equal(c.date, '2026-11-01');
  assert.equal(h.find((u) => u.kind === 'comment').path, 'history/comment/3#901');
  assert.equal(h.find((u) => u.kind === 'pr').header, `beta-memory${SEP}history${SEP}pr 5${SEP}2026-11-08${SEP}Compact journal segments`);

  // the history index answers on its own fields and never on a stranger's words
  // the index holds analysed tokens, so a word is looked up as the engine's analyser cuts it
  const { analyse } = await import(pathToFileURL(path.join(tree.root, 'packages', 'engine', 'analyse.mjs')).href);
  const analyser = readJson(path.join(pack, 'RECIPE.json')).analyser;
  const hit = (db, w) => {
    assert.equal(analyse(w, analyser).split(' ').length, 1, `"${w}" is one token`);
    return query(pack, db, 'SELECT count(*) AS n FROM fts WHERE fts MATCH ?', `"${analyse(w, analyser)}"`)[0].n;
  };
  for (const w of ['harborwisp', 'tidequill', 'cinderloft', 'lantern317', ...OTHER_COMMITS]) assert.equal(hit('history.db', w), 1, `kept text "${w}" is indexed`);
  for (const w of STRANGERS) {
    assert.equal(hit('history.db', w), 0, `"${w}" (not the owner) must not be indexed`);
    for (const f of fs.readdirSync(pack)) {
      assert.ok(!fs.readFileSync(path.join(pack, f)).toString('latin1').toLowerCase().includes(w), `"${w}" appears in ${f}`);
    }
  }

  // listed in the pack manifest with its own role; counted per source
  const files = readJson(path.join(pack, 'PACK.json')).files;
  assert.equal(files.find((f) => f.path === 'history.db')?.role, 'history-db');
  const m = readJson(path.join(pack, 'manifest.json'));
  const beta = m.sources.find((s) => s.repo === 'beta-memory');
  assert.deepEqual(beta.history.units, 11);
  assert.deepEqual(beta.history.dropped, { notOwner: 3, empty: 1, short: 2, merge: 1 });
  assert.equal(m.sources.find((s) => s.repo === 'alpha-vectors').history, null);
  assert.equal(query(pack, 'lexical.db', "SELECT count(*) AS n FROM units WHERE path LIKE 'history/%'")[0].n, 0, 'history units are not in the passage store');
});
