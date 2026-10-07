#!/usr/bin/env node
/**
 * detach.mjs — launch one long-running maintenance job OUT of the hook's process group, with an
 * explicit lifetime and a written receipt.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE (measured, not reasoned) ────────────────────────────────────
 * `scripts/selfcheck.mjs` fires every registration with the child in its OWN process group and then
 * asks, at exit and again after SIGTERM, whether ANYTHING in that group is still alive
 * (`kill(-pgid, 0)`). session-start.sh backgrounded three jobs with a bare `&`. A bare `&` in a
 * non-interactive `sh` does NOT change the process group — the job stays a member of the hook's
 * group — so the answer was "yes, descendants alive": the `orphan` violation the stranger-matrix
 * reported on all five images. The failure is real and not cosmetic: on a stranger's machine those
 * are `node` and `claude` processes still running after Claude Code has moved on, invisible to the
 * user and multiplied by every session start.
 *
 * ── WHY THE JOBS ARE NOT SIMPLY KILLED AT EXIT ─────────────────────────────────────────────────
 * "Kill the group on the way out" is the obvious fix and it is wrong for this workload. The three
 * jobs are a spine seed, a signed-bundle freshness check, and a plugin auto-update; each is seconds
 * to minutes of work, and session-start.sh exits in ~200ms. Killing them on exit would mean the
 * update NEVER completes on any machine — trading a hygiene violation for a permanently broken
 * updater. So the honest answer is the third one ADR-023 already implies: these jobs do not belong
 * to the session's lifetime at all. They are machine maintenance, like a package manager's
 * background install, and they are moved out of the session's process group ON PURPOSE.
 *
 * "On purpose" has to be worth something, so it comes with two obligations this file discharges:
 *
 *   1. AN EXPLICIT LIFETIME. Every job carries a TTL in seconds. A supervisor — itself detached —
 *      holds a timer and SIGTERMs the job's whole group at the deadline (SIGKILL 3s later). A
 *      detached job with no deadline is exactly the invisible-forever process this file is fixing;
 *      moving it to a new process group without a clock would only hide it better.
 *   2. A RECEIPT. Every start, exit and TTL-kill appends one line to
 *      ~/.cache/ruvnet-brain/detached-jobs.jsonl. "Invisible and unkillable-by-the-user" was half
 *      the complaint; a user who wants to know what is running, or wants to kill it, has a pid and
 *      a command to look at rather than a mystery in `ps`.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────────────
 *   node detach.mjs <ttlSeconds> <logPath|-> <cmd> [args...]
 * Returns in ~40ms having spawned nothing the caller must wait for. Exit code is always 0: a
 * maintenance job that cannot be launched must never fail a session start.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SUPERVISOR = process.env.RUVNET_DETACH_SUPERVISOR === '1';
const GRACE_MS = 3000; // SIGTERM → this long → SIGKILL. Matches selfcheck's own watchdog shape.

let inputArgs = process.argv.slice(2);
if (SUPERVISOR && inputArgs.length === 1 && inputArgs[0] === '--payload-env') {
  try {
    inputArgs = JSON.parse(Buffer.from(process.env.RUVNET_DETACH_PAYLOAD_B64 || '', 'base64').toString('utf8'));
  } catch {
    inputArgs = [];
  }
}
const [ttlRaw, logPath, ...cmd] = inputArgs;
const ttlSec = Number(ttlRaw);
if (!cmd.length || !Number.isFinite(ttlSec) || ttlSec <= 0) {
  process.stderr.write('usage: detach.mjs <ttlSeconds> <logPath|-> <cmd> [args...]\n');
  process.exit(0); // never fail a hook over a bad maintenance invocation
}

const receiptPath = () => path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ruvnet-brain', 'detached-jobs.jsonl',
);

/** Best-effort, fail-silent. A receipt that throws would defeat the point of writing one. */
function receipt(row) {
  try {
    const p = receiptPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
    return true;
  } catch { return false; }
}

/** Open the job's log, or /dev/null. Never throws — an unwritable log is not a reason to skip work. */
function openLog() {
  if (!logPath || logPath === '-') return 'ignore';
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    return fs.openSync(logPath, 'w');
  } catch { return 'ignore'; }
}

