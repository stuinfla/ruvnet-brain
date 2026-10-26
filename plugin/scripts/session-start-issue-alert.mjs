#!/usr/bin/env node
// session-start-issue-alert.mjs — the maintainer-only open-issue pointer.
//
// REWRITTEN 2026-09-11 after two findings:
//   1. SCOPING BUG: the per-user entitlement file was never checked against the CURRENT project's
//      identity, so an entitled maintainer saw the alert in every unrelated project on the machine.
//      Fixed by session-start-repo-identity.mjs's isMaintainerRepo() — BOTH the local entitlement
//      file AND the current checkout's git remote must agree before anything is shown.
//   2. SCOPE CREEP: SessionStart printed a per-issue breakdown (numbers, titles, ages) sourced from a
//      GitHub lookup. Per reviewer correction, that detail belongs to issue-watch.mjs's own output
//      surface (its console report and open-issues.json), not to a hook that fires on every prompt
//      boundary. SessionStart now prints AT MOST one line — a pointer, not a report — read from the
//      cache within a 100ms budget and never touching the network itself.
import fs from 'node:fs';
import path from 'node:path';
import { isMaintainerRepo } from './session-start-repo-identity.mjs';

const json = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export const ISSUE_POINTER_BUDGET_MS = 100;
// A corrupt/huge open-issues.json is not evidence of anything actionable; refuse to even attempt
// parsing past this size rather than let a pathological file consume the stage's budget.
const MAX_STATUS_BYTES = 256 * 1024;

export const maintainerIssueEntitlement = (env, home, repo, platform = process.platform) => {
  const file = env.RUVNET_BRAIN_MAINTAINER_ISSUES_FILE
    || path.join(home, '.config', 'ruvnet-brain', 'maintainer-issues.json');
  // Windows ACL ownership is not available through this dependency-free hot path. Fail closed
  // instead of weakening an owner-only promise into "any local user who can write the file".
  if (platform === 'win32') return false;
  let stat;
  try { stat = fs.lstatSync(file); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  // This is maintainer-only operational data. Refuse group/world-readable opt-ins on POSIX so a
  // shared machine cannot turn a private maintainer signal into a terminal banner for other users.
  if ((stat.mode & 0o077) !== 0) return false;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
  const entitlement = json(file);
  return entitlement?.enabled === true
    && Array.isArray(entitlement.repos)
    && entitlement.repos.includes(repo);
};

/**
 * At most ONE line, naming a count and where to look — never a per-issue breakdown. Requires BOTH
 * the local per-user entitlement file AND the current project's git remote to name the entitled
 * repo; either alone is not enough (see module header).
 */
export function surfaceIssuePointer({ stateDir, emit, now, env, home, platform, cwd, budgetMs = ISSUE_POINTER_BUDGET_MS }) {
  const start = Date.now();
  try {
    const statusPath = path.join(stateDir, 'open-issues.json');
    let size = 0;
    try { size = fs.statSync(statusPath).size; } catch { return; }
    if (size > MAX_STATUS_BYTES) return;

    const status = json(statusPath);
    const observedAt = Date.parse(status?.at || '');
    if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60_000 || now - observedAt > 6 * 3600_000) return;
    // The 100ms budget covers exactly what correction #2 named — "a one-line pointer read from the
    // cache" — checked HERE, before the (separately, generously bounded — see
    // session-start-repo-identity.mjs's own spawnSync timeout) git-based repo-scoping check below.
    // A local JSON read is always microseconds; a real overrun here means something pathological.
    if (Date.now() - start > budgetMs) return;
    if (!maintainerIssueEntitlement(env, home, status.repo, platform)) return;
    if (!isMaintainerRepo(cwd)) return; // the CURRENT project must itself be the entitled repo

    const open = Array.isArray(status.issues) ? status.issues : [];
    if (!open.length) return;
    const breaches = open.filter((issue) => issue.breach).length;
    const ageHours = (now - observedAt) / 3_600_000;
    const breachNote = breaches ? `, ${breaches} past SLA` : '';
    emit(`[RuvNet Brain — OPEN ISSUES: ${open.length} on ${status.repo}${breachNote}, checked ${ageHours.toFixed(1)}h ago — full detail: node scripts/issue-watch.mjs]`);
  } catch { /* advisory only — a broken cache read must never affect the session */ }
}

/**
 * The owner's ntfy alerts that still need action (scripts/ntfy-inbox.mjs keeps the list; owner, 2026-10-25: "I don't
 * want to be in the middle of this equation where I'm having to tell you what's broken"). Same maintainer gate as the
 * issue pointer; one line, naming the count and the three newest, with the instruction to handle them first.
 */
