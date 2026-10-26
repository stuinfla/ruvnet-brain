#!/usr/bin/env node
// scripts/issue-watch.mjs — GitHub-issues SLA watcher.
//
// Stuart's mandate: no open issue on stuinfla/ruvnet-brain may sit >4h without a response, or an
// ntfy alert must reach his phone. "Response" = a comment from the repo owner (stuinfla) — a
// contributor's comment (see issue #12, commented by @sparkling) does NOT satisfy the SLA.
//
// 2026-07-24 incident, two rules born from it:
//   1. A BOT comment is not an owner response. issue-fix.mjs posts through the owner's gh auth, so
//      its comments arrive as stuinfla — and four issues (#38/#39/#41/#42) sat 28h with ZERO pages
//      because those bot comments satisfied the owner-comment check below. The fixer manufactured
//      the exact signal that silences the watcher. Marked comments (BOT_MARKER) never count.
//   2. The breach alert is the ESCALATION channel, not the AWARENESS channel. Waiting 4h to say
//      anything is how the maintainer learned about four issues from a GitHub email instead of a
//      page. The watcher now pages ONCE, immediately, the first time it sees any open issue.
//
// Follows the house positive-confirmation pattern established 2026-07-13 (scripts/job-heartbeat.sh,
// scripts/nightly-watchdog.mjs, config/scheduled-jobs.json): this script is meant to run WRAPPED by
// job-heartbeat.sh from a launchd plist, so a crash still leaves a receipt and a failed run still
// pages the phone via the wrapper's own "SCHEDULED JOB FAILED" alert. This script's own exit code is
// therefore reserved for real execution failures (gh unreachable, bad JSON) — finding an SLA breach
// is the job working correctly, not a failure, so it always exits 0 on a clean run.
//
// Dedup: alerts for a given issue repeat at most once per SLA window (4h), tracked in a small state
// file, so a still-breaching issue doesn't re-page every hourly run.
//
// Usage:
//   node scripts/issue-watch.mjs             # check + alert on breaches
//   node scripts/issue-watch.mjs --dry-run   # check + print what WOULD be sent; no ntfy push, no state write

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'stuinfla/ruvnet-brain';
export const OWNER_LOGIN = 'stuinfla';
// Every comment the automation posts through the owner's gh auth begins with this prefix — the
// watcher's acknowledgment ("🤖 Automated acknowledgment …") and the fixer child's notes
// ("🤖 Automated issue-fix run …") both start with it. Spoof-safety: only comments AUTHORED BY
// the owner are checked against it, so a stranger opening their comment with the marker changes
// nothing — and the owner starting a personal reply with a robot emoji is not a realistic
// collision. (Generalized from the fixer-specific wording 2026-07-24 when the acknowledgment
// moved here.)
export const BOT_MARKER = '🤖 Automated';
const SLA_HOURS = 4;
// A person's issue whose detail AND list comments cannot be read this many runs in a row fails the run once (review fix).
const UNREADABLE_RUNS = 3;
// WHO IS WAITING (owner, 2026-10-25: "10,747 notifications"). An issue opened by the owner's own account or a bot is
// work the owner's automation filed (Dream Cycle, dependabot), not a person waiting for an answer: it never pages
// and gets no acknowledgment. Only a person's issue pages.
const AUTOMATION_AUTHORS = new Set([OWNER_LOGIN, 'dependabot', 'dependabot[bot]', 'github-actions', 'github-actions[bot]', 'app/dependabot']);
export const isPersonIssue = (issue) => !AUTOMATION_AUTHORS.has(String(issue?.author?.login || '').toLowerCase())
  && !issue?.author?.is_bot && !String(issue?.author?.login || '').endsWith('[bot]');
// ONE morning summary instead of a page per issue per 4 hours: the first run at or after 9 a.m. Eastern sends it,
// only if a person's issue is still waiting, and at most once per Eastern calendar day.
const DIGEST_HOUR_ET = 9;
const etParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric',
  month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
export function digestDue(lastDay, now) {
  const p = etParts(now); const day = `${p.year}-${p.month}-${p.day}`;
  return { due: Number(p.hour) % 24 >= DIGEST_HOUR_ET && lastDay !== day, day };
}
const STATE_PATH = process.env.ISSUE_WATCH_STATE
  || path.join(os.homedir(), '.claude', 'ruvnet-brain', 'issue-watch-state.json');
