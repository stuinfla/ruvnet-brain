// tests/unit/nightly-watchdog.test.mjs — the supervisor that ends "oh, it hasn't run in three days".
//
// THE BUG THIS ENCODES (2026-07-13): launchd reports LAST EXIT STATUS 0 for a job that has NEVER RUN —
// byte-identical to a job that ran and succeeded. So the obvious design ("check the exit code") cannot
// tell triumph from total absence, and com.ruvnet.brain-nightly sat unfired for its entire life while
// every surface said healthy. Silence was read as health.
//
// The rule these tests exist to defend: ABSENCE OF EVIDENCE IS FAILURE. Every state below must be
// distinguishable, and "no receipt" must NEVER resolve to OK — that single assertion is the whole point.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judge, productSchedulerVerdict, transitions, OK, MISSING, NEVER_RAN, STALE, FAILING } from '../../scripts/nightly-watchdog.mjs';

const NOW = new Date('2026-07-13T12:00:00Z');
const JOB = { label: 'com.test.job', maxAgeHours: 26, what: 'x', schedule: 'daily' };
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();

describe('judge — the five states, and why each one exists', () => {
  it('NO RECEIPT is NEVER-RAN, never OK — the failure that caused all of this', () => {
    const v = judge(JOB, null, true, NOW);
    expect(v.state).toBe(NEVER_RAN);
    expect(v.state).not.toBe(OK); // stated explicitly: silence must never resolve to health
  });

  it('NOT LOADED in launchd is MISSING — a plist on disk that cannot fire is not a job', () => {
    // How com.ruvnet.issue4-verify sat dead: present on disk, absent from launchd, invisible to everyone.
    expect(judge(JOB, { ended_at: hoursAgo(1), state: 'ok', exit_code: 0 }, false, NOW).state).toBe(MISSING);
  });

  it('a fresh, successful receipt is the ONLY thing that counts as OK', () => {
    const v = judge(JOB, { ended_at: hoursAgo(3), state: 'ok', exit_code: 0 }, true, NOW);
    expect(v.state).toBe(OK);
    expect(v.detail).toMatch(/exit 0/);
  });

  it('a receipt older than the schedule allows is STALE — the job stopped', () => {
    const v = judge(JOB, { ended_at: hoursAgo(30), state: 'ok', exit_code: 0 }, true, NOW);
    expect(v.state).toBe(STALE);
    expect(v.detail).toMatch(/It stopped/);
  });

  it('a non-zero exit is FAILING even when it is perfectly fresh', () => {
    expect(judge(JOB, { ended_at: hoursAgo(1), state: 'failed', exit_code: 7 }, true, NOW).state).toBe(FAILING);
  });

  it('STARTED AND NEVER FINISHED is FAILING — the SIGKILL / power-loss case no trap can catch', () => {
    // job-heartbeat.sh traps TERM/INT, but SIGKILL runs no handler by definition, leaving the receipt
    // stuck in "running" forever. That is caught HERE — the second half of the belt-and-braces.
    const v = judge(JOB, { started_at: hoursAgo(9), state: 'running' }, true, NOW);
    expect(v.state).toBe(FAILING);
    expect(v.detail).toMatch(/NEVER FINISHED/);
  });

  it('a job legitimately running right now is OK, not a false alarm', () => {
    // The gists job takes ~78 minutes. Reporting that as "hung" would cry wolf nightly and poison the gong.
    expect(judge(JOB, { started_at: hoursAgo(1), state: 'running' }, true, NOW).state).toBe(OK);
  });
});

describe('transitions — page on CHANGE, because a nightly alarm is an ignored alarm', () => {
  it('alerts only when a state changes, and treats an unknown job as previously-OK', () => {
    const results = [
      { label: 'a', state: FAILING }, // was OK → page
      { label: 'b', state: FAILING }, // already failing → silent
      { label: 'c', state: OK },      // was failing → all-clear
      { label: 'd', state: OK },      // still fine → silent
    ];
    const fired = transitions(results, { a: OK, b: FAILING, c: FAILING, d: OK }).map((r) => r.label);
    expect(fired).toEqual(['a', 'c']);
  });
});

describe('installed product scheduler projection', () => {
  it.each([
    [{ state: 'off', evidence: 'absent' }, MISSING],
    [{ state: 'on', runHealth: { state: 'never-ran', evidence: 'none' } }, NEVER_RAN],
    [{ state: 'on', runHealth: { state: 'failed', evidence: 'red' } }, FAILING],
    [{ state: 'on', runHealth: { state: 'stale', evidence: 'old' } }, STALE],
    [{ state: 'on', runHealth: { state: 'ok', evidence: 'fresh' } }, OK],
    [{ state: 'on', runHealth: { state: 'running', evidence: 'active' } }, OK],
  ])('maps scheduler and atomic refresh receipt state without a second identity', (status, expected) => {
    expect(productSchedulerVerdict(status)).toMatchObject({ label: 'com.ruvnet.brain-update', state: expected });
  });
});

// The wrapper is a shell script, so it is exercised as a subprocess — the same pattern memdb-health and
// token-meter already use. These four cases ARE the contract; case 3 failed on the first break-test
// (a POSIX shell blocked on a FOREGROUND child does not run its trap when signalled) and the fix — run
// the child in the background and `wait` — is what these pin.
const REPO = path.resolve(import.meta.dirname, '../..');
const WRAPPER = path.join(REPO, 'scripts/job-heartbeat.sh');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.skipIf(!hasSh || process.platform === 'win32')('job-heartbeat.sh — a job cannot run without leaving proof', () => {
  const run = (label, cmd, dir) =>
    spawnSync('sh', [WRAPPER, label, '--', '/bin/sh', '-c', cmd], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' }, // no topic → no real push from tests
      encoding: 'utf8',
    });
  const receipt = (dir, label) => JSON.parse(fs.readFileSync(path.join(dir, `${label}.json`), 'utf8'));
  const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));

  it('success: writes an ok receipt AND passes the real exit code through to launchd', () => {
    const dir = tmpdir();
    expect(run('t.ok', 'exit 0', dir).status).toBe(0);
    expect(receipt(dir, 't.ok')).toMatchObject({ state: 'ok', exit_code: 0 });
  });

  it('failure: writes a failed receipt with the REAL exit code, and still exits non-zero itself', () => {
    const dir = tmpdir();
    expect(run('t.bad', 'exit 7', dir).status).toBe(7); // launchd must still see the truth
    expect(receipt(dir, 't.bad')).toMatchObject({ state: 'failed', exit_code: 7 });
  });

  it('a start receipt exists BEFORE the job finishes — so a hard-killed job is still known to have started', () => {
    const dir = tmpdir();
    const child = spawnSync('sh', ['-c', `sh ${WRAPPER} t.slow -- /bin/sh -c 'sleep 2' & sleep 0.5; cat ${dir}/t.slow.json`], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' },
      encoding: 'utf8',
    });
    expect(child.stdout).toMatch(/"state":"running"/); // SIGKILL leaves exactly this — and judge() calls it FAILING
  });
});
