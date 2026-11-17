// WP6: a release without the answer-gate result is refused. Promotion needs a passed gate result
// bound to exactly the staged bytes (release.json sha256 and pack generation): no file, a failed
// gate, or a gate for other bytes are each refused and nothing moves; a passed gate promotes.
// The three receipts here are promotion fixtures bound to the staged bytes; the real
// install-and-probe step is exercised in wp6-06.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { REQUIRED_OS, appVersion, gateFor, rail, sealed, sha256File, writeJson } from './wp6-helpers.mjs';

test('WP6 nothing is promoted without a passed answer-gate result for these bytes', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp6-03');
  const tree = ctx.tree();
  const { rel, r } = sealed(ctx, tree);
  assert.equal(r.status, 0, r.out);
  const channel = ctx.tmp('rb5-wp6-ch-');
  const st = rail(tree, ['stage', '--release', rel, '--channel', channel]);
  assert.equal(st.status, 0, st.out);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  const staged = path.join(channel, 'staged', tag);
  const sha = sha256File(path.join(staged, 'release.json'));
  const receipts = ctx.tmp('rb5-wp6-rc-');
  for (const os of REQUIRED_OS) writeJson(path.join(receipts, `${os}.json`), { os, release: sha, ok: true });
  const dir = ctx.tmp('rb5-wp6-gate-');
  const promote = (gateValue) => {
    const args = ['promote', '--channel', channel, '--tag', tag, '--version', appVersion(tree), '--receipts', receipts];
    if (gateValue !== undefined) {
      const f = path.join(dir, `gate-${Math.random().toString(16).slice(2)}.json`);
      writeJson(f, gateValue);
      args.push('--gate', f);
    }
    return rail(tree, args);
  };
  const refused = (res, why, label) => {
    assert.notEqual(res.status, 0, `${label} must be refused: ${res.out}`);
    assert.match(res.stderr, why, `${label} must be refused with the reason: ${res.stderr}`);
    assert.equal(fs.existsSync(path.join(channel, 'latest.json')), false, `${label}: nothing may be promoted`);
    assert.equal(fs.existsSync(path.join(channel, 'packages.json')), false, `${label}: no package pointer may move`);
  };

  refused(promote(undefined), /no answer-gate result; nothing is promoted without the gate/, 'a release without the gate result');
  refused(promote(gateFor(staged, { passed: false, hit: 3, of: 100 })), /the answer gate did not pass \(3 of 100/, 'a release whose gate failed');
  refused(promote({ ...gateFor(staged), release: 'f'.repeat(64) }), /for different bytes than the staged release/, 'a gate result for other bytes');
  refused(promote({ ...gateFor(staged), score: undefined }), /carries no score/, 'a gate result with no score');

  const ok = promote(gateFor(staged));
  assert.equal(ok.status, 0, `a passed gate promotes: ${ok.out}`);
  assert.match(ok.stdout, new RegExp(`published: ${tag}`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(channel, 'latest.json'), 'utf8')).tag, tag);
});
