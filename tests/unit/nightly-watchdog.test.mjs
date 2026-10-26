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
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judge, productSchedulerVerdict, transitions, OK, MISSING, NEVER_RAN, STALE, FAILING, STALLED } from '../../scripts/nightly-watchdog.mjs';
import * as watchdog from '../../scripts/nightly-watchdog.mjs';
import * as issueAlert from '../../plugin/scripts/session-start-issue-alert.mjs';
import { writeShardProgress } from '../../kb/shard-progress.mjs';

const NOW = new Date('2026-07-13T12:00:00Z');
const JOB = { label: 'com.test.job', maxAgeHours: 26, what: 'x', schedule: 'daily' };
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

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

  it('KILLED is reported distinctly from a plain non-zero exit, with the signal named', () => {
    const v = judge(JOB, { ended_at: hoursAgo(1), state: 'killed', exit_code: 137, signal: 9 }, true, NOW);
    expect(v.state).toBe(FAILING);
    expect(v.detail).toMatch(/KILLED by signal 9/);
  });
});

describe('STALLED — a live pid proves the wrapper survived, not that the work is moving (2026-09-11)', () => {
  // THE INCIDENT THIS ENCODES: an 8-shard gists embed sat at 0% CPU for six hours. Its heartbeat
  // said "running" the whole time and the wrapper pid genuinely was alive — every check that
  // existed before this reported OK. `progressGlob` + `stallMinutes` is the fix: the job's own
  // per-shard progress files (kb/shard-progress.mjs) are read directly, independent of pid liveness.
  const STALL_JOB = { label: 'com.test.stall', maxAgeHours: 26, what: 'x', schedule: 'daily', progressGlob: 'kb/x.big.progress.*.json', stallMinutes: 15 };
  const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-stall-'));

  it('reports STALLED when the oldest incomplete shard has not advanced within the stall budget, even with a live/likely-alive pid', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'kb'));
    writeShardProgress(path.join(root, 'kb'), 'x', 0, 2, 32, 382, { now: () => new Date(minutesAgo(20)) }); // stalled 20m ago
    writeShardProgress(path.join(root, 'kb'), 'x', 1, 2, 380, 382, { now: () => new Date(minutesAgo(1)) }); // fine
    const v = judge(STALL_JOB, { started_at: hoursAgo(1), state: 'running', pid: process.pid }, true, NOW, { root });
    expect(v.state).toBe(STALLED);
    expect(v.detail).toMatch(/shard 0\/2/);
    expect(v.detail).toMatch(/20m/);
  });

  it('stays OK when every shard is advancing within budget', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'kb'));
    writeShardProgress(path.join(root, 'kb'), 'x', 0, 1, 300, 382, { now: () => new Date(minutesAgo(2)) });
    const v = judge(STALL_JOB, { started_at: hoursAgo(1), state: 'running', pid: process.pid }, true, NOW, { root });
    expect(v.state).toBe(OK);
  });

  it('does not stall on absence of any progress file — the job may not have reached embedding yet', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'kb'));
    const v = judge(STALL_JOB, { started_at: hoursAgo(1), state: 'running', pid: process.pid }, true, NOW, { root });
    expect(v.state).toBe(OK);
  });

  it('a mock-embedder-that-stops-advancing job trips STALLED even though its wall-clock age is well under the long-run 6h grace window', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'kb'));
    writeShardProgress(path.join(root, 'kb'), 'x', 0, 1, 32, 382, { now: () => new Date(minutesAgo(16)) });
    const v = judge(STALL_JOB, { started_at: minutesAgo(16), state: 'running', pid: process.pid }, true, NOW, { root });
    expect(v.state).toBe(STALLED); // NOT OK "long run in progress" — that branch requires ageHours > 6
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

