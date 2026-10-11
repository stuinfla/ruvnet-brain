/** Canonical capture queue, fencing and bounded replay; no independent writer authority. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { developmentHooksSuspended } from './development-maintenance.mjs';
import { resolveTurnDb } from './turn-outcome-capture.mjs';
import { enrichStateWithObservation } from './project-progression-hook.mjs';
import { buildProjectProgression } from './project-progression-producer.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { redactProgression } from './project-progression-contract.mjs';
import { ProgressionOutbox } from './project-progression-outbox.mjs';
import { captureNormalizedTransition } from './project-transition-hook.mjs';
import { boundedStoreFactory, runSessionSnapshotHook } from './session-snapshot-hook.mjs';
import { operatorProgressionSuspension } from './project-progression-suspension.mjs';

/**
 * How long the detached worker may spend per step. The lock is refreshed between steps and goes stale
 * after REPLAY_LOCK_STALE_MS, which is more than twice a step, so a live worker never looks dead.
 */
export const DETACHED_REPLAY_BUDGET_MS = 45_000;
export const REPLAY_LOCK_STALE_MS = 120_000;
const REPLAY_LOCK = '.progression-replay.lock';
const QUEUE_PREFIX = '.progression-capture-queue-';
const lockPath = (projectDir) => path.join(projectDir, '.swarm', REPLAY_LOCK);
// The lock's FIRST line is the owner token; a second `pid <n>` line names the process holding it.
const readLock = (projectDir) => { try { return fs.readFileSync(lockPath(projectDir), 'utf8').split('\n')[0].trim(); } catch { return null; } };
const CLAIM_PREFIX = '.progression-capture-claimed-';
/** After this long a stale lock is taken over even if its holder pid looks alive (pid reuse, a wedged process). */
export const REPLAY_LOCK_ABANDON_MS = 30 * 60_000;

/** Is a process with this pid alive? EPERM means alive but not ours. Never throws. */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
const seqOf = (name) => Number((/(\d{12})\.json$/.exec(name) || [])[1] ?? 0);
const swarmEntries = (projectDir) => { try { return fs.readdirSync(path.join(projectDir, '.swarm')); } catch { return []; } };
// 4.4.0 named queue files by wall clock: `<prefix><15-digit ms>-<hrtime>-<pid>-<n>.json`. Open 4.4.0
// sessions keep queuing in that format after the update, so the two formats coexist for a while.
const LEGACY_QUEUE = /^\d{15}-/;
const queueTail = (name) => (name.startsWith(QUEUE_PREFIX) ? name.slice(QUEUE_PREFIX.length) : name.slice(CLAIM_PREFIX.length).replace(/^\d+-[A-Za-z0-9]*-\d+-/, ''));   // <pid>-<start>-<queuedAt>-
const mtimeOf = (projectDir, name) => { try { return fs.statSync(path.join(projectDir, '.swarm', name)).mtimeMs; } catch { return Infinity; } };

/**
 * Queue one boundary's capture for the worker (0600, inside the project's own .swarm). ORDER IS THE
 * ORDER OF EXCLUSIVE CREATION: the name is the next sequence number after every queued or claimed one,
 * created with O_EXCL and retried on collision — never a clock, which can step backwards or wrap.
 */
export function queueCapture({ projectDir, originProjectDir = projectDir, event, host, payload, env = process.env }) {
  try {
    if (operatorProgressionSuspension(env)) return null;
    const consent = resolveTurnDb({ projectDir: originProjectDir, requestedStorePath: path.join(projectDir, '.swarm', 'memory.db'),
      brainHome: env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain') });
    if (consent.skipped) return null;
  } catch { return null; }
  // Freeze legacy callers at the original boundary too, before dropping host payload.
  let progression = payload?.projectProgression;
  if (!progression && !payload?.normalizedTransition) {
    try { progression = buildProjectProgression({ resolution: resolveProjectStore({ projectDir: originProjectDir }), projectDir: originProjectDir, payload, host, trigger: event }).projectProgression; } catch { return null; }
  }
  // Freeze the bounded native observation before discarding raw host input. Replay receives no
  // tool fields, so the native writer cannot append it twice.
  if (progression && (payload?.tool_name || payload?.tool_input)) progression = { ...progression,
    completeProjectState: enrichStateWithObservation(progression.completeProjectState, { ...payload, hook_event_name: event }) };
  // This queue is durable: never serialize arbitrary host prompts, tool input or output.
  const minimized = { session_id: payload?.session_id, hook_event_name: event,
    ...(progression ? { projectProgression: progression } : {}),
    ...(payload?.normalizedTransition ? { normalizedTransition: payload.normalizedTransition } : {}) };
  const body = JSON.stringify(redactProgression({ event, host, originProjectDir,
    queuedAt: new Date().toISOString(), payload: minimized }).value);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const seq = Math.max(0, ...swarmEntries(projectDir).filter((n) => n.startsWith(QUEUE_PREFIX) || n.startsWith(CLAIM_PREFIX)).map(seqOf)) + 1;
    const file = path.join(projectDir, '.swarm', `${QUEUE_PREFIX}${String(seq).padStart(12, '0')}.json`);
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return file;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
    }
  }
  return null;
}

