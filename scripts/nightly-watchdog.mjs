#!/usr/bin/env node
// scripts/nightly-watchdog.mjs — WHO WATCHES THE WATCHERS.
//
// WHY THIS EXISTS (2026-07-13). Stuart: "Every time I ask you, you tell me one thing, and then three
// days later you're like, 'oh by the way, it hasn't been running for three days.'" He was describing a
// real structural hole. The audit that night found com.ruvnet.brain-nightly's launchd trigger had NEVER
// fired — and everything reported healthy, because:
//
//   THE TRAP: launchd reports LAST EXIT STATUS 0 for a job that has NEVER RUN. That is byte-identical
//   to a job that ran and succeeded. So "check the exit code" — the obvious design, and the one that was
//   in place — literally cannot distinguish triumph from total absence. Silence read as health.
//
// THE FIX, and the rule the whole file is built on: EVIDENCE OR IT DIDN'T HAPPEN. Every watched job is
// declared in config/scheduled-jobs.json and must produce a timestamped receipt (written by
// scripts/job-heartbeat.sh, trap-protected so a dying job still writes one). Reality is then compared
// against the registry. Anything less than fresh, successful, positive proof is a VIOLATION:
//
//   MISSING   — declared in the registry but not loaded in launchd (it can never fire; this is how
//               com.ruvnet.issue4-verify sat dead on disk, invisible)
//   NEVER-RAN — loaded, but no receipt has EVER been written (the brain-nightly case)
//   STALE     — a receipt exists but is older than the job's schedule allows (it stopped)
//   FAILING   — it ran and reported a non-zero exit, or it started and never finished
//   OK        — a fresh receipt says it ran and exited 0. The ONLY state that counts as working.
//
// Shape confirmed against prior art in the ecosystem: agentic-qe/src/workers/workers/heartbeat-scheduler.ts
// (token-free periodic liveness + stale detection). No launchd supervision existed to reuse.
//
// Alerts are TRANSITION-ONLY (the discipline proven in kb/brain-alarm.mjs): a state change pages once.
// Constant redness must never become constant noise, or the gong trains you to ignore it.
//
// Usage:
//   node scripts/nightly-watchdog.mjs           # verdict + exit 1 if ANY job is not OK
//   node scripts/nightly-watchdog.mjs --json
//   node scripts/nightly-watchdog.mjs --quiet   # cron mode: speak only when something is wrong

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NIGHTLY_LABEL, schedulerStatus } from '../plugin/scripts/nightly-scheduler.mjs';
import { oldestIncompleteProgress } from '../kb/shard-progress.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = process.env.WATCHDOG_REGISTRY || path.join(ROOT, 'config', 'scheduled-jobs.json');
const STATE = process.env.WATCHDOG_STATE || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'watchdog-state.json');
const HB_DIR = process.env.JOB_HEARTBEAT_DIR || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'heartbeats');
const HOUR = 3600_000;

export const OK = 'OK';
export const MISSING = 'MISSING';
export const NEVER_RAN = 'NEVER-RAN';
export const STALE = 'STALE';
export const FAILING = 'FAILING';
export const STALLED = 'STALLED';

/**
 * Per-shard progress evidence for a job that declares `progressGlob` + `stallMinutes` in the
 * registry (see kb/shard-progress.mjs, written by kb/forge-big.mjs's `embed`/`shard-all` modes).
 *
 * WHY THIS EXISTS (2026-09-11): a live wrapper pid proves the WRAPPER survived a run; it proves
 * NOTHING about whether the work inside it is still moving — an 8-shard gists embed once sat at 0%
 * CPU for six hours with `judge()`'s existing pid-liveness check reporting it OK the entire time
 * (the pid genuinely was alive; it just was not doing anything). `job.stallMinutes` is deliberately
 * independent of `job.maxAgeHours`/the 6h long-run branch below — a job stuck at 0% progress for 20
 * minutes must be flagged well before its overall schedule budget or the long-run grace period would
 * ever trip.
 */
