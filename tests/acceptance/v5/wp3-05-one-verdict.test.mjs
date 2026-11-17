// WP3-05 one verdict, three readers: in every health state the shim's exact hook command, `ruvnet-brain
// doctor` and `ruvnet-brain status` print the same line, doctor exits 0 exactly when that line is OK,
// and every non-ok line is one line of at most 160 characters naming one cause and one fix.
// States from a real install and real server: not installed, installed ok, server stopped, stale
// heartbeat, pack damaged (probe failing). States from status files written by hand: self-test still
// running, self-test that ran no probes, self-test overdue, safe mode, lane unavailable, update rolled
// back, update refused, two servers. Runtime missing: with `node` broken the hook command still
// prints its DOWN line. Breaks: doctor gets its own check; the hook gets its own check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from './helpers.mjs';
import { PROBE_INTERVAL_MS, walkStates } from './health-states.mjs';
import { failedProbe, status, wp3 } from './wp3-helpers.mjs';

function same(tree, h, state) {
  const { line } = tree.hook(h);
  const doc = tree.cli(h, ['doctor']);
  const st = tree.cli(h, ['status']);
  assert.equal(doc.stdout.split('\n')[0], line, `doctor and the hook disagree in state ${state}:\n  hook:   ${line}\n  doctor: ${doc.stdout.split('\n')[0]}`);
  assert.equal(st.stdout.split('\n')[0], line, `status and the hook disagree in state ${state}`);
  const ok = /^\[RuvNet Brain OK /.test(line);
  assert.equal(doc.status === 0, ok, `doctor exit code ${doc.status} disagrees with the line in state ${state}: ${line}`);
  assert.ok(line.length <= 160 && line.startsWith('[RuvNet Brain ') && line.endsWith(']'), `one line of at most 160 characters in state ${state}: ${line}`);
  if (!ok) assert.match(line, / · [^·]+ · fix: [^·]+\]$/, `a non-ok line names one cause and one fix in state ${state}: ${line}`);
  return { line, doctor: doc.stdout };
}

test('WP3-05 the hook, doctor and status give one verdict in every state', { timeout: 300_000 }, async (t) => {
  const { ctx, tree, livePid, deadPid, home } = wp3(t, 'wp3-05');
  const seen = {};

  await walkStates(ctx, tree, async (state, h) => {
    if (state === 'damaged') await waitFor(() => /RuvNet Brain DOWN/.test(tree.hook(h).line), PROBE_INTERVAL_MS + 3_000, 'the DOWN line');
    seen[state] = same(tree, h, state).line;
  });
  assert.match(seen.ok, /^\[RuvNet Brain OK · knowledge of 14 Nov · search_ruvnet ready\]$/);
  assert.match(seen.damaged, /^\[RuvNet Brain DOWN since .* · pack failed its self-test.* · fix: ruvnet-brain install --repair\]$/);

  const now = Date.now();
  const hand = {
    'self-test running': [status(livePid(), now, { probe: null }), /UNKNOWN since .* · the self-test has not finished yet · fix: wait one minute\]$/],
    'no probes ran': [status(livePid(), now, { probe: { ok: true, at: now - 10_000, results: [] } }), /UNKNOWN since .* · the self-test ran no probes · fix: ruvnet-brain install --repair\]$/],
    'self-test overdue': [status(livePid(), now, { probe: { ...status(0).probe, at: now - 5 * 3_600_000 } }), /UNKNOWN since .* · the self-test has not run for 5 h · fix: restart the session\]$/],
    'safe mode': [status(livePid(), now, { lastSearch: { ok: false, at: now - 1000, safeMode: true, reason: 'the search took longer than 10000 ms' } }), /DEGRADED since .* · last search used keyword-only safe mode \(the search took longer than 10000 ms\) · fix: restart the session\]$/],
    'lane unavailable': [status(livePid(), now, { lanes: [{ name: 'lexical', available: true }, { name: 'history', available: false }] }), /DEGRADED since .* · lane history unavailable · fix: ruvnet-brain install --repair\]$/],
    'probe failing': [status(livePid(), now, { probe: failedProbe(now, 'database disk image is malformed') }), /DOWN since .* · pack failed its self-test \(database disk image is malformed\) · fix: ruvnet-brain install --repair\]$/],
  };
  for (const [state, [s, want]] of Object.entries(hand)) assert.match(same(tree, home({ servers: [s] }), state).line, want, state);

  const rolled = home({ servers: [status(livePid(), now)], update: { result: 'rolled-back', stage: 'post-switch', rolledBack: true, at: now - 60_000, to: { app: '5.0.2', pack: 'g-2' }, reason: 'probe failed through the real server' } });
  const r = same(tree, rolled, 'update rolled back');
  assert.match(r.line, /DEGRADED since .* · update to 5\.0\.2 failed its check after the switch and was rolled back · fix: ruvnet-brain doctor\]$/);
  assert.match(r.doctor, /last update: app 5\.0\.2, pack g-2 was rolled back after the switch .*probe failed through the real server; the previous version is answering/, 'doctor shows what the fix asked to look at');

  const refused = home({ servers: [status(livePid(), now)], update: { result: 'refused', stage: 'pre-switch-probes', rolledBack: false, at: now - 60_000, to: { app: '5.0.2', pack: 'g-2' }, reason: '1 of 3 probes did not find their file' } });
  const f = same(tree, refused, 'update refused');
  assert.match(f.line, /^\[RuvNet Brain OK /, 'a refused update changed nothing: nobody needs to act, so the line stays OK');
  assert.match(f.doctor, /last update: refused app 5\.0\.2, pack g-2 before the switch .*1 of 3 probes did not find their file; nothing was changed/);

  const two = home({ servers: [status(livePid(), now), status(await deadPid(), now, { probe: failedProbe(now) })] });
  assert.match(same(tree, two, 'a live server and a dead one').line, /^\[RuvNet Brain OK /, 'a dead server\'s leftover file is not a live server');

  // Runtime missing: no Node can run, so neither the hook program nor doctor can; the hook command's
  // own fallback still prints one DOWN line with its fix.
  const bin = ctx.tmp('rb5-bin-');
  const broken = path.join(bin, process.platform === 'win32' ? 'node.cmd' : 'node');
  fs.writeFileSync(broken, process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
  fs.chmodSync(broken, 0o755);
  const missing = tree.hook(home({ servers: [status(livePid(), now)] }), { pathPrefix: bin });
  assert.match(missing.line, /^\[RuvNet Brain\] DOWN: Node could not run\. Search is unavailable\. Fix: run 'node -v' in a terminal; reinstall Node if it fails\.$/, `runtime missing: ${missing.line}`);
});