/**
 * Unclaimed queued captures, in queue order. While any 4.4.0 (timestamp-named) entry is present the
 * order is creation time (mtime, then name) — by NAME every 4.4.1 sequence file would sort before every
 * 4.4.0 one, replaying newer captures before older ones across the upgrade window. Once the legacy
 * entries are gone the order is the sequence alone, independent of any clock.
 */
export function queuedCaptures(projectDir) {
  const all = swarmEntries(projectDir).filter((n) => (n.startsWith(QUEUE_PREFIX) || n.startsWith(CLAIM_PREFIX)) && n.endsWith('.json'));
  const queued = all.filter((n) => n.startsWith(QUEUE_PREFIX));
  const mixed = all.some((n) => LEGACY_QUEUE.test(queueTail(n)));
  const ordered = mixed
    ? queued.map((n) => [mtimeOf(projectDir, n), n]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([, n]) => n)
    : queued.sort();
  return ordered.map((n) => path.join(projectDir, '.swarm', n));
}

/** All older work a boundary must wait behind: unclaimed captures plus captures a worker has claimed. */
export function queuedWork(projectDir) {
  return swarmEntries(projectDir).filter((n) => (n.startsWith(QUEUE_PREFIX) || n.startsWith(CLAIM_PREFIX)) && n.endsWith('.json')).length;
}

/**
 * A process's START TIME, as a filename-safe token, or null where it cannot be read (no `ps`, e.g.
 * Windows). With the pid it identifies the process: a reused pid has a different start time.
 */
export function processStart(pid) {
  try {
    // TZ and locale PINNED: `lstart` prints local time in the locale's format, so two workers with
    // different settings would record the same live process differently and read it as pid reuse.
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, windowsHide: true,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
    const s = String(r.stdout || '').replace(/[^A-Za-z0-9]/g, '');
    return r.status === 0 && s ? s : null;
  } catch { return null; }
}
let selfStart;
const ownStart = () => (selfStart === undefined ? (selfStart = processStart(process.pid)) : selfStart);

/**
 * Claim a queued capture by atomic rename; null if taken. The claim's name records pid, start time and
 * the queue file's ORIGINAL mtime (its creation order, which the mixed upgrade window sorts by); the
 * claim file's own mtime is then set to the claim time, from which the orphan ceiling counts.
 */
function claimQueued(file) {
  let queuedAt = 0;
  try { queuedAt = Math.floor(fs.statSync(file).mtimeMs); } catch { return null; }
  const claimed = path.join(path.dirname(file), `${CLAIM_PREFIX}${process.pid}-${ownStart() || 'na'}-${queuedAt}-${path.basename(file).slice(QUEUE_PREFIX.length)}`);
  try { fs.renameSync(file, claimed); } catch { return null; }
  try { const t = new Date(); fs.utimesSync(claimed, t, t); } catch { /* the ceiling then counts from queue time: earlier, never later */ }
  return claimed;
}
const unclaimedName = (claimed) => path.join(path.dirname(claimed), `${QUEUE_PREFIX}${queueTail(path.basename(claimed))}`);
/** Put a claim back in the queue: rename (atomic, needs no hard links), restoring its creation order. */
const returnClaim = (claimed) => {
  const queuedAt = Number(path.basename(claimed).slice(CLAIM_PREFIX.length).split('-')[2]);
  const back = unclaimedName(claimed);
  try { fs.renameSync(claimed, back); } catch { return false; }
  if (Number.isFinite(queuedAt) && queuedAt > 0) { try { const t = new Date(queuedAt); fs.utimesSync(back, t, t); } catch { /* best effort */ } }
  return true;
};

