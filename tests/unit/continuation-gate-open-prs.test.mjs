// continuation-gate-open-prs.test.mjs — the gate must see an open PR as unfinished work.
//
// THE GAP THIS CLOSES, measured 2026-08-06. The gate had two sources: an issue past its SLA, and a
// red CI run. PRs #117, #118 and #119 were opened, every required check passed, and at the Stop
// boundary the gate said NOTHING — correctly, by its own logic, because `open` was empty. A PR is
// neither an issue nor a CI failure, and nothing had been written to the ledger. The owner asked
// "why the hell have you stopped?" and the honest answer was that the gate could not see the work.
//
// The failure mode being guarded is therefore SILENCE, which is also the correct behaviour on most
// turns — so the negative cases below matter as much as the positive ones. A gate that fires on a PR
// whose CI is still running would nag through every normal build and get ignored, which is the same
// disease one layer up.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'continuation-gate.mjs');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prs-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

/** Write an open-issues.json snapshot with the given PR rows, observed now. */
function snapshot(prs, { issues = [], atMs = Date.now() } = {}) {
  const file = path.join(dir, 'open-issues.json');
  fs.writeFileSync(file, JSON.stringify({
    at: new Date(atMs).toISOString(), repo: 'stuinfla/ruvnet-brain',
    open: issues.length, breaches: 0, issues, prs,
  }));
  return file;
}

/**
 * Fire the gate the way Claude Code does, with an isolated ledger and cooldown.
 *
 * `session_id` is REQUIRED: the gate exits silently without one (continuation-gate.mjs:161), because
 * a Stop envelope with no session cannot be a real host boundary. Omitting it here made all four
 * positive cases pass vacuously as silence during development — the exact shape of bug this whole
 * file exists to catch, committed inside its own harness.
 */
function fire(openIssuesFile) {
  const res = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'test-session' }),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      RUVNET_OPEN_ISSUES_FILE: openIssuesFile,
      RUVNET_CI_STATUS_FILE: path.join(dir, 'no-ci.json'),
      RUVNET_WORK_LEDGER: path.join(dir, 'ledger.json'),
      RUVNET_CONTINUATION_COOLDOWN_MS: '0',
      HOME: dir,
      USERPROFILE: dir,
    },
  });
  let ctx = '';
  try { ctx = JSON.parse(res.stdout || '{}')?.hookSpecificOutput?.additionalContext || ''; } catch {}
  return { status: res.status, stdout: res.stdout || '', context: ctx };
}

const PR = (over = {}) => ({
  number: 119, title: 'the payload boundary is the shipping invariant',
  author: 'stuinfla', checksState: 'passing', failing: 0, mergeable: 'MERGEABLE',
  url: 'https://github.com/stuinfla/ruvnet-brain/pull/119', ...over,
});

describe('continuation gate — an open PR is unfinished work', () => {
  it('THE REGRESSION: a green open PR FORCES continuation', () => {
    const { status, context } = fire(snapshot([PR()]));
    expect(status).toBe(0);                       // never breaks the turn
    expect(context).toContain('PR #119');
    expect(context).toContain('GREEN');
    expect(context).toContain('Do NOT end the turn');
  });

  it('a RED open PR forces, and names how many checks are failing', () => {
    const { context } = fire(snapshot([PR({ checksState: 'failing', failing: 3 })]));
    expect(context).toContain('PR #119');
    expect(context).toContain('RED');
    expect(context).toContain('3 failing check(s)');
  });

  it('a PR with NO checks configured still forces — nothing will ever arrive to resolve it', () => {
    const { context } = fire(snapshot([PR({ checksState: 'none' })]));
    expect(context).toContain('PR #119');
  });
});

