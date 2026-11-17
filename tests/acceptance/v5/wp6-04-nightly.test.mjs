// WP6: the watchdog reports a missed nightly, and the dispatcher's kill switch and one retry hold.
// Run evidence is recorded JSON (what `rail.mjs gather` reads from GitHub), relative to now, so the
// test does not depend on the clock or the time zone; times are printed in Eastern time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { rail, writeJson } from './wp6-helpers.mjs';

const H = 3_600_000;
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * H).toISOString();
const run = (id, startedHoursAgo, outcome, { status = 'completed', conclusion = outcome ? 'success' : 'failure' } = {}) => ({ id, status, conclusion, createdAt: iso(startedHoursAgo), updatedAt: iso(startedHoursAgo - 1), outcome });

test('WP6 the watchdog reports a missed nightly; the dispatcher obeys its kill switch and retries once', { timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'wp6-04');
  const tree = ctx.tree();
  const dir = ctx.tmp('rb5-wp6-runs-');
  const runsFile = (name, runs) => {
    const f = path.join(dir, `${name}.json`);
    writeJson(f, runs);
    return f;
  };
  const watchdog = (runs, name) => rail(tree, ['watchdog', '--runs', runsFile(name, runs)]);

  const missed = watchdog([run(1, 75, 'published'), run(2, 51, null), run(3, 27, null)], 'missed');
  assert.equal(missed.status, 1, `a missed nightly must turn the watchdog red: ${missed.out}`);
  assert.match(missed.stdout.split('\n')[0], /^v5-watchdog RED · missed nightly: no night ended published or no-change in 48 h \(last: published .* E[SD]T\)$/);
  assert.match(missed.stdout, /newest run 3: failed \(failure\)/);

  const never = watchdog([run(4, 5, null)], 'never');
  assert.equal(never.status, 1, never.out);
  assert.match(never.stdout, /\(last: never\)/);

  const fresh = watchdog([run(5, 30, null), run(6, 10, 'no-change')], 'fresh');
  assert.equal(fresh.status, 0, `a night that ended no-change within 48 h is green: ${fresh.out}`);
  assert.match(fresh.stdout, /^v5-watchdog GREEN · last night no-change/);

  const decide = (runs, slot, killSwitch, name) => {
    const args = ['dispatch-decision', '--slot', slot, '--runs', runsFile(name, runs)];
    if (killSwitch !== null) args.push('--kill-switch', killSwitch);
    const r = rail(tree, args);
    assert.equal(r.status, 0, r.out);
    return r.stdout;
  };
  assert.match(decide([], 'first', null, 'unset'), /^dispatch=false · V5_NIGHTLY is "", not "on"/, 'unset kill switch must stand down');
  assert.match(decide([], 'first', 'off', 'off'), /^dispatch=false/, 'off must stand down');
  assert.match(decide([], 'first', 'on', 'armed'), /^dispatch=true/);
  assert.match(decide([run(7, 3, null)], 'retry', 'on', 'retry-once'), /^dispatch=true · every run tonight failed; retrying once/);
  assert.match(decide([run(7, 3, null), run(8, 1, null)], 'retry', 'on', 'retried'), /^dispatch=false · tonight was already retried once/);
  assert.match(decide([run(9, 3, 'published')], 'retry', 'on', 'answered'), /^dispatch=false · tonight already has an answer/);
  assert.match(decide([run(10, 1, null, { status: 'in_progress', conclusion: null })], 'retry', 'on', 'running'), /^dispatch=false · a run is still going/);
  assert.match(decide([run(11, 3, null)], 'retry', 'off', 'retry-off'), /^dispatch=false/, 'the kill switch also stops the retry');

  // gather: what the workflows read from GitHub (a stub `gh` here; no network). A successful run's
  // outcome comes from its artifact; a run that left none, or failed, has no outcome.
  const { gather, judge } = await import(pathToFileURL(path.join(tree.root, 'packages', 'release', 'nightly.mjs')).href);
  const now = Date.now();
  const api = { workflow_runs: [
    { id: 21, status: 'completed', conclusion: 'success', created_at: iso(30), updated_at: iso(29) },
    { id: 22, status: 'completed', conclusion: 'success', created_at: iso(6), updated_at: iso(5) },
    { id: 23, status: 'completed', conclusion: 'failure', created_at: iso(3), updated_at: iso(2) },
    { id: 24, status: 'completed', conclusion: 'success', created_at: iso(200), updated_at: iso(199) },
  ] };
  const calls = [];
  const gh = (args) => {
    calls.push(args.slice(0, 3).join(' '));
    if (args[0] === 'api') return { ok: true, stdout: JSON.stringify(api), stderr: '' };
    if (args[2] === '22') {
      fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], 'outcome.json'), JSON.stringify({ outcome: 'published' }));
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'no artifact' };
  };
  const got = gather({ repo: 'o/r', now, gh });
  assert.deepEqual(got.map((r) => [r.id, r.outcome]), [[21, null], [22, 'published'], [23, null]], 'runs older than the window are dropped; outcomes come from artifacts');
  assert.ok(!calls.includes('run download 23'), 'a failed run has no outcome to download');
  assert.equal(judge({ runs: got, now }).red, false, 'the gathered evidence judges green: run 22 published 5 h ago');
});
