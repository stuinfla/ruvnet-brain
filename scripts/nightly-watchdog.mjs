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
//   STALLED   — running, but its per-shard progress has not moved within its stallMinutes
//   STUCK     — still running past its registry maxRunHours with a live wrapper pid (4.7.21)
//   OK        — a fresh receipt says it ran and exited 0. The ONLY state that counts as working.
//
// Shape confirmed against prior art in the ecosystem: agentic-qe/src/workers/workers/heartbeat-scheduler.ts
// (token-free periodic liveness + stale detection). No launchd supervision existed to reuse.
//
// Alerts are TRANSITION-ONLY (the discipline proven in kb/brain-alarm.mjs): a state change pages once.
// Constant redness must never become constant noise, or the gong trains you to ignore it.
//
// EXIT CODE = "was the verdict DELIVERED?", not "is every job green?" (4.7.21). A red job is the watchdog doing
// its job; exiting 1 for it made the heartbeat wrapper page "SCHEDULED JOB FAILED: nightly-watchdog" on top of
// the real page, every day. Exit 1 now means a page went undelivered or the watchdog itself broke, which the
// wrapper's own curl page then reports by a second path.
//
// Usage:
//   node scripts/nightly-watchdog.mjs             # verdict; pages transitions; exit 0 when delivered
//   node scripts/nightly-watchdog.mjs --strict    # for a human: also exit 1 if ANY job is not OK
//   node scripts/nightly-watchdog.mjs --no-push   # judge and print only: no pages, no state write
//   node scripts/nightly-watchdog.mjs --json      # machine-readable verdict (implies --no-push)
//   node scripts/nightly-watchdog.mjs --quiet     # cron mode: speak only when something is wrong
//   node scripts/nightly-watchdog.mjs --test-page # send one "watchdog delivery test" page; exit 0 only on 2xx
// Exit codes: 0 delivered (or nothing due) · 1 a page was not delivered, an internal error, or --strict and red ·
// 2 `launchctl list` was empty or failed (nothing judged, nothing paged, no state written).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NIGHTLY_LABEL, schedulerStatus, updateOwnedByAgenticKit } from '../plugin/scripts/nightly-scheduler.mjs';
import { oldestIncompleteProgress } from '../kb/shard-progress.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

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
/** Running longer than the job's registry `maxRunHours`, with its wrapper pid still alive (4.7.21). */
export const STUCK = 'STUCK';
/** The watchdog's own label: its receipt reads "running" while it judges, so it never judges itself. */
const SELF_LABEL = process.env.WATCHDOG_SELF_LABEL || 'com.ruvnet.nightly-watchdog';

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

