// WP8 layer 1 on a good release: the gate installs the staged bytes, asks the pinned (synthetic) set
// through the real server in two processes, and writes a gate-result file the contract accepts,
// bound to this release.json's sha256 and pack generation, carrying the set's hash and n and no
// question text; `rail.mjs promote` then accepts exactly that file. Same inputs, same result bytes
// apart from the time it was written. Break: the gate copies question text into its output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { REQUIRED_OS, appVersion, rail, sha256File, writeJson } from './wp6-helpers.mjs';
import { gate, noQuestionText, outFile, pin, questionSet, readJson, releaseOf, setHash } from './wp8-helpers.mjs';

test('WP8 layer 1 passes a good release with a bound, promotable result', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp8-01');
  const tree = ctx.tree();
  const set = questionSet(ctx);
  const hash = setHash(tree, set);
  assert.match(hash, /^[0-9a-f]{64}$/);
  pin(tree, hash);
  const rel = releaseOf(tree);
  const out = outFile(ctx);
  const r = gate(tree, ['--release', rel, '--questions', set, '--out', out]);
  assert.equal(r.status, 0, `the gate must pass a good release: ${r.out}`);
  const g = readJson(out);
  const relSha = sha256File(path.join(rel, 'release.json'));
  assert.equal(g.schema, 'ruvnet-brain/gate-result');
  assert.equal(g.passed, true, g.reasons?.join('; '));
  assert.equal(g.release, relSha, 'bound to the sha256 of this release.json');
  assert.equal(g.pack, readJson(path.join(rel, 'release.json')).pack.generation, 'bound to this pack generation');
  assert.deepEqual(g.score, { hit: 5, of: 6 }, 'five of the six synthetic questions have their gold file in the pack');
  assert.equal(g.questionSet.sha256, hash);
  assert.equal(g.questionSet.n, 6);
  assert.equal(g.layers.retrieval.probes.passed, g.layers.retrieval.probes.of);
  assert.ok(g.layers.retrieval.questions.every((q) => q.problems.length === 0 && q.chars > 0 && q.chars <= 44_000 && q.tokens <= 20_000));
  assert.equal(g.layers.answer.given, false);
  assert.match(r.stdout, new RegExp(`question set wp8-synthetic-fixture · sha256 ${hash} · n=6`));
  assert.match(r.stdout, /layer 2 · not given \(not required by this question set\)/);
  assert.deepEqual(noQuestionText(fs.readFileSync(out, 'utf8') + r.out), [], 'no question text may reach the result file or the log');

  // Same inputs, same result: only the time it was written differs.
  const out2 = outFile(ctx);
  assert.equal(gate(tree, ['--release', rel, '--questions', set, '--out', out2]).status, 0);
  const g2 = readJson(out2);
  assert.equal(g2.resultSha256, g.resultSha256, 'the hashed part of the result is the same on a second run');
  assert.deepEqual({ ...g2, at: null }, { ...g, at: null });

  // The rail promotes with exactly this file.
  const channel = ctx.tmp('rb5-wp8-ch-');
  const st = rail(tree, ['stage', '--release', rel, '--channel', channel]);
  assert.equal(st.status, 0, st.out);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  const receipts = ctx.tmp('rb5-wp8-rc-');
  for (const os of REQUIRED_OS) writeJson(path.join(receipts, `${os}.json`), { os, release: relSha, ok: true });
  const p = rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', appVersion(tree), '--receipts', receipts, '--gate', out]);
  assert.equal(p.status, 0, `promote must accept the gate's own file: ${p.out}`);
});