export function surfaceNtfyAlerts({ stateDir, emit, env, home, platform, cwd, now = Date.now() }) {
  try {
    if (!maintainerIssueEntitlement(env, home, 'stuinfla/ruvnet-brain', platform) || !isMaintainerRepo(cwd)) return;
    surfaceJobHealth({ stateDir, emit, now, cwd });
    // The reader writes a few-byte summary (scripts/ntfy-inbox.mjs writeSummary) so a large alert list can never
    // push this banner past its read limit; the detailed list is only a fallback for an older reader.
    let total = 0; let kinds = {};
    const summaryPath = path.join(stateDir, 'ntfy-open-summary.json');
    const summary = (() => { try { return fs.statSync(summaryPath).size <= 4096 ? json(summaryPath) : null; } catch { return null; } })();
    // The summary is written before the list; if the list is newer anyway (an interrupted write), trust the list.
    // Compare the files' own write times (the summary's `at` is when the poll started, which can be minutes earlier).
    const listNewer = (() => { try { return fs.statSync(path.join(stateDir, 'ntfy-open-alerts.json')).mtimeMs > fs.statSync(summaryPath).mtimeMs + 5000; } catch { return false; } })();
    let dropped = 0;
    if (summary && Number.isInteger(summary.open) && !listNewer) {
      if (Number.isInteger(summary.dropped)) dropped = summary.dropped;
      total = summary.open;
      for (const [k, n] of Object.entries(summary.kinds || {})) if (['job', 'ci', 'issue', 'pr', 'other'].includes(k) && Number.isInteger(n)) kinds[k] = n;
    } else {
      const file = path.join(stateDir, 'ntfy-open-alerts.json');
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return; }
      // Too big to read here is still news: say so rather than staying silent.
      if (size > MAX_STATUS_BYTES) { emit('[RuvNet Brain — NTFY: open alerts present (list too large to summarise here). Details: node scripts/ntfy-inbox.mjs --open]'); return; }
      const open = (json(file, []) || []).filter((a) => a && !a.closedAt);
      total = open.length;
      // Counts by kind only, never message text: anyone who learns the topic can post to it, so a title here would
      // be a way to put words into the session (review 2026-10-25). The owner's tool prints the details.
      for (const a of open) { const k = ['job', 'ci', 'issue', 'pr'].includes(a.kind) ? a.kind : 'other'; kinds[k] = (kinds[k] || 0) + 1; }
    }
    if (!total && !dropped) return;
    const summaryText = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
    const polled = json(path.join(stateDir, 'ntfy-inbox-state.json'), {})?.polledAt;
    const age = polled ? `, read ${((now - Date.parse(polled)) / 3_600_000).toFixed(1)}h ago` : '';
    const over = dropped ? `; ${dropped} more dropped past the cap` : '';
    emit(`[RuvNet Brain — NTFY: ${total} open alert(s) (${summaryText || 'none listed'})${over}${age}. Details: node scripts/ntfy-inbox.mjs --open]`);
  } catch { /* advisory only */ }
}

const WATCHDOG_LABEL = 'com.ruvnet.nightly-watchdog';
const WATCHDOG_MAX_AGE_H = 30;
const MAX_RECEIPTS = 64;
const MAX_RECEIPT_BYTES = 64 * 1024;

/** The job labels config/scheduled-jobs.json registers, found by walking up from the session's project directory (the
 *  maintainer gate already requires this checkout to be the repo), or null when there is no readable registry. */
export function registeredJobLabels(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth++) {
    const file = path.join(dir, 'config', 'scheduled-jobs.json');
    try {
      if (fs.statSync(file).size <= MAX_STATUS_BYTES) {
        const jobs = json(file)?.jobs;
        if (Array.isArray(jobs)) return new Set(jobs.map((j) => j?.label).filter((l) => typeof l === 'string'));
      }
    } catch { /* not here: look one level up */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * WHO WATCHES THE WATCHDOG (4.7.21). nightly-watchdog.mjs cannot judge its own run, and a watchdog that stopped
 * firing would be silent by construction. This reads the local heartbeat receipts (scripts/job-heartbeat.sh) —
 * no network, bounded file count and size — and says ONE line when any receipt is failed/killed or the
 * watchdog's own receipt is older than 30 h. Machines without heartbeats (every end user) get nothing.
 * Only receipts of jobs the registry still lists count (review fix): a retired job's last failed receipt left in the
 * heartbeat directory must not read as "failing" forever. Without a readable registry every receipt counts.
 */
export function surfaceJobHealth({ stateDir, emit, now = Date.now(), cwd }) {
  try {
    const dir = path.join(stateDir, 'heartbeats');
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).slice(0, MAX_RECEIPTS); } catch { return; }
    if (!names.length) return;
    const registered = registeredJobLabels(cwd);
    const red = [];
    let watchdogAt = null;
    for (const name of names) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).size > MAX_RECEIPT_BYTES) continue; } catch { continue; }
      const r = json(file);
      if (!r || typeof r !== 'object') continue;
      const label = name.slice(0, -'.json'.length);
      if (registered && !registered.has(label)) continue;
      if (r.state === 'failed' || r.state === 'killed') red.push(label);
      if (label === WATCHDOG_LABEL) watchdogAt = Date.parse(r.ended_at || r.started_at || '');
    }
    const parts = [];
    if (red.length) parts.push(`${red.length} scheduled job(s) failing (${red.slice(0, 3).join(', ')}${red.length > 3 ? ', …' : ''})`);
    if (watchdogAt !== null) {
      const ageH = Number.isFinite(watchdogAt) ? (now - watchdogAt) / 3_600_000 : Infinity;
      if (ageH > WATCHDOG_MAX_AGE_H) parts.push(`the nightly watchdog last ran ${Number.isFinite(ageH) ? `${Math.floor(ageH)}h ago` : 'at an unreadable time'}`);
    }
    if (parts.length) emit(`[RuvNet Brain — JOBS: ${parts.join('; ')}. Details: node scripts/nightly-watchdog.mjs --no-push]`);
  } catch { /* advisory only */ }
}