// A compact, always-current snapshot the SessionStart hook surfaces (2026-07-17). ntfy alerts are
// easy to miss — issues stacked unseen for 29h precisely because the only channel was the phone.
// The session banner is a channel the maintainer cannot miss; this file is how it learns the count.
const STATUS_PATH = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'open-issues.json');
const GH_BIN = process.env.GH_BIN || 'gh';

/** A network-shaped gh failure worth waiting out (2026-07-19 "TLS handshake timeout"; 4.7.21 adds the 1 a.m.
 *  "error connecting to api.github.com" and GitHub's 502/503/504). Anything else — auth, 404, bad JSON — is real. */
export function isTransientGhError(text) {
  return /TLS handshake|unexpected EOF|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection refused|temporarily unavailable|error connecting to api\.github\.com|HTTP 50[234]/i.test(String(text || ''));
}
/** Seconds to wait before attempts 2 and 3. Bounded: three attempts, then the failure is loud. */
export const GH_RETRY_DELAYS_S = [10, 30];

/** `gh … --json` with backoff on transient failures. Shared by issue-fix.mjs (one rule, one place). */
export function ghJsonWithRetry(args, { bin = GH_BIN, who = 'issue-watch' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= GH_RETRY_DELAYS_S.length + 1; attempt++) {
    const res = spawnSync(bin, args, { encoding: 'utf8' });
    if (res.status === 0) return JSON.parse(res.stdout);
    const err = (res.stderr || res.stdout || '').trim();
    lastErr = new Error(`gh ${args.join(' ')} failed (exit ${res.status}): ${err}`);
    if (attempt <= GH_RETRY_DELAYS_S.length && isTransientGhError(err)) {
      const wait = GH_RETRY_DELAYS_S[attempt - 1];
      console.error(`${who}: transient gh/network failure (${err.slice(0, 90)}) — retry ${attempt} in ${wait}s`);
      spawnSync('sleep', [String(wait)]);
      continue;
    }
    break;
  }
  throw lastErr;
}
const ghJson = (args) => ghJsonWithRetry(args);

/** Resolve the ntfy topic the same way the rest of the repo does: env, then the machine-wide
 * cache file, then the repo .env — see scripts/notify.sh / scripts/job-heartbeat.sh / scripts/nightly-watchdog.mjs. */
function resolveTopic() {
  // Set-but-EMPTY is an explicit opt-out (job-heartbeat.sh's convention): tests use it, and it must never fall
  // through to the repo's real .env topic (2026-10-25: a unit test read the owner's topic that way).
  if (process.env.NTFY_TOPIC !== undefined) return process.env.NTFY_TOPIC || null;
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ntfy-topic'), 'utf8').trim();
    if (t) return t;
  } catch { /* fall through */ }
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^NTFY_TOPIC=(.*)$/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return null;
}

async function pushNtfy(topic, { title, body, priority = 'urgent', tags = 'rotating_light' }) {
  const base = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
  try {
    // Title is ASCII only: a non-ByteString header makes fetch() throw before sending (4.7.21). Issue titles never
    // go in the header — they are public, untrusted text — only the body.
    const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: String(title).replace(/[^\x20-\x7e]+/g, ' ').trim(), Priority: priority, Tags: tags },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false; // alerting must never break the job — fail-silent, matching scripts/notify.sh
  }
}

/** A missing or unreadable state file is an empty one. That is safe since 4.7.21 (a reset state replayed 17
 *  "SLA breach" pages in 11 s): every breach due in one run is ONE page, and an acknowledgment already on the
 *  thread is recognised from the thread itself, never posted twice. */