/**
 * Return to the queue every claim whose worker is gone: its pid is dead, OR the pid now belongs to a
 * different process (start time differs — pid reuse), OR the claim is older than REPLAY_LOCK_ABANDON_MS
 * whatever the pid says (a reused pid where no start time can be read, a wedged worker). Without the
 * last two a reused pid stranded a claim forever and every Stop spawned a worker that could not run it.
 */
export function reclaimOrphans(projectDir, { isAlive = pidAlive, startOf = processStart, now = Date.now() } = {}) {
  let n = 0;
  for (const name of swarmEntries(projectDir).filter((x) => x.startsWith(CLAIM_PREFIX))) {
    const [pidText, start] = name.slice(CLAIM_PREFIX.length).split('-');
    const pid = Number(pidText);
    const claimed = path.join(projectDir, '.swarm', name);
    const abandoned = now - mtimeOf(projectDir, name) > REPLAY_LOCK_ABANDON_MS;
    let gone = abandoned || !isAlive(pid);
    if (!gone && start && start !== 'na') {
      const current = startOf(pid);
      gone = Boolean(current) && current !== start;
    }
    if (gone && returnClaim(claimed)) n += 1;
  }
  return n;
}

const lockFacts = (file) => { const st = fs.statSync(file); return { content: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs, ino: st.ino }; };
const sameFacts = (a, b) => a.content === b.content && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
/** The pid ACTUALLY holding a lock: the `pid <n>` line a worker writes for itself, else the token's pid. */
const holderPid = (content) => {
  const line = /^pid (\d+)$/m.exec(String(content));
  return Number(line ? line[1] : String(content).trim().split('-')[0]);
};

/**
 * Take the lock. Returns this holder's TOKEN (`<pid>-<time>-<random>`), or null.
 *  • Free → exclusive create.
 *  • Fresh (refreshed within REPLAY_LOCK_STALE_MS) → null.
 *  • Stale but its holder pid is ALIVE → null until REPLAY_LOCK_ABANDON_MS: a laptop asleep mid-step,
 *    or a long step, is not a dead worker, and taking over would put two workers on one job. The holder
 *    pid is the WORKER's own (it rewrites the lock on start), not the hook that spawned it and exited.
 *  • Otherwise taken over: the stale file is renamed aside and VERIFIED to be the very file judged
 *    stale (content, mtime, inode). If a successor's fresh lock was moved instead (it took over between
 *    our check and our rename), it is put back — never over a third lock — and we back off. One winner.
 */
export function takeReplayLock(projectDir, now = Date.now(), { isAlive = pidAlive, beforeRename = null } = {}) {
  const lock = lockPath(projectDir);
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const create = () => { fs.writeFileSync(lock, `${token}\npid ${process.pid}\n`, { flag: 'wx', mode: 0o600 }); return token; };
  try { return create(); } catch { /* held, or stale */ }
  let seen;
  try { seen = lockFacts(lock); } catch { try { return create(); } catch { return null; } }
  const age = now - seen.mtimeMs;
  if (age <= REPLAY_LOCK_STALE_MS) return null;
  if (age <= REPLAY_LOCK_ABANDON_MS && isAlive(holderPid(seen.content))) return null;
  beforeRename?.();
  const aside = `${lock}.stale-${token}`;
  try { fs.renameSync(lock, aside); } catch { return null; }
  let moved = null;
  try { moved = lockFacts(aside); } catch { /* vanished */ }
  if (!moved || !sameFacts(moved, seen)) {
    // Put the successor's lock back without ever overwriting a third holder's: a hard link where the
    // filesystem has them, else an exclusive copy.
    try { fs.linkSync(aside, lock); } catch {
      try { fs.copyFileSync(aside, lock, fs.constants.COPYFILE_EXCL); } catch { /* a third holder exists; the successor sees it lost the lock and stops */ }
    }
    try { fs.rmSync(aside, { force: true }); } catch { /* best effort */ }
    return null;
  }
  try { fs.rmSync(aside, { force: true }); } catch { /* best effort */ }
  try { return create(); } catch { return null; }
}

