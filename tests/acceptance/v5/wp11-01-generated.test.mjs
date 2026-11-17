// WP11-01 the generated documents cannot drift. On a copy of the tree with the committed documents, the
// check passes; a changed recipe, a changed command, or a hand edit to a generated file makes it fail
// and name the file; regenerating writes what the source now says, and the check passes again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { doc, docsTree, editJson, gen } from './wp11-helpers.mjs';

test('WP11-01 a stale generated document fails the check', { timeout: 240_000 }, (t) => {
  const ctx = setup(t, 'wp11-01');
  const tree = docsTree(ctx);
  const first = gen(tree, '--check');
  assert.equal(first.status, 0, `the committed documents must be current: ${first.out}`);

  editJson(path.join(tree.root, 'recipe', 'RECIPE.json'), (r) => ({ ...r, deadlineMs: 12345 }));
  const stale = gen(tree, '--check');
  assert.equal(stale.status, 1, `a changed recipe must make the check fail: ${stale.out}`);
  assert.match(stale.out, /stale generated document\(s\): docs\/RECIPE\.md\b/);
  assert.equal(gen(tree).status, 0);
  assert.match(doc(tree, 'docs/RECIPE.md'), /\| search deadline \| 12345 ms \|/, 'the regenerated RECIPE.md shows the new deadline');
  assert.equal(gen(tree, '--check').status, 0, 'and the check passes again');

  const cli = path.join(tree.root, 'packages', 'cli', 'ruvnet-brain.mjs');
  fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace('  ruvnet-brain status\n', '  ruvnet-brain status [--brief]\n'));
  const cmd = gen(tree, '--check');
  assert.equal(cmd.status, 1, 'a changed command must make the check fail');
  assert.match(cmd.out, /docs\/v5\/REFERENCE\.md/);
  assert.equal(gen(tree).status, 0);
  assert.match(doc(tree, 'docs/v5/REFERENCE.md'), /ruvnet-brain status \[--brief\]/, 'the reference shows the command as the CLI prints it');

  fs.appendFileSync(path.join(tree.root, 'docs', 'v5', 'PARITY.md'), '\nA line written by hand.\n');
  const hand = gen(tree, '--check');
  assert.equal(hand.status, 1, 'a hand edit to a generated document must fail the check');
  assert.match(hand.out, /docs\/v5\/PARITY\.md/);
  fs.rmSync(path.join(tree.root, 'docs', 'v5', 'REFERENCE.md'));
  assert.equal(gen(tree, '--check').status, 1, 'a missing generated document fails the check');
});
