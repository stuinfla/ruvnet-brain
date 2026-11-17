#!/usr/bin/env node
// scripts/search-canary.mjs — IS SEARCH ACTUALLY WORKING? Asked every 5 minutes, answered by evidence.
//
// WHY (owner, 2026-11-16): a Homebrew upgrade at 3:31 a.m. broke the node every long-running MCP shell
// spawned its search worker with, and every search_ruvnet call failed for hours with nobody told. "If
// search is not working and not delivering searches it must tell me immediately."
//
// Two tiers, so the 5-minute cadence stays a second or two of CPU:
//   CHEAP (every run)  the live MCP shells' own readiness records (a shell whose worker cannot START is
//                      `degraded` in phase initialize / warmup / node-runtime — the stale-long-running-server
//                      case), a fresh startup/timeout outage in health.json, and a usable node on this machine.
//   DEEP  (hourly, and at once whenever a cheap check fails or the last verdict was DOWN)  a REAL search
//                      through a FRESH copy of the installed plugin's server.mjs, exactly as a session starts
//                      it; the answer must be non-empty and cite a repo + source path.
// A dead worker pid on a `ready` record is NOT a failure: workers retire after 30 idle minutes by design.
//
// The reader that matters is the AI session: the state file this writes is what SessionStart and EVERY prompt
// read (plugin/scripts/search-down-notice.mjs) to put "RUVNET BRAIN SEARCH IS DOWN since ... ET. Diagnose and
// fix it before other work" and its runbook in front of the model, until a run judges search OK again.
// ntfy is optional: with no topic configured nothing is sent and nothing counts as failed.
// Alerts: DOWN on 2 consecutive failing runs -> "SERIOUS ALERT: RuvNet Brain search down" (ntfy urgent, plus
// e-mail through ntfy when a token is configured); repeated at most hourly while down; one recovery notice;
// one low-priority "search OK" heartbeat a day so silence can never hide a dead canary. E-mail is sent only
// for the first alert and the recovery (ntfy.sh allows 5 e-mails a day).
//
// Exit: 0 judged and every due message delivered (a DOWN verdict is the canary working, not failing — a
// nonzero exit would make job-heartbeat.sh page a second, misleading "SCHEDULED JOB FAILED");
// 1 a due message was not delivered, or an internal error; 75 another run holds the lock (a skip).
//
//   node scripts/search-canary.mjs                 # judge, alert on transitions
//   node scripts/search-canary.mjs --json --no-push   # judge and print, nothing sent
//   node scripts/search-canary.mjs --deep          # force the real search this run (--cheap: never this run)
//   node scripts/search-canary.mjs --test-alert    # send ONE labelled TEST alert (ntfy + e-mail), no state change
// RUVNET_BRAIN_CANARY_INJECT=down  fault injection: every check reports DOWN without reading or touching the
//                                  live health or readiness files (to prove the alert path, never an outage).
//                                  The shared state file is not written, so no other session sees it; the
//                                  session hooks read the same variable from their own environment instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isAlive, readAll } from '../plugin/scripts/mcp-readiness.mjs';
import { nodeCandidates, selfTest } from '../plugin/scripts/node-runtime.mjs';
import { lfLineReader } from '../plugin/scripts/lf-lines.mjs';
import { downFlagPath, recordIsLive } from '../plugin/scripts/search-down-notice.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';
import { ntfyTopic, push } from './nightly-watchdog.mjs';

const HOME = os.homedir();
const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(HOME, '.cache', 'ruvnet-brain');
export const STATE_FILE = process.env.SEARCH_CANARY_STATE || path.join(BRAIN_HOME, 'search-canary.json');
export const ALERT_TITLE = 'SERIOUS ALERT: RuvNet Brain search down';
const MIN = 60_000;
const REPEAT_MS = 60 * MIN;
const DEEP_EVERY_MS = 60 * MIN;
// While something looks wrong the real search re-runs at most this often: a stale degraded session must not
// load a multi-GB worker every 5 minutes, indefinitely.
const DEEP_RETRY_MS = 15 * MIN;
// Inside the plist's JOB_MAX_SECONDS (280 s) with room for the cheap tier and two 10 s deliveries, so a slow
// machine's deep search is a DOWN verdict the canary records, not a run job-heartbeat kills half-way.
const DEEP_TIMEOUT_MS = Number(process.env.SEARCH_CANARY_DEEP_TIMEOUT_MS) || 150_000;
const STARTUP_PHASES = new Set(['initialize', 'warmup', 'node-runtime']);
const CANARY_QUERY = 'What package name is declared in the RuvNet Brain KB package manifest?';

