// WP5 / review F03: a secret in a history item is redacted before the item is split into units. A
// commit message holding a private key longer than one history unit (1,600 characters) must not leave
// any piece of the key in the history rows. The key is generated at test time; no key text is
// committed. Owned by the builder (packages/builder): this test stays `todo` until the integration
// owner applies the change in docs/REVIEW-FIXES.md (redact whole history fields in historyUnits before
// splitText, as extract() already does for documents), then the todo flag is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';

test('WP5 a private key spanning history units is redacted whole (review F03)', { todo: 'builder-owned fix pending (docs/REVIEW-FIXES.md F03)', timeout: 60_000 }, async (t) => {
  const ctx = setup(t, 'wp5-history-secret-split');
  const tree = ctx.tree();
  const imp = (f) => import(pathToFileURL(path.join(tree.root, 'packages', 'builder', f)).href);
  const { settings } = await imp('settings.mjs');
  const { extract } = await imp('extract.mjs');
  const s = settings(JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8')));
  const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.ok(pem.length > s.history.splitChars, `the key (${pem.length} characters) is longer than one history unit`);
  const body = pem.split('\n').filter((l) => l && !l.startsWith('-----'));
  const raw = {
    commits: [{ sha: 'feed'.repeat(10), commit: { message: `Rotate the deploy key\n\n${pem}`, author: { date: '2026-11-01T00:00:00Z' } } }],
    issues: [], comments: [], releases: [],
  };
  const out = extract({ meta: { repo: 'alpha-vectors', commit: 'c'.repeat(40), date: '2026-11-01' }, docs: [], history: { owner: 'someone', raw } }, s);
  const rows = out.history.rows;
  assert.ok(rows.length >= 1, 'the commit becomes history rows');
  const leaked = body.filter((l) => rows.some((r) => r.text.includes(l) || r.subject.includes(l) || r.title.includes(l)));
  assert.equal(leaked.length, 0, `${leaked.length} of ${body.length} lines of the private key are in the history rows`);
  assert.ok(out.screened.secrets.some((x) => x.rule === 'private-key'), 'the screen records the private key');
});