function loadState() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  return {};
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function fmtAge(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

/** Judge one issue. Comments are re-fetched per-issue via `gh issue view` (not trusted from the
 * list call) so owner-comment presence is computed off the authoritative per-issue payload. */
export function judgeIssue(issue, comments, now) {
  const ageHours = (now - new Date(issue.createdAt).getTime()) / 3_600_000;
  // An owner response is a HUMAN response: bot-marked comments never satisfy the SLA (see header,
  // 2026-07-24 — the fixer's failure notes muted every page for four real issues).
  const ownerComment = comments.find((c) => c.author?.login === OWNER_LOGIN
    && !String(c.body || '').trimStart().startsWith(BOT_MARKER));
  const breach = ageHours > SLA_HOURS && !ownerComment;
  return { ageHours, ownerComment: !!ownerComment, breach };
}

export async function run({ dryRun = false, now = Date.now(), repo = REPO } = {}) {
  const issues = ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--json',
    'number,title,createdAt,comments,updatedAt,author']);

  const state = loadState();
  const results = [];
  const alertsSent = [];
  const degraded = [];
  const dueBreaches = [];
  const unreadable = []; // person issues unreadable for UNREADABLE_RUNS runs and no other way to judge them: fail once

  for (const issue of issues) {
    const url = `https://github.com/${repo}/issues/${issue.number}`;
    const key = String(issue.number);
    // One issue whose detail cannot be read does not stop the run (4.7.21). It is judged from the comments the list
    // call already returned (review fix: before, it was skipped forever and never got its SLA page); with no list
    // comments either it is skipped, and once it has been unreadable on UNREADABLE_RUNS runs in a row the run fails
    // ONCE so the heartbeat wrapper pages. Never acknowledged from the list copy (it may be incomplete, and a second
    // public acknowledgment is worse than none).
    let detail; let fromList = false;
    try { detail = ghJson(['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments']); }
    catch (err) {
      degraded.push(issue.number);
      const prev = state[key] || {};
      const runs = (Number(prev.unreadableRuns) || 0) + 1;
      state[key] = { ...prev, unreadableRuns: runs, unreadableSince: prev.unreadableSince || new Date(now).toISOString() };
      if (Array.isArray(issue.comments)) {
        detail = { comments: issue.comments }; fromList = true;
        console.error(`issue-watch: #${issue.number} detail unreadable — judged from the list's comments — ${err.message.slice(0, 160)}`);
      } else {
        console.error(`issue-watch: #${issue.number} skipped this run (${runs} in a row) — ${err.message.slice(0, 160)}`);
        if (isPersonIssue(issue) && runs >= UNREADABLE_RUNS && !prev.unreadableEscalatedAt) {
          unreadable.push(issue.number);
          state[key].unreadableEscalatedAt = new Date(now).toISOString();
        }
        continue;
      }
    }
    if (!fromList && state[key]?.unreadableRuns) { // readable again: the next unreadable streak counts from zero
      state[key] = { ...state[key] };
      for (const f of ['unreadableRuns', 'unreadableSince', 'unreadableEscalatedAt']) delete state[key][f];
    }
    const comments = detail.comments || [];
    const { ageHours, ownerComment, breach } = judgeIssue(issue, comments, now);
    // A person's issue pages ONCE when it first passes the SLA, never again (it used to repeat every 4 h, forever,
    // which with ~14 old issues and an hourly run was most of the 10,747 notifications). The morning digest below
    // carries whatever is still waiting. An existing lastAlertAt means that one page already went out.
    const person = isPersonIssue(issue);
    const dueForAlert = person && breach && !state[key]?.lastAlertAt;
    // First sighting → page once, immediately (rule 2 in the header). Delivery-derived like
    // lastAlertAt: state is only written when the push actually went out, so a failed push
    // retries next run instead of burying the sighting.
    const firstSighting = !state[key];
    // Acknowledgment delivery is not page delivery. Retry each missing channel independently. Neither applies to an
    // issue the owner's automation opened.
    // Arrival is paged once, instantly, by .github/workflows/ntfy-alerts.yml (the `issues: opened` event). Paging it
    // here too sent every new issue twice (review 2026-10-25), so this watcher owns only the SLA page and the digest.
    const needsNewPage = false;
    // Our acknowledgment already on the thread (a lost or reset state file) is never posted twice in public.
    const alreadyAcked = comments.some((c) => c.author?.login === OWNER_LOGIN
      && /^🤖 Automated acknowledgment/.test(String(c.body || '').trimStart()));
    if (person && !state[key]?.ackAt && alreadyAcked) {
      state[key] = { ...(state[key] || {}), ackAt: new Date(now).toISOString(), ackBaselined: true, title: issue.title, url };
    }
    const needsAck = person && !fromList && !state[key]?.ackAt;

    results.push({ number: issue.number, title: issue.title, ageHours, ownerComment, breach, dueForAlert, firstSighting, url, person });

    if (needsNewPage || needsAck) {
      if (dryRun) {
        alertsSent.push({ number: issue.number, sent: false, kind: 'new-issue', reason: 'dry-run' });
      } else {
        const topic = needsNewPage ? resolveTopic() : null;
        let sent = !needsNewPage;
        if (needsNewPage && topic) sent = await pushNtfy(topic, {
          title: `New issue #${issue.number} (open ${fmtAge(ageHours)})`,
          body: `${issue.title}\n${url}`,
          priority: 'high', tags: 'new,eyes',
        });
        // THE ONE PUBLIC ACKNOWLEDGMENT (owner directive, 2026-07-24): tell the reporter we have
        // it and it's being worked — once, warmly, with zero excuses and zero deadlines. After
        // this, the thread's next post is a real fix, real findings, or the maintainer in person;
        // failure-progress notes never appear anywhere ("we gave it 15 minutes and quit" reads as
        // not caring — the opposite of the point). Carries BOT_MARKER so judgeIssue() can never
        // mistake it for the owner responding. Best-effort like ntfy: a comment failure must not
        // break the watch; unacked issues simply retry next run (ackAt is delivery-derived).
        let acked = !needsAck;
        if (needsAck) {
          const ackBody = `${BOT_MARKER} acknowledgment — received and opened. The next update here will be a fix, findings, or the maintainer in person.`;
          const ack = spawnSync(GH_BIN, ['issue', 'comment', String(issue.number), '--repo', repo, '--body', ackBody], { encoding: 'utf8' });
          acked = ack.status === 0;
        }
        if (sent || acked) state[key] = {
          ...(state[key] || {}), firstSeenAt: state[key]?.firstSeenAt || new Date(now).toISOString(),
          ...(needsNewPage && sent ? { newAlertAt: new Date(now).toISOString() } : {}),
          ...(needsAck && acked ? { ackAt: new Date(now).toISOString() } : {}), title: issue.title, url,
        };
        alertsSent.push({ number: issue.number, sent, acked, kind: 'new-issue',
          pageAttempted: needsNewPage, ackAttempted: needsAck,
          reason: needsNewPage && !topic ? 'no ntfy topic configured' : null });
      }
    }

    if (dueForAlert) dueBreaches.push({ issue, ageHours, url, key });
  }

  // ONE page per run for every breach that is due (4.7.21), oldest first, body bounded to 8 lines. The title keeps
  // the "SLA breach: issue #N" shape scripts/ntfy-inbox.mjs classifies. DERIVED, not asserted (F5, 2026-07-18):
  // lastAlertAt is written only for a delivered page; a failed page retries next run as the same single page.
  // Spread-merge, never overwrite (2026-07-24: clobbering firstSeenAt/newAlertAt re-paged forever).
  let breachPaged = new Set();
  if (dueBreaches.length) {
    dueBreaches.sort((a, b) => b.ageHours - a.ageHours);
    const [first, ...rest] = dueBreaches;
    const title = rest.length
      ? `SLA breach: issue #${first.issue.number} (+${rest.length} more waiting > ${SLA_HOURS}h)`
      : `SLA breach: issue #${first.issue.number}`;
    const lines = dueBreaches.slice(0, 8).map((b) => `#${b.issue.number} (${fmtAge(b.ageHours)}) ${String(b.issue.title).slice(0, 70)}`);
    // Past 8 lines the rest are still NAMED ("…and K more: #a #b"): scripts/ntfy-inbox.mjs files one alert per issue,
    // so the session banner counts the breach truly (a 17-issue page used to count as 1).
    const body = `${dueBreaches.length} contributor issue(s) past ${SLA_HOURS}h with no response from ${OWNER_LOGIN}:\n${lines.join('\n')}`
      + (dueBreaches.length > 8 ? `\n…and ${dueBreaches.length - 8} more: ${dueBreaches.slice(8).map((b) => `#${b.issue.number}`).join(' ')}` : '')
      + `\nhttps://github.com/${repo}/issues`;
    if (dryRun) {
      for (const b of dueBreaches) alertsSent.push({ number: b.issue.number, sent: false, kind: 'sla-breach', reason: 'dry-run' });
    } else {
      const topic = resolveTopic();
      const sent = topic ? await pushNtfy(topic, { title, body, priority: 'urgent', tags: 'rotating_light,warning' }) : false;
      for (const b of dueBreaches) {
        if (sent) state[b.key] = { ...(state[b.key] || {}), lastAlertAt: new Date(now).toISOString(), title: b.issue.title, url: b.url };
        else state[b.key] = { ...(state[b.key] || {}), lastAttemptAt: new Date(now).toISOString(), sent: false, title: b.issue.title, url: b.url };
        alertsSent.push({ number: b.issue.number, sent, kind: 'sla-breach', reason: topic ? null : 'no ntfy topic configured' });
      }
      if (sent) breachPaged = new Set(dueBreaches.map((b) => b.issue.number));
    }
  }

  // The morning digest: one notification naming every person's issue still unanswered, oldest first.
  const waiting = results.filter((r) => r.person && r.breach).sort((a, b) => b.ageHours - a.ageHours);
  const digest = digestDue(state._digest?.day, now);
  // Everything still waiting was named in this run's breach page: that page IS today's summary.
  if (waiting.length && digest.due && waiting.every((r) => breachPaged.has(r.number))) {
    state._digest = { day: digest.day, sentAt: new Date(now).toISOString(), count: waiting.length, viaBreachPage: true };
  } else if (waiting.length && digest.due) {
    const title = `Waiting on a reply: ${waiting.length} contributor issue${waiting.length === 1 ? '' : 's'}`;
    const body = waiting.slice(0, 8).map((r) => `#${r.number} (${fmtAge(r.ageHours)}) ${r.title.slice(0, 70)}`).join('\n')
      + (waiting.length > 8 ? `\n…and ${waiting.length - 8} more` : '') + `\nhttps://github.com/${repo}/issues`;
    if (dryRun) alertsSent.push({ kind: 'digest', sent: false, reason: 'dry-run', count: waiting.length });
    else {
      const topic = resolveTopic();
      const sent = topic ? await pushNtfy(topic, { title, body, priority: 'default', tags: 'clipboard' }) : false;
      if (sent) state._digest = { day: digest.day, sentAt: new Date(now).toISOString(), count: waiting.length };
      alertsSent.push({ kind: 'digest', sent, count: waiting.length, reason: topic ? null : 'no ntfy topic configured' });
    }
  }

  if (!dryRun) saveState(state);

  return { results, alertsSent, degraded, unreadable, checkedAt: new Date(now).toISOString() };
}

