// WP3-02 two servers, one healthy and one failing: the prompt hook (the shim's exact hook command)
// and doctor both show the failing one, whichever of the two wrote its status file last.
// Break: show the newest writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failedProbe, status, wp3 } from './wp3-helpers.mjs';

test('WP3-02 with one healthy and one failing server the line shows the failing one', { timeout: 60_000 }, async (t) => {
  const { tree, livePid, home } = wp3(t, 'wp3-02');
  const now = Date.now();
  for (const failingIsNewest of [false, true]) {
    const bad = status(livePid(), now - (failingIsNewest ? 0 : 30_000), { probe: failedProbe(now) });
    const good = status(livePid(), now - (failingIsNewest ? 30_000 : 0));
    const h = home({ servers: [bad, good] });
    const { line } = tree.hook(h);
    assert.match(line, /^\[RuvNet Brain DOWN since .* · pack failed its self-test/, `the hook must show the failing server (failing one newest: ${failingIsNewest}): ${line}`);
    const doc = tree.cli(h, ['doctor']);
    assert.equal(doc.stdout.split('\n')[0], line, 'doctor prints the same line');
    assert.equal(doc.status, 1, 'doctor exits non-zero');
    assert.match(doc.stdout, new RegExp(`server ${bad.pid}: .*self-test FAILED`), 'doctor names the failing server');
  }
});
