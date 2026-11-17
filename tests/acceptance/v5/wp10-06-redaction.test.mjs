// WP10 / review F21: explicit diagnostic paths never print or log a secret as given. An override
// reason holding a token is recorded and echoed masked, in a log readable by its owner only; an update
// address with credentials and a query token is printed by `config update-url` and `config show`
// without them. The token values are made up at test time.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { TERM_TEXT, emptyTranscript, guard, okServer, writeMsg } from './wp10-helpers.mjs';

test('WP10-06 override reasons and update addresses are redacted (review F21)', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp10-06');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const token = `ghp_${crypto.randomBytes(18).toString('hex')}`;
  const pass = crypto.randomBytes(8).toString('hex');
  const url = `https://deploy:${pass}@releases.example.invalid/brain/?token=${token}`;
  const c1 = tree.cli(home, ['config', 'update-url', url]);
  const c2 = tree.cli(home, ['config', 'show']);
  for (const [label, r] of [['config update-url', c1], ['config show', c2]]) {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(token) && !r.stdout.includes(pass), `${label} printed a secret: ${r.stdout}`);
    assert.match(r.stdout, /releases\.example\.invalid/, `${label} still names the host`);
  }

  assert.equal(tree.cli(home, ['guard', 'on']).status, 0);
  const srv = await okServer(ctx, tree, home);
  t.after(() => srv.close());
  const dir = ctx.tmp('rb5-session-');
  const file = path.join(dir, 'adapter.ts');
  const r = guard(tree, home, writeMsg(file, `// ruvnet-brain-guard: allow spike using ${token}\n${TERM_TEXT}`, emptyTranscript(dir)));
  assert.equal(r.status, 0, r.stderr);
  const logFile = path.join(home, 'state', 'guard-overrides.jsonl');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.ok(!log.includes(token) && !`${r.stdout}${r.stderr}${r.msg ?? ''}`.includes(token), 'the token must not reach the override log or the hook output');
  assert.match(log, /spike using REDACTED/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(logFile).mode & 0o777, 0o600, 'the override log is readable by its owner only');
});
