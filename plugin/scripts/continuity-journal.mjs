/**
 * continuity-journal.mjs — durable outbox FIRST, then AgentDB, then an exact read-back. Never silent.
 * THE GUARANTEE, and the failure it is built around. `ruflo memory store` refuses a write while another
 * process holds the store's native WAL sidecars: memory-initializer.ts storeEntry/getEntry check
 * `hasNativeWalSidecars(dbPath)` and return `walRefusalError` ("active native WAL connection — refusing
 * an unsafe sql.js whole-image write"; ruflo #2735/#2878, search_ruvnet:
 * ruflo/v3/@claude-flow/cli/src/memory/memory-initializer.ts). That is ordinary under concurrency, so an
 * event that is only ever handed to `ruflo` once is an event that can be lost. Here:
 *
 *   1. append(): every event is written to `.swarm/continuity-events-outbox.jsonl` and fsynced BEFORE
 *      any store call. From that instant it cannot be lost by a crash, a SIGKILL or a refusal.
 *   2. drain(): `ruflo memory store --no-upsert --path <db>` (the ONLY writer of memory.db), then the
 *      row is read back by exact key through the read-only node:sqlite reader (the same independent
 *      read path project-progression-store.mjs uses) and compared. Only then is a `commit` line
 *      appended. A refusal is retried with backoff inside the worker's budget; whatever is left stays
 *      pending and is retried by the next boundary's worker.
 *   3. status(): pending count, oldest pending, last commit, last failure — surfaced by the SessionStart
 *      brief, `--doctor`, and (Claude) a Stop line when recording is stuck. Never swallowed.
 * WHAT "✗" MEANS, AND WHAT KEEPS THE FILE SMALL (independent review S3/S4, 2026-10-01):
 *   • ONE EVENT, ONE KEY: two lines under one key are one event seen twice (first wins); only a stored row
 *     that is NOT that kind:id is a conflict, and that key is quarantined.
 *   • NOT APPLICABLE IS NOT A FAILURE: no initialized store → nothing journalled; no ruflo → events wait,
 *     no drainer, and the line says "n/a", never ✗.
 *   • A PROBLEM IS REPORTED, THEN CLEARS: quarantine/corrupt lines age out after QUARANTINE_REPORT_MS or
 *     with `continuity-brief.mjs --clear`; the Stop line shows once per session per condition.
 *   • BOUNDED. A failure is ONE record per event (attempt count, last error), never a line per attempt;
 *     compact() rewrites the file atomically (lock + size re-check, so a concurrent append is never
 *     lost): committed events older than RETAIN_COMMITTED_MS leave (the store keeps them and dedupes),
 *     corrupt lines become one notice, and a hard cap of MAX_EVENT_RECORDS drops the oldest, reported.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestCanonical } from './project-progression-contract.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { rufloRunDir } from './project-progression-store.mjs';
import { resolveRuflo, rufloInvocation } from './ruflo-bin.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { readSettledTranscript } from './turn-outcome-capture.mjs';
import {
  CONTINUITY_NAMESPACE, INITIAL_LOOKBACK_MS, collectCommits, collectReleases, collectTurnEvents, eventIdOf, eventKey,
} from './continuity-events.mjs';

export const OUTBOX_NAME = 'continuity-events-outbox.jsonl';
const LOCK_NAME = '.continuity-events.lock';
const APPEND_LOCK_NAME = '.continuity-events-outbox.lock';
const NOTICE_STATE = '.continuity-stop-notices.json';
export const DRAIN_BUDGET_MS = 90_000;
export const RETRY_BACKOFF_MS = Object.freeze([1_000, 3_000, 8_000, 20_000]);
/** Pending longer than this is no longer "in flight": it is stuck, and the user is told. */
export const STUCK_AFTER_MS = 10 * 60_000;
export const QUARANTINE_REPORT_MS = 7 * 86_400_000;
export const RETAIN_COMMITTED_MS = 7 * 86_400_000;
export const MAX_EVENT_RECORDS = 2_000;
const [COMPACT_AT_BYTES, LOCK_STALE_MS, APPEND_LOCK_WAIT_MS, APPEND_LOCK_STALE_MS] = [256 * 1024, 3 * 60_000, 1_000, 30_000];
const WAL_REFUSAL = /refusing an unsafe sql\.js|active native WAL|database is locked|SQLITE_BUSY/i;
export const CLEAR_COMMAND = `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'continuity-brief.mjs')}" --clear`;

