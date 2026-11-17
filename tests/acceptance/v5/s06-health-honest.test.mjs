// S6 health is honest: OK on a working install; DOWN within one probe interval after the pack's index
// file is damaged; NOT RUNNING with the server stopped; UNKNOWN (never OK) with a stale heartbeat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor } from './helpers.mjs';
import { PROBE_INTERVAL_MS, walkStates } from './health-states.mjs';

test('S6 the health line is honest in every state', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's06');
  const tree = ctx.tree();
  const seen = {};
  await walkStates(ctx, tree, async (state, home, info) => {
    if (state === 'damaged') {
      // Slack beyond one interval: the probe's own run time on a loaded machine.
      const line = await waitFor(() => (/RuvNet Brain DOWN/.test(tree.hook(home).line) ? tree.hook(home).line : null), PROBE_INTERVAL_MS + 3_000, 'the DOWN line').catch(() => tree.hook(home).line);
      assert.match(line, /^\[RuvNet Brain DOWN since .* · pack failed its self-test/, `a damaged index must turn the line DOWN: ${line}`);
      seen.damagedAfterMs = Date.now() - info.damagedAt;
      return;
    }
    const { line } = tree.hook(home);
    seen[state] = line;
    if (state === 'not-installed') assert.match(line, /^\[RuvNet Brain NOT INSTALLED · .* · fix: ruvnet-brain install\]$/);
    if (state === 'ok') assert.match(line, /^\[RuvNet Brain OK · knowledge of 14 Nov · search_ruvnet ready\]$/);
    if (state === 'stopped') assert.match(line, /^\[RuvNet Brain NOT RUNNING · the search server did not start in this session/);
    if (state === 'stale') {
      assert.doesNotMatch(line, /RuvNet Brain OK/, `a stale heartbeat must never read OK: ${line}`);
      assert.match(line, /^\[RuvNet Brain UNKNOWN since .* · the search server stopped reporting \(stale heartbeat\)/);
    }
  });
  t.diagnostic(`DOWN seen ${seen.damagedAfterMs} ms after the damage (probe interval ${PROBE_INTERVAL_MS} ms)`);
});
