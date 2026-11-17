// WP11-03 the parity table. Every row of packages/docs/parity.json is in docs/v5/PARITY.md with its
// decision, and the totals printed are the totals of the data. A row that is not "kept", "replaced
// by" or "dropped, because" (or "undecided", with a reason), or that cites evidence that does not
// exist, makes the generator refuse with the row named.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { doc, docsTree, editJson, gen } from './wp11-helpers.mjs';

test('WP11-03 every 4.7.28 capability ends kept, replaced by, or dropped because', { timeout: 240_000 }, (t) => {
  const ctx = setup(t, 'wp11-03');
  const tree = docsTree(ctx);
  const file = path.join(tree.root, 'packages', 'docs', 'parity.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(gen(tree).status, 0);
  const md = doc(tree, 'docs/v5/PARITY.md');
  const n = (d) => data.rows.filter((r) => r.decision === d).length;
  assert.match(md, new RegExp(`${data.rows.length} capabilities: \\*\\*${n('kept')} kept\\*\\*, \\*\\*${n('replaced')} replaced\\*\\*, \\*\\*${n('dropped')} dropped\\*\\* \\(moved out of the product or stopped\\), \\*\\*${n('undecided')} undecided\\*\\*`), 'the totals are those of the data');
  for (const r of data.rows) {
    const line = md.split('\n').find((l) => l.startsWith(`| ${r.capability.replace(/\|/g, '\\|')}`));
    assert.ok(line, `PARITY.md lists ${r.capability}`);
    const want = r.decision === 'kept' ? 'kept: ' : r.decision === 'replaced' ? 'replaced by ' : `${r.decision}, because `;
    assert.ok(line.includes(want), `${r.capability}: ${want}`);
  }

  const refuse = (change, why) => {
    const before = fs.readFileSync(file, 'utf8');
    editJson(file, change);
    const r = gen(tree);
    fs.writeFileSync(file, before);
    assert.equal(r.status, 1, `${why}: the generator must refuse (${r.out.slice(0, 200)})`);
    return r.out;
  };
  const drop = data.rows.findIndex((r) => r.decision === 'dropped');
  assert.match(refuse((p) => ({ ...p, rows: p.rows.map((r, i) => (i === drop ? { ...r, because: '' } : r)) }), 'a dropped row with no reason'), new RegExp(`row ${drop + 1} .*a dropped row says why`));
  assert.match(refuse((p) => ({ ...p, rows: p.rows.map((r, i) => (i === 0 ? { ...r, decision: 'probably kept' } : r)) }), 'an unknown decision'), /row 1 .*decision must be one of kept, replaced, dropped, undecided/);
  const rep = data.rows.findIndex((r) => r.decision === 'replaced');
  assert.match(refuse((p) => ({ ...p, rows: p.rows.map((r, i) => (i === rep ? { ...r, by: undefined } : r)) }), 'a replaced row that does not say by what'), /a replaced row says by what/);
  assert.match(refuse((p) => ({ ...p, rows: p.rows.map((r, i) => (i === 0 ? { ...r, evidence: ['packages/server/no-such-file.mjs'] } : r)) }), 'missing evidence'), /evidence packages\/server\/no-such-file\.mjs does not exist/);
  assert.equal(gen(tree, '--check').status, 0, 'the restored data generates the committed document');
});