describe('continuation gate — and does NOT become a nag', () => {
  it('a PR whose checks are still PENDING is silent: waiting for CI is not stopping early', () => {
    // The whole risk of this source. If it fired here it would speak on every normal build.
    const { status, stdout } = fire(snapshot([PR({ checksState: 'pending' })]));
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('no PRs at all → silent', () => {
    const { stdout } = fire(snapshot([]));
    expect(stdout).toBe('');
  });

  it('a STALE snapshot (>6h) is not evidence of anything → silent', () => {
    const stale = snapshot([PR()], { atMs: Date.now() - 7 * 3600_000 });
    const { stdout } = fire(stale);
    expect(stdout).toBe('');
  });

  it('a missing or unreadable artifact → silent, never a crash', () => {
    const { status, stdout } = fire(path.join(dir, 'does-not-exist.json'));
    expect(status).toBe(0);
    expect(stdout).toBe('');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json at all');
    const r2 = fire(bad);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toBe('');
  });

  it('the PR source does not disturb the existing issue source', () => {
    const withIssue = snapshot([PR({ checksState: 'pending' })], {
      issues: [{ number: 103, title: 'an issue past SLA', ageHours: 66, breach: true }],
    });
    const { context } = fire(withIssue);
    expect(context).toContain('issue #103');   // still fires
    expect(context).not.toContain('PR #119');  // pending PR still suppressed
  });
});

// ── Security alerts: what GitHub emails the owner, the gate must also know ────────────────────────
//
// The owner had to relay Dependabot findings by hand because nothing pulled them into the session.
// For a repo that publishes an npm package and a signed bundle, an unpatched advisory ships to every
// user — so this is the highest-consequence of the four sources, and also the easiest to turn into
// noise. Both properties are asserted here.
function snapshotAlerts(securityAlerts, { atMs = Date.now() } = {}) {
  const file = path.join(dir, 'open-issues-sec.json');
  fs.writeFileSync(file, JSON.stringify({
    at: new Date(atMs).toISOString(), repo: 'stuinfla/ruvnet-brain',
    open: 0, breaches: 0, issues: [], prs: [], securityAlerts,
  }));
  return file;
}

const ALERT = (over = {}) => ({
  kind: 'dependabot', severity: 'critical',
  title: 'lodash: prototype pollution', url: 'https://example.invalid', ...over,
});

describe('continuation gate — GitHub security alerts', () => {
  it('a CRITICAL dependabot alert forces continuation and says GitHub already emailed it', () => {
    const { context } = fire(snapshotAlerts([ALERT()]));
    expect(context).toContain('dependabot alert');
    expect(context).toContain('already emailed');
    expect(context).toContain('lodash');
  });

  it('a secret-scanning alert ALWAYS forces, whatever its severity — a live credential is not "medium"', () => {
    const { context } = fire(snapshotAlerts([ALERT({ kind: 'secret-scanning', severity: 'low', title: 'AWS Access Key' })]));
    expect(context).toContain('secret-scanning alert');
    expect(context).toContain('AWS Access Key');
  });

  it('LOW and MEDIUM advisories are SILENT — a permanent backlog would make the gate ignorable', () => {
    const { stdout } = fire(snapshotAlerts([ALERT({ severity: 'low' }), ALERT({ severity: 'medium' })]));
    expect(stdout).toBe('');
  });

  it('many alerts of one kind collapse to ONE item with a count, not one item each', () => {
    const many = Array.from({ length: 12 }, (_, i) => ALERT({ title: `pkg-${i}: advisory` }));
    const { context } = fire(snapshotAlerts(many));
    expect(context).toContain('12 open dependabot alert(s)');
    // exactly one ☐ line for this kind — twelve advisories is one job, not twelve refusals to stop
    expect(context.split('\n').filter((l) => l.includes('dependabot alert(s)')).length).toBe(1);
  });

  it('a stale snapshot is not evidence → silent', () => {
    const { stdout } = fire(snapshotAlerts([ALERT()], { atMs: Date.now() - 7 * 3600_000 }));
    expect(stdout).toBe('');
  });

  it('no alerts → silent', () => {
    const { stdout } = fire(snapshotAlerts([]));
    expect(stdout).toBe('');
  });
});
