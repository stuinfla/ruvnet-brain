// S11 doctor is the same verdict: in every S6 state, `ruvnet-brain doctor` prints the same line as the
// prompt hook and exits non-zero exactly when that line is anything but OK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor } from './helpers.mjs';
import { PROBE_INTERVAL_MS, walkStates } from './health-states.mjs';

test('S11 doctor gives the health line verdict in every state', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's11');
  const tree = ctx.tree();
  const visited = [];
  await walkStates(ctx, tree, async (state, home) => {
    if (state === 'damaged') await waitFor(() => /RuvNet Brain DOWN/.test(tree.hook(home).line), PROBE_INTERVAL_MS + 3_000, 'the DOWN line');
    const line = tree.hook(home).line;
    const doc = tree.cli(home, ['doctor']);
    const ok = /^\[RuvNet Brain OK /.test(line);
    assert.equal(doc.status === 0, ok, `doctor exit code disagrees with the health line in state ${state}: exit ${doc.status}, line ${line}\n${doc.stdout}`);
    assert.equal(doc.stdout.split('\n')[0], line, `doctor and the hook must print the same verdict in state ${state}`);
    visited.push(`${state}:${doc.status}`);
  });
  assert.deepEqual(visited.map((v) => v.split(':')[0]), ['not-installed', 'ok', 'stopped', 'stale', 'damaged']);
  t.diagnostic(`doctor exit codes: ${visited.join(', ')}`);
});
