// Wave 4, test 4 (Codex review F03): a secret in a history item never reaches the pack, even when the
// item is longer than one history unit (1,600 characters) and the split would cut the secret in two.
// The recorded history is written at test time (no key-shaped text is committed): an owner issue whose
// body holds a 3,000-character PEM private key, a commit message with a GitHub token placed across the
// split point, and a release whose title carries a token (titles feed the unit header too).
//   - no BEGIN/END key line, no key body line and no token appears in history.db, in any form;
//   - each secret is replaced by the recipe's redaction, once, and recorded in manifest.json by rule;
//   - the item is still split and searchable by its ordinary words.
// Break (breaks-wave4.mjs): history items screened per piece after the split, as before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { built, query, readJson, writeRepo } from './wp5-helpers.mjs';

const OWNER = 'stellarowner';
// Key-shaped material assembled at run time.
const DASH = '-'.repeat(5);
const keyLines = Array.from({ length: 46 }, (_, i) => crypto.createHash('sha512').update(`line-${i}`).digest('base64').slice(0, 64));
const PEM = [`${DASH}BEGIN RSA PRIVATE KEY${DASH}`, ...keyLines, `${DASH}END RSA PRIVATE KEY${DASH}`].join('\n');
const TOKEN = ['gh', 'p_', 'Zq7Lp2Xk9Vr4Tn8Wm3Hs6Jd1Fb5Gc0Ny7Ke2Ua'].join('');
const TOKEN2 = ['gh', 'p_', 'Rr9Tt8Yy7Uu6Ii5Oo4Pp3Aa2Ss1Dd0FfGgHhJj'].join('');

test('Wave 4: history secrets are screened before any unit is cut (F03)', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave4-04');
  const tree = ctx.tree();
  assert.ok(PEM.length > 3000, `the key must be longer than two history units (${PEM.length})`);
  const src = writeRepo(path.join(ctx.tmp('rb5-src-'), 'hist-kit'), { repo: 'hist-kit', commit: 'aaaa1111bbbb2222', date: '2026-11-15' }, { 'README.md': '# hist-kit\n\nA fixture whose only purpose is its history, with the word marrowfen.\n' });
  const rec = ctx.tmp('rb5-rec-');
  // The token sits across character 1,600 of the commit message: a split there would cut it in two.
  const pad = 'Rework the cinderloft queue. ' + 'cinderloft '.repeat(144);
  const msg = `${pad.slice(0, 1590)} ${TOKEN} and more cinderloft notes after the token.`;
  fs.writeFileSync(path.join(rec, 'commits-1.json'), JSON.stringify([{ sha: 'd00d1234567890abcdef1234567890abcdef1234', author: { login: OWNER }, commit: { author: { name: 'Owner', date: '2026-11-02T10:00:00Z' }, message: msg } }]));
  fs.writeFileSync(path.join(rec, 'issues-1.json'), JSON.stringify([{ number: 7, title: 'Deploy key for the quarrylight mirror', body: `The quarrylight mirror needs this key.\n\n${PEM}\n\nRotate it after the quarrylight move.`, user: { login: OWNER }, created_at: '2026-11-03T09:00:00Z' }]));
  fs.writeFileSync(path.join(rec, 'comments-1.json'), '[]');
  fs.writeFileSync(path.join(rec, 'releases-1.json'), JSON.stringify([{ tag_name: 'v1.0.0', name: `Release with ${TOKEN2}`, body: 'Released the brightmoss build. '.repeat(12), author: { login: OWNER }, published_at: '2026-11-04T09:00:00Z' }]));
  const list = path.join(ctx.tmp('rb5-list-'), 'sources.json');
  fs.writeFileSync(list, JSON.stringify({ sources: [{ dir: src, history: { owner: OWNER, recorded: rec } }] }));
  const pack = built(ctx, tree, { list });

  const units = query(pack, 'history.db', 'SELECT * FROM units ORDER BY id');
  const all = units.map((u) => [u.text, u.header, u.title, u.symbol].join('\n')).join('\n');
  assert.ok(units.filter((u) => u.kind === 'issue').length >= 1 && units.some((u) => u.text.includes('quarrylight')), 'the issue is still in the pack');
  assert.ok(units.filter((u) => u.kind === 'commit').length >= 2, 'the long commit is still split');
  const leaks = [/BEGIN RSA PRIVATE KEY/, /END RSA PRIVATE KEY/, ...keyLines.map((l) => new RegExp(l.replace(/[+/=]/g, '\\$&'))), new RegExp(TOKEN.slice(0, 12)), new RegExp(TOKEN.slice(-12)), new RegExp(TOKEN2.slice(-12))];
  for (const re of leaks) assert.equal(re.test(all), false, `a secret reached history.db: ${re}`);
  for (const f of ['history.db', 'lexical.db']) {
    const bytes = fs.readFileSync(path.join(pack, f));
    for (const s of ['PRIVATE KEY', keyLines[20], TOKEN.slice(-12), TOKEN2.slice(-12)]) assert.equal(bytes.includes(Buffer.from(s)), false, `a secret reached ${f} on disk: ${s.slice(0, 12)}`);
  }
  assert.equal((all.match(/\[redacted\]/g) ?? []).length >= 3, true, 'each secret is replaced by the recipe redaction');
  const rules = readJson(path.join(pack, 'manifest.json')).screened.secrets.filter((x) => x.path.startsWith('history/')).map((x) => x.rule).sort();
  assert.deepEqual(rules, ['github-token', 'github-token', 'private-key'], 'the manifest records each history secret by rule, once');
});
