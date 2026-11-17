// WP3 / review F14: OK needs evidence of a completed self-test. A live, fresh status whose probe
// says ok with results that are not passing probes (the review's `{"probe":{"ok":true,"results":[{}]}}`),
// or with no valid time, is never OK; nor is a server that reports another app or pack than the
// installed one; a status file that is not a status file (wrong schema, or not named by its own pid)
// is not evidence of a server at all. Checked through assess() and through `ruvnet-brain doctor`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { status, wp3 } from './wp3-helpers.mjs';

test('WP3-07 malformed self-test evidence is never OK (review F14)', { timeout: 120_000 }, async (t) => {
  const { tree, livePid, home, mod } = wp3(t, 'wp3-07');
  const { assessHome } = await mod('assess.mjs');
  const now = Date.now();
  const verdictOf = (h) => ({ v: assessHome(h, { now }), doctor: tree.cli(h, ['doctor']) });
  const notOk = (h, label, reason) => {
    const { v, doctor } = verdictOf(h);
    assert.notEqual(v.state, 'ok', `${label} must not be OK: ${v.reason}`);
    if (reason) assert.match(v.reason, reason, `${label}: the reason`);
    assert.notEqual(doctor.status, 0, `${label}: doctor must not exit 0: ${doctor.stdout}`);
  };

  // The control: a complete record is OK.
  const good = verdictOf(home({ servers: [status(livePid(), now)] }));
  assert.equal(good.v.state, 'ok', good.v.reason);
  assert.equal(good.doctor.status, 0, good.doctor.stdout);

  notOk(home({ servers: [status(livePid(), now, { probe: { ok: true, results: [{}] } })] }), 'the review\'s {"probe":{"ok":true,"results":[{}]}}', /incomplete|completed run/);
  notOk(home({ servers: [status(livePid(), now, { probe: { ok: true, results: [{ question: 'q', expect: 'alpha-vectors/README.md', pass: true }] } })] }), 'a passed probe with no time', /incomplete|completed run/);
  notOk(home({ servers: [status(livePid(), now, { probe: { ok: true, at: now - 1000, results: [{ question: 'q', expect: 'alpha-vectors/README.md', pass: false }] } })] }), 'ok:true with a failed result', /incomplete|completed run/);
  notOk(home({ servers: [status(livePid(), now, { app: '4.9.9-other', pack: 'g-other' })] }), 'a server on another generation', /not the installed app/);
  const pid = livePid();
  notOk(home({ servers: [{ ...status(pid, now), schema: 'something-else' }] }), 'a file that is not a status file');
});
