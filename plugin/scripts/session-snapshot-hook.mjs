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
  const idle = { metadataWritten, progressionCaptured: false, receipt: null, turn };

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
        + `${queued ? (handed ? ', handed to a detached worker' : ' (a live worker holds the lock and drains the queue)') : ''}` };
  };
  if (!ordered) {
    token = takeReplayLock(root);
    if (!token) return handOff('a worker is committing older work');
    const queuedAhead = queuedCaptures(root).length;
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
      replayed,
      receipt: result.receipt,
      provenance: produced.provenance,
    };
  } finally {
    if (!ordered && !handedLock) releaseReplayLock(root, token);
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
const readLock = (projectDir) => { try { return fs.readFileSync(lockPath(projectDir), 'utf8').trim(); } catch { return null; } };
let queueSeq = 0;

/** Queue one boundary's capture for the worker (0600, inside the project's own .swarm), in arrival order. */
export function queueCapture({ projectDir, event, host, payload, now = Date.now() }) {
  try {
    queueSeq += 1;
    const name = `${QUEUE_PREFIX}${String(now).padStart(15, '0')}-${String(process.hrtime.bigint() % 1_000_000_000n).padStart(9, '0')}-${process.pid}-${queueSeq}.json`;
    const file = path.join(projectDir, '.swarm', name);
    fs.writeFileSync(file, JSON.stringify({ event, host, payload }), { flag: 'wx', mode: 0o600 });
    return file;
  } catch { return null; }
}

export function queuedCaptures(projectDir) {
  try {
    return fs.readdirSync(path.join(projectDir, '.swarm')).filter((n) => n.startsWith(QUEUE_PREFIX) && n.endsWith('.json'))
      .sort().map((n) => path.join(projectDir, '.swarm', n));
  } catch { return []; }
}

/**
 * Take the lock. Returns this holder's TOKEN, or null when a live holder has it. A lock not refreshed
 * for REPLAY_LOCK_STALE_MS belongs to a dead worker and is taken over: renamed aside first, so two
 * would-be successors cannot both win the exclusive create.
 */
export function takeReplayLock(projectDir, now = Date.now()) {
  const lock = lockPath(projectDir);
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const create = () => { fs.writeFileSync(lock, `${token}\n`, { flag: 'wx', mode: 0o600 }); return token; };
  try { return create(); } catch { /* held, or stale */ }
  try {
    if (now - fs.statSync(lock).mtimeMs <= REPLAY_LOCK_STALE_MS) return null;
    const aside = `${lock}.stale-${process.pid}-${now}`;
    fs.renameSync(lock, aside);
    fs.rmSync(aside, { force: true });
    return create();
  } catch { return null; }
}

/** Heartbeat: refresh the lock's mtime if (and only if) this holder still owns it. */
export function refreshReplayLock(projectDir, token) {
  if (!token || readLock(projectDir) !== token) return false;
  try { const t = new Date(); fs.utimesSync(lockPath(projectDir), t, t); return true; } catch { return false; }
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
 * The detached worker's body, holding the lock `token`: replay the outbox, then run every queued capture
 * IN ORDER — each re-entering the boundary as `ordered`, so it replays before it produces — refreshing
 * the lock between steps and STOPPING the moment the lock is no longer its own (a successor took it
 * over: running on would duplicate its work). Releases only its own lock, then re-checks for captures
 * queued while it held it.
 */
export function runOutboxReplay({ projectDir, token = process.env.RUVNET_REPLAY_LOCK_TOKEN || null, budgetMs = DETACHED_REPLAY_BUDGET_MS,
  makeStoreFactory = boundedStoreFactory, now = Date.now, runCapture = runSessionSnapshotHook } = {}) {
  let held = token || takeReplayLock(projectDir);
  let replayed = 0;
  for (let round = 0; held && round < 8; round += 1) {
    try {
      if (!refreshReplayLock(projectDir, held)) return replayed;
      const resolution = resolveProjectStore({ projectDir });
      const store = makeStoreFactory(now() + budgetMs)({ projectDir, requestedStorePath: resolution.canonicalAgentDbPath });
      for (const snapshot of store.outbox.pendingSnapshots()) {
        if (!refreshReplayLock(projectDir, held)) return replayed;
        store.outbox.markCommitted(store.appendExact(snapshot));
        replayed += 1;
      }
      for (const file of queuedCaptures(projectDir)) {
        if (!refreshReplayLock(projectDir, held)) return replayed;
        let job = null;
        try { job = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* torn: dropped below */ }
        try {
          if (job) runCapture(projectDir, job.event, { rawInput: JSON.stringify(job.payload), host: job.host,
            budgetMs, makeStoreFactory, now, ordered: held, writeMetadata: false,
            captureTurn: () => ({ recorded: false, skipped: 'detached replay' }) });
        } catch { /* a failed capture leaves its own snapshot durable in the outbox */ }
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    } catch { /* the debt stays durable; the next boundary hands it on again */ } finally {
      releaseReplayLock(projectDir, held);
    }
    held = queuedCaptures(projectDir).length ? takeReplayLock(projectDir) : null;
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
    runSessionSnapshotHook(projectDirectory(), process.argv[2] || 'SessionEnd', { rawInput });
  } catch (error) {
    // ADVISORY, ALWAYS. A capture boundary fires at Stop, PreCompact and SessionEnd; one that can
    // return a non-zero status can interrupt a turn, a compaction, or a clean exit. Report and exit 0.
    process.stderr.write(`[project-progression] ${error.message}\n`);
  }
}