/** Eastern, 12-hour, with zone — the owner's rule for every time he is told. */
export const eastern = (ms) => `${new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
const easternDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const easternHour = (ms) => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * The cheap tier. Returns failures ({ what, check, recorded?, retriable? }); empty means nothing cheap is wrong.
 *   recorded   a past event (health.json), superseded by a real search that answers this run
 *   retriable  a session server that failed to start but retries on its next search with a node that runs
 *              now; only a real search that answers (judge) downgrades it to a note — a working node alone
 *              does not prove that session's worker will start
 */
export async function cheapChecks({ brainHome = BRAIN_HOME, now = Date.now(), env = process.env } = {}) {
  const failures = [], notes = [];
  // A session starts the server as `node` from ITS PATH, which this launchd job cannot see; the canary's own
  // PATH (plist) and the server's fallback chain stand in for it. The first candidate that runs is used.
  const pathNodes = String(env.PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d)).map((d) => path.join(d, 'node'));
  const candidates = [...new Set([...pathNodes, ...nodeCandidates({ env })])].filter((f) => fs.existsSync(f));
  const chain = { usable: [], rejected: [] };
  for (const node of candidates) {
    const r = await selfTest(node);
    if (r.ok) { chain.usable.push({ node, version: r.version }); break; }
    chain.rejected.push({ node, reason: r.reason });
  }
  for (const r of readAll(brainHome)) {
    if (r.state !== 'degraded' || !STARTUP_PHASES.has(r.phase)) continue;
    // A reused pid is not that server: never judge (or run) another process's executable.
    if (!recordIsLive(r.pid, Date.parse(r.at || ''), { now })) continue;
    // A pre-fix shell retries with the node it was launched under; a post-fix shell (phase node-runtime, or
    // any phase once its chain is in place) retries through the fallback chain, which a usable node satisfies.
    // A pre-fix shell whose own node cannot be identified (no lsof, a timeout under load) or is deleted is
    // DOWN, never retriable: nothing proves its next search can start a worker.
    let own = null;
    let runsNow;
    if (r.phase !== 'node-runtime') {
      const exe = serverNode(r.pid);
      own = exe?.path || null;
      if (own && !/^node(?:\.exe)?$/i.test(path.basename(own))) continue; // not a node process: not our server
      runsNow = Boolean(own) && !exe.deleted && (await selfTest(own)).ok;
    } else runsNow = chain.usable.length > 0;
    failures.push({ what: `a running session's search server (pid ${r.pid}) cannot start its search worker (${r.phase}: ${String(r.error || 'no reason recorded').slice(0, 300)})${own && !runsNow ? `; its node ${own} fails to run` : ''}`,
      check: `restart the Claude Code / Codex session that owns pid ${r.pid} (a new session picks a working node); if a new session fails the same way, run \`npx ruvnet-brain --doctor\``,
      ...(runsNow ? { retriable: true, note: `pid ${r.pid} last failed to start its worker (${r.phase}), but ${own ? `its node ${own}` : 'a working node'} runs now and a real search answered; its next search retries` } : {}) });
  }
  const health = readJson(path.join(brainHome, 'health.json'));
  const at = Date.parse(health?.ts || '');
  if (health?.status === 'down' && /^mcp-parent-(startup|timeout)$/.test(health.source || '') && Number.isFinite(at) && now - at < 30 * MIN) {
    // `recorded`: a past event, not a live fact — a real search that answers this run supersedes it.
    failures.push({ what: `the last search outage was recorded ${Math.round((now - at) / MIN)} min ago (${String(health.error || '').slice(0, 300)})`,
      check: 'run `npx ruvnet-brain --doctor`', recorded: true });
  }
  if (!chain.usable.length) {
    failures.push({ what: `no working Node runtime on this machine (${chain.rejected.map((r) => `${r.node}: ${r.reason}`).join('; ').slice(0, 400) || 'none found'})`,
      check: 'run `node -e 0`; reinstall Node (`brew reinstall node@24`), then start a new session' });
  }
  return { failures, notes, node: chain.usable[0]?.node || null };
}

/** Pure: this run's verdict from the cheap tier and the deep search (null when not run this run). A real
 *  search that answered supersedes past events and proves retriable session failures will recover. */