/**
 * AN OPEN PR YOU OPENED IS UNFINISHED WORK. Added 2026-08-06.
 *
 * The continuation gate could already see two kinds of outstanding work — an issue past its SLA,
 * and a red CI run. It could not see the third and most common kind: a pull request that is sitting
 * open, fully green, one `gh pr merge` from done. Measured that day: PRs #117, #118 and #119 were
 * opened and the gate said nothing at the Stop boundary, because a PR is neither an issue nor a CI
 * failure and nobody had called `--commit-to`. The owner's reaction — "why the hell have you
 * stopped?" — was the gate's blind spot talking, not a missing rule.
 *
 * This is the producer half. `issue-watch.mjs` already answers "what is outstanding on GitHub" once
 * an hour and already writes the artifact the gate reads; it simply only knew about issues. Teaching
 * it PRs needs no new pipeline, no new writer, and no network call at the Stop boundary — which is
 * the whole reason to put it here rather than in the gate.
 *
 * DELIBERATELY NARROW, for the same reason the issues source reports only breaches: a permanently
 * non-empty list makes the gate nag forever, which trains people to ignore it.
 *   - DRAFT PRs are excluded. A draft is explicitly "not ready" — nagging about it is noise.
 *   - `checksState` is recorded, never filtered on here. The gate decides what is actionable, so
 *     this stays a plain observation and the policy lives in one place.
 * Failure is silent-and-empty by design: this is best-effort decoration on a status file whose
 * absence must never break the watcher, and a PR list that cannot be read is not evidence of work.
 */