if (!SUPERVISOR) {
  // ── FOREGROUND HALF. Re-exec self, detached, and return immediately. This process IS still in the
  // hook's process group, which is correct and is the whole trick: it is short-lived and finishes
  // before the hook does, so the group is empty at exit. Everything with a real duration is on the
  // far side of the setsid boundary below.
  try {
    const supervisorEnv = {
      ...process.env,
      RUVNET_DETACH_SUPERVISOR: '1',
      RUVNET_DETACH_PAYLOAD_B64: Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'),
    };
    let child;
    if (process.platform === 'win32') {
      // detached:true and `cmd start /b` both left the cold hook's capture pipe open on
      // windows-latest after session-start.sh itself had finished. Start-Process crosses a native
      // process-launch boundary without `/b`'s same-console inheritance. All variable arguments
      // still travel in a base64 environment payload, so the PowerShell command contains only
      // trusted executable paths and no job/log-path metacharacters.
      const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const quotePs = (value) => `'${String(value).replaceAll("'", "''")}'`;
      // Start-Process has its own standard-stream boundary. On GitHub's packed PowerShell install
      // path the SessionStart body finished but the external checker never received `close` before
      // its 5s watchdog — consistent with a descendant retaining a capture handle, though that job
      // did not instrument exact handle ownership. Redirect both streams to distinct files at the
      // native boundary so the supervisor cannot inherit the hook's capture streams; redirecting
      // only this short Node wrapper's stdio does not establish that contract for its grandchild.
      const supervisorOut = logPath && logPath !== '-'
        ? `${logPath}.supervisor.stdout`
        : path.join(os.tmpdir(), `ruvnet-brain-detach-supervisor-${process.pid}.stdout`);
      const supervisorErr = logPath && logPath !== '-'
        ? `${logPath}.supervisor.stderr`
        : path.join(os.tmpdir(), `ruvnet-brain-detach-supervisor-${process.pid}.stderr`);
      const launch = [
        'Start-Process',
        '-FilePath', quotePs(process.execPath),
        '-ArgumentList', `@(${quotePs(SELF)},${quotePs('--payload-env')})`,
        '-WindowStyle', 'Hidden',
        '-RedirectStandardOutput', quotePs(supervisorOut),
        '-RedirectStandardError', quotePs(supervisorErr),
      ].join(' ');
      child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', launch], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: supervisorEnv,
      });
    } else {
      child = spawn(process.execPath, [SELF, ...process.argv.slice(2)], {
        detached: true, // POSIX setsid() — the child leads its OWN process group, not the session's
        stdio: 'ignore',
        env: supervisorEnv,
      });
    }
    child.on('error', () => {});
    child.unref();
  } catch { /* nothing to report — the session must start regardless */ }
  process.exit(0);
}

// ── SUPERVISOR HALF (already outside the session's process group). Runs the real job, holds the
// clock, and is the only thing that can end it early.
const out = openLog();
// Keep an unresolved retirement requirement if any later receipt cannot be written.
if (!receipt({ state: 'launching', supervisorPid: process.pid, ttlSec, cmd, retirementRequired: true })) process.exit(0);
const job = spawn(cmd[0], cmd.slice(1), {
  detached: true, // its own group again, so the TTL kill reaches ITS children too (npm, git, node)
  stdio: ['ignore', out, out],
  windowsHide: true,
  env: process.env,
});

let killedAtTtl = false;
let finished = false;
let grace;
const probe = (group = process.platform !== 'win32') => {
  if (!job.pid) return { state: 'unknown', error: 'missing-job-pid' };
  try { process.kill(group ? -job.pid : job.pid, 0); return { state: 'alive' }; }
  catch (error) { return error.code === 'ESRCH' ? { state: 'gone' } : { state: 'unknown', error: error.code || 'probe-failed' }; }
};
const finish = (state, detail = {}) => {
  if (finished) return;
  finished = true; clearTimeout(deadline); clearTimeout(grace);
  // Group absence cannot certify descendants that escaped into another group. Keep that fence.
  receipt({ state, pid: job.pid ?? null, supervisorPid: process.pid, ttlSec, cmd,
    retirementRequired: true, retirementConfirmed: false, retirementState: 'UNKNOWN',
    scope: process.platform === 'win32' ? 'windows-taskkill-tree-attempt' : 'posix-process-group', ...detail });
  process.exit(0);
};
receipt({ state: 'started', pid: job.pid ?? null, supervisorPid: process.pid, ttlSec, cmd, retirementRequired: true });

const deadline = setTimeout(() => {
  killedAtTtl = true;
  if (process.platform === 'win32') {
    if (job.exitCode !== null || job.signalCode !== null) return finish('retirement-unknown', { reason: 'parent-exited; descendant identity unavailable', rootObservation: probe(false) });
    const killed = spawnSync('taskkill', ['/PID', String(job.pid), '/T', '/F'], {
      timeout: 1000, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 });
    return finish('retirement-unknown', { reason: 'complete Windows descendant retirement not observed',
      taskkill: { status: killed.status, error: killed.error?.code || null }, rootObservation: probe(false) });
  }
  const errors = [];
  const signal = name => {
    try { process.kill(-job.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') errors.push({ signal: name, error: error.code || 'kill-failed' }); }
  };
  signal('SIGTERM');
  grace = setTimeout(() => {
    if (probe().state !== 'gone') signal('SIGKILL');
    // Ref'd timers retain supervision after the direct parent exits; observe native reaping too.
    grace = setTimeout(() => {
      const groupObservation = probe();
      finish(groupObservation.state === 'gone' && !errors.length ? 'group-retired-at-ttl' : 'retirement-unknown',
        { groupObservation, groupRetirementConfirmed: groupObservation.state === 'gone', killErrors: errors,
          reason: 'escaped or unobserved descendants are not certified' });
    }, 100);
  }, GRACE_MS);
}, ttlSec * 1000);

job.on('error', (e) => {
  clearTimeout(deadline);
  receipt({ state: 'spawn-failed', pid: null, ttlSec, cmd, detail: e.message, retirementRequired: false, launched: false });
  process.exit(0);
});
job.on('exit', (code, signal) => {
  if (killedAtTtl) return; // the TTL path writes its own, more specific receipt
  receipt({ state: 'parent-exited', pid: job.pid ?? null, code, signal, cmd, retirementRequired: true, retirementConfirmed: false });
  if (process.platform === 'win32') return finish('retirement-unknown', { reason: 'parent exit does not establish descendant retirement', rootObservation: probe(false) });
  const groupObservation = probe();
  if (groupObservation.state === 'gone') finish('group-retired', { code, signal, groupObservation, groupRetirementConfirmed: true,
    reason: 'escaped or unobserved descendants are not certified' });
  else if (groupObservation.state === 'unknown') finish('retirement-unknown', { code, signal, groupObservation });
  // A surviving owned group stays supervised until the original TTL.
});