export function readJobProgress(job, { root = ROOT } = {}) {
  if (!job.progressGlob) return null;
  const full = path.join(root, job.progressGlob);
  const dir = path.dirname(full);
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${path.basename(full).split('*').map(escapeRegExp).join('.*')}$`);
  return oldestIncompleteProgress(dir, pattern);
}

/** Labels currently loaded in launchd. A job that isn't here CANNOT fire, whatever its plist says. */
export function loadedLabels(run = () => spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout || '') {
  return new Set(
    run()
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[2])
      .filter(Boolean),
  );
}

/**
 * Judge one job from its receipt. `hb === null` means NO RECEIPT EXISTS — which is NEVER-RAN, never OK.
 * This single line is the whole lesson of 2026-07-13: absence of evidence is not evidence of health.
 */
export function judge(job, hb, loaded, now, { root = ROOT } = {}) {
  if (!loaded) {
    return { state: MISSING, detail: 'declared in the registry but NOT LOADED in launchd — it can never fire' };
  }
  if (!hb) {
    return { state: NEVER_RAN, detail: 'no run has EVER been recorded — the schedule has not fired once' };
  }
  const stamp = new Date(hb.ended_at || hb.started_at);
  if (Number.isNaN(stamp.getTime())) {
    return { state: FAILING, detail: 'receipt exists but its timestamp is unreadable' };
  }
  const ageHours = (now - stamp) / HOUR;

  // STALLED: checked BEFORE the long-run pid-liveness branch below, and independent of it — a live
  // pid is not proof of progress. Only applies when the job declares a stall budget; absence of a
  // progress file is never treated as a stall (the job may not have reached embedding yet).
  if (hb.state === 'running' && job.stallMinutes) {
    const progress = readJobProgress(job, { root });
    if (progress) {
      const staleMinutes = (now - progress.updatedAt) / 60_000;
      if (staleMinutes > job.stallMinutes) {
        return { state: STALLED, ageHours,
          detail: `${progress.detail} has not advanced in ${staleMinutes.toFixed(0)}m — its stall budget is ${job.stallMinutes}m. The wrapper pid may be alive; the work is not.` };
      }
    }
  }

  // Started and never finished? DERIVE it from process liveness, not wall-clock alone (2026-07-19):
  // a full corpus rebuild legitimately runs 12h+ (five changed repos = a long day), and the old
  // ">6h running ⇒ FAILING" rule false-alarmed on exactly that — a 13.5h nightly whose worker was
  // verifiably at 70% CPU got paged as "hung". The receipt carries the wrapper's pid: if that pid is
  // STILL ALIVE (and is genuinely our wrapper, not a recycled pid), the job is a long run in
  // progress — OK, stated as such. If the pid is GONE while the receipt still says "running", THAT
  // is the real started-and-never-finished (SIGKILL/power loss skipped the trap) — FAILING.
  if (hb.state === 'running' && ageHours > 6) {
    let alive = false;
    if (hb.pid) {
      try {
        process.kill(hb.pid, 0); // signal 0 = existence check, sends nothing
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(hb.pid)], { encoding: 'utf8' });
        alive = cmd.includes('job-heartbeat.sh') && cmd.includes(job.label); // guard against pid recycling
      } catch { alive = false; }
    }
    if (alive) {
      return { state: OK, ageHours, detail: `LONG RUN in progress — running ${ageHours.toFixed(1)}h, wrapper pid ${hb.pid} verified alive (full rebuilds legitimately take 12h+)` };
    }
    return { state: FAILING, ageHours, detail: `started ${ageHours.toFixed(1)}h ago and NEVER FINISHED — receipt says "running" but pid ${hb.pid ?? '?'} is GONE (killed/power loss skipped the trap)` };
  }
  if (ageHours > job.maxAgeHours) {
    return { state: STALE, ageHours, detail: `last ran ${ageHours.toFixed(1)}h ago — its schedule allows ${job.maxAgeHours}h. It stopped.` };
  }
  // A "skipped" receipt (lock-skip fired but no real run has EVER recorded a result — job-heartbeat
  // restores the real receipt when one exists, so this only survives when there was none) proves the
  // schedule fires, not that the work runs. Never count it as OK. (F3, 2026-07-18)
  if (hb.state === 'skipped') {
    return { state: NEVER_RAN, ageHours, detail: 'only a lock-skip receipt exists — no real run has ever recorded a result' };
  }
  if (hb.state === 'failed' || hb.state === 'killed' || (typeof hb.exit_code === 'number' && hb.exit_code !== 0)) {
    // job-heartbeat.sh distinguishes "failed" (plain non-zero exit) from "killed" (died to a
    // signal — the wrapper's own trap, or a direct kill of the child; POSIX 128+signal) — surface
    // which one it was rather than collapsing both into one undifferentiated exit code.
    const how = hb.state === 'killed' ? `KILLED by signal ${hb.signal ?? '?'}` : `FAILED with exit ${hb.exit_code}`;
    return { state: FAILING, ageHours, detail: `last run ${how} (${ageHours.toFixed(1)}h ago)` };
  }
  if (hb.state === 'running') {
    return { state: OK, ageHours, detail: `running right now (started ${ageHours.toFixed(1)}h ago)` };
  }
  return { state: OK, ageHours, detail: `ran ${ageHours.toFixed(1)}h ago, exit 0` };
}

export function readHeartbeat(label, dir = HB_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${label}.json`), 'utf8')); } catch { return null; }
}

