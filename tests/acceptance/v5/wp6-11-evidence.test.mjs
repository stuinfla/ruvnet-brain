// WP6 / review F01: promotion takes no "passed" or "ok" on trust. A gate result is refused when no
// question set is pinned, when it names another set, when its score disagrees with its own layers
// (the review's {hit: 0, of: 1, passed: true}), when its hash does not match its content, and when it
// says passed although its recorded count is below its baseline (re-hashed by a forger). A receipt is
// refused when it is the abbreviated {os, release, ok: true}, names another release number, misses a
// staged probe or has a doctor that did not exit 0; in GitHub Actions a receipt relabelled from
// another runner, or from another run, is refused. Complete, consistent evidence promotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { appVersion, gateFor, rail, receiptsFor, rehash, sealed, writeJson, writeReceipts } from './wp6-helpers.mjs';

test('WP6 promotion recomputes the gate decision and requires complete receipts (review F01)', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-11');
  const tree = ctx.tree();
  const { rel, r } = sealed(ctx, tree);
  assert.equal(r.status, 0, r.out);
  const channel = ctx.tmp('rb5-wp6-ch-');
  const st = rail(tree, ['stage', '--release', rel, '--channel', channel]);
  assert.equal(st.status, 0, st.out);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  const staged = path.join(channel, 'staged', tag);
  const dir = ctx.tmp('rb5-wp6-ev-');
  let n = 0;
  const promote = ({ gate = gateFor(staged), receipts = receiptsFor(staged), env = {} } = {}) => {
    const g = path.join(dir, `gate-${++n}.json`);
    writeJson(g, gate);
    const rc = writeReceipts(path.join(dir, `rc-${n}`), staged, receipts);
    return rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', appVersion(tree), '--receipts', rc, '--gate', g], { env });
  };
  const refused = (res, why, label) => {
    assert.notEqual(res.status, 0, `${label} must be refused: ${res.out}`);
    assert.match(res.stderr, why, `${label} must be refused with the reason: ${res.stderr}`);
    assert.equal(fs.existsSync(path.join(channel, 'latest.json')), false, `${label}: nothing may be promoted`);
  };

  // Gate evidence.
  refused(promote({ gate: { ...gateFor(staged), score: { hit: 0, of: 1 } } }), /evidence does not|counts disagree|resultSha256/, 'asserted success with a score of 0 of 1');
  refused(promote({ gate: rehash({ ...gateFor(staged), score: { hit: 0, of: 1 } }) }), /counts disagree/, 'a re-hashed score that disagrees with its layers');
  refused(promote({ gate: { ...gateFor(staged), rule: 'edited after the gate wrote it' } }), /resultSha256 does not match its content/, 'a result edited after it was written');
  const below = gateFor(staged, { hit: 2, of: 6, layer: { baseline: { hit: 5, of: 6, measuredOn: 'fixture' } } });
  refused(promote({ gate: below }), /2 of 6 is below the baseline 5 by more than 0/, 'passed although the count is below the baseline');
  refused(promote({ gate: gateFor(staged, { set: 'e2'.repeat(32) }) }), /is not the pinned/, 'a result for another question set');
  refused(promote({ gate: gateFor(staged, { layer: { probes: { passed: 2, of: 3 } } }) }), /probes 2 of 3/, 'a result whose probes did not all pass');
  const railFile = path.join(tree.root, 'packages', 'release', 'rail.json');
  const railBefore = fs.readFileSync(railFile);
  const unpinned = JSON.parse(railBefore);
  unpinned.answerGate.questionSetSha256 = '';
  fs.writeFileSync(railFile, JSON.stringify(unpinned));
  refused(promote(), /no frozen question set is pinned/, 'a passed result while no question set is pinned');
  fs.writeFileSync(railFile, railBefore);

  // Receipt evidence.
  const sha = receiptsFor(staged)[0].release;
  refused(promote({ receipts: ['linux', 'macos', 'windows'].map((os) => ({ os, release: sha, ok: true })) }), /not a complete probe-receipt/, 'abbreviated ok receipts');
  const edit = (os, change) => receiptsFor(staged).map((x) => (x.os === os ? { ...x, ...change(x) } : x));
  refused(promote({ receipts: edit('macos', () => ({ releaseNumber: 99 })) }), /from macos .*different app, pack or release number/, 'a receipt for another release number');
  refused(promote({ receipts: edit('windows', (x) => ({ probes: x.probes.slice(1) })) }), /from windows .*every probe of the staged pack/, 'a receipt that skipped a probe');
  refused(promote({ receipts: edit('linux', () => ({ doctor: { exit: 1, line: 'DOWN' } })) }), /from linux .*doctor did not exit 0/, 'a receipt whose doctor failed');
  const ci = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '4242' };
  refused(promote({ env: ci }), /not written by this workflow run/, 'receipts with no run identity in GitHub Actions');
  const relabelled = receiptsFor(staged, { ci: '4242' }).map((x) => ({ ...x, ci: { runId: '4242', runnerOs: 'Linux' } }));
  refused(promote({ receipts: relabelled, env: ci }), /from macos .*on a macOS runner/, 'Linux receipts relabelled as other systems');
  refused(promote({ receipts: receiptsFor(staged, { ci: '1111' }), env: ci }), /not written by this workflow run/, 'receipts from another run');

  // Complete, consistent evidence promotes (in and out of GitHub Actions).
  const ok = promote({ receipts: receiptsFor(staged, { ci: '4242' }), env: ci });
  assert.equal(ok.status, 0, `complete evidence must promote: ${ok.out}`);
  assert.match(ok.stdout, new RegExp(`published: ${tag}`));
});
