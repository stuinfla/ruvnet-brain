import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProgressionOutbox } from './project-progression-outbox.mjs';
import {
  captureProjectTransition,
  hasProjectProgression,
} from './project-progression-hook.mjs';
import { createSessionSnapshot } from './session-snapshot-contract.mjs';
import { projectDirectory } from './project-identity.mjs';
import { buildProjectProgression } from './project-progression-producer.mjs';
import { ProjectProgressionStore } from './project-progression-store.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { captureTurnOutcome } from './turn-outcome-capture.mjs';
import { captureContinuityEvents, stopNotice } from './continuity-journal.mjs';

/**
 * The capture boundary's whole budget. hooks.json declares 10s; this keeps the internal work well
 * inside it so the host never has to kill us, and so a slow store degrades to "no snapshot this
 * time" rather than to a hung turn. Capture is advisory: it fails open, always.
 */
export const CAPTURE_BUDGET_MS = 8_000;

/**
 * Replaying an interrupted session's outbox costs one `ruflo` write per pending snapshot, each ~3s
 * cold (project-progression-store.mjs). Under this budget there is room for the NEW snapshot or the
 * old ones, not both — and the new one is the one nothing else will ever write.
 */
export const REPLAY_MIN_BUDGET_MS = 4_000;

/**
 * The budget this invocation really has. The Codex wrapper hands its own kill deadline down as
 * RUVNET_CODEX_BUDGET_MS (2200ms at SessionEnd, which Codex caps at 3s); planning for 8s there meant
 * being SIGKILLed mid-write with nothing reported. 300ms is left for the adapter → shim → body spawns.
 */
export function effectiveBudgetMs(env = process.env) {
  const handed = Number(env.RUVNET_CODEX_BUDGET_MS);
  return Number.isFinite(handed) && handed > 0 ? Math.max(0, Math.min(CAPTURE_BUDGET_MS, handed - 300)) : CAPTURE_BUDGET_MS;
}