// 2026-09-12: computed live against two FAILED refresh-run receipts, the watchdog projected
// com.ruvnet.brain-update as MISSING with the detail "LaunchAgent is loaded and runner digest
// verified, but last exited 1" — a contradiction in one line. MISSING is defined at the top of the
// watchdog as "not loaded in launchd — it can never fire"; a job that is loaded, verified and FIRED
// (that is what a non-zero LastExitStatus means) is the opposite case, and its truth is the receipt.
describe('installed product scheduler projection — a job that FIRED and failed is never MISSING', () => {
  const fired = (runHealth, lastExitCode = 1) => ({ state: 'degraded', lastExitCode,
    evidence: `LaunchAgent is loaded and runner digest verified, but last exited ${lastExitCode}`, runHealth });

  it('non-zero last exit + latest receipt FAILED → FAILING, and the detail is the receipt\'s reason, not the launchd line', () => {
    const v = productSchedulerVerdict(fired({ state: 'failed',
      evidence: 'Nightly refresh 1789208177087-d51ad2c7e6b004b2 failed at source-enumeration: unresolved rollback state exists; refusing to create another full-KB copy.' }));
    expect(v.state).toBe(FAILING);
    expect(v.detail).toMatch(/failed at source-enumeration: unresolved rollback state exists/);
    expect(v.detail).not.toMatch(/last exited/);
  });

  it('non-zero last exit + latest receipt too old → STALE (the cadence judgement still comes from the receipt)', () => {
    const v = productSchedulerVerdict(fired({ state: 'stale', evidence: 'Last verified nightly refresh is 40.0h old.' }));
    expect(v.state).toBe(STALE);
    expect(v.detail).toMatch(/40\.0h old/);
  });

  it('non-zero last exit but NO receipt at all → FAILING (it fired and died before recording a run), never NEVER-RAN or MISSING', () => {
    const v = productSchedulerVerdict(fired({ state: 'never-ran', evidence: 'No nightly refresh receipt exists yet.' }));
    expect(v.state).toBe(FAILING);
    expect(v.detail).toMatch(/exited 1/);
    expect(v.detail).toMatch(/no receipt/i);
  });

  it('non-zero last exit while the latest receipt still reads ok → FAILING with both facts stated (the run after that receipt died silently)', () => {
    const v = productSchedulerVerdict(fired({ state: 'ok', evidence: 'Last nightly refresh applied 20.0h ago.' }));
    expect(v.state).toBe(FAILING);
    expect(v.detail).toMatch(/exited 1/);
    expect(v.detail).toMatch(/ok/);
  });

  it('degraded WITHOUT a last exit (plist not loaded / command drift / invalid registration) stays MISSING — those genuinely cannot fire', () => {
    for (const evidence of ['LaunchAgent plist exists but job is not loaded',
      'LaunchAgent command does not match the registered runner', 'Registration invalid: runner digest mismatch']) {
      const v = productSchedulerVerdict({ state: 'degraded', evidence, runHealth: { state: 'failed', evidence: 'x' } });
      expect(v.state).toBe(MISSING);
      expect(v.detail).toBe(evidence);
    }
    expect(productSchedulerVerdict({ state: 'off', evidence: 'absent', runHealth: { state: 'failed' } }).state).toBe(MISSING);
    expect(productSchedulerVerdict({ state: 'unsupported', evidence: 'no adapter' }).state).toBe(MISSING);
  });

  it('a clean last exit (0) on a degraded adapter is not the fired-and-failed case — unchanged projection', () => {
    expect(productSchedulerVerdict({ state: 'degraded', lastExitCode: 0, evidence: 'drift', runHealth: { state: 'failed' } }).state).toBe(MISSING);
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

  it('every receipt (running AND terminal) carries a run_id, and two separate invocations get different ones', () => {
    const dir = tmpdir();
    const a = run('t.runid.a', 'exit 0', dir);
    const b = run('t.runid.b', 'exit 0', dir);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const ra = receipt(dir, 't.runid.a');
    const rb = receipt(dir, 't.runid.b');
    expect(typeof ra.run_id).toBe('string');
    expect(ra.run_id.length).toBeGreaterThan(0);
    expect(ra.run_id).not.toBe(rb.run_id);
  });
});

// 2026-09-11 review correction: the wrapper (not the child) is the supervisor — it owns a run_id,
// and must classify a signal-killed job as "killed" (with the signal), never fold it into a bare
// "failed" exit code or let a stale invocation clobber a newer one's receipt. These need mid-flight
// signal delivery, so they use async `spawn` + `pgrep -P` to find the wrapper's OWN direct child —
// deterministic, no marker/regex guessing across process trees.
describe.skipIf(!hasSh || process.platform === 'win32')('job-heartbeat.sh — killed(signal), stale-writer guard, and the uncatchable SIGKILL case', () => {
  const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-kill-'));
  const receipt = (dir, label) => JSON.parse(fs.readFileSync(path.join(dir, `${label}.json`), 'utf8'));
  async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  const directChildPid = (parentPid) => {
    const out = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    return out[0] || null;
  };

  it('a child killed DIRECTLY by SIGTERM (not the wrapper) is recorded killed with signal 15', async () => {
    const dir = tmpdir();
    const wrapper = spawn('sh', [WRAPPER, 't.childterm', '--', '/bin/sh', '-c', 'sleep 5'], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' },
    });
    const done = new Promise((resolve) => wrapper.on('exit', resolve));
    const childPid = await waitFor(() => directChildPid(wrapper.pid));
    process.kill(Number(childPid), 'SIGTERM');
    await done;
    expect(receipt(dir, 't.childterm')).toMatchObject({ state: 'killed', exit_code: 143, signal: 15 });
  });

  it('a child killed DIRECTLY by SIGKILL is recorded killed with signal 9', async () => {
    const dir = tmpdir();
    const wrapper = spawn('sh', [WRAPPER, 't.childkill', '--', '/bin/sh', '-c', 'sleep 5'], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' },
    });
    const done = new Promise((resolve) => wrapper.on('exit', resolve));
    const childPid = await waitFor(() => directChildPid(wrapper.pid));
    process.kill(Number(childPid), 'SIGKILL');
    await done;
    expect(receipt(dir, 't.childkill')).toMatchObject({ state: 'killed', exit_code: 137, signal: 9 });
  });

  it('SIGTERM of the WRAPPER ITSELF is also recorded killed(15), and the grandchild is not left orphaned', async () => {
    const dir = tmpdir();
    const wrapper = spawn('sh', [WRAPPER, 't.wrapterm', '--', '/bin/sh', '-c', 'sleep 5'], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' },
    });
    const done = new Promise((resolve) => wrapper.on('exit', resolve));
    await waitFor(() => directChildPid(wrapper.pid));
    wrapper.kill('SIGTERM');
    await done;
    expect(receipt(dir, 't.wrapterm')).toMatchObject({ state: 'killed', exit_code: 143, signal: 15 });
    // no orphan: the wrapper's trap kills its child before exiting.
    await new Promise((r) => setTimeout(r, 600));
    expect(spawnSync('pgrep', ['-f', `sh -c sleep 5`], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });

  it('STALE WRITER GUARD: an older invocation must not clobber a newer run\'s receipt with its own terminal outcome', async () => {
    const dir = tmpdir();
    const wrapper = spawn('sh', [WRAPPER, 't.stale', '--', '/bin/sh', '-c', 'sleep 1'], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' },
    });
    const done = new Promise((resolve) => wrapper.on('exit', resolve));
    await waitFor(() => fs.existsSync(path.join(dir, 't.stale.json')));
    // Simulate a NEWER invocation taking the receipt over mid-flight.
    fs.writeFileSync(path.join(dir, 't.stale.json'), JSON.stringify({
      label: 't.stale', started_at: '2099-01-01T00:00:00Z', state: 'running', pid: 999999, run_id: 'newer-run',
    }));
    await done; // the ORIGINAL (stale) run finishes and must NOT overwrite the newer record
    expect(receipt(dir, 't.stale')).toMatchObject({ run_id: 'newer-run', state: 'running' });
  });

  it('SIGKILL of the wrapper (uncatchable): the receipt is stuck at "running" forever, and judge() derives FAILING from the dead pid', async () => {
    const dir = tmpdir();
    const wrapper = spawn('sh', [WRAPPER, 'com.test.sigkill', '--', '/bin/sh', '-c', 'sleep 30'], {
      env: { ...process.env, JOB_HEARTBEAT_DIR: dir, NTFY_TOPIC: '' },
    });
    await waitFor(() => fs.existsSync(path.join(dir, 'com.test.sigkill.json')));
    const before = receipt(dir, 'com.test.sigkill');
    expect(before.state).toBe('running');
    expect(typeof before.run_id).toBe('string');
    process.kill(wrapper.pid, 'SIGKILL'); // no trap can run — this is the one death nothing here catches
    await new Promise((resolve) => wrapper.on('exit', resolve));
    await new Promise((r) => setTimeout(r, 500));
    const after = receipt(dir, 'com.test.sigkill');
    // The run_id NEVER reaches a terminal state — this receipt is exactly what it was at "running".
    expect(after).toEqual(before);
    // scripts/nightly-watchdog.mjs, given this exact receipt 7h "later" (now is a judge() parameter,
    // not a real sleep), must call it FAILING because the pid is provably gone — never OK.
    const verdict = judge(
      { label: 'com.test.sigkill', maxAgeHours: 26, what: 'x', schedule: 'daily' },
      after,
      true,
      new Date(new Date(after.started_at).getTime() + 7 * 3600_000),
    );
    expect(verdict.state).toBe(FAILING);
    expect(verdict.detail).toMatch(/NEVER FINISHED/);
  });
});

