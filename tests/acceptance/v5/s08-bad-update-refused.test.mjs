// S8 bad update is refused: a signed update whose pack fails its probes (keyword index emptied
// before signing) leaves current.json unchanged and the old pack answering, and is refused BEFORE
// the switch (not switched and rolled back).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { THREE, readPointerRaw, repo, setup } from './helpers.mjs';

test('S8 an update whose pack fails its probes is refused', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's08');
  const tree = ctx.tree();
  const { home, pack: pack1 } = ctx.installed(tree);
  const before = readPointerRaw(home);
  const gen1 = JSON.parse(before).pack;

  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const db = new DatabaseSync(path.join(pack2, 'lexical.db'));
  db.exec('DELETE FROM fts');
  db.close();
  tree.reassemble(pack2);
  const gen2 = JSON.parse(fs.readFileSync(path.join(pack2, 'PACK.json'), 'utf8')).generation;
  const rel2 = tree.release(pack2, { number: 2 });

  const u = tree.cli(home, ['update', '--from', rel2]);
  assert.notEqual(u.status, 0, `a pack that fails its probes must be refused: ${u.stdout}`);
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'state', 'update.json'), 'utf8'));
  assert.equal(rec.result, 'refused', `the bad pack must be refused before the switch, not switched: ${JSON.stringify(rec)}`);
  assert.equal(rec.stage, 'pre-switch-probes');
  assert.equal(readPointerRaw(home), before, 'current.json must be byte-for-byte unchanged');
  assert.equal(fs.existsSync(path.join(home, 'packs', gen2)), false, 'the refused pack must not be left on disk');
  assert.ok(fs.existsSync(pack1));

  const srv = await ctx.server(tree, home);
  const r = await srv.search('gloamwick journal');
  assert.equal(r.mode, 'MODE · normal', r.mode);
  assert.ok(r.header.includes(`pack ${gen1}`), `the old pack must still answer: ${r.header}`);
  assert.equal(r.files[0]?.file, 'beta-memory/docs/DESIGN.md');
});
