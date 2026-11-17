// WP9 / review F07: version 5 never writes into the 4.7 folder. A version 5 home that is the 4.7 home,
// inside it, around it, or a link to it is refused by `migrate --apply` and by `rollback-to-4` before
// anything is written, and the 4.7 world is byte for byte unchanged. A separate home still migrates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_ENV, THREE, setup } from './helpers.mjs';
import { make47, runCli, world47 } from './wp9-helpers.mjs';

test('WP9-04 a version 5 home overlapping the 4.7 home is refused, and 4.7 is unchanged (review F07)', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp9-04');
  const tree = ctx.tree();
  const rel = tree.release(tree.build(THREE));
  const s = make47(ctx);
  const before = world47(s);
  const link = path.join(ctx.tmp('rb5-link-'), 'v5-home');
  fs.symlinkSync(s.real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const cases = {
    'the 4.7 home itself': s.defaultHome,
    'a folder inside the 4.7 home': path.join(s.real, 'v5'),
    'the folder around the 4.7 home': path.dirname(s.real),
    'a link to the 4.7 home': link,
  };
  for (const [label, home5] of Object.entries(cases)) {
    for (const args of [['migrate', '--apply', '--from', rel], ['rollback-to-4']]) {
      const r = runCli(tree, { ...s, home5 }, args, { [HOME_ENV]: home5 });
      assert.notEqual(r.status, 0, `${label}, ${args[0]}: must be refused: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /is the 4\.7 home .* or overlaps it/, `${label}, ${args[0]}: the reason`);
      assert.deepEqual(world47(s), before, `${label}, ${args[0]}: the 4.7 world must be unchanged`);
    }
  }
  const ok = runCli(tree, s, ['migrate', '--apply', '--from', rel]);
  assert.equal(ok.status, 0, `a separate version 5 home migrates: ${ok.stdout}${ok.stderr}`);
  assert.deepEqual(world47(s), before, 'and 4.7 is still unchanged');
});
