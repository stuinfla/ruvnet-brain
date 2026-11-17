// S7 hook fallback: with `node` on PATH replaced by a program that exits with an error, the exact hook
// command from the shim's hooks.json, run through the platform shell, still prints the DOWN line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

function brokenNode(dir) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'node.cmd'), '@echo ran> "%RB5_MARK%"\r\n@exit /b 1\r\n');
  } else {
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho ran > "$RB5_MARK"\nexit 1\n');
    fs.chmodSync(path.join(dir, 'node'), 0o755);
  }
}

test('S7 the hook still prints DOWN when node cannot run', { timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 's07');
  const tree = ctx.tree();
  const home = ctx.tmp('rb5-home-');

  const normal = tree.hook(home);
  assert.match(normal.line, /^\[RuvNet Brain NOT INSTALLED/, `with a working node the hook prints the verdict: ${normal.line}`);

  const bin = ctx.tmp('rb5-bin-');
  brokenNode(bin);
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  const r = tree.hook(home, { pathPrefix: bin, env: { RB5_MARK: mark } });
  assert.ok(fs.existsSync(mark), 'the broken node on PATH must be the one the hook command ran');
  assert.match(r.line, /\[RuvNet Brain\] DOWN: Node could not run\. Search is unavailable\./, `the hook must still print the DOWN line; printed: "${r.line}"`);
});
