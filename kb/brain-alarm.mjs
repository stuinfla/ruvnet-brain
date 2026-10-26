// brain-alarm.mjs — the GONG. When retrieval itself breaks, this makes the failure IMPOSSIBLE to miss.
//
// Born 2026-07-12: the brain went completely dark (node_modules wiped — every repo erroring) and
// search_ruvnet reported it as an innocent "(no results)" for an unknown number of days. Stuart's
// standing order: "big gonging things flashing all over the place — that can NEVER happen silently."
//
// This module is the shared alarm plumbing behind three independent gong layers:
//   1. REAL-TIME  — forge-mcp-all.mjs / forge-ask-all.mjs call reportBrainDown() the moment a
//                   total-failure search happens (all repos erroring ≠ empty result).
//   2. PER-SESSION — plugin/scripts/session-start.sh reads health.json (written here) plus its own
//                   structural checks, and flashes a banner in EVERY new Claude Code session.
//   3. NIGHTLY    — scripts/nightly-wrapper.sh runs a canary query; a non-zero exit (which
//                   forge-ask-all now guarantees on total failure) triggers an urgent phone push.
//
// Contract: NEVER throws, NEVER blocks a healthy query. Alarm failure must not break search —
// but search failure must always ring the alarm.
//
// Phone push: sent via ntfy when a topic is discoverable (NTFY_TOPIC env, or a one-line
// ~/.cache/ruvnet-brain/ntfy-topic file). No topic → no push (public installs stay quiet), but
// health.json is ALWAYS written, so the session-start banner still gongs on every machine.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.cache', 'ruvnet-brain');
export const HEALTH_PATH = path.join(STATE_DIR, 'health.json');
// PAGE DAMPING (4.7.21). The pages below never left the machine before 4.7.21 (an emoji Title made fetch() throw
// before sending), so these rules were never exercised. Now that pages arrive, a flapping brain must not flap the
// phone: DOWN pages only after two failures at least 5 min apart, at most once per 6 h (remembered across "up"
// states), and a recovery is announced only for a DOWN page that was delivered and an outage of 10 min or more.
const MIN = 60_000;
const DOWN_CONFIRM_MS = 5 * MIN;
const DOWN_PAGE_GAP_MS = 6 * 60 * MIN;
const RECOVERY_MIN_OUTAGE_MS = 10 * MIN;
// FLAPPING (4.7.21 review): every "up" reset the outage, so a brain failing every few minutes with a good search in
// between never met the 5-min confirm rule and never paged. Failures are also counted across "ok" states inside this
// window: two failures 5+ min apart within an hour page DOWN (still at most once per 6 h).
const FLAP_WINDOW_MS = 60 * MIN;
const MAX_RECENT = 50;
// ONE PAGER AT A TIME (4.7.21 review): parallel failing searches all read downPaged:false before any of them finished
// its (up to 10 s) POST, so one outage paged two or three times. The read-decide-write of health.json now runs under an
// exclusive lock file and the page is CLAIMED (lastDownPageAt = now) before sending, then rolled back if not delivered.
const LOCK_PATH = path.join(STATE_DIR, 'health.lock');
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8')); } catch { return null; }
}