export function judge(cheap, deep) {
  const proven = Boolean(deep?.ok);
  const live = proven ? cheap.failures.filter((f) => !f.recorded && !f.retriable) : cheap.failures;
  const notes = [...(cheap.notes || []), ...(proven ? cheap.failures.filter((f) => f.retriable).map((f) => f.note) : [])];
  const failure = live[0] || (deep && !deep.ok ? deep : null);
  return failure ? { ok: false, what: failure.what, check: failure.check, notes } : { ok: true, notes };
}

/** The executable a running process was started from (macOS/Linux): { path, deleted } or null. */
function serverNode(pid) {
  if (process.platform === 'linux') {
    // An upgrade that deletes the binary leaves "/path/node (deleted)": still that server, and its node is gone.
    try { const link = fs.readlinkSync(`/proc/${pid}/exe`); const deleted = / \(deleted\)$/.test(link); return { path: link.replace(/ \(deleted\)$/, ''), deleted }; } catch { return null; }
  }
  const r = spawnSync(fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8', timeout: 5_000 });
  const file = /^n(\/.+)$/m.exec(r.stdout || '')?.[1] || null;
  return file ? { path: file, deleted: !fs.existsSync(file) } : null;
}

/** The installed plugin server sessions actually run: the newest ~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/<v>/mcp/server.mjs. */
export function installedServer(env = process.env, home = HOME) {
  if (env.SEARCH_CANARY_SERVER) return env.SEARCH_CANARY_SERVER;
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain');
  const num = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
  let versions = [];
  try { versions = fs.readdirSync(dir).filter((v) => fs.existsSync(path.join(dir, v, 'mcp', 'server.mjs'))); } catch { return null; }
  versions.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return versions.length ? path.join(dir, versions[0], 'mcp', 'server.mjs') : null;
}

/** The deep tier: one real search through a fresh server process. Resolves { ok, what?, check?, ms, cited? }. */
export function deepSearch({ server = installedServer(), node, env = process.env, timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  const started = Date.now();
  if (!server) return Promise.resolve({ ok: false, ms: 0, what: 'the RuvNet Brain plugin server is not installed (no ~/.claude/plugins/cache/ruvnet-brain)', check: 'run `npx ruvnet-brain --update`' });
  if (!node) return Promise.resolve({ ok: false, ms: 0, what: 'no working Node runtime to start the search server with', check: 'run `node -e 0`' });
  return new Promise((resolve) => {
    let done = false;
    // The canary's search must not look like use: no token-ledger line (doctor's "last answer"), no usage
    // ping, and a neutral cwd. (It can still flip install-state "grounding: unproven" to proven, which a
    // real cited answer makes true, and brain-alarm records the result in health.json like any search.)
    // The notification topic and token are the canary's, never the probe's.
    const childEnv = { ...env, RUVNET_BRAIN_METER: '0', RUVNET_BRAIN_TELEMETRY: '0' };
    delete childEnv.NTFY_TOPIC; delete childEnv.NTFY_TOKEN;
    const proc = spawn(node, [server], { stdio: ['pipe', 'pipe', 'ignore'], cwd: os.tmpdir(), env: childEnv });
    let exited = false;
    proc.once('exit', () => { exited = true; });
    // Resolve only once the server is gone: stdin EOF (it stops its worker), SIGTERM after 3 s, SIGKILL after
    // 6 s. main() exits right after, so an unref'd kill timer would never fire and a hung server would live on.
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      const result = { ...r, ms: Date.now() - started };
      try { proc.stdin.end(); } catch { /* gone */ }
      if (exited || proc.exitCode !== null || proc.signalCode !== null) return resolve(result);
      const term = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } }, 3_000);
      const kill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 6_000);
      const hard = setTimeout(() => resolve(result), 8_000);
      proc.once('exit', () => { clearTimeout(term); clearTimeout(kill); clearTimeout(hard); resolve(result); });
    };
    const timer = setTimeout(() => finish({ ok: false, what: `a real search got no answer within ${Math.round(timeoutMs / 1000)}s`, check: 'run `npx ruvnet-brain --doctor`' }), timeoutMs);
    proc.on('error', (e) => finish({ ok: false, what: `the search server could not be started (${e.code || e.message})`, check: 'run `node -e 0`' }));
    proc.on('exit', (code, signal) => finish({ ok: false, what: `the search server exited (${signal || `code ${code}`}) before answering`, check: 'run `npx ruvnet-brain --doctor`' }));
    proc.stdin.on('error', () => { /* reported through exit/error */ });
    lfLineReader(proc.stdout).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== 2) return;
      const text = m.result?.content?.[0]?.text || m.error?.message || '';
      if (m.error || m.result?.isError) return finish({ ok: false, what: `a real search failed: ${text.slice(0, 400)}`, check: 'run `npx ruvnet-brain --doctor`' });
      let cited = null;
      try { const r = JSON.parse(text).retrieval?.results?.[0]; if (r?.repo && r?.path) cited = `${r.repo}/${r.path}`; } catch { /* checked below */ }
      if (!cited) { const p = /^path\s*:\s*(\S+)/m.exec(text); if (p) cited = p[1]; }
      if (!text.trim() || !cited) return finish({ ok: false, what: 'a real search returned no cited source', check: 'run `npx ruvnet-brain --doctor`' });
      finish({ ok: true, cited });
    });
    const send = (o) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'search-canary', version: '1' } } });
    send({ id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: CANARY_QUERY, k: 3 } } });
  });
}