export function collectOpenPrs() {
  try {
    const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--json',
      'number,title,isDraft,mergeable,statusCheckRollup,url,author']);
    if (!Array.isArray(prs)) return [];
    return prs.filter((p) => !p.isDraft).map((p) => {
      const rollup = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [];
      // A check is UNRESOLVED while it has no conclusion yet. Same discipline as redCiOpenWork:
      // a run still in flight is not yet evidence of anything.
      const unresolved = rollup.filter((c) => {
        const s = String(c?.status || '').toUpperCase();
        const concl = String(c?.conclusion || c?.state || '');
        return s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'PENDING' || (!concl && s !== 'COMPLETED');
      }).length;
      const failing = rollup.filter((c) => {
        const v = String(c?.conclusion || c?.state || '').toUpperCase();
        return v === 'FAILURE' || v === 'TIMED_OUT' || v === 'CANCELLED' || v === 'ERROR';
      }).length;
      let checksState = 'none';
      if (rollup.length) checksState = unresolved ? 'pending' : (failing ? 'failing' : 'passing');
      return {
        number: p.number,
        title: String(p.title || '').slice(0, 80),
        author: p.author?.login || '',
        checksState,
        failing,
        mergeable: p.mergeable || 'UNKNOWN',
        url: p.url || `https://github.com/${REPO}/pull/${p.number}`,
      };
    });
  } catch { return []; }
}

