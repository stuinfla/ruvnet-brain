import { DETACHED_REPLAY_BUDGET_MS, REPLAY_LOCK_STALE_MS, REPLAY_LOCK_ABANDON_MS, pidAlive, queueCapture, queuedCaptures, queuedWork, processStart, reclaimOrphans, takeReplayLock, refreshReplayLock, adoptReplayLock, releaseReplayLock, replayOutboxDetached, runOutboxReplay, drainCaptureQueue } from './project-capture-queue.mjs';
export { DETACHED_REPLAY_BUDGET_MS, REPLAY_LOCK_STALE_MS, REPLAY_LOCK_ABANDON_MS, pidAlive, queueCapture, queuedCaptures, queuedWork, processStart, reclaimOrphans, takeReplayLock, refreshReplayLock, adoptReplayLock, releaseReplayLock, replayOutboxDetached, runOutboxReplay, drainCaptureQueue } from './project-capture-queue.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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
import { resolveTurnDb, captureTurnOutcome } from './turn-outcome-capture.mjs';
import { captureContinuityEvents, stopNotice } from './continuity-journal.mjs';
import { automaticProgressionSuspensionResult } from './project-progression-suspension.mjs';

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
export function boundedStoreFactory(deadlineAt) {
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
  env = process.env,
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
  const suspended = (reason) => ({ metadataWritten: false, progressionCaptured: false, receipt: null, skipped: reason,
    turn: { event, recorded: false, skipped: reason }, continuity: { event, recorded: 0, launched: false, skipped: reason } });
  // Consent is checked before metadata, transcript inspection or any durable capture queue.
  try {
    const consent = resolveTurnDb({ projectDir, brainHome: env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain'),
      gitTimeoutMs: Math.max(1, Math.min(500, budgetMs)) });
    if (consent.skipped) return suspended(consent.skipped);
  } catch (error) {
    return suspended(`capture consent unavailable: ${error.message}`);
  }
  // The detached worker re-runs a QUEUED boundary; its session receipt was already written then.
  const metadataWritten = writeMetadata ? writeSessionSnapshot(projectDir, event) : false;
  let payload;
  try { payload = rawInput ? JSON.parse(rawInput) : {}; } catch { payload = {}; }
  // TURN OUTCOMES FIRST: consent and canonical store availability govern whether a turn is queued
  // (a project without a store requires persisted opt-in — turn-outcome-capture.mjs).
  // It only reads and spawns a detached writer, so it costs the progression budget below nothing.
  let turn;
  try { turn = captureTurn({ projectDir, event, payload, host, env }); } catch (error) {
    turn = { recorded: false, skipped: `turn capture failed: ${error.message}` };
  }
  // MATERIAL EVENTS (continuity-journal.mjs): commits, releases, gates, findings, decisions, lessons —
  // journalled to the durable outbox with one fsync and committed by a detached drainer. Like turn
  // capture it is independent of the progression lock below and costs this boundary only a read.
  let continuity;
  try { continuity = captureEvents({ projectDir, event, payload, host, env }); } catch (error) {
    continuity = { recorded: 0, skipped: `continuity capture failed: ${error.message}` };
  }
  const idle = { metadataWritten, progressionCaptured: false, receipt: null, turn, continuity };
  const operatorSuspended = automaticProgressionSuspensionResult(env, idle);
  if (operatorSuspended) return operatorSuspended;

  if (hasProjectProgression(payload)) {
    if (payload.hook_event_name !== event) {
      throw new Error(`progression boundary mismatch: expected ${event}, received ${payload.hook_event_name}`);
    }
    const result = captureProgression({ host, payload, projectDir, recoverFrozen: Boolean(ordered),
      canCommit: () => Boolean(ordered) && refreshReplayLock(resolveProjectStore({ projectDir }).projectRoot, ordered), storeFactory: (options) => makeStoreFactory(now() + budgetMs)({ ...options, env }) });
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
    let frozen;
    try { frozen = produce({ resolution, projectDir, payload, host, trigger: event }); } catch { frozen = null; }
    const queued = frozen?.projectProgression ? queueCapture({ projectDir: root, originProjectDir: projectDir, env, event, host,
      payload: { session_id: payload.session_id, hook_event_name: event, projectProgression: frozen.projectProgression } }) : null;
    const handed = queued ? spawnReplay({ projectDir: root, token, env }) : false;
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
    const storeFactory = (options) => makeStoreFactory(deadlineAt)({ ...options, env });
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
      produced = produce({ resolution, projectDir, payload, host, trigger: event });
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
      handedLock = !ordered && budgetMs < REPLAY_MIN_BUDGET_MS && pendingCount() > 0 && spawnReplay({ projectDir: root, token, env });
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
      if (!(queuedWork(root) && spawnReplay({ projectDir: root, token, env }))) {
        releaseReplayLock(root, token);
        if (queuedWork(root)) spawnReplay({ projectDir: root, env });
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs') && process.argv[2] === '--replay-outbox') {
  try { runOutboxReplay({ projectDir: process.cwd() }); } catch { /* the debt stays durable in the outbox */ }
} else if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')
  && ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop'].includes(process.argv[2])) {
  // Compatibility entrypoint uses the same minimized transition producer as direct registrations.
  // Finish evaluating this module before importing its transition consumer.
  void (async () => {
  try {
    const { runProjectTransitionHook } = await import('./project-transition-hook.mjs');
    const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const result = runProjectTransitionHook(payload.cwd || projectDirectory(), process.argv[2], { payload });
    if (result.state === 'pending') process.stdout.write(JSON.stringify({ systemMessage: 'Project memory transition remains pending; exact readback was not verified.' }));
  } catch { process.stdout.write(JSON.stringify({ systemMessage: 'Project memory transition capture degraded; exact readback was not verified.' })); }
  })();
} else if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  // projectDirectory() is the SAME derivation the Console's detector uses. Deriving it here
  // independently is what let this hook write a receipt the Console then reported as missing (#85).
  const rawInput = fs.readFileSync(0, 'utf8');
  try {
    let originProjectDir = projectDirectory();
    try {
      const cwd = JSON.parse(rawInput || '{}').cwd;
      if (typeof cwd === 'string' && path.isAbsolute(cwd)) originProjectDir = cwd;
    } catch { /* malformed input keeps the host's project fallback */ }
    const result = runSessionSnapshotHook(originProjectDir, process.argv[2] || 'SessionEnd', { rawInput });
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
