#!/usr/bin/env node
/**
 * API SPEND WATCHDOG — the alarm that should have caught the 2026-07-09 incident.
 *
 * On 2026-07-09 an agentic-qe fleet spawned 374+ headless agents (one every
 * ~105s for 11h), each calling Sonnet on the Anthropic API, burning ~$1,600 —
 * silently, while a paid Max subscription sat unused. Nothing alerted. This is
 * the missing alarm.
 *
 * TWO independent detectors, so it works WITH or WITHOUT an admin key:
 *
 *   1. BURST DETECTOR (no key needed — would have caught the exact failure):
 *      scans every project's .claude-flow/logs/headless/ for agent logs created
 *      in the last window. A flood of automated agents is the signature of a
 *      runaway fleet billing the API. Alerts past a threshold.
 *
 *   2. ANTHROPIC ADMIN COST (definitive $, needs ANTHROPIC_ADMIN_KEY):
 *      pulls today's spend from the Admin Cost API. Alerts if it crosses the
 *      dollar threshold. This is the real-money source of truth.
 *
 * Alerts go to ntfy (phone) + macOS desktop, and are rate-limited so a genuine
 * runaway doesn't spam. Config via env:
 *   AIE_NTFY_TOPIC          ntfy topic (else the first line of ~/.cache/ruvnet-brain/ntfy-topic; else none)
 *   SPEND_ALERT_USD         daily $ threshold (default 50)
 *   SPEND_BURST_AGENTS      agents/hour that trips the burst alarm (default 20)
 *   ANTHROPIC_ADMIN_KEY     admin key for the $ detector (optional)
 *   SPEND_SCAN_ROOTS        colon-separated project roots to scan (default ~/Code)
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const HOME = homedir();
const STATE_DIR = join(HOME, '.claude', 'logs');
const LAST_ALERT = join(STATE_DIR, 'api-spend-watchdog-last.ts');
const ALERTS_LOG = join(STATE_DIR, 'api-spend-ALERTS.log');
mkdirSync(STATE_DIR, { recursive: true });

const THRESHOLD_USD = Number(process.env.SPEND_ALERT_USD || 50);
const BURST_AGENTS = Number(process.env.SPEND_BURST_AGENTS || 20);
const COOLDOWN_MS = 60 * 60 * 1000; // one alert/hour max
const ROOTS = (process.env.SPEND_SCAN_ROOTS || join(HOME, 'Code')).split(':');

// Resolve the ntfy topic from config this tool owns. Nothing else.
//
// This used to also read `~/Code/All In Expert/.env` — the maintainer's own unrelated project's
// secrets file — as a fallback. On any other machine that is a failed read of a file that isn't
// theirs, so it bought nothing; but "hourly background job reads another project's .env and POSTs
// to an anonymous relay" is a sentence no corporate security review survives, and every EDR scores
// .env access as credential theft. Removed: own env var, own config file, or no topic at all.
function ntfyTopic() {
  if (process.env.AIE_NTFY_TOPIC) return process.env.AIE_NTFY_TOPIC;
  for (const f of [join(HOME, '.cache', 'ruvnet-brain', 'ntfy-topic')]) {
    try {
      const line = readFileSync(f, 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#'));
      if (line) return line.trim();
    } catch {}
  }
  return '';
}

// An HTTP header must be a ByteString: one non-ASCII character (an em dash, an emoji) makes fetch THROW
// "Cannot convert argument to a ByteString" before anything is sent, and the catch below hid it, so the
// phone page silently never left the machine (the nightly watchdog's and brain-alarm's titles, 4.7.21).
// Every title below is plain ASCII; this keeps a future edit from reintroducing the silent drop.
const asciiHeader = (text) => String(text).replace(/[^\x20-\x7e]/g, '-');

function ts() {
  return new Date().toISOString();
}

// `stamp` is the cooldown this alert reads and earns. Money and failure alarms share LAST_ALERT; the admin-key
// "works again" note has its own (review round 2, Opus #4): it used to earn the shared hour, so a spend-over-threshold
// alert in the same run was held back by the cooldown a reassurance note had just started.
async function alert(title, body, stamp = LAST_ALERT) {
  // rate limit
  try {
    if (existsSync(stamp)) {
      const last = Date.parse(readFileSync(stamp, 'utf8').trim());
      if (Date.now() - last < COOLDOWN_MS) {
        console.log(`[watchdog] would alert but in cooldown: ${title}`);
        return;
      }
    }
  } catch {}
  try {
    writeFileSync(ALERTS_LOG, `[${ts()}] ${title} — ${body}\n`, { flag: 'a' });
  } catch {}
  console.error(`[watchdog] ALERT: ${title} — ${body}`);
  // DERIVED, not asserted (F10a, 2026-07-18): the cooldown stamp is written only AFTER an alert
  // channel actually delivered. The old code stamped BEFORE attempting delivery — so ntfy+osascript
  // both failing still started the 1h cooldown, and a money alarm was silently swallowed for an hour
  // at a time. Delivery = ntfy accepted (HTTP ok) OR the local macOS notification fired. If neither
  // delivered: no cooldown (next run retries) and this run exits degraded so the failure is visible.
  let delivered = false;
  const topic = ntfyTopic();
  if (topic) {
    try {
      const r = await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { Title: asciiHeader(title), Priority: 'urgent', Tags: 'rotating_light,money_with_wings' },
        body,
      });
      if (r.ok) delivered = true;
    } catch {}
  }
  try {
    // execFile with an arg array — no shell, so title/body can't be interpreted.
    execFileSync('osascript', ['-e',
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify('⚠️ ' + title)} sound name "Basso"`]);
    delivered = true;
  } catch {}
  if (delivered) writeFileSync(stamp, ts());
  else {
    console.error('[watchdog] ALERT DELIVERY FAILED on every channel — no cooldown recorded, next run retries; exiting degraded');
    process.exitCode = 1;
  }
  return delivered;
}

// ─── Detector 1: headless-agent burst (no key needed) ────────────────────────
function countRecentAgents(windowMs = 60 * 60 * 1000) {
  let count = 0;
  const cutoff = Date.now() - windowMs;
  const seen = [];
  let rootsRead = 0; // F10b: a blind scanner must not report "healthy" — count what we could read
  for (const root of ROOTS) {
    let projects = [];
    try {
      projects = readdirSync(root).map((p) => join(root, p));
      rootsRead++;
    } catch {
      continue;
    }
    for (const proj of projects) {
      // .claude-flow/logs/headless can be nested (web/src/... etc). Walk shallowly.
      for (const sub of ['.claude-flow/logs/headless', 'web/src/.claude-flow/logs/headless', 'web/src/app/.claude-flow/logs/headless']) {
        const dir = join(proj, sub);
        if (!existsSync(dir)) continue;
        try {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith('.log')) continue;
            const m = statSync(join(dir, f)).mtimeMs;
            if (m >= cutoff) {
              count++;
              if (seen.length < 3) seen.push(proj.split('/').pop() + '/' + f);
            }
          }
        } catch {}
      }
    }
  }
  return { count, seen, rootsRead };
}

// ─── Detector 2: Anthropic Admin Cost (definitive $) ─────────────────────────
async function todaySpendUsd(adminKey) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start.toISOString()}`;
  try {
    const r = await fetch(url, { headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' } });
    if (!r.ok) return { ok: false, reason: `http_${r.status}` };
    const j = await r.json();
    // Sum amounts across the report (shape tolerant).
    let total = 0;
    const walk = (o) => {
      if (o == null) return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (/amount|cost|usd|total/i.test(k) && typeof v === 'number') total += v;
          else walk(v);
        }
      }
    };
    walk(j);
    return { ok: true, usd: total };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────
const { count, seen, rootsRead } = countRecentAgents();
console.log(`[watchdog] headless agents in last hour: ${count} (threshold ${BURST_AGENTS})`);
// DERIVED, not asserted (F10b): count 0 with ZERO readable roots is blindness, not health — the old
// code swallowed every readdir error and reported "healthy" with no scanning capability at all.
if (rootsRead === 0) {
  console.error('[watchdog] burst detector is BLIND — could not read any project root; exiting degraded');
  process.exitCode = 1;
}
if (count >= BURST_AGENTS) {
  await alert(
    'RUNAWAY AGENT FLEET - check your API bill',
    `${count} automated agents spawned in the last hour (e.g. ${seen.join(', ')}). This is the signature that burned ~$1,600 on 2026-07-09. Kill the fleet / check console spend.`
  );
}

// ─── Detector 3: silently-failing scheduled jobs (no key needed) ─────────────
// A launchd job that exits non-zero leaves no trace unless it configured a log —
// most don't. This surfaces the exact class that hid the All-In pipeline outage
// AND that leaves 5 of this machine's jobs quietly broken. Intelligence added,
// nothing taken away: your automation keeps running; it just can't fail in silence.
try {
  const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
  const mine = /^(com\.ruvnet|ai\.askruvnet|com\.stuartkerr|com\.isovision)\./;
  // 2026-10-25 flood fix (owner: 31 consecutive hourly pages, 2,157 alert lines): this detector paged EVERY HOUR for as long
  // as any job's last exit was non-zero, and the nightly watchdog exits non-zero by design whenever anything is red, so
  // it never cleared. Two rules now: (1) a job wrapped by scripts/job-heartbeat.sh (it has a receipt in the heartbeat
  // dir) already pages once on failure and once on recovery, so it is not this detector's business; (2) for the rest,
  // page only when a job NEWLY joins the failing set, never repeatedly for one that is still failing.
  const HB_DIR = join(HOME, '.cache', 'ruvnet-brain', 'heartbeats');
  const FAIL_STATE = join(STATE_DIR, 'api-spend-failing-jobs.json');
  const wrapped = (label) => existsSync(join(HB_DIR, `${label}.json`));
  const failing = out.split('\n').slice(1)
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 3 && mine.test(c[2]) && c[1] !== '0' && c[1] !== '-' && c[0] === '-' && !wrapped(c[2]))
    // c[0] === '-' : not running right now. A job that IS running (a KeepAlive daemon) is not failing; its last-exit is history.
    .map((c) => ({ label: c[2], text: `${c[2]} (exit ${c[1]})` }));
  console.log(`[watchdog] failing scheduled jobs (unwrapped): ${failing.length}`);
  let previous = [];
  try { previous = JSON.parse(readFileSync(FAIL_STATE, 'utf8')); } catch {}
  if (!Array.isArray(previous)) previous = [];
  const labels = failing.map((f) => f.label).sort();
  const fresh = failing.filter((f) => !previous.includes(f.label));
  if (fresh.length > 0) {
    const delivered = await alert(
      `${fresh.length} scheduled job(s) newly failing silently`,
      `These launchd jobs just started exiting non-zero and are not watched by the heartbeat wrapper: ${fresh.slice(0, 6).map((f) => f.text).join('; ')}. Check them before they cost you.`
    );
    // Remember them only once the page really went out, so a failed or cooled-down delivery retries next run.
    if (delivered) writeFileSync(FAIL_STATE, JSON.stringify(labels));
    else writeFileSync(FAIL_STATE, JSON.stringify(labels.filter((l) => previous.includes(l))));
  } else {
    writeFileSync(FAIL_STATE, JSON.stringify(labels)); // recovered jobs drop out, so a later re-failure pages again
  }
} catch {
  /* launchctl unavailable — skip */
}