const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.of(0)]);
/** Is `db` an initialized SQLite store (not absent, not an empty placeholder)? */
export function storeReady(db) {
  try {
    const fd = fs.openSync(db, 'r');
    try { const head = Buffer.alloc(16); return fs.readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER); } finally { fs.closeSync(fd); }
  } catch { return false; }
}
const pause = (t) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, t);
const ms = (iso) => Date.parse(iso || '') || 0;

export class ContinuityJournal {
  /** `ruflo`: the binary (string), null = not installed, undefined = resolve it. */
  constructor({ projectRoot, fsync = fs.fsyncSync, now = Date.now, ruflo } = {}) {
    if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required');
    this.projectRoot = projectRoot;
    this.swarm = path.join(projectRoot, '.swarm');
    this.path = path.join(this.swarm, OUTBOX_NAME);
    this.db = path.join(this.swarm, 'memory.db');
    this.fsync = fsync;
    this.now = now;
    this.ruflo = ruflo === undefined ? resolveRuflo() : ruflo;
  }

  /** Short exclusive section shared by every appender and the compactor (never held across a store call). */
  withAppendLock(fn) {
    const lock = path.join(this.swarm, APPEND_LOCK_NAME);
    const deadline = Date.now() + APPEND_LOCK_WAIT_MS;
    let held = false;
    // Only EEXIST is retried, and every iteration is deadline-bounded: EACCES/EROFS/ENOSPC used to spin at 100% CPU
    // forever (re-review B2). Any other error is the outbox's own failure: thrown, reported as "outbox write failed".
    for (;;) {
      try { fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: 'wx', mode: 0o600 }); held = true; break; } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > APPEND_LOCK_STALE_MS; } catch { /* vanished: retry once more below */ }
      let removed = false; // a stale lock we cannot remove is waited out ASLEEP, never spun on (re-review a6 NIT)
      if (stale) { try { fs.rmSync(lock, { force: true }); removed = true; } catch { /* not ours to remove: wait it out */ } }
      // Waited long enough: append anyway (durability first); the compactor's size re-check keeps it from being lost.
      if (Date.now() >= deadline) break;
      if (!removed) pause(5);
    }
    try { return fn(); } finally { if (held) fs.rmSync(lock, { force: true }); }
  }

  /** Append records with ONE fsync. Refuses to create `.swarm` (absence = project did not adopt). */
  appendRecords(records) {
    if (!records.length) return 0;
    const stat = fs.lstatSync(this.swarm);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('.swarm is not a real directory');
    return this.withAppendLock(() => {
      const fd = fs.openSync(this.path, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        fs.writeSync(fd, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
        this.fsync(fd);
      } finally { fs.closeSync(fd); }
      return records.length;
    });
  }

  /** Every line, tolerant: unparseable lines are counted, never thrown. */
  scan() {
    let text = '';
    try { text = fs.readFileSync(this.path, 'utf8'); } catch { /* no outbox yet */ }
    const events = new Map();
    const committed = new Map();
    const failures = new Map();
    const quarantined = new Map();
    const notices = [];
    let clearedAt = 0;
    let corrupt = 0;
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      let rec;
      try { rec = JSON.parse(line); } catch { corrupt += 1; continue; }
      if (rec?.type === 'event' && typeof rec.key === 'string' && typeof rec.digest === 'string' && rec.event) {
        if (!events.has(rec.key)) events.set(rec.key, rec); // a second observation of the same event: first wins
      } else if (rec?.type === 'commit' && typeof rec.key === 'string') committed.set(rec.key, rec);
      else if (rec?.type === 'failure' && typeof rec.key === 'string') {
        const prior = failures.get(rec.key);
        failures.set(rec.key, { ...rec, attempts: (prior?.attempts || 0) + (Number(rec.attempts) || 1) });
      } else if (rec?.type === 'quarantine' && typeof rec.key === 'string') quarantined.set(rec.key, rec);
      else if (rec?.type === 'notice') notices.push(rec);
      else if (rec?.type === 'cleared') clearedAt = Math.max(clearedAt, ms(rec.at));
      else corrupt += 1;
    }
    return { events, committed, failures, quarantined, notices, clearedAt, corrupt, lines, bytes: Buffer.byteLength(text) };
  }

  /** Events fsynced but not yet read back from AgentDB, oldest key first. A quarantined key never retries. */
  pending(scan = this.scan()) {
    return [...scan.events.values()]
      .filter((rec) => !scan.committed.has(rec.key) && !scan.quarantined.has(rec.key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** `kind:id` of every event already journalled here or committed to the store (dedupe set). */
  knownIds(scan = this.scan()) {
    const ids = new Set();
    for (const key of scan.events.keys()) { const id = eventIdOf(key); if (id) ids.add(id); }
    if (storeReady(this.db)) {
      const listed = withProgressionReader(this.db, (reader) => reader.listKeys(CONTINUITY_NAMESPACE, { maxEntries: 200_000 }));
      if (listed.ok) for (const key of listed.value) { const id = eventIdOf(key); if (id) ids.add(id); }
    }
    return ids;
  }

  /** Journal the events this boundary observed that are not already known. Returns what was added. */
  record(events) {
    const known = this.knownIds();
    const fresh = [];
    for (const event of events) {
      const id = `${event.kind}:${event.id}`;
      if (known.has(id)) continue;
      known.add(id);
      fresh.push({ type: 'event', key: eventKey(event), digest: digestCanonical(event), journaledAt: new Date(this.now()).toISOString(), event });
    }
    this.appendRecords(fresh);
    return fresh;
  }

  /** The one documented clear: acknowledges every reported quarantine/corrupt/drop up to now. */
  clearProblems() {
    // Compact first, so raw corrupt lines become a notice dated before the acknowledgement.
    try { this.compact(); } catch { /* the acknowledgement still stands for everything recorded so far */ }
    return this.appendRecords([{ type: 'cleared', at: new Date(this.now()).toISOString() }]);
  }

  /** Does the file carry anything compact() would remove? (cheap: from one scan) */
  needsCompaction(scan = this.scan()) {
    const now = this.now();
    if (scan.corrupt || scan.bytes > COMPACT_AT_BYTES || scan.events.size > MAX_EVENT_RECORDS) return true;
    const failureLines = scan.lines - scan.events.size - scan.committed.size - scan.quarantined.size - scan.notices.length - (scan.clearedAt ? 1 : 0) - scan.corrupt;
    if (failureLines > scan.failures.size) return true;
    for (const c of scan.committed.values()) if (now - ms(c.committedAt) > RETAIN_COMMITTED_MS) return true;
    return false;
  }

  /**
   * Rewrite the outbox to what still matters, atomically. Never loses an event that is still pending.
   * `beforeRename` is a test seam (an append landing mid-compaction must abort the rewrite, not vanish).
   */
  compact({ beforeRename = null } = {}) {
    const now = this.now();
    return this.withAppendLock(() => {
      let before;
      try { before = fs.statSync(this.path); } catch { return { compacted: false, reason: 'no outbox' }; }
      const scan = this.scan();
      const out = [];
      let dropped = 0;
      const quarantineLive = (q) => now - ms(q.at) <= QUARANTINE_REPORT_MS;
      const keep = [...scan.events.values()].filter((rec) => {
        const c = scan.committed.get(rec.key);
        if (c) return now - ms(c.committedAt) <= RETAIN_COMMITTED_MS;
        const q = scan.quarantined.get(rec.key);
        return q ? quarantineLive(q) : true;
      }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      // The hard cap: committed events go first (the store holds them), then the oldest pending.
      let over = keep.length - MAX_EVENT_RECORDS;
      if (over > 0) {
        const committedFirst = keep.filter((r) => scan.committed.has(r.key)).slice(0, over);
        over -= committedFirst.length;
        const pendingDrop = over > 0 ? keep.filter((r) => !scan.committed.has(r.key)).slice(0, over) : [];
        dropped = pendingDrop.length;
        const gone = new Set([...committedFirst, ...pendingDrop]);
        keep.splice(0, keep.length, ...keep.filter((r) => !gone.has(r)));
      }
      const kept = new Set(keep.map((r) => r.key));
      for (const rec of keep) {
        out.push(rec);
        if (scan.committed.has(rec.key)) out.push(scan.committed.get(rec.key));
        else if (scan.quarantined.has(rec.key)) out.push(scan.quarantined.get(rec.key));
        else if (scan.failures.has(rec.key)) out.push({ ...scan.failures.get(rec.key), type: 'failure' });
      }
      const notice = { corrupt: 0, dropped: 0, at: null };
      for (const n of scan.notices) {
        if (now - ms(n.at) > QUARANTINE_REPORT_MS || ms(n.at) <= scan.clearedAt) continue;
        notice.corrupt += Number(n.corrupt) || 0; notice.dropped += Number(n.dropped) || 0;
        notice.at = notice.at && notice.at < n.at ? notice.at : n.at;
      }
      if (scan.corrupt || dropped) {
        notice.corrupt += scan.corrupt; notice.dropped += dropped;
        notice.at = notice.at || new Date(now).toISOString();
      }
      if (notice.corrupt || notice.dropped) out.push({ type: 'notice', ...notice });
      if (scan.clearedAt) out.push({ type: 'cleared', at: new Date(scan.clearedAt).toISOString() });
      const tmp = `${this.path}.tmp-${process.pid}`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, out.map((r) => `${JSON.stringify(r)}\n`).join('')); this.fsync(fd); } finally { fs.closeSync(fd); }
      beforeRename?.();
      let now_;
      try { now_ = fs.statSync(this.path); } catch { now_ = null; }
      if (!now_ || now_.size !== before.size || now_.mtimeMs !== before.mtimeMs) {
        fs.rmSync(tmp, { force: true });
        return { compacted: false, reason: 'the outbox changed during compaction; left as is' };
      }
      fs.renameSync(tmp, this.path);
      return { compacted: true, lines: out.length, kept: kept.size, dropped };
    });
  }

  status(scan = this.scan()) {
    const now = this.now();
    const pending = this.pending(scan);
    const oldest = pending.length ? Math.min(...pending.map((r) => ms(r.journaledAt || r.event.at) || now)) : null;
    const commits = [...scan.committed.values()];
    const lastCommitAt = commits.reduce((max, c) => Math.max(max, ms(c.committedAt)), 0) || null;
    const lastFailure = [...scan.failures.values()].reduce((latest, f) => (!latest || f.at > latest.at ? f : latest), null);
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const eventsToday = commits.filter((c) => ms(c.committedAt) >= dayStart.getTime()).length;
    const reportable = (at) => at > scan.clearedAt && now - at <= QUARANTINE_REPORT_MS;
    const quarantined = [...scan.quarantined.values()].filter((q) => reportable(ms(q.at))).map((q) => q.key);
    const live = scan.notices.filter((n) => reportable(ms(n.at)));
    const corrupt = live.reduce((n, x) => n + (Number(x.corrupt) || 0), 0) + (scan.corrupt && reportable(now) ? scan.corrupt : 0);
    const dropped = live.reduce((n, x) => n + (Number(x.dropped) || 0), 0);
    const ready = storeReady(this.db);
    const notApplicable = !ready ? 'no AgentDB store in this project (.swarm/memory.db is not initialized)'
      : !this.ruflo ? 'ruflo is not installed' : null;
    const problem = quarantined.length ? 'quarantined' : corrupt ? 'corrupt' : dropped ? 'dropped'
      : !notApplicable && oldest !== null && now - oldest > STUCK_AFTER_MS ? 'stuck-pending' : null;
    return {
      outbox: this.path, db: this.db, storeReady: ready, rufloPresent: Boolean(this.ruflo),
      applicable: !notApplicable, notApplicable,
      pending: pending.length, oldestPendingAt: oldest, lastCommitAt, eventsToday,
      lastFailure: lastFailure && (!lastCommitAt || ms(lastFailure.at) > lastCommitAt) ? lastFailure : null,
      quarantined, corrupt, dropped, problem, stuck: Boolean(problem),
    };
  }
}

const ago = (t) => (t < 90_000 ? `${Math.max(0, Math.round(t / 1000))}s` : t < 5_400_000 ? `${Math.round(t / 60_000)}m` : `${Math.round(t / 3_600_000)}h`);

/** The one-line positive (or loud) confirmation, shared by the brief, --doctor and the Stop line. */
export function recordingLine(status, now = Date.now()) {
  if (!status) return 'AgentDB: recording unknown — status unavailable';
  if (status.stuck) {
    const clears = `clears itself in ${Math.round(QUARANTINE_REPORT_MS / 86_400_000)}d, or now: ${CLEAR_COMMAND}`;
    const why = status.problem === 'quarantined' ? `${status.quarantined.length} quarantined (a different row holds its key; never retried — ${clears})`
      : status.problem === 'corrupt' ? `${status.corrupt} corrupt outbox line(s) removed (${clears})`
        : status.problem === 'dropped' ? `${status.dropped} uncommitted event(s) dropped at the outbox cap (${clears})`
          : status.lastFailure ? `last error: ${status.lastFailure.reason || status.lastFailure.error}` : 'not committing';
    return `AgentDB: recording stuck — ${status.pending} event(s) pending${status.oldestPendingAt && status.problem === 'stuck-pending' ? ` for ${ago(now - status.oldestPendingAt)}` : ''}, ${why}.`
      + ` Pending events are durable in ${status.outbox} and retry at every capture boundary.`;
  }
  if (status.notApplicable) {
    return `AgentDB: recording n/a — ${status.notApplicable}; ${status.pending} event(s) wait in the outbox (not a failure).`;
  }
  // ✓ only on evidence: a committed, read-back event. "Nothing failed yet" is not proof of recording.
  if (!status.lastCommitAt) return `AgentDB: recording not yet proven — no event committed and read back yet (outbox ${status.pending} pending)`;
  return `AgentDB: recording ✓ (last write ${ago(now - status.lastCommitAt)} ago, ${status.eventsToday} event(s) today, outbox ${status.pending} pending)`;
}

/**
 * The Claude Stop line, at most ONCE per session per condition (review S3: it repeated at every turn).
 * State is a tiny file in the project's own .swarm, bounded to the last 20 sessions.
 */
export function stopNotice({ journal, status, session }) {
  if (!status?.stuck || !status.problem) return '';
  const file = path.join(journal.swarm, NOTICE_STATE);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first notice */ }
  const id = String(session || 'unknown');
  const shown = Array.isArray(state[id]?.conditions) ? state[id].conditions : [];
  if (shown.includes(status.problem)) return '';
  state[id] = { at: new Date(journal.now()).toISOString(), conditions: [...shown, status.problem] };
  const recent = Object.entries(state).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at))).slice(0, 20);
  try { fs.writeFileSync(file, JSON.stringify(Object.fromEntries(recent)), { mode: 0o600 }); } catch { /* still show it once */ }
  return `[RuvNet Brain] ${recordingLine(status, journal.now())}`;
}