/** Pure: the next state and the messages due, from the previous state and this run's verdict. */
export function decide(prev, verdict, now, { emailReady = false } = {}) {
  const s = { ...prev, lastRunAt: now, lastVerdict: verdict.ok ? 'ok' : 'down', lastReason: verdict.ok ? null : verdict.what, lastCheck: verdict.ok ? null : verdict.check };
  const messages = [];
  if (!verdict.ok) {
    s.consecutiveFailures = (prev.consecutiveFailures || 0) + 1;
    s.failingSince = prev.failingSince || now;
    const due = s.consecutiveFailures >= 2 && (!prev.lastAlertAt || now - prev.lastAlertAt >= REPEAT_MS);
    if (due) {
      const first = !prev.lastAlertAt;
      messages.push({ kind: first ? 'alert' : 'repeat', title: ALERT_TITLE, priority: 'urgent', email: first && emailReady,
        body: `What failed: ${verdict.what}.\nSince: ${eastern(s.failingSince)} (${s.consecutiveFailures} checks in a row).\nFirst thing to check: ${verdict.check}.\n`
          + `From the search canary on ${os.hostname()}. ${first ? 'Repeats hourly while down; a recovery notice follows the fix.' : 'Still down; next reminder in an hour.'}` });
    }
  } else {
    if (prev.lastAlertAt) {
      messages.push({ kind: 'recovery', title: 'Recovered: RuvNet Brain search is working again', priority: 'default', email: emailReady,
        body: `A real search answered and cited ${verdict.cited || 'a source'} at ${eastern(now)}. It was down since ${eastern(prev.failingSince || now)}.` });
    }
    s.consecutiveFailures = 0; s.failingSince = null; s.lastAlertAt = null; s.lastOkAt = now;
    if (prev.lastHeartbeatDay !== easternDay(now) && easternHour(now) >= 9 && !prev.lastAlertAt) {
      messages.push({ kind: 'heartbeat', title: 'RuvNet Brain search OK', priority: 'low', email: false,
        body: `Daily proof the search canary runs: the last real search answered at ${eastern(prev.lastDeepOkAt || now)}${verdict.cited ? ` and cited ${verdict.cited}` : ''}. Checked every 5 minutes.` });
    }
  }
  return { state: s, messages };
}

/** ntfy forwards to the owner's verified address only with an account token (anonymous e-mail is disabled on ntfy.sh). */
function emailHeaders(env = process.env) {
  let token = env.NTFY_TOKEN;
  if (token === undefined) { try { token = fs.readFileSync(path.join(HOME, '.cache', 'ruvnet-brain', 'ntfy-token'), 'utf8').trim(); } catch { token = ''; } }
  return token ? { Authorization: `Bearer ${token}`, 'X-Email': 'yes' } : null;
}

async function deliver(messages, topic, mail) {
  // No topic configured: ntfy is optional. The session alarm (search-down-notice.mjs reads the state file
  // written below) is the reader that matters, so nothing is sent, nothing fails, and the run exits 0.
  if (!topic) return messages.map((m) => ({ kind: m.kind, delivered: false, skipped: 'no ntfy topic configured', email: false }));
  const results = [];
  for (const m of messages) {
    const withMail = Boolean(m.email && mail);
    let delivered = topic ? await push(topic, m.title, m.body, m.priority, withMail ? mail : {}) : false;
    let email = withMail && delivered;
    // A bad or expired token (401) must never cost the phone alert: resend without the e-mail headers.
    if (topic && withMail && !delivered) { delivered = await push(topic, m.title, m.body, m.priority); email = false; }
    results.push({ kind: m.kind, delivered, email, ...(withMail && !email ? { emailFailed: true } : {}) });
  }
  return results;
}

