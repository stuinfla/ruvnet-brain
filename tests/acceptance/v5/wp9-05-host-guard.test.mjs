// WP9 / review F06 (migration part): under the test marker, migration applies the protected-home
// guard to every host file it reads (Claude Code and Codex settings, the 4.7 job file, the 4.7 switch
// folder), not only to the 4.7 home. A host settings folder under a protected root is refused before
// it is read, by the plan and by --apply, and nothing is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { make47, runCli, world47 } from './wp9-helpers.mjs';

test('WP9-05 migration guards every host file it reads (review F06)', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp9-05');
  const tree = ctx.tree();
  const rel = tree.release(tree.build(THREE));
  const s = make47(ctx);
  const before = world47(s);
  const guarded = ctx.tmp('rb5-guarded-');
  fs.cpSync(s.claude, path.join(guarded, '.claude'), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: path.join(guarded, '.claude'), RUVNET_BRAIN5_PROTECTED_HOME: guarded };
  for (const args of [['migrate'], ['migrate', '--apply', '--from', rel]]) {
    const r = runCli(tree, s, args, env);
    assert.equal(r.status, 1, `${args.join(' ')}: a protected host folder must be refused: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /is under the protected home .*; nothing was read or written/, `${args.join(' ')}: the reason`);
    assert.equal(fs.existsSync(s.home5), false, `${args.join(' ')}: no version 5 home was created`);
  }
  assert.deepEqual(world47(s), before, 'the 4.7 world is unchanged');
});