function defaultStore({ ruflo, db, key, value }) {
  const cwd = rufloRunDir(db);
  try {
    const { executable, args } = rufloInvocation(ruflo, ['memory', 'store', '--key', key, '--value', value,
      '--namespace', CONTINUITY_NAMESPACE, '--no-upsert', '--provenance', 'system_observation', '--path', db]);
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    return { status: Number.isInteger(r.status) ? r.status : 1, output: `${r.stderr || ''}\n${r.stdout || ''}${r.error ? `\n${r.error.message}` : ''}` };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function defaultReadBack({ ruflo, db, key }) {
  const fast = withProgressionReader(db, (reader) => reader.readContent(CONTINUITY_NAMESPACE, key));
  if (fast.ok) return { content: fast.value, readPath: 'node:sqlite' };
  const cwd = rufloRunDir(db);
  try {
    const { executable, args } = rufloInvocation(ruflo, ['memory', 'retrieve', '--key', key, '--namespace', CONTINUITY_NAMESPACE, '--value-only', '--path', db]);
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    return { content: r.status === 0 ? String(r.stdout || '') : null, readPath: `ruflo-cli (${fast.reason})` };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

/** Is a stored row the SAME event (same kind and content id), whoever observed it? */
const sameEvent = (content, event) => {
  try { const row = JSON.parse(content); return row?.kind === event.kind && row?.id === event.id; } catch { return false; }
};

/**
 * Commit every pending event: store → exact read-back → commit line. A refusal is retried with
 * backoff while the budget lasts; nothing is ever dropped. Failures are ONE record per event per run
 * (attempts counted), merged across runs by compact(). Returns { committed, failed, remaining }.
 */
export function drain(journal, {
  ruflo = journal.ruflo, store = defaultStore, readBack = defaultReadBack,
  budgetMs = DRAIN_BUDGET_MS, backoff = RETRY_BACKOFF_MS, now = Date.now, sleep = pause,
} = {}) {
  const deadline = now() + budgetMs;
  let committed = 0;
  let failed = 0;
  // Not applicable is not a failure: nothing is written, the events simply wait (review S4).
  if (!ruflo) return { committed, failed, remaining: journal.pending().length, skipped: 'ruflo not found' };
  if (!storeReady(journal.db)) return { committed, failed, remaining: journal.pending().length, skipped: 'store not initialized' };
  for (const rec of journal.pending()) {
    const value = JSON.stringify(rec.event);
    let done = false;
    let attempts = 0;
    let last = null;
    for (let attempt = 0; !done && now() < deadline; attempt += 1) {
      attempts += 1;
      const result = store({ ruflo, db: journal.db, key: rec.key, value });
      const back = readBack({ ruflo, db: journal.db, key: rec.key });
      const content = typeof back.content === 'string' ? back.content.trim() : '';
      if (content && (content === value || sameEvent(content, rec.event))) {
        journal.appendRecords([{ type: 'commit', key: rec.key, digest: rec.digest, committedAt: new Date(now()).toISOString(), readPath: back.readPath,
          alreadyStored: result.status !== 0 || content !== value, ...(attempts > 1 ? { attempts, lastError: last?.reason } : {}) }]);
        committed += 1;
        done = true;
      } else if (content) {
        // A DIFFERENT row holds our key: never overwritten (--no-upsert), never retried, reported.
        journal.appendRecords([{ type: 'quarantine', key: rec.key, at: new Date(now()).toISOString(), reason: 'a different stored row holds this key' }]);
        failed += 1;
        done = true;
      } else {
        last = { reason: WAL_REFUSAL.test(result.output || '') ? 'wal-contention' : `store exited ${result.status}`, error: String(result.output || '').trim().slice(-300) };
        const wait = backoff[Math.min(attempt, backoff.length - 1)];
        if (attempt >= backoff.length || now() + wait >= deadline) break;
        sleep(wait);
      }
    }
    if (!done && last) {
      failed += 1;
      try { journal.appendRecords([{ type: 'failure', key: rec.key, at: new Date(now()).toISOString(), attempts, ...last }]); } catch { /* the event itself is still durable */ }
    }
    if (!done && now() >= deadline) break;
  }
  try { if (journal.needsCompaction()) journal.compact(); } catch { /* a larger file is not a lost event */ }
  return { committed, failed, remaining: journal.pending().length };
}

/** One drainer per project at a time. Returns a release function, or null if another is live. */
export function takeLock(journal, { now = Date.now } = {}) {
  const lock = path.join(journal.swarm, LOCK_NAME);
  const body = `${process.pid} ${now()}\n`;
  const create = () => { fs.writeFileSync(lock, body, { flag: 'wx', mode: 0o600 }); return () => { try { if (fs.readFileSync(lock, 'utf8') === body) fs.rmSync(lock, { force: true }); } catch { /* gone */ } }; };
  try { return create(); } catch { /* held */ }
  try {
    const [pid, at] = fs.readFileSync(lock, 'utf8').trim().split(' ').map(Number);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e?.code === 'EPERM'; }
    if (now() - at > LOCK_STALE_MS && (!alive || now() - at > 10 * LOCK_STALE_MS)) {
      fs.rmSync(lock, { force: true });
      return create();
    }
  } catch { /* unreadable lock: leave it, the next boundary tries again */ }
  return null;
}

/** Start a detached drainer for this project. Never throws; returns whether one was started. */
export function launchDrain({ projectRoot, spawnFn = spawn, env = process.env } = {}) {
  try {
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), '--drain', projectRoot], {
      cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0' },
    });
    child.unref?.();
    return true;
  } catch { return false; }
}