/**
 * THE THINGS GITHUB EMAILS THE OWNER ABOUT. Added 2026-08-06, at his request:
 *
 *   "That stuff that keeps coming to me as an email that I seem to have to tell you and you don't
 *    know. I want you to know about anything that would cause GitHub to spit out a notify note."
 *
 * That is a real asymmetry: GitHub pushes Dependabot and secret-scanning findings to his inbox, and
 * nothing pulled them into this session, so he had to relay them by hand. A watcher that already
 * answers "what is outstanding on GitHub" every hour is the right place to close it.
 *
 * Failed workflow runs are deliberately NOT collected here — scripts/signal-watch.mjs is the SINGLE
 * WRITER of ci-status.json and the continuation gate already reads red CI from it. Duplicating that
 * signal would give one fact two owners, which is the one-poisoned-predicate hazard ADR-050 exists
 * to prevent.
 *
 * Each endpoint is independent and best-effort: a repo with code scanning disabled 404s, a token
 * without `security_events` 403s, and neither is evidence of a problem — an alert we cannot read is
 * not an alert. Never let this fail the watcher.
 */
export function collectSecurityAlerts() {
  const alerts = [];
  const safe = (args) => { try { const v = ghJson(args); return Array.isArray(v) ? v : []; } catch { return []; } };

  for (const a of safe(['api', `repos/${REPO}/dependabot/alerts?state=open&per_page=50`])) {
    alerts.push({
      kind: 'dependabot',
      severity: String(a?.security_advisory?.severity || 'unknown').toLowerCase(),
      title: `${a?.dependency?.package?.name || 'dependency'}: ${String(a?.security_advisory?.summary || '').slice(0, 70)}`,
      url: a?.html_url || `https://github.com/${REPO}/security/dependabot`,
    });
  }
  for (const a of safe(['api', `repos/${REPO}/secret-scanning/alerts?state=open&per_page=50`])) {
    alerts.push({
      kind: 'secret-scanning',
      severity: 'critical', // a live credential in a public repo has exactly one severity
      title: String(a?.secret_type_display_name || a?.secret_type || 'secret'),
      url: a?.html_url || `https://github.com/${REPO}/security/secret-scanning`,
    });
  }
  for (const a of safe(['api', `repos/${REPO}/code-scanning/alerts?state=open&per_page=50`])) {
    alerts.push({
      kind: 'code-scanning',
      severity: String(a?.rule?.security_severity_level || a?.rule?.severity || 'unknown').toLowerCase(),
      title: String(a?.rule?.description || a?.rule?.id || 'code scanning alert').slice(0, 70),
      url: a?.html_url || `https://github.com/${REPO}/security/code-scanning`,
    });
  }
  return alerts;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const asJson = process.argv.includes('--json');

  let output;
  try {
    output = await run({ dryRun });
  } catch (err) {
    console.error(`issue-watch: FAILED — ${err.message}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`GitHub issue SLA watch — ${REPO} (SLA: ${SLA_HOURS}h to first owner (@${OWNER_LOGIN}) response)${dryRun ? '  [DRY-RUN]' : ''}\n`);
    for (const r of output.results) {
      const icon = r.breach ? '\u{1F534}' : '✅';
      console.log(`${icon} #${r.number}  ${r.title}`);
      console.log(`   age: ${fmtAge(r.ageHours)} · owner comment: ${r.ownerComment ? 'yes' : 'no'} · breach: ${r.breach ? 'YES' : 'no'}`);
      if (r.firstSighting) {
        const na = output.alertsSent.find((a) => a.number === r.number && a.kind === 'new-issue');
        console.log(`   🆕 first sighting — ${dryRun ? '[DRY-RUN] would push new-issue page' : na?.sent ? 'new-issue page pushed' : `new-issue page NOT sent (${na?.reason})`}`);
      }
      if (r.dueForAlert) {
        const alert = output.alertsSent.find((a) => a.number === r.number && a.kind === 'sla-breach');
        console.log(`   ${dryRun ? '[DRY-RUN] would push ntfy alert' : alert?.sent ? 'ntfy alert pushed' : `ntfy alert NOT sent (${alert?.reason})`}`);
      } else if (r.breach && !r.person) {
        console.log('   opened by the owner\'s own automation — never paged');
      } else if (r.breach) {
        console.log('   already paged once — listed in the morning summary until answered');
      }
      console.log('');
    }
    const breaches = output.results.filter((r) => r.breach).length;
    console.log(breaches
      ? `${breaches} of ${output.results.length} open issue(s) are in SLA breach.`
      : `All ${output.results.length} open issue(s) are within the ${SLA_HOURS}h SLA.`);
    if (dryRun) console.log('(dry-run: no ntfy pushed, no state file written)');
  }

  // Write the snapshot the SessionStart hook reads. Best-effort — a status-file failure must never
  // fail the watcher (whose real job, alerting, already succeeded above).
  if (!dryRun) {
    try {
      const issues = output.results.map((r) => ({
        number: r.number, title: r.title, ageHours: Math.round(r.ageHours),
        breach: !!r.breach, url: `https://github.com/${REPO}/issues/${r.number}`,
      }));
      fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
      fs.writeFileSync(STATUS_PATH, JSON.stringify({
        at: new Date().toISOString(), repo: REPO,
        open: issues.length, breaches: issues.filter((i) => i.breach).length, issues,
        prs: collectOpenPrs(),
        securityAlerts: collectSecurityAlerts(),
      }, null, 2));
    } catch { /* status file is best-effort; never break the watcher */ }
  }

  // Finding a breach is the watcher doing its job — exit 0. But a due alert that FAILED TO DELIVER
  // is an execution failure (Sol amendment to F5, 2026-07-18): this watcher's one real job is the
  // page, and if the page didn't go out, "ok" would be asserted, not derived. Exit 1 so the
  // heartbeat records the failure and the wrapper's own channel escalates — that duplicate-looking
  // page IS the correct behavior when the primary page provably never left the building.
  const undeliveredAlert = !dryRun && (output.alertsSent || []).some((a) => !a.sent && a.reason !== 'dry-run');
  // Skipping one unreadable issue is a degraded run, not a failed one; reading NONE of them is a failure.
  const allDegraded = output.degraded.length > 0 && output.results.length === 0;
  if (output.degraded.length) console.error(`issue-watch: ${output.degraded.length} issue(s) not fully readable this run: #${output.degraded.join(', #')}`);
  const stuck = !dryRun && (output.unreadable || []).length > 0;
  if (stuck) console.error(`issue-watch: FAILING this run once — a person's issue has been unreadable ${UNREADABLE_RUNS} runs in a row and cannot be judged: #${output.unreadable.join(', #')}`);
  process.exit(undeliveredAlert || allDegraded || stuck ? 1 : 0);
}

if (isDirectInvocation(import.meta.url)) await main();