/**
 * TIER 2 EVIDENCE. A heartbeat (tier 1) is the real proof: start, end, exit code, trap-protected.
 * But receipts only exist from the moment a job is wrapped, and jobs that have genuinely been running
 * for weeks would read NEVER-RAN on day one — a false alarm that would poison the gong immediately.
 *
 * A job's own log, written WHILE IT WORKED, is still evidence it ran (it satisfies the rule: a job that
 * died silently cannot produce it). It is weaker — no exit code, so a job that logs and then dies looks
 * alive — so it is accepted, LABELLED as second-class, and superseded the moment a real receipt lands.
 * Absence of BOTH remains NEVER-RAN. This is a bootstrap ramp, not a loophole.
 */
export function readLegacyLog(job, root = ROOT) {
  if (!job.legacyLog) return null;
  try {
    const p = path.join(root, job.legacyLog);
    const { mtime } = fs.statSync(p);
    const tail = fs.readFileSync(p, 'utf8').slice(-4000);
    return {
      started_at: mtime.toISOString(),
      ended_at: mtime.toISOString(),
      state: /FATAL|VERIFIED FAILURE/.test(tail) ? 'failed' : 'ok',
      exit_code: /FATAL|VERIFIED FAILURE/.test(tail) ? 1 : 0,
      _tier2: true, // surfaced in the verdict so nobody mistakes this for a real receipt
    };
  } catch { return null; }
}

export function checkAll(now, { registry = REGISTRY, loaded = loadedLabels(), hbDir = HB_DIR, root = ROOT } = {}) {
  const { jobs } = JSON.parse(fs.readFileSync(registry, 'utf8'));
  return jobs.map((job) => {
    const hb = readHeartbeat(job.label, hbDir) || readLegacyLog(job, root);
    const verdict = judge(job, hb, loaded.has(job.label), now, { root });
    if (hb?._tier2 && verdict.state === OK) verdict.detail += ' (via its log — no receipt yet; the next run writes one)';
    return { ...job, ...verdict };
  });
}

export function productSchedulerVerdict(status) {
  const base = { label: NIGHTLY_LABEL, what: 'Refreshes the installed Brain corpus and converges every detected host',
    schedule: 'daily 03:47', maxAgeHours: 30, required: true };
  // A 'degraded' adapter whose only defect is a NON-ZERO LAST EXIT is a job that is loaded, verified
  // and FIRED — the exact opposite of MISSING ("not loaded — it can never fire", top of this file).
  // Its truth is the receipt. Measured 2026-09-12 against two FAILED receipts: this projected as
  // MISSING with the detail "LaunchAgent is loaded and runner digest verified, but last exited 1" —
  // a contradiction in one line, and the receipt's reason never surfaced.
  if (status?.state === 'degraded' && Number.isInteger(status.lastExitCode) && status.lastExitCode !== 0) {
    const run = status.runHealth || null;
    if (run?.state === 'stale') return { ...base, state: STALE, detail: run.evidence };
    if (!run || run.state === 'never-ran') {
      return { ...base, state: FAILING, detail: `runner last exited ${status.lastExitCode} and left no receipt — it fired and died before recording a run` };
    }
    if (run.state === 'ok' || run.state === 'running') {
      return { ...base, state: FAILING, detail: `runner last exited ${status.lastExitCode} although its latest receipt reads ${run.state} — the run after that receipt died without recording one (${run.evidence})` };
    }
    return { ...base, state: FAILING, detail: run.evidence };
  }
  if (status?.state !== 'on') return { ...base, state: MISSING, detail: status?.evidence || 'scheduler is not registered' };
  const run = status.runHealth || { state: 'never-ran', evidence: 'No nightly refresh receipt exists yet.' };
  const mapped = run.state === 'ok' || run.state === 'running' ? OK
    : run.state === 'stale' ? STALE
      : run.state === 'never-ran' ? NEVER_RAN : FAILING;
  return { ...base, state: mapped, detail: run.evidence };
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };

/** Page only on a CHANGE of state. Repeating the same alarm nightly is how alarms get ignored. */
export function transitions(results, prev) {
  return results.filter((r) => (prev[r.label] ?? OK) !== r.state);
}

async function push(title, body, priority) {
  const topic = process.env.NTFY_TOPIC
    || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ntfy-topic'), 'utf8').trim(); } catch { return null; } })();
  if (!topic) return false;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: priority === 'urgent' ? 'rotating_light' : 'white_check_mark' },
      body,
    });
    return true;
  } catch { return false; }
}

async function main() {
  const json = process.argv.includes('--json');
  const quiet = process.argv.includes('--quiet');
  const brainHome = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  const results = [...checkAll(new Date()), productSchedulerVerdict(schedulerStatus({
    brainHome, kbDir: process.env.RUVNET_BRAIN_KB || path.join(brainHome, 'kb'),
  }))];
  const bad = results.filter((r) => r.state !== OK);

  const prev = loadState();
  // DERIVED, not asserted (F1, 2026-07-18): a transition is only recorded as handled when its page
  // was actually DELIVERED (push() returned true). The old code saved every new state unconditionally
  // — so a FAILING job whose urgent page failed (ntfy down for a minute) was marked "alerted" and,
  // because alerts are transition-only, would NEVER page again. Now an undelivered transition keeps
  // its PREVIOUS state in the snapshot, so the same transition re-fires (and re-pages) on the next
  // run until a page genuinely lands. The ledger can no longer claim a page that didn't happen.
  const undelivered = new Set();
  for (const c of transitions(results, prev)) {
    const delivered = c.state === OK
      ? await push(`✅ ${c.label} is healthy again`, c.detail, 'default')
      : await push(`🔴 ${c.state}: ${c.label}`, `${c.what}\n\n${c.detail}\n\nschedule: ${c.schedule}`, 'urgent');
    if (!delivered) undelivered.add(c.label);
  }
  saveState(Object.fromEntries(results.map((r) => [r.label, undelivered.has(r.label) ? (prev[r.label] ?? OK) : r.state])));
  // Sol amendment to F1: an undelivered page also FAILS this run (exitCode, not exit — the report
  // below still prints). The watchdog's own heartbeat then records the degradation, so "the pager is
  // broken" is itself a paged, visible condition instead of a silent one.
  if (undelivered.size > 0) process.exitCode = 1;

  if (json) console.log(JSON.stringify({ results, checkedAt: new Date().toISOString() }, null, 2));
  else if (!quiet || bad.length) {
    console.log('Scheduled-job watchdog — proof each job RAN, not just that it exists\n');
    for (const r of results) {
      const icon = r.state === OK ? '✅' : '🔴';
      console.log(`${icon} ${r.state.padEnd(10)} ${r.label}`);
      console.log(`   ${r.detail}`);
      console.log(`   ${r.what} · ${r.schedule}\n`);
    }
    console.log(bad.length
      ? `${bad.length} of ${results.length} job(s) are NOT confirmed working. NEVER-RAN means the schedule has never fired — it does not mean "probably fine".`
      : `All ${results.length} jobs produced a fresh, successful receipt.`);
  }
  process.exit(bad.length || undelivered.size ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