function regularOrAbsent(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function writeSessionSnapshot(projectDir, event) {
  const swarm = path.join(projectDir, '.swarm');
  const target = path.join(swarm, 'agentdb-sessions.jsonl');
  try {
    // WE DO NOT CREATE `.swarm` — WE ONLY WRITE INTO ONE THAT EXISTS.
    //
    // This hook runs machine-wide, so `mkdirSync(swarm)` planted a `.swarm/` directory in EVERY
    // repository the user opened, alongside a session receipt they never asked for. Measured
    // 2026-08-14 by the both-hosts conformance gate, in a temp project with no git and no brain
    // artifacts: PreCompact, PostToolUse and SessionEnd each left `.swarm` behind. ADR-058 D5 —
    // never touch what we do not own — and the owner's report was blunter: opening the plugin in
    // another project produced files and errors he did not ask for.
    //
    // `.swarm` is Ruflo's own convention and `ruflo init` creates it, so its PRESENCE is the
    // project's opt-in and its ABSENCE is a project that has not adopted the brain. Writing a
    // receipt into a store that exists is participation; conjuring the store is trespass.
    if (!fs.existsSync(swarm)) return false;
    const stat = fs.lstatSync(swarm);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (!regularOrAbsent(target)) return false;
    fs.appendFileSync(target, `${JSON.stringify(createSessionSnapshot({ event }))}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A deadline-bounded `ruflo` runner. The store's own 120s per-call timeout is right for a deliberate
 * CLI invocation and far too generous for a lifecycle hook, so the remaining budget caps every call.
 */
function boundedStoreFactory(deadlineAt) {
  return (options) => new ProjectProgressionStore({
    ...options,
    runner: (binary, args, runOptions) => {
      const remaining = deadlineAt - Date.now();
      if (remaining < 1) throw new Error('capture budget exceeded');
      const result = spawnSync(binary, args, {
        ...runOptions,
        timeout: Math.min(runOptions.timeout ?? remaining, remaining),
        shell: false,
      });
      if (result.error) throw new Error(`capture budget exceeded: ${result.error.message}`);
      return result;
    },
  });
}

/**
 * THE AUTOMATIC CAPTURE BOUNDARY.
 *
 * Before this, `captureProjectTransition` could only run when a host payload already carried a
 * `projectProgression` extension — and no host emits one, so nothing was ever captured. Now the
 * producer BUILDS that extension from real sources (git, the work ledger, the owner's own
 * `project-state-current` note, the prior head, and a bounded transcript reference) whenever the
 * payload does not supply one. An explicitly supplied extension still wins: that is how
 * /ruvnet-brain:checkpoint hands over a state the model actually wrote.
 *
 * Two things are deliberately NOT done here:
 *   • `.swarm` is never created. Its absence means the project has not adopted the brain, and a
 *     lifecycle hook that plants a store in every repository the user opens is trespass (see above).
 *   • No exception escapes. A capture boundary that can fail a turn is worse than a missed snapshot.
 */
export function runSessionSnapshotHook(projectDir, event, {
  rawInput = '',
  host = process.env.RUVNET_HOOK_HOST || 'claude',
  captureProgression = captureProjectTransition,
  produce = buildProjectProgression,
  budgetMs = effectiveBudgetMs(),
  now = Date.now,
  captureTurn = captureTurnOutcome,
  writeMetadata = true,
  makeStoreFactory = boundedStoreFactory,
  spawnReplay = replayOutboxDetached,
  ordered = null,
  captureEvents = captureContinuityEvents,
} = {}) {
  // The detached worker re-runs a QUEUED boundary; its session receipt was already written then.
  const metadataWritten = writeMetadata ? writeSessionSnapshot(projectDir, event) : false;
  let payload;
  try { payload = rawInput ? JSON.parse(rawInput) : {}; } catch { payload = {}; }
  // TURN OUTCOMES FIRST, and independent of `.swarm`: every turn in every repository is recorded
  // (a project without `.swarm` records to the machine-wide db outside it — turn-outcome-capture.mjs).
  // It only reads and spawns a detached writer, so it costs the progression budget below nothing.
  let turn;
  try { turn = captureTurn({ projectDir, event, payload, host }); } catch (error) {
    turn = { recorded: false, skipped: `turn capture failed: ${error.message}` };
  }
  // MATERIAL EVENTS (continuity-journal.mjs): commits, releases, gates, findings, decisions, lessons —
  // journalled to the durable outbox with one fsync and committed by a detached drainer. Like turn
  // capture it is independent of the progression lock below and costs this boundary only a read.
  let continuity;
  try { continuity = captureEvents({ projectDir, event, payload, host }); } catch (error) {
    continuity = { recorded: 0, skipped: `continuity capture failed: ${error.message}` };
  }
  const idle = { metadataWritten, progressionCaptured: false, receipt: null, turn, continuity };

  if (hasProjectProgression(payload)) {
    if (payload.hook_event_name !== event) {
      throw new Error(`progression boundary mismatch: expected ${event}, received ${payload.hook_event_name}`);
    }
    const result = captureProgression({ host, payload, projectDir });
    return { ...idle, progressionCaptured: true, receipt: result.receipt };
  }

  // A payload with no session identity is not a real lifecycle event (an empty `{}` from a probe,
  // a malformed host). Capturing against an invented session id would fabricate a journal entry.
  if (typeof payload.session_id !== 'string' || !payload.session_id) {
    return { ...idle, skipped: 'no session identity in the host payload' };
  }

  let resolution;
  try { resolution = resolveProjectStore({ projectDir }); } catch {
    return { ...idle, skipped: 'project store could not be resolved' };
  }
  if (!fs.existsSync(path.dirname(resolution.canonicalAgentDbPath))) {
    return { ...idle, skipped: 'project has not adopted the canonical store' };
  }

  const root = resolution.projectRoot;
  const pendingCount = () => {
    try { return new ProgressionOutbox({ projectRoot: root }).pendingSnapshots().length; } catch { return 0; }
  };

  // CAUSAL ORDER. The producer links a new snapshot to the COMMITTED heads
  // (project-progression-producer.mjs), so a snapshot produced while older work is uncommitted would
  // not descend from it and the project would end with two unrelated heads
  // (tests/acceptance/cross-host-project-resume.test.mjs). "Older work" is BOTH the outbox (captures
  // interrupted after their fsync) AND the capture queue (whole boundaries waiting for a worker).
  //
  // THE REPLAY LOCK IS THE RIGHT TO COMMIT IN ORDER (4.4.0 re-review S-A). Every boundary takes it
  // before doing anything that commits. If it cannot — a live worker holds it — or older work is
  // queued, or (on a short budget) outbox debt cannot be replayed here, this boundary QUEUES itself
  // behind that work and the lock passes to a DETACHED, bounded worker that drains everything in
  // order. On Codex no boundary has the replay budget (Stop 3700ms effective, SessionEnd 1900ms, no
  // PreCompact). Any boundary, of any budget, therefore also drains a queue a dead worker stranded.
  // `ordered` is the worker's own re-entry: it already holds the lock and is draining in order.
  let token = ordered;
  const handOff = (why) => {
    const queued = queueCapture({ projectDir: root, event, host, payload });
    const handed = queued ? spawnReplay({ projectDir: root, token }) : false;
    if (!handed && token && token !== ordered) releaseReplayLock(root, token);
    return { ...idle, replayed: 0, progressionCaptured: false, deferredToReplayer: Boolean(queued),
      replaySkipped: `${why}; this capture ${queued ? 'queued behind it' : 'NOT queued (queue unwritable)'}`
        + `${queued ? (handed ? ', handed to a detached worker' : ' (the current lock holder hands the queue to a worker when it releases)') : ''}` };
  };
  if (!ordered) {
    token = takeReplayLock(root);
    if (!token) return handOff('a worker is committing older work');
    const queuedAhead = queuedWork(root);
    if (queuedAhead) return handOff(`${queuedAhead} older capture(s) queued`);
    if (budgetMs < REPLAY_MIN_BUDGET_MS) {
      const pending = pendingCount();
      if (pending) return handOff(`outbox replay deferred: budget ${budgetMs}ms < ${REPLAY_MIN_BUDGET_MS}ms; ${pending} pending`);
    }
  }

  let handedLock = false;
  try {
    const deadlineAt = now() + budgetMs;
    const storeFactory = makeStoreFactory(deadlineAt);
    let replayed = 0;
    if (budgetMs >= REPLAY_MIN_BUDGET_MS) {
      try {
        replayed = storeFactory({ projectDir, requestedStorePath: resolution.canonicalAgentDbPath }).replay().length;
      } catch { /* the debt stays durable in the outbox; this capture is still worth attempting */ }
    }

    // Before COMMITTING anything, re-check the lock is still ours: with three racers, a stale-lock
    // put-back can leave a holder that no longer owns it. One that lost it queues itself instead.
    if (!ordered && !refreshReplayLock(root, token)) {
      token = null;
      handedLock = true;   // nothing of ours to release
      return handOff('the lock was taken over before this capture committed');
    }

    let produced;
    try {
      produced = produce({ resolution, payload, host, trigger: event });
    } catch (error) {
      return { ...idle, replayed, skipped: `producer failed: ${error.message}` };
    }
    if (produced.skipped) return { ...idle, replayed, skipped: produced.skipped.reason };

    let result;
    try {
      result = captureProgression({
        host,
        payload: { ...payload, hook_event_name: event, projectProgression: produced.projectProgression },
        projectDir,
        storeFactory,
      });
    } catch (error) {
      // NOT LOST — DEFERRED. capture() fsyncs the snapshot to the durable outbox BEFORE it writes to
      // the store, so a budget overrun leaves the evidence on disk. On a short budget nothing later in
      // this process can settle it, so the lock goes straight to a detached worker.
      handedLock = !ordered && budgetMs < REPLAY_MIN_BUDGET_MS && pendingCount() > 0 && spawnReplay({ projectDir: root, token });
      return { ...idle, replayed, skipped: `capture deferred: ${error.message}`,
        ...(handedLock ? { replaySkipped: 'deferred capture handed to a detached worker' } : {}) };
    }
    return {
      metadataWritten,
      progressionCaptured: true,
      turn,
      continuity,
      replayed,
      receipt: result.receipt,
      provenance: produced.provenance,
    };
  } finally {
    // A boundary that fired while this one held the lock queued itself and could not start a worker
    // (this lock was in the way). Releasing without looking stranded it until the next boundary — two
    // simultaneous SessionEnds lost the second one's final state (4.4.1). So: queued work → hand THIS
    // lock to a worker; and re-check after releasing, for a boundary that queued in between.
    if (!ordered && !handedLock) {
      if (!(queuedWork(root) && spawnReplay({ projectDir: root, token }))) {
        releaseReplayLock(root, token);
        if (queuedWork(root)) spawnReplay({ projectDir: root });
      }
    }
  }
}

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
export function queueCapture({ projectDir, event, host, payload }) {
  const body = JSON.stringify({ event, host, payload });
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const seq = Math.max(0, ...swarmEntries(projectDir).filter((n) => n.startsWith(QUEUE_PREFIX) || n.startsWith(CLAIM_PREFIX)).map(seqOf)) + 1;
    const file = path.join(projectDir, '.swarm', `${QUEUE_PREFIX}${String(seq).padStart(12, '0')}.json`);
    try { fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); return file; } catch (error) {
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
export function replayOutboxDetached({ projectDir, token = null, spawnFn = spawn } = {}) {
  const held = token || takeReplayLock(projectDir);
  if (!held) return false;
  try {
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), '--replay-outbox'], {
      cwd: projectDir, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, RUVNET_REPLAY_LOCK_TOKEN: held },
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
  makeStoreFactory = boundedStoreFactory, now = Date.now, runCapture = runSessionSnapshotHook, onClaim = null } = {}) {
  let held = token || takeReplayLock(projectDir);
  let replayed = 0;
  for (let round = 0; held && round < 8; round += 1) {
    try {
      if (!adoptReplayLock(projectDir, held)) return replayed;
      reclaimOrphans(projectDir);
      const resolution = resolveProjectStore({ projectDir });
      const store = makeStoreFactory(now() + budgetMs)({ projectDir, requestedStorePath: resolution.canonicalAgentDbPath });
      for (const snapshot of store.outbox.pendingSnapshots()) {
        if (!refreshReplayLock(projectDir, held)) return replayed;
        store.outbox.markCommitted(store.appendExact(snapshot));
        replayed += 1;
      }
      for (const file of queuedCaptures(projectDir)) {
        if (!refreshReplayLock(projectDir, held)) return replayed;
        const claimed = claimQueued(file);
        if (!claimed) continue;
        onClaim?.(claimed);
        if (!refreshReplayLock(projectDir, held)) {
          returnClaim(claimed);
          return replayed;
        }
        let job = null;
        try { job = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch { /* torn: dropped below */ }
        try {
          if (job) runCapture(projectDir, job.event, { rawInput: JSON.stringify(job.payload), host: job.host,
            budgetMs, makeStoreFactory, now, ordered: held, writeMetadata: false,
            captureTurn: () => ({ recorded: false, skipped: 'detached replay' }),
            captureEvents: () => ({ recorded: 0, skipped: 'detached replay' }) });
        } catch { /* a failed capture leaves its own snapshot durable in the outbox */ }
        try { fs.rmSync(claimed, { force: true }); } catch { /* best effort */ }
      }
    } catch { /* the debt stays durable; the next boundary hands it on again */ } finally {
      releaseReplayLock(projectDir, held);
    }
    held = queuedWork(projectDir) ? takeReplayLock(projectDir) : null;
  }
  return replayed;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs') && process.argv[2] === '--replay-outbox') {
  try { runOutboxReplay({ projectDir: process.cwd() }); } catch { /* the debt stays durable in the outbox */ }
} else if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  // projectDirectory() is the SAME derivation the Console's detector uses. Deriving it here
  // independently is what let this hook write a receipt the Console then reported as missing (#85).
  const rawInput = fs.readFileSync(0, 'utf8');
  try {
    const result = runSessionSnapshotHook(projectDirectory(), process.argv[2] || 'SessionEnd', { rawInput });
    // FAIL LOUDLY, NEVER SILENTLY — AND ONCE. When recording is stuck (events pending past STUCK_AFTER_MS,
    // a quarantined conflict, a corrupt outbox line, a cap drop) Claude Code shows this systemMessage, at
    // most once per session per condition (stopNotice; it used to repeat at every turn). "Not applicable"
    // (no store, no ruflo) is never stuck. Codex is excluded on purpose: its Stop schema turns any `reason`
    // into a BLOCK (codex-hook-adapter.mjs), and a recording problem must never hold a turn open.
    const host = process.env.RUVNET_HOOK_HOST || 'claude';
    const { status, journal } = result?.continuity || {};
    if (host === 'claude' && status?.stuck && journal) {
      let session = null;
      try { session = JSON.parse(rawInput || '{}').session_id || null; } catch { /* no session: still once per 'unknown' */ }
      const message = stopNotice({ journal, status, session });
      if (message) process.stdout.write(JSON.stringify({ systemMessage: message }));
    }
  } catch (error) {
    // ADVISORY, ALWAYS. A capture boundary fires at Stop, PreCompact and SessionEnd; one that can
    // return a non-zero status can interrupt a turn, a compaction, or a clean exit. Report and exit 0.
    process.stderr.write(`[project-progression] ${error.message}\n`);
  }
}