const LOCK_STALE_MS = 10 * MIN; // longer than any run (JOB_MAX_SECONDS 280): a reused pid cannot hold it forever

/** One run at a time. The lock is created complete (written aside, then hard-linked into place, which fails if
 *  it exists), carries this run's token, and is released only by its owner. Stale = owner dead or too old. */
export function takeLock(file, { now = Date.now() } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}:${now}:${Math.random().toString(36).slice(2)}`;
  const tmp = `${lock}.${process.pid}.${now}`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  try {
    for (let i = 0; i < 2; i++) {
      try {
        fs.linkSync(tmp, lock);
        return () => { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* gone */ } };
      } catch {
        let held = '', age = Infinity;
        try { held = fs.readFileSync(lock, 'utf8'); age = now - fs.statSync(lock).mtimeMs; } catch { /* raced away */ }
        // isAlive refuses pid 0/NaN, so an unreadable lock never reads as held by "process 0".
        if (isAlive(Number(held.split(':')[0])) && age < LOCK_STALE_MS) return null;
        try { if (fs.readFileSync(lock, 'utf8') === held) fs.unlinkSync(lock); } catch { /* raced */ }
      }
    }
    return null;
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

/** Never let the topic or token reach the state file, the log or a session's context. */
function redactor(env = process.env) {
  const secrets = [ntfyTopic(), env.NTFY_TOKEN].filter((v) => typeof v === 'string' && v.length >= 4);
  try { const t = fs.readFileSync(path.join(HOME, '.cache', 'ruvnet-brain', 'ntfy-token'), 'utf8').trim(); if (t.length >= 4) secrets.push(t); } catch { /* none */ }
  // Whole tokens only: a topic that is also an ordinary word must not garble paths that merely contain it.
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text) => secrets.reduce((acc, v) => acc.replace(new RegExp(`(?<![\\w-])${esc(v)}(?![\\w-])`, 'g'), '[redacted]'), String(text ?? ''));
}

/** Atomic publish (tmp + rename): a prompt reading mid-write sees the old verdict or the new, never half. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function main(argv = process.argv.slice(2)) {
  const noPush = argv.includes('--no-push') || argv.includes('--json');
  const topic = noPush ? null : ntfyTopic();
  const mail = emailHeaders();
  if (argv.includes('--test-alert')) {
    if (!topic) { console.error('search-canary: no ntfy topic configured (NTFY_TOPIC or ~/.cache/ruvnet-brain/ntfy-topic) — nothing sent'); return 1; }
    const now = Date.now();
    const [r] = await deliver([{ kind: 'test', title: `TEST - ${ALERT_TITLE}`, priority: 'default', email: true,
      body: `TEST ONLY, nothing is wrong. This is the search canary's delivery test from ${os.hostname()} at ${eastern(now)}. A real alert looks like this, with what failed, since when, and the first thing to check.` }], topic, mail);
    console.log(`search-canary: test alert ntfy ${r.delivered ? 'DELIVERED (2xx)' : 'NOT delivered'}; e-mail ${r.email ? 'handed to ntfy with the account token' : mail ? 'not sent (ntfy push failed)' : 'NOT SENT: no ntfy account token (NTFY_TOKEN or ~/.cache/ruvnet-brain/ntfy-token) with a verified address'}`);
    return r.delivered ? 0 : 1;
  }
  const release = noPush ? () => {} : takeLock(STATE_FILE);
  if (!release) { console.error('search-canary: another run holds the lock — skipped'); return 75; }
  try {
    const now = Date.now();
    const prev = readJson(STATE_FILE) || {};
    let verdict;
    const redact = redactor();
    const injected = process.env.RUVNET_BRAIN_CANARY_INJECT === 'down';
    if (injected) verdict = { ok: false, what: 'fault injected (RUVNET_BRAIN_CANARY_INJECT=down); nothing real was checked', check: 'unset RUVNET_BRAIN_CANARY_INJECT' };
    else {
      const cheap = await cheapChecks({ now });
      const sinceDeep = prev.lastDeepAt ? now - prev.lastDeepAt : Infinity;
      const suspect = cheap.failures.length > 0 || prev.lastVerdict === 'down';
      // While suspect, real searches back off 15 -> 30 -> 60 min: an idle broken session must not load a
      // multi-GB worker every 15 minutes forever. Any OK verdict resets the back-off.
      const retryMs = Math.min(DEEP_EVERY_MS, DEEP_RETRY_MS * 2 ** Math.max(0, (prev.suspectDeeps || 0) - 1));
      const deepDue = argv.includes('--deep') || argv.includes('--cheap') ? argv.includes('--deep') : sinceDeep >= DEEP_EVERY_MS || (suspect && sinceDeep >= retryMs);
      if (process.env.SEARCH_CANARY_TRACE) console.error(`search-canary: deep ${deepDue ? 'due' : 'not due'} (retry ${retryMs / MIN} min)`);
      let deep = deepDue ? await deepSearch({ node: cheap.node }) : null;
      if (deep?.what) deep.what = redact(deep.what);
      if (deep) {
        prev.lastDeepAt = now; prev.lastDeepMs = deep.ms;
        if (deep.ok) { prev.lastDeepOkAt = now; prev.lastDeepFailure = null; } else prev.lastDeepFailure = { what: deep.what, check: deep.check };
      } else if (prev.lastDeepAt && sinceDeep < retryMs) {
        // Not re-run this time: the last real search, pass or fail, still speaks for this run inside the retry
        // window (a failed one keeps search DOWN until the next real search, never a silent "recovery").
        deep = prev.lastDeepOkAt === prev.lastDeepAt ? { ok: true, cited: prev.lastCited, carried: true }
          : prev.lastDeepFailure ? { ok: false, ...prev.lastDeepFailure, carried: true } : null;
      }
      verdict = judge(cheap, deep);
      // Keyed on suspicion, not the verdict: an idle session marked retriable makes every verdict OK, and the
      // back-off exists for exactly that case. Reset only once nothing cheap fails and search is not down.
      prev.suspectDeeps = !cheap.failures.length && verdict.ok ? 0 : (prev.suspectDeeps || 0) + (deep && !deep.carried ? 1 : 0);
      if (verdict.ok) verdict.cited = (deep?.ok && deep.cited) || prev.lastCited || null;
      if (deep?.ok && !deep.carried) prev.lastCited = deep.cited;
      verdict.deep = deep ? (deep.carried ? 'carried from the last real search' : { ok: deep.ok, ms: deep.ms }) : 'not due';
    }
    if (verdict.what) verdict.what = redact(verdict.what);
    if (verdict.check) verdict.check = redact(verdict.check);
    const { state, messages } = decide(prev, verdict, now, { emailReady: Boolean(mail) });
    const results = noPush ? [] : await deliver(messages, topic, mail);
    for (const r of results) {
      if (r.skipped && r.kind === 'heartbeat') state.lastHeartbeatDay = easternDay(now); // once a day, not every run
      if (!r.delivered) continue;
      if (r.kind === 'alert' || r.kind === 'repeat') state.lastAlertAt = now;
      if (r.kind === 'heartbeat') state.lastHeartbeatDay = easternDay(now);
    }
    if (!noPush) {
      // A recovery that did not land is retried: keep the alert open until it is delivered.
      if (results.some((r) => r.kind === 'recovery' && !r.delivered && !r.skipped)) { state.lastAlertAt = prev.lastAlertAt; state.failingSince = prev.failingSince; }
      if (results.some((r) => r.kind === 'heartbeat' && !r.delivered && !r.skipped)) state.lastHeartbeatDay = prev.lastHeartbeatDay;
      if (!injected || process.env.SEARCH_CANARY_STATE) {
        writeAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
        // The per-prompt hook's fork-free test: present exactly while the confirmed verdict is DOWN.
        const flag = downFlagPath();
        if (state.lastVerdict === 'down' && state.consecutiveFailures >= 2) writeAtomic(flag, `${state.failingSince}\n`);
        else { try { fs.unlinkSync(flag); } catch { /* not down */ } }
      }
    }
    const out = { verdict: verdict.ok ? 'OK' : 'DOWN', reason: verdict.what || null, check: verdict.check || null, deep: verdict.deep || null, notes: verdict.notes || [],
      consecutiveFailures: state.consecutiveFailures, messages: messages.map((m) => m.kind), delivered: results };
    const sent = results.filter((r) => !r.skipped);
    console.log(argv.includes('--json') ? JSON.stringify(out) : `search-canary: ${out.verdict}${out.reason ? ` — ${out.reason}` : ''}${sent.length ? ` · sent ${sent.map((r) => `${r.kind}:${r.delivered ? 'ok' : 'FAILED'}`).join(', ')}` : ''}`);
    return sent.every((r) => r.delivered) ? 0 : 1;
  } finally { release(); }
}

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(`search-canary: internal error — ${e?.stack || e}`); process.exit(1); });
}
