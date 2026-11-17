// Wave 3: under the test marker, `migrate --apply` reads a 4.7 home only from a path given explicitly
// (RUVNET_BRAIN_HOME) and refuses the real user's default 4.7 home, before anything is read or
// written. Nothing here reads the real 4.7 home: the guard refuses first, and the other guard (the host
// registration's protected-home check) stays behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { make47, runCli } from './wp9-helpers.mjs';

test('Wave 3 migrate --apply refuses the real 4.7 home and any 4.7 home not named explicitly', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave3-06');
  const tree = ctx.tree();
  assert.equal(process.env.RUVNET_BRAIN5_TEST, '1', 'the test marker is set');
  const s = make47(ctx);
  const rel = path.join(ctx.tmp('rb5-w3-norel-'), 'release');

  // RUVNET_BRAIN_HOME empty: the 4.7 home would be the default under HOME, which is not explicit.
  const a =runCli(tree, s, ['migrate', '--apply', '--from', rel], { RUVNET_BRAIN_HOME: '' });
  assert.equal(a.status, 1, `${a.stdout}${a.stderr}`);
  assert.match(a.stderr, /migrate --apply reads a 4\.7 home only from a path given explicitly in RUVNET_BRAIN_HOME; nothing was read or written/, 'a 4.7 home not named explicitly must be refused by migrate --apply');

  const realDefault = path.join(os.userInfo().homedir, '.cache', 'ruvnet-brain');
  const b = runCli(tree, s, ['migrate', '--apply', '--from', rel, '--register-hosts'], { RUVNET_BRAIN_HOME: realDefault });
  assert.equal(b.status, 1, `${b.stdout}${b.stderr}`);
  assert.match(b.stderr, /migrate --apply refuses the real 4\.7 home .*; nothing was read or written/, 'the real 4.7 home must be refused by migrate --apply');
  assert.equal(fs.existsSync(s.home5), false, 'no version 5 home was created');
  assert.equal(fs.existsSync(path.join(s.claude, 'settings.json')) && fs.readFileSync(path.join(s.claude, 'settings.json'), 'utf8').includes('ruvnet-brain-5'), false, 'no host file was touched');
});