/** Heartbeat: refresh the lock's mtime if (and only if) this holder still owns it. */
export function refreshReplayLock(projectDir, token) {
  if (!token || readLock(projectDir) !== token) return false;
  try { const t = new Date(); fs.utimesSync(lockPath(projectDir), t, t); return true; } catch { return false; }
}

/** A worker that inherited the lock records ITS OWN pid on it, keeping the owner token. */
export function adoptReplayLock(projectDir, token) {
  if (!token || readLock(projectDir) !== token) return false;
  try { fs.writeFileSync(lockPath(projectDir), `${token}\npid ${process.pid}\n`, { mode: 0o600 }); return true; } catch { return false; }
}

/** Release ONLY a lock this holder owns; a successor's lock is never deleted. */
export function releaseReplayLock(projectDir, token) {
  if (!token || readLock(projectDir) !== token) return false;
  try { fs.rmSync(lockPath(projectDir), { force: true }); return true; } catch { return false; }
}

/** Hand the lock (or take it, if free) to a detached worker. Returns whether one was started. Never throws. */
export function replayOutboxDetached({ projectDir, token = null, spawnFn = spawn, env = process.env } = {}) {
  try {
    if (operatorProgressionSuspension(env)) { if (token) releaseReplayLock(projectDir, token); return false; }
  } catch { if (token) releaseReplayLock(projectDir, token); return false; }
  const held = token || takeReplayLock(projectDir);
  if (!held) return false;
  try {
    const child = spawnFn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-snapshot-hook.mjs'), '--replay-outbox'], {
      cwd: projectDir, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...env, RUVNET_REPLAY_LOCK_TOKEN: held },
    });
    child.unref?.();
    return true;
  } catch {
    releaseReplayLock(projectDir, held);
    return false;
  }
}

/**
 * The detached worker's body, holding the lock `token`: record its own pid on the lock, return orphaned
 * claims to the queue, replay the outbox, then run every queued capture IN ORDER — each CLAIMED by
 * atomic rename first, so no other worker can run it too, and each re-entering the boundary as
 * `ordered`, so it replays before it produces. Ownership is re-checked before every step and right
 * after each claim; a worker that lost the lock puts an unstarted claim back and stops. A finished
 * claim is the claimer's own and is deleted. Releases only its own lock, then re-checks for captures
 * queued while it held it.
 */