describe('one update owner per machine (2026-09-26 consolidation)', () => {
  it('treats agentic-kit as the Brain update owner only when kit.json says ruvnetBrain:true', async () => {
    const { brainUpdateOwnedByAgenticKit } = await import('../../scripts/nightly-watchdog.mjs');
    const fsm = await import('node:fs'); const osm = await import('node:os'); const pathm = await import('node:path');
    const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'ak-owner-'));
    expect(brainUpdateOwnedByAgenticKit(home)).toBe(false);                 // no agentic-kit → Brain scheduler is expected
    fsm.mkdirSync(pathm.join(home, '.config', 'agentic-kit'), { recursive: true });
    fsm.writeFileSync(pathm.join(home, '.config', 'agentic-kit', 'kit.json'), JSON.stringify({ ruvnetBrain: false }));
    expect(brainUpdateOwnedByAgenticKit(home)).toBe(false);                 // agentic-kit present but not managing the Brain
    fsm.writeFileSync(pathm.join(home, '.config', 'agentic-kit', 'kit.json'), JSON.stringify({ ruvnetBrain: true }));
    expect(brainUpdateOwnedByAgenticKit(home)).toBe(true);                  // agentic-kit owns updates
  });
});

// 4.7.21 (RC1.8): a stuck job with a live pid used to read "OK forever" until the 6 h long-run branch, and a
// genuinely long full rebuild was then waved through as "LONG RUN in progress" indefinitely.
describe.skipIf(!hasSh || process.platform === 'win32')('STUCK — a run past its maxRunHours, even with a live wrapper pid', () => {
  it('reports STUCK with a live wrapper-shaped pid, and FAILING (never finished) when the pid is gone', async () => {
    const fake = spawn('/bin/sh', ['-c', 'sleep 30; :', 'job-heartbeat.sh', 'com.test.stuck'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const job = { label: 'com.test.stuck', maxAgeHours: 26, maxRunHours: 1, what: 'x', schedule: 'daily' };
      const v = judge(job, { started_at: hoursAgo(2), state: 'running', pid: fake.pid }, true, NOW);
      expect(v.state).toBe(watchdog.STUCK); // before: OK ("running right now")
      expect(v.detail).toMatch(/2\.0h/);
      expect(v.detail).toMatch(/limit is 1h/);
      expect(judge(job, { started_at: hoursAgo(0.5), state: 'running', pid: fake.pid }, true, NOW).state).toBe(OK);
      const gone = judge(job, { started_at: hoursAgo(2), state: 'running', pid: 999999 }, true, NOW);
      expect(gone.state).toBe(FAILING);
      expect(gone.detail).toMatch(/NEVER FINISHED/);
    } finally { fake.kill('SIGKILL'); }
  });
});

describe('the job registry (config/scheduled-jobs.json) matches what is actually loaded (4.7.21)', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'scheduled-jobs.json'), 'utf8'));
  const job = (label) => registry.jobs.find((j) => j.label === label);
  it('every job declares a run limit, and the long ones get more', () => {
    for (const j of registry.jobs) expect(j.maxRunHours, j.label).toBeGreaterThan(0);
    // brain-gists was retired 2026-10-26: the registry must not watch a job that is deliberately not loaded.
    expect(job('com.ruvnet.brain-gists')).toBeUndefined();
    expect(registry._retired.map((r) => r.label)).toContain('com.ruvnet.brain-gists');
    expect(job('com.ruvnet.goldie-weekly').maxRunHours).toBe(3);
    expect(job('com.ruvnet.model-refresh').maxRunHours).toBe(1);
  });
  it('schedules and budgets match the plists', () => {
    expect(job('com.ruvnet.nightly-watchdog').schedule).toBe('daily 09:30');
    expect(job('com.ruvnet.issue-fix').maxAgeHours).toBe(3); // 30-min cadence; 1 h false-alarmed on one late run
  });
  it('the loaded, wrapped stuartkerr jobs are registered; npx-72h-verdict is retired', () => {
    expect(job('com.stuartkerr.purge-local-snapshots')).toBeTruthy();
    expect(job('com.stuartkerr.model-freshness-watchdog')).toBeTruthy();
    expect(job('com.ruvnet.npx-72h-verdict')).toBeUndefined();
    expect(registry._retired.map((r) => r.label)).toContain('com.ruvnet.npx-72h-verdict');
  });
  it('the product scheduler verdict names the real 03:30 slot', () => {
    expect(productSchedulerVerdict({ state: 'off' }).schedule).toBe('daily 03:30');
  });
});