/** Is `pid` still OUR wrapper for this label (not a recycled pid)? */
function wrapperAlive(pid, label) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, sends nothing
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return cmd.includes('job-heartbeat.sh') && cmd.includes(label); // guard against pid recycling
  } catch { return false; }
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

  // STUCK (4.7.21): a job that declares `maxRunHours` and is still "running" past it is stuck even with a live
  // wrapper pid — the 6 h long-run grace below exists for the corpus rebuild, not for a 2-minute job that hung.
  // A gone pid is still the started-and-never-finished FAILING case.
  if (hb.state === 'running' && job.maxRunHours && ageHours > job.maxRunHours) {
    if (wrapperAlive(hb.pid, job.label)) {
      return { state: STUCK, ageHours, detail: `still running after ${ageHours.toFixed(1)}h — its limit is ${job.maxRunHours}h. Wrapper pid ${hb.pid} is alive; the job is not finishing.` };
    }
    return { state: FAILING, ageHours, detail: `started ${ageHours.toFixed(1)}h ago and NEVER FINISHED — receipt says "running" but pid ${hb.pid ?? '?'} is GONE (killed/power loss skipped the trap)` };
  }

  // Started and never finished? DERIVE it from process liveness, not wall-clock alone (2026-07-19):
  // a full corpus rebuild legitimately runs 12h+ (five changed repos = a long day), and the old
  // ">6h running ⇒ FAILING" rule false-alarmed on exactly that — a 13.5h nightly whose worker was
  // verifiably at 70% CPU got paged as "hung". The receipt carries the wrapper's pid: if that pid is
  // STILL ALIVE (and is genuinely our wrapper, not a recycled pid), the job is a long run in
  // progress — OK, stated as such. If the pid is GONE while the receipt still says "running", THAT
  // is the real started-and-never-finished (SIGKILL/power loss skipped the trap) — FAILING.
  if (hb.state === 'running' && ageHours > 6) {
    if (wrapperAlive(hb.pid, job.label)) {
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

export function checkAll(now, { registry = REGISTRY, loaded = loadedLabels(), hbDir = HB_DIR, root = ROOT, self = SELF_LABEL } = {}) {
  const { jobs } = JSON.parse(fs.readFileSync(registry, 'utf8'));
  return jobs.map((job) => {
    const hb = readHeartbeat(job.label, hbDir) || readLegacyLog(job, root);
    // Its own receipt says "running" because this IS that run: judging it is meaningless (it would always read
    // OK, and announce a false recovery). SessionStart and the spend guard judge the watchdog instead (4.7.21).
    if (job.label === self && hb?.state === 'running') {
      return { ...job, state: OK, self: true, detail: 'this run — the watchdog does not judge itself; SessionStart and the spend guard do' };
    }
    const verdict = judge(job, hb, loaded.has(job.label), now, { root });
    if (hb?._tier2 && verdict.state === OK) verdict.detail += ' (via its log — no receipt yet; the next run writes one)';
    // The heartbeat wrapper already paged (or deliberately damped) this failing streak itself (4.7.21).
    // Only for a TERMINAL receipt: a "running" receipt that never finished carries the old streak's fields forward, but
    // the wrapper never saw that death, so the watchdog must page it.
    const wrapperPaged = verdict.state === FAILING && (hb?.state === 'failed' || hb?.state === 'killed')
      && !!hb.failing_since && (hb.paged === true || hb.paged === 'suppressed');
    // The wrapper will send its own "Recovered: X" when this job next passes: its receipt carries a failing streak
    // whose page was delivered (job-heartbeat.sh announces recovery exactly then, also after a never-finished run).
    // A watchdog page sent meanwhile (STALE, STUCK, ...) is then recorded as 'both', and its recovery note is left to
    // the wrapper, so one recovery is announced once (4.7.21 review, Fable P2-2).
    const wrapperRecovers = ['failed', 'killed', 'running'].includes(hb?.state) && !!hb.failing_since && hb.paged === true;
    return { ...job, ...verdict, ...(wrapperPaged ? { wrapperPaged: true } : {}), ...(wrapperRecovers ? { wrapperRecovers: true } : {}) };
  });
}

export function productSchedulerVerdict(status) {
  // The night's receipt: its runId tells one failed night from the next, and a failed night the coordinator already
  // paged itself (developer-update.mjs pageNight, delivered) is handled like a wrapper-paged one.
  const receipt = status?.runHealth?.receipt || null;
  const night = { ...(receipt?.runId ? { runId: receipt.runId } : {}),
    ...(receipt?.page?.kind === 'failed' && receipt.page.state === 'delivered' ? { coordinatorPaged: true } : {}) };
  const base = { label: NIGHTLY_LABEL, what: 'Refreshes the installed Brain corpus and converges every detected host',
    schedule: 'daily 03:30', maxAgeHours: 30, required: true, ...night };
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

/** ONE update owner per machine (CONTRIBUTING.md § The knowledge corpus). agentic-kit removes the
 *  Brain's own scheduler by design and updates through `ak sync`, which the registry watches as
 *  com.stuartkerr.ak-sync — so on such a machine the Brain scheduler is not expected to exist. */
// One reader of agentic-kit ownership, shared with SessionStart's knowledge-currency line.
export function brainUpdateOwnedByAgenticKit(home = os.homedir()) {
  return updateOwnedByAgenticKit(home);
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };

/** Page only on a CHANGE of state. Repeating the same alarm nightly is how alarms get ignored. One exception: a NEW
 *  failed night of the product nightly (a different receipt runId than the one last handled) pages once, because "it
 *  failed again tonight" is news; before this, three failed nights in a row paged only the first (2026-10-27..30). */
export function transitions(results, prev) {
  const handledRun = (label) => prev._runs?.[label];
  return results.filter((r) => !r.self && ((prev[r.label] ?? OK) !== r.state
    || (r.state === FAILING && !!r.runId && !!handledRun(r.label) && handledRun(r.label) !== r.runId)));
}

/** An HTTP header value must be a ByteString. An emoji in `Title` made fetch() throw before sending a byte, so
 *  this watchdog never delivered a page (4.7.21). Titles are plain ASCII; the meaning rides in `Tags`. */
export const asciiTitle = (s) => String(s).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'RuvNet Brain';

/** The topic: NTFY_TOPIC when set (set-but-EMPTY is an explicit opt-out: null), else the owner's topic file. */
function ntfyTopic() {
  if (process.env.NTFY_TOPIC !== undefined) return process.env.NTFY_TOPIC.trim() || null;
  try { return fs.readFileSync(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ntfy-topic'), 'utf8').trim() || null; } catch { return null; }
}

/** One POST. Delivered means a 2xx answer — a 429 or 5xx is not a page. */
async function push(topic, title, body, priority) {
  const base = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: asciiTitle(title), Priority: priority, Tags: priority === 'urgent' ? 'rotating_light' : 'white_check_mark' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

const RETRY_MS = Number(process.env.WATCHDOG_RETRY_MS ?? 30_000);
const ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send every message, retrying the undelivered ones up to ATTEMPTS times, RETRY_MS apart. Returns the
 *  indexes that never landed. */
async function deliverAll(topic, messages) {
  let pending = messages.map((_, i) => i);
  for (let attempt = 1; attempt <= ATTEMPTS && pending.length; attempt++) {
    if (attempt > 1) await sleep(RETRY_MS);
    const still = [];
    for (const i of pending) if (!(await push(topic, ...messages[i]))) still.push(i);
    pending = still;
  }
  return new Set(pending);
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const strict = argv.includes('--strict');
  const noPush = json || argv.includes('--no-push');

  if (argv.includes('--test-page')) {
    const topic = ntfyTopic();
    if (!topic) { console.error('nightly-watchdog: no ntfy topic configured (NTFY_TOPIC or ~/.cache/ruvnet-brain/ntfy-topic) — nothing sent'); process.exit(1); }
    const failed = await deliverAll(topic, [['Watchdog delivery test', `nightly-watchdog --test-page from ${os.hostname()} at ${new Date().toISOString()}. If you can read this, pages reach you.`, 'default']]);
    console.log(failed.size ? 'nightly-watchdog: test page NOT delivered (no 2xx after 3 attempts)' : 'nightly-watchdog: test page delivered (2xx)');
    process.exit(failed.size ? 1 : 0);
  }

  // An empty or failed `launchctl list` (launchd busy, sandbox, a broken PATH) would read EVERY job as MISSING and
  // page them all. It is not evidence about any job: say so, page nothing, keep the state (4.7.21).
  const listing = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
  const loaded = loadedLabels(() => (listing.status === 0 ? listing.stdout || '' : ''));
  if (!loaded.size) {
    console.error(`nightly-watchdog: \`launchctl list\` returned no jobs (exit ${listing.status ?? listing.error?.code ?? '?'}) — cannot judge anything; nothing paged, state unchanged`);
    process.exit(2);
  }

  const brainHome = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  const results = [...checkAll(new Date(), { loaded }), ...(brainUpdateOwnedByAgenticKit() ? [] : [productSchedulerVerdict(schedulerStatus({
    brainHome, kbDir: process.env.RUVNET_BRAIN_KB || path.join(brainHome, 'kb'),
  }))])];
  const bad = results.filter((r) => r.state !== OK);

  // DERIVED, not asserted (F1, 2026-07-18): a transition is only recorded as handled when its page was actually
  // DELIVERED. An undelivered transition keeps its PREVIOUS state, so it re-fires on the next run until a page
  // genuinely lands. A failure the heartbeat wrapper already paged is handled; so is the recovery of a failure the
  // watchdog never paged itself (the wrapper sends that note). The watchdog pages what the wrapper cannot see:
  // MISSING, NEVER-RAN, STALE, STALLED, STUCK, a run that never finished, and their recoveries (4.7.21).
  const topic = noPush ? null : ntfyTopic();
  const optedOut = !noPush && process.env.NTFY_TOPIC !== undefined && !topic;
  let undelivered = new Set();
  if (!noPush && !optedOut) {
    const prev = loadState();
    const pagedBy = { ...(prev._pagedBy || {}) };
    const sends = []; const owners = []; const viaBoth = new Set();
    for (const c of transitions(results, prev)) {
      if (c.wrapperPaged || (c.coordinatorPaged && c.state === FAILING)) { pagedBy[c.label] = 'wrapper'; continue; }
      if (c.state === OK) {
        if (pagedBy[c.label] === 'both') { delete pagedBy[c.label]; continue; } // the wrapper's "Recovered" covers it
        if (prev[c.label] === FAILING && pagedBy[c.label] !== 'watchdog') { delete pagedBy[c.label]; continue; }
        sends.push([`${c.label} is healthy again`, c.detail, 'default']); owners.push(c.label);
      } else {
        if (c.wrapperRecovers) viaBoth.add(c.label);
        sends.push([`${c.state}: ${c.label}`, `${c.what}\n\n${c.detail}\n\nschedule: ${c.schedule}`, 'urgent']); owners.push(c.label);
      }
    }
    const failed = topic ? await deliverAll(topic, sends) : new Set(sends.map((_, i) => i));
    undelivered = new Set([...failed].map((i) => owners[i]));
    for (const [i, label] of owners.entries()) {
      if (failed.has(i)) continue;
      if (sends[i][2] === 'urgent') pagedBy[label] = viaBoth.has(label) ? 'both' : 'watchdog'; else delete pagedBy[label];
    }
    const next = Object.fromEntries(results.map((r) => [r.label,
      r.self || undelivered.has(r.label) ? (prev[r.label] ?? OK) : r.state]));
    // The night each label's verdict was last handled for; an undelivered page keeps the old one so it re-fires.
    const runs = { ...(prev._runs || {}) };
    for (const r of results) if (r.runId && !undelivered.has(r.label)) runs[r.label] = r.runId;
    saveState({ ...next, _pagedBy: pagedBy, _runs: runs });
  }

  if (json) console.log(JSON.stringify({ results, checkedAt: new Date().toISOString() }, null, 2));
  else if (!quiet || bad.length || undelivered.size) {
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
    if (undelivered.size) console.log(`PAGE NOT DELIVERED for: ${[...undelivered].join(', ')} — it re-fires on the next run.`);
    if (optedOut) console.log('(NTFY_TOPIC="" — paging disabled; no state recorded)');
  }
  // Sol amendment to F1: an undelivered page FAILS this run, so "the pager is broken" is itself visible.
  process.exit(undelivered.size || (strict && bad.length) ? 1 : 0);
}

if (isDirectInvocation(import.meta.url)) {
  try { await main(); } catch (e) { console.error(`nightly-watchdog: internal error — ${e?.stack || e}`); process.exit(1); }
}
