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
const STATE_PATH = process.env.ISSUE_WATCH_STATE
  || path.join(os.homedir(), '.claude', 'ruvnet-brain', 'issue-watch-state.json');
// A compact, always-current snapshot the SessionStart hook surfaces (2026-07-17). ntfy alerts are
// easy to miss — issues stacked unseen for 29h precisely because the only channel was the phone.
// The session banner is a channel the maintainer cannot miss; this file is how it learns the count.
const STATUS_PATH = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'open-issues.json');
const GH_BIN = process.env.GH_BIN || 'gh';

function ghJson(args) {
  // Retry ONCE on a transient network-shaped failure (2026-07-19, same class as issue-fix's 1am
  // "TLS handshake timeout" page): 20s of patience absorbs a blip; a second failure still fails
  // LOUD. Bounded, logged, never silent.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = spawnSync(GH_BIN, args, { encoding: 'utf8' });
    if (res.status === 0) return JSON.parse(res.stdout);
    const err = (res.stderr || res.stdout || '').trim();
    lastErr = new Error(`gh ${args.join(' ')} failed (exit ${res.status}): ${err}`);
    const transient = /TLS handshake|unexpected EOF|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection refused|temporarily unavailable/i.test(err);
    if (attempt === 1 && transient) {
      console.error(`issue-watch: transient gh/network failure (${err.slice(0, 90)}) — retrying once in 20s`);
      spawnSync('sleep', ['20']);
      continue;
    }
    break;
  }
  throw lastErr;
}

/** Resolve the ntfy topic the same way the rest of the repo does: env, then the machine-wide
 * cache file, then the repo .env — see scripts/notify.sh / scripts/job-heartbeat.sh / scripts/nightly-watchdog.mjs. */
function resolveTopic() {
  if (process.env.NTFY_TOPIC) return process.env.NTFY_TOPIC;
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
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: tags },
      body,
    });
    return res.ok;
  } catch {
    return false; // alerting must never break the job — fail-silent, matching scripts/notify.sh
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
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
    'number,title,createdAt,comments,updatedAt']);

  const state = loadState();
  const results = [];
  const alertsSent = [];

  for (const issue of issues) {
    const detail = ghJson(['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments']);
    const { ageHours, ownerComment, breach } = judgeIssue(issue, detail.comments || [], now);
    const url = `https://github.com/${repo}/issues/${issue.number}`;
    const key = String(issue.number);
    const last = state[key]?.lastAlertAt ? Date.parse(state[key].lastAlertAt) : null;
    const dueForAlert = breach && (!last || (now - last) / 3_600_000 >= SLA_HOURS);
    // First sighting → page once, immediately (rule 2 in the header). Delivery-derived like
    // lastAlertAt: state is only written when the push actually went out, so a failed push
    // retries next run instead of burying the sighting.
    const firstSighting = !state[key];

    results.push({ number: issue.number, title: issue.title, ageHours, ownerComment, breach, dueForAlert, firstSighting, url });

    if (firstSighting) {
      if (dryRun) {
        alertsSent.push({ number: issue.number, sent: false, kind: 'new-issue', reason: 'dry-run' });
      } else {
        const topic = resolveTopic();
        let sent = false;
        if (topic) sent = await pushNtfy(topic, {
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
        let ackAt = null;
        const ackBody = `🤖 Automated acknowledgment — received and opened. The maintainer has been paged and this is being worked. The next update here will be a fix, findings, or the maintainer in person.`;
        const ack = spawnSync(GH_BIN, ['issue', 'comment', String(issue.number), '--repo', repo, '--body', ackBody], { encoding: 'utf8' });
        if (ack.status === 0) ackAt = new Date(now).toISOString();
        if (sent || ackAt) state[key] = { firstSeenAt: new Date(now).toISOString(), ...(sent ? { newAlertAt: new Date(now).toISOString() } : {}), ...(ackAt ? { ackAt } : {}), title: issue.title, url };
        alertsSent.push({ number: issue.number, sent, acked: Boolean(ackAt), kind: 'new-issue', reason: topic ? null : 'no ntfy topic configured' });
      }
    }

    if (dueForAlert) {
      const title = `SLA breach: issue #${issue.number}`;
      const body = `${issue.title}\nopen ${fmtAge(ageHours)}, no response from ${OWNER_LOGIN}\n${url}`;
      if (dryRun) {
        alertsSent.push({ number: issue.number, sent: false, reason: 'dry-run' });
      } else {
        const topic = resolveTopic();
        let sent = false;
        if (topic) sent = await pushNtfy(topic, { title, body, priority: 'urgent', tags: 'rotating_light,warning' });
        // DERIVED, not asserted (F5, 2026-07-18): lastAlertAt may only be written when the page was
        // actually DELIVERED (sent===true). The old line stamped it unconditionally, so a breach whose
        // push failed (ntfy down, no topic) was suppressed for the whole 4h cooldown — the alert ledger
        // asserted a delivery it never verified. A failed attempt records itself as failed and the next
        // hourly run retries; the ledger can no longer claim a page that didn't happen.
        // Spread-merge, never overwrite: the record may already carry firstSeenAt/newAlertAt from
        // the first-sighting page above — clobbering them would re-page "new" forever (the exact
        // state-erasure class that broke issue-fix's comment dedup, 2026-07-24).
        if (sent) state[key] = { ...(state[key] || {}), lastAlertAt: new Date(now).toISOString(), title: issue.title, url };
        else state[key] = { ...(state[key] || {}), lastAttemptAt: new Date(now).toISOString(), sent: false, title: issue.title, url };
        alertsSent.push({ number: issue.number, sent, kind: 'sla-breach', reason: topic ? null : 'no ntfy topic configured' });
      }
    }
  }

  if (!dryRun) saveState(state);

  return { results, alertsSent, checkedAt: new Date(now).toISOString() };
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
      } else if (r.breach) {
        console.log(`   already alerted within the last ${SLA_HOURS}h — not repeating`);
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
  process.exit(undeliveredAlert ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
