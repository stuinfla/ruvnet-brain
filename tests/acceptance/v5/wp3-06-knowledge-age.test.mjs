// WP3-06 old knowledge is reported as its age and its cause, never as a failure of this machine. With
// a healthy server and knowledge 40 days old, the line stays OK (it shows the knowledge date) and
// doctor exits 0; doctor's knowledge line gives the age in days and the one cause this machine can
// see: no newer release published, no update source, automatic updates off with a newer release
// available, a newer release that failed its checks here, or no check run yet.
// Breaks: old knowledge turns the verdict DEGRADED; the cause is dropped from the age line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, status, wp3, ymd } from './wp3-helpers.mjs';

test('WP3-06 knowledge age is reported with its cause, and the machine stays OK', { timeout: 120_000 }, async (t) => {
  const { tree, livePid, home } = wp3(t, 'wp3-06');
  const now = Date.now();
  const date = ymd(now - 40 * DAY);
  const src = 'https://example.invalid/rb5/';
  const check = (offered) => ({ checked: true, at: now - 3_600_000, offered, installed: 3, available: offered > 3, interrupted: false });
  const cases = [
    ['no newer release published', { updateUrl: src }, check(3), null, /no newer knowledge has been published/],
    ['no update source', {}, null, null, /no update source is configured.*ruvnet-brain config update-url/],
    ['auto-update off, newer available', { updateUrl: src, autoUpdate: false }, check(4), null, /release 4 is available and automatic updates are off \(run: ruvnet-brain update\)/],
    ['newer release failed here', { updateUrl: src }, check(4), { result: 'refused', rolledBack: false, at: now - 60_000, to: { app: '5.0.4', pack: 'g-4' }, reason: '2 of 3 probes did not find their file' }, /release 4 was offered and failed its checks before the switch \(2 of 3 probes did not find their file\)/],
    ['never checked', { updateUrl: src }, null, null, /no update check has run yet/],
  ];
  for (const [what, config, updateCheck, update, cause] of cases) {
    const s = status(livePid(), now, { knowledgeDate: date });
    const h = home({ knowledgeDate: date, releaseNumber: 3, servers: [s], config, updateCheck, update });
    const { line } = tree.hook(h);
    const doc = tree.cli(h, ['doctor']);
    const shown = `${Number(date.slice(8))} ${new Date(`${date}T12:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
    assert.equal(line, `[RuvNet Brain OK · knowledge of ${shown} · search_ruvnet ready]`, `${what}: old knowledge is not a failure of this machine; the line stays OK: ${line}`);
    assert.equal(doc.status, 0, `${what}: old knowledge is not a failure of this machine; doctor exits 0`);
    const age = doc.stdout.split('\n').find((l) => l.startsWith('knowledge: ')) ?? '';
    assert.match(age, new RegExp(`^knowledge: ${date}, 40 days old · `), `${what}: doctor gives the age in days: ${doc.stdout}`);
    assert.match(age, cause, `${what}: the age line names its cause: ${age}`);
  }
});
