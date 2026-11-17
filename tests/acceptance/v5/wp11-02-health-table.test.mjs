// WP11-02 the health table is the health code's own. Every state in the reference is what
// packages/health's assess() and renderLine() give; a changed fix in packages/health's FIX table shows
// up when regenerated; a new cause the generator has no case for makes it refuse rather than skip it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { doc, docsTree, gen } from './wp11-helpers.mjs';

const NEW_FIX = 'ruvnet-brain doctor --and-then-restart-the-session';

test('WP11-02 the health states and fixes come from packages/health', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp11-02');
  const tree = docsTree(ctx);
  const assess = path.join(tree.root, 'packages', 'health', 'assess.mjs');
  fs.writeFileSync(assess, fs.readFileSync(assess, 'utf8').replace("  'safe-mode': 'restart the session',", `  'safe-mode': '${NEW_FIX}',`));
  assert.equal(gen(tree).status, 0);
  const ref = doc(tree, 'docs/v5/REFERENCE.md');
  const rows = Object.fromEntries(ref.split('\n').filter((l) => /^\| [a-z-]+ \| [A-Z ]+ \| `/.test(l)).map((l) => [l.split(' | ')[0].slice(2), l]));
  assert.match(rows['safe-mode'] ?? '', new RegExp(`\`${NEW_FIX}\``), 'a changed fix in packages/health must appear in the reference');

  const { FIX } = await import(pathToFileURL(assess).href);
  const { renderLine } = await import(pathToFileURL(path.join(tree.root, 'packages', 'health', 'line.mjs')).href);
  for (const cause of Object.keys(FIX)) assert.ok(rows[cause], `the reference has a row for ${cause}`);
  for (const cause of ['ok', 'not-installed', 'not-running']) assert.ok(rows[cause], `the reference has a row for ${cause}`);
  assert.ok(rows['safe-mode'].includes(`\`${renderLine({ state: 'degraded', label: 'DEGRADED', since: null, reason: 'last search used keyword-only safe mode (the deadline passed)', fix: NEW_FIX })}\``), 'the line shown is what renderLine prints');

  fs.writeFileSync(assess, fs.readFileSync(assess, 'utf8').replace("  'safe-mode':", "  'disk-full': 'free some disk',\n  'safe-mode':"));
  const refused = gen(tree);
  assert.equal(refused.status, 1, 'a cause the generator does not describe must be refused, not skipped');
  assert.match(refused.out, /causes this generator does not describe: disk-full/);
});