export function runOutboxReplay({ projectDir, token = process.env.RUVNET_REPLAY_LOCK_TOKEN || null, budgetMs = DETACHED_REPLAY_BUDGET_MS,
  makeStoreFactory = boundedStoreFactory, now = Date.now, runCapture = runSessionSnapshotHook, onClaim = null,
  captureNormalized = captureNormalizedTransition, onCaptured = null, env = process.env,
  deadlineAt: inheritedDeadlineAt = Infinity, signal } = {}) {
  const deadlineAt = Math.min(inheritedDeadlineAt, now() + budgetMs);
  if (signal?.aborted || now() >= deadlineAt) return 0;
  if (developmentHooksSuspended(projectDir)) return 0;
  if (operatorProgressionSuspension(env)) { if (token) releaseReplayLock(projectDir, token); return 0; }
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain');
  try {
    const consent = resolveTurnDb({ projectDir, brainHome, deadlineAt, signal });
    if (consent.skipped && !consent.skipped.startsWith('no project memory db')) return 0;
  } catch { return 0; }
  if (signal?.aborted || now() >= deadlineAt) return 0;
  let held = token || takeReplayLock(projectDir);
  let replayed = 0;
  for (let round = 0; held && round < 8 && now() < deadlineAt && !signal?.aborted; round += 1) {
    try {
      if (!adoptReplayLock(projectDir, held)) return replayed;
      reclaimOrphans(projectDir);
      const resolution = resolveProjectStore({ projectDir, deadlineAt });
      const store = makeStoreFactory(deadlineAt)({ projectDir, env, requestedStorePath: resolution.canonicalAgentDbPath, deadlineAt, signal });
      for (const snapshot of store.outbox.pendingSnapshots()) {
        if (operatorProgressionSuspension(env)) return replayed;
        if (signal?.aborted || now() >= deadlineAt) return replayed;
        if (!refreshReplayLock(projectDir, held)) return replayed;
        store.captureFrozen(snapshot, { canCommit: () => !signal?.aborted && now() < deadlineAt && refreshReplayLock(projectDir, held) });
        // captureFrozen commits only the verified key, retaining conflicting original history.
        replayed += 1;
      }
      for (const file of queuedCaptures(projectDir)) {
        if (operatorProgressionSuspension(env)) return replayed;
        if (signal?.aborted || now() >= deadlineAt) return replayed;
        if (!refreshReplayLock(projectDir, held)) return replayed;
        const claimed = claimQueued(file);
        if (!claimed) continue;
        onClaim?.(claimed);
        if (signal?.aborted || now() >= deadlineAt) { returnClaim(claimed); return replayed; }
        if (!refreshReplayLock(projectDir, held)) {
          returnClaim(claimed);
          return replayed;
        }
        if (operatorProgressionSuspension(env)) { returnClaim(claimed); return replayed; }
        let job = null;
        try { job = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch { /* torn: dropped below */ }
        let committed = false;
        try {
          if (job) {
            // Pre-upgrade raw queues lack origin identity and cannot be truthfully reconstructed.
            if (runCapture === runSessionSnapshotHook && (!job.originProjectDir || (!job.payload?.projectProgression && !job.payload?.normalizedTransition))) { returnClaim(claimed); return replayed; }
            const consent = resolveTurnDb({ projectDir: job.originProjectDir || projectDir, brainHome, deadlineAt, signal });
            if (developmentHooksSuspended(job.originProjectDir || projectDir)
              || (consent.skipped && !consent.skipped.startsWith('no project memory db'))) { returnClaim(claimed); return replayed; }
            const options = { rawInput: JSON.stringify(job.payload), host: job.host, env,
              budgetMs: Math.max(0, deadlineAt - now()), deadlineAt, signal,
              makeStoreFactory: () => makeStoreFactory(deadlineAt), now, ordered: held, writeMetadata: false,
              // A queued job was admitted at its live boundary; replay must not re-run (or be suspended by) enrollment.
              enrollMemory: () => ({ state: 'existing' }),
              captureTurn: () => ({ recorded: false, skipped: 'detached replay' }),
              captureEvents: () => ({ recorded: 0, skipped: 'detached replay' }) };
            const result = job.payload?.normalizedTransition ? captureNormalized(job, options)
              : runCapture(job.originProjectDir || projectDir, job.event, options);
            committed = now() < deadlineAt && !signal?.aborted && result?.progressionCaptured === true && Boolean(result.receipt);
            if (committed) onCaptured?.(result);
          }
        } catch { /* retain the queue until an exact-readback receipt exists */ }
        if (!committed) { returnClaim(claimed); return replayed; }
        try { fs.rmSync(claimed, { force: true }); } catch { /* best effort */ }
      }
    } catch { /* the debt stays durable; the next boundary hands it on again */ } finally {
      releaseReplayLock(projectDir, held);
    }
    held = !signal?.aborted && now() < deadlineAt && queuedWork(projectDir) ? takeReplayLock(projectDir) : null;
  }
  if (held) releaseReplayLock(projectDir, held);
  return replayed;
}


/** Synchronous bounded startup drain. Pending debt must downgrade restore, never disappear. */
export function drainCaptureQueue({ projectDir, budgetMs = 1000, ...options } = {}) {
  if (operatorProgressionSuspension(options.env || process.env)) return { state: 'suspended', replayed: 0, pending: null };
  const startedAt = Date.now();
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, startedAt + budgetMs);
  if (options.signal?.aborted || startedAt >= deadlineAt) return { state: 'pending', replayed: 0, pending: null, reason: 'restore deadline exceeded' };
  const resolution = resolveProjectStore({ projectDir, gitTimeoutMs: Math.max(1, Math.min(300, budgetMs)), deadlineAt });
  const root = resolution.projectRoot;
  const replayed = runOutboxReplay({ ...options, deadlineAt, projectDir: root, budgetMs: Math.max(0, deadlineAt - Date.now()) });
  let outboxPending = 0;
  try { outboxPending = new ProgressionOutbox({ projectRoot: root }).pendingSnapshots().length; } catch { return { state: 'degraded', replayed, pending: null }; }
  const pending = queuedWork(root) + outboxPending;
  return { state: pending ? 'pending' : 'settled', replayed, pending };
}