function writeHealth(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Atomic replace: a concurrent reader never sees half a file (which it would read as "no state").
    const tmp = `${HEALTH_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, HEALTH_PATH);
  } catch { /* the alarm must never throw */ }
}

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ } };

/** Run fn() holding the health lock (cross-process). The critical sections are synchronous file edits, held for
 *  milliseconds; a lock older than LOCK_STALE_MS was left by a killed process and is taken over. If the lock cannot be
 *  had within LOCK_WAIT_MS, fn runs with locked=false: state is still written (the banner must gong), no page is sent. */
function withLock(fn) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* writeHealth reports nothing either */ }
  let locked = false;
  // Bounded by attempts, not the clock (a frozen or skewed clock must not spin forever).
  for (let attempt = 0; !locked && attempt <= LOCK_WAIT_MS / 5; attempt++) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      locked = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_PATH); continue; } } catch { continue; }
      sleepSync(5);
    }
  }
  if (!locked) return fn(false);
  try { return fn(true); } finally { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } }
}

// A claim whose sender died mid-POST (the push times out at 10 s) must not swallow the page for 6 h.
const CLAIM_STALE_MS = 60_000;

// The list is bounded, but its OLDEST in-window failure is the flap anchor and is always kept (review round 2, Codex r4
// #5): keeping only the newest 50 meant a failure every few seconds never spanned 5 minutes, so it never paged.
const recentFails = (prev, now) => {
  const fails = (Array.isArray(prev?.recentFails) ? prev.recentFails : [])
    .map(Number).filter((t) => Number.isFinite(t) && now - t < FLAP_WINDOW_MS && t <= now).sort((a, b) => a - b);
  return fails.length > MAX_RECENT ? [fails[0], ...fails.slice(-(MAX_RECENT - 1))] : fails;
};
const boundFails = (fails) => (fails.length > MAX_RECENT ? [fails[0], ...fails.slice(-(MAX_RECENT - 1))] : fails);

// A page claim lives beside the up/down status, never inside it (review round 2, Codex r4 #4): an "ok" record written
// while a DOWN page is in flight keeps the claim, so the sender's settle step can still release or confirm it, and a
// claim whose sender died is released by the next failure whatever the status was in between.
const claimOf = (rec) => (rec?.downPaged === 'pending'
  ? { at: Number(rec.lastDownPageAt) || 0, prevPageAt: Number(rec.claimPrevPageAt) || 0, outageStart: Number(rec.claimOutageStart) || 0 }
  : null);
const withClaim = (rec, claim) => (claim
  ? { ...rec, downPaged: 'pending', claimPrevPageAt: claim.prevPageAt, claimOutageStart: claim.outageStart }
  : rec);

function ntfyTopic() {
  // Set-but-EMPTY is an explicit opt-out (job-heartbeat.sh's convention): never fall through to the topic file.
  if (process.env.NTFY_TOPIC !== undefined) return process.env.NTFY_TOPIC.trim() || null;
  try {
    const t = fs.readFileSync(path.join(STATE_DIR, 'ntfy-topic'), 'utf8').trim();
    if (t) return t;
  } catch { /* no topic file — push disabled, banner still gongs */ }
  return null;
}

/** Delivered means a 2xx. The Title is plain ASCII (an HTTP header must be a ByteString); Tags carry the emoji. */
async function push(title, message, priority = 'urgent', tags = 'rotating_light') {
  const topic = ntfyTopic();
  if (!topic) return false;
  const base = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: String(title).replace(/[^\x20-\x7e]+/g, ' ').trim(), Priority: priority, Tags: tags },
      body: message,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Ring the gong: the brain failed a real search (total failure — retrieval itself is broken).
 * Writes health.json on EVERY call (the session-start banner is never damped) and pages per the rules above.
 * Never throws. Await it from a CLI that is about to exit; fire-and-forget from a server.
 */
export async function reportBrainDown({ error, source }) {
  try {
    const now = Date.now();
    const claim = withLock((locked) => {
      const prev = readHealth();
      const continuing = prev?.status === 'down';
      const firstDownTs = continuing ? (prev.firstDownTs || now) : now;
      const failCount = continuing ? (Number(prev.failCount) || 1) + 1 : 1;
      let lastDownPageAt = Number(prev?.lastDownPageAt) || (continuing ? Number(prev.lastNtfyTs) || 0 : 0);
      let pending = claimOf(prev); // whatever the status: a recovery in between does not settle a claim
      if (pending && now - pending.at > CLAIM_STALE_MS) { // abandoned claim (its sender died): undo it
        lastDownPageAt = pending.prevPageAt; pending = null;
      }
      const fails = boundFails([...recentFails(prev, now), now]);
      const health = withClaim({
        status: 'down',
        error: String(error || 'unknown').slice(0, 500),
        source: source || 'unknown',
        ts: new Date(now).toISOString(),
        firstDownTs,
        failCount,
        recentFails: fails,
        lastDownPageAt,
        downPaged: continuing && prev.downPaged === true,
        fix: 'cd ~/.cache/ruvnet-brain/kb && npm i   — then verify: npx github:stuinfla/ruvnet-brain --doctor',
      }, pending);
      const sustained = failCount >= 2 && now - firstDownTs >= DOWN_CONFIRM_MS;
      const flapping = fails.length >= 2 && now - fails[0] >= DOWN_CONFIRM_MS;
      const due = locked && !health.downPaged && (sustained || flapping) && now - lastDownPageAt >= DOWN_PAGE_GAP_MS;
      if (due) { // the claim
        Object.assign(health, withClaim({ lastDownPageAt: now }, { prevPageAt: lastDownPageAt, outageStart: firstDownTs }));
      }
      writeHealth(health);
      return due ? { previousPageAt: lastDownPageAt, health } : null;
    });
    if (!claim) return;
    const { health } = claim;
    const sent = await push(
      'RuvNet Brain is DOWN',
      `Every repo failed to search (source: ${health.source}). This is NOT an empty result — retrieval itself is broken.\n`
      + `First error: ${health.error.slice(0, 200)}\n`
      + `Fix: ${health.fix}`,
    );
    const recovered = withLock(() => {
      const cur = readHealth();
      if (!cur || Number(cur.lastDownPageAt) !== now || cur.downPaged !== 'pending') return null; // superseded
      const outageStart = Number(cur.claimOutageStart) || Number(health.firstDownTs) || now;
      delete cur.claimPrevPageAt; delete cur.claimOutageStart;
      if (sent) {
        cur.downPaged = cur.status === 'down';
      } else {
        cur.lastDownPageAt = claim.previousPageAt; // undelivered: release the claim so the next failure retries
        cur.downPaged = false;
      }
      if (cur.status === 'down') { writeHealth(cur); return null; }
      delete cur.downPaged; // an "ok" record carries no paged flag, only the 6 h memory
      writeHealth(cur);
      // The brain came back while this DOWN page was in flight (review round 2, Opus #8): reportBrainUp could not
      // announce a page it did not know had arrived, so the recovery note is sent here, under the same rules.
      const upAt = Date.parse(cur.ts) || now;
      return sent && upAt - outageStart >= RECOVERY_MIN_OUTAGE_MS ? cur : null;
    });
    if (recovered) {
      await push('RuvNet Brain recovered', `Searches are working again (source: ${recovered.source || 'unknown'}).`, 'default', 'white_check_mark');
    }
  } catch { /* never */ }
}

/**
 * All-clear: a real search succeeded with zero repo errors. Only writes on a down→ok transition
 * (no write churn on every healthy query). The 6 h DOWN-page memory and the recent failures survive the "ok" record.
 */
export async function reportBrainUp({ source } = {}) {
  try {
    const peek = readHealth();
    if (!peek || peek.status !== 'down') return;
    const now = Date.now();
    const prev = withLock(() => {
      const cur = readHealth();
      if (!cur || cur.status !== 'down') return null;
      writeHealth(withClaim({ status: 'ok', ts: new Date(now).toISOString(), recoveredFrom: cur.error, source: source || 'unknown',
        lastDownPageAt: Number(cur.lastDownPageAt) || 0, recentFails: recentFails(cur, now) }, claimOf(cur)));
      return cur;
    });
    if (prev && prev.downPaged === true && now - (Number(prev.firstDownTs) || now) >= RECOVERY_MIN_OUTAGE_MS) {
      await push('RuvNet Brain recovered', `Searches are working again (source: ${source || 'unknown'}).`, 'default', 'white_check_mark');
    }
  } catch { /* never */ }
}

/** Classify a searchAll() perRepo map: which repos errored, and is this a TOTAL failure? */
export function classifyPerRepo(perRepo, repos) {
  const errors = Object.entries(perRepo || {}).filter(([, v]) => typeof v === 'string' && v.startsWith('ERR:'));
  return {
    errors,
    total: repos?.length || 0,
    allFailed: repos?.length > 0 && errors.length === repos.length,
  };
}