const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
// Admin-key health is a TRANSITION, like detector 3 (4.7.21 review): a dead key paged on every hourly run, ~24 pages a
// day until rotated. Now: one page when the key goes working -> dead, one note when it comes back, and the run still exits
// 1 every hour while it is dead, so the heartbeat wrapper's single streak page and the watchdog keep seeing it.
// The state flips only once the page really went out, so a failed or cooled-down delivery is retried next run.
const KEY_STATE = join(STATE_DIR, 'api-spend-admin-key.json');
let keyWasDead = false;
try { keyWasDead = JSON.parse(readFileSync(KEY_STATE, 'utf8')).dead === true; } catch {}
const saveKeyState = (dead) => writeFileSync(KEY_STATE, JSON.stringify({ dead, at: ts() }));
const KEY_NOTE_STAMP = join(STATE_DIR, 'api-spend-key-recovered-last.ts');
if (adminKey) {
  const s = await todaySpendUsd(adminKey);
  if (s.ok) {
    console.log(`[watchdog] Anthropic API spend today: $${s.usd.toFixed(2)} (threshold $${THRESHOLD_USD})`);
    if (keyWasDead) {
      const delivered = await alert('ANTHROPIC_ADMIN_KEY works again - the $ spend detector is back',
        'cost_report answered again; the definitive spend alarm is watching.', KEY_NOTE_STAMP);
      if (delivered) saveKeyState(false);
    }
    if (s.usd >= THRESHOLD_USD) {
      await alert(
        `API spend today = $${s.usd.toFixed(2)}`,
        `Anthropic API spend crossed $${THRESHOLD_USD} today while you have a paid Max plan. Check console → Cost → group by API key.`
      );
    }
  } else if (/^http_40[13]$/.test(s.reason || '')) {
    // DERIVED, not asserted (F10c): a 401/403 on the admin key means the DEFINITIVE $ detector is
    // dead — the old code logged one line and exited 0 forever, a permanently green job with its
    // main sensor dark. A dead key is its own alarm (key-canary class) and a degraded exit.
    if (keyWasDead) {
      console.error(`[watchdog] ANTHROPIC_ADMIN_KEY still dead (${s.reason}); already paged, exiting degraded`);
    } else {
      const delivered = await alert(
        'ANTHROPIC_ADMIN_KEY is DEAD - the $ spend detector is dark',
        `cost_report returned ${s.reason}. The definitive spend alarm cannot see anything until the key is rotated. Burst detector still active, but it is the weaker signal.`
      );
      if (delivered) saveKeyState(true);
    }
    process.exitCode = 1;
  } else {
    console.log(`[watchdog] admin cost check unavailable: ${s.reason}`);
  }
} else {
  console.log('[watchdog] ANTHROPIC_ADMIN_KEY not set — $ detector idle; burst detector still active.');
}