// Who watches the watchdog (4.7.21): SessionStart says one local line when a scheduled job's receipt is red or
// the watchdog's own receipt is older than 30 h. No network; silent when there are no receipts (end users).
describe('SessionStart job-health line', () => {
  const setup = (receipts) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-jobs-'));
    const hb = path.join(stateDir, 'heartbeats'); fs.mkdirSync(hb);
    for (const [label, r] of Object.entries(receipts)) fs.writeFileSync(path.join(hb, `${label}.json`), JSON.stringify({ label, ...r }));
    const lines = []; return { stateDir, lines, emit: (l) => lines.push(l) };
  };
  const now = Date.parse('2026-10-26T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600_000).toISOString();
  it('silent with no heartbeat directory at all', () => {
    const lines = [];
    issueAlert.surfaceJobHealth({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-none-')), emit: (l) => lines.push(l), now });
    expect(lines).toEqual([]);
  });
  it('silent when every receipt is fine and the watchdog ran recently', () => {
    const f = setup({ 'com.ruvnet.nightly-watchdog': { state: 'ok', ended_at: ago(3) }, 'com.x': { state: 'ok', ended_at: ago(1) } });
    issueAlert.surfaceJobHealth({ ...f, now });
    expect(f.lines).toEqual([]);
  });
  it('one line naming the count when receipts are failed or killed', () => {
    const f = setup({ 'com.ruvnet.nightly-watchdog': { state: 'ok', ended_at: ago(3) }, 'com.a': { state: 'failed', ended_at: ago(1) }, 'com.b': { state: 'killed', ended_at: ago(1) } });
    issueAlert.surfaceJobHealth({ ...f, now });
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toMatch(/2 scheduled job\(s\) failing/);
  });
  it('only receipts of jobs the registry lists count; a retired job\'s failed receipt is ignored (4.7.21 review #6)', () => {
    const f = setup({ 'com.ruvnet.nightly-watchdog': { state: 'ok', ended_at: ago(3) }, 'com.ruvnet.brain-gists': { state: 'failed', ended_at: ago(30) },
      'com.ruvnet.issue-watch': { state: 'killed', ended_at: ago(1) } });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-jobs-repo-'));
    fs.mkdirSync(path.join(repo, 'config'));
    fs.mkdirSync(path.join(repo, 'plugin', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'scheduled-jobs.json'), JSON.stringify({ jobs: [{ label: 'com.ruvnet.nightly-watchdog' }, { label: 'com.ruvnet.issue-watch' }],
      _retired: [{ label: 'com.ruvnet.brain-gists' }] }));
    issueAlert.surfaceJobHealth({ ...f, now, cwd: path.join(repo, 'plugin', 'scripts') }); // found walking up from a subdirectory
    expect(f.lines).toEqual(['[RuvNet Brain — JOBS: 1 scheduled job(s) failing (com.ruvnet.issue-watch). Details: node scripts/nightly-watchdog.mjs --no-push]']);
    fs.rmSync(repo, { recursive: true, force: true });
  });
  it('one line when the watchdog itself has not run for more than 30 h', () => {
    const f = setup({ 'com.ruvnet.nightly-watchdog': { state: 'ok', ended_at: ago(31) } });
    issueAlert.surfaceJobHealth({ ...f, now });
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toMatch(/watchdog last ran 31h ago/);
  });
});