/**
 * THE CAPTURE BOUNDARY'S CALL (session-snapshot-hook.mjs, Stop / PreCompact / SessionEnd on Claude,
 * Stop / SessionEnd on Codex). Reads git and the turn, journals new events with one fsync, and hands
 * the AgentDB writes to a detached drainer — so it fits Codex's 3s SessionEnd with room to spare.
 * Never throws; every skip carries its reason.
 */
export function captureContinuityEvents({
  projectDir, event, payload = {}, host = 'claude', env = process.env, ruflo = resolveRuflo({ env }),
  readTranscript = (file) => readSettledTranscript(file, { maxMs: 0 }), launch = launchDrain, now = Date.now,
} = {}) {
  const report = { event, recorded: 0, launched: false };
  if (String(env.RUVNET_CONTINUITY_CAPTURE || '').toLowerCase() === 'off') return { ...report, skipped: 'RUVNET_CONTINUITY_CAPTURE=off' };
  let resolution;
  try { resolution = resolveProjectStore({ projectDir }); } catch { return { ...report, skipped: 'project store could not be resolved' }; }
  const journal = new ContinuityJournal({ projectRoot: resolution.projectRoot, now, ruflo });
  try {
    const st = fs.lstatSync(journal.swarm);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ...report, skipped: '.swarm is not a real directory' };
  } catch { return { ...report, skipped: 'project has not adopted the canonical store' }; }
  // No initialized store: recording is not applicable here, so nothing is journalled (review S3c/S4).
  if (!storeReady(journal.db)) return { ...report, skipped: 'not applicable: no AgentDB store in this project (.swarm/memory.db is not initialized)' };
  const session = typeof payload.session_id === 'string' ? payload.session_id : null;
  const project = path.basename(resolution.projectRoot);
  const scan = journal.scan();
  const lastBoundary = [...scan.events.values()].reduce((max, r) => Math.max(max, ms(r.journaledAt)), 0);
  const sinceMs = lastBoundary ? Math.min(lastBoundary - 86_400_000, now() - 3_600_000) : now() - INITIAL_LOOKBACK_MS;
  const events = [];
  if (resolution.kind === 'git') {
    events.push(...collectCommits({ checkoutRoot: resolution.checkoutRoot, sinceMs, host, session, project }));
    events.push(...collectReleases({ checkoutRoot: resolution.checkoutRoot, sinceMs, host, session, project }));
  }
  if (event === 'Stop') {
    let lines = null;
    if (host === 'claude' && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      try { lines = readTranscript(payload.transcript_path); } catch { /* unreadable transcript: git events still count */ }
    }
    const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
    events.push(...collectTurnEvents({ lines, lastAssistantMessage: last, host, session, project, env, at: now() }));
  }
  try { report.recorded = journal.record(events).length; } catch (error) { return { ...report, skipped: `outbox write failed: ${error.message}` }; }
  try { if (journal.needsCompaction()) journal.compact(); } catch { /* bounded next time */ }
  const status = journal.status();
  // A drainer only where it can succeed: an initialized store AND a ruflo to write it (review S4).
  if (status.pending && status.applicable) report.launched = launch({ projectRoot: resolution.projectRoot, env });
  return { ...report, status, journal };
}

/** The detached worker body. */
export function runDrain(projectRoot, options = {}) {
  const journal = new ContinuityJournal({ projectRoot, ...(options.ruflo !== undefined ? { ruflo: options.ruflo } : {}) });
  const release = takeLock(journal);
  if (!release) return { skipped: 'another drainer holds the lock' };
  try { return drain(journal, options); } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--drain') {
  try { runDrain(process.argv[3]); } catch { /* the events stay durable in the outbox */ }
  process.exit(0);
}
