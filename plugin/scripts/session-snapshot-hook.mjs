/**
 * The lifecycle memory boundary. It only CALLS ruflo (owner ruling 2026-10-12): the hand-rolled
 * progression store, outbox, capture queue and replay worker were deleted after a live-size copy of the
 * owner's store (1,763 cumulative snapshots, 751 MB; a 3.38 GB outbox; 36k queued jobs) ran Stop,
 * PreCompact and SessionEnd into the 8.5 s watchdog on every fire.
 *
 *   Stop                  → the turn outcome: `ruflo memory store` in namespace `turns` + exact-key readback
 *   PreCompact/SessionEnd → turn distillation (detached `ruflo memory distill run`) and one append-only
 *                           `project-state-auto-<ms>` checkpoint, read back by exact key
 *   PostToolUse           → learning observation (consent-gated) via `ruflo memory store`
 *
 * A refused or unverified write is recorded in the hook-failures ledger and summarized at the next
 * SessionStart. Advisory always: exit 0. `.swarm` is never created here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectDirectory } from './project-identity.mjs';
import { resolveTurnDb, captureTurnOutcome } from './turn-outcome-capture.mjs';
import { recordHookFailure } from './hook-failures.mjs';
import { redactText } from './continuity-events.mjs';

/** hooks.json gives this boundary 10 s; the shim's watchdog fires at 8.5 s. Plan inside it. */
export const CAPTURE_BUDGET_MS = 8_000;

/**
 * The budget this invocation really has. The Codex wrapper hands its own kill deadline down as
 * RUVNET_CODEX_BUDGET_MS (2200 ms at SessionEnd, which Codex caps at 3 s); 300 ms is left for the
 * adapter → shim → body spawns.
 */
export function effectiveBudgetMs(env = process.env) {
  const handed = Number(env.RUVNET_CODEX_BUDGET_MS);
  return Number.isFinite(handed) && handed > 0 ? Math.max(0, Math.min(CAPTURE_BUDGET_MS, handed - 300)) : CAPTURE_BUDGET_MS;
}

/**
 * What one checkpoint needs: a store plus an exact readback, each measured at 0.5-1.3 s on a live-size
 * store (ADR-106). With less left (Codex gives SessionEnd ~1.9 s for everything) it is handed to a
 * detached, bounded child instead of being started with a ~1 ms timeout (review M4).
 */
export const CHECKPOINT_NEED_MS = 2_600;

async function checkpointNow({ projectDir, event, payload, env, deadlineAt, brainHome }) {
  // Same consent as turn capture: a persisted opt-out, or a project without a store, writes nothing.
  const consent = resolveTurnDb({ projectDir, brainHome, deadlineAt });
  if (consent.skipped) return { stored: false, skipped: consent.skipped };
  const { checkpoint } = await import('./ruflo-memory-hooks.mjs');
  const saved = await checkpoint({ projectDir, event, payload, env, deadlineAt });
  if (saved.stored === false && saved.key || saved.stored && saved.verified !== true) {
    recordHookFailure({ hook: 'checkpoint', event, error: saved.skipped || 'exact checkpoint readback failed' }, { brainHome });
  }
  return saved;
}

/** The detached checkpoint: its own full budget, the same consent, the same ledger on failure. */
export function detachCheckpoint({ projectDir, event, payload, env, brainHome }) {
  const job = JSON.stringify({ projectDir, session_id: payload?.session_id ?? null });
  const childEnv = { ...env, RUVNET_CHECKPOINT_JOB: job, RUVNET_BRAIN_HOME: brainHome };
  delete childEnv.RUVNET_CODEX_BUDGET_MS;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--checkpoint-detached', event],
    { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: childEnv });
  child.unref();
  return { detached: true, pid: child.pid };
}

export async function runLifecycleBoundary(event, payload, { env = process.env, deadlineAt = Date.now() + effectiveBudgetMs(env) } = {}) {
  const projectDir = typeof payload?.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : projectDirectory();
  const host = env.RUVNET_HOOK_HOST || 'claude';
  if (event === 'PostToolUse') {
    const { captureLearning } = await import('./learn-capture.mjs');
    return { learning: captureLearning(payload, { env, detach: true }) };
  }
  if (!['Stop', 'PreCompact', 'SessionEnd'].includes(event)) return { skipped: `no lifecycle memory at ${event}` };
  const turn = captureTurnOutcome({ projectDir, event, payload, host, env, deadlineAt });
  if (event === 'Stop') return { turn };
  try { // the observation rows are distilled by rUv's `memory distill run`, detached and bounded (review M3)
    const { learningContext } = await import('./runtime-preferences.mjs');
    if (learningContext().enabled) (await import('./learn-capture.mjs')).detachLearning('--distill', { env });
  } catch (error) { recordHookFailure({ hook: 'learn-distill', event, error: `detach failed: ${error.code || 'spawn'}` }); }
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') return { turn, checkpoint: { stored: false, skipped: 'RUVNET_TURN_CAPTURE=off' } };
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  if (deadlineAt - Date.now() < CHECKPOINT_NEED_MS) {
    try { return { turn, checkpoint: { stored: false, ...detachCheckpoint({ projectDir, event, payload, env, brainHome }) } }; } catch (error) {
      recordHookFailure({ hook: 'checkpoint', event, error: `skipped: hook budget too small and detach failed (${error.code || 'spawn'})` }, { brainHome });
      return { turn, checkpoint: { stored: false, skipped: 'hook budget too small; detach failed' } };
    }
  }
  return { turn, checkpoint: await checkpointNow({ projectDir, event, payload, env, deadlineAt, brainHome }) };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  const loud = (event) => (error) => {
    // ADVISORY, ALWAYS: exit 0 — but LOUD (review M1): the shim records only nonzero exits, so a thrown
    // error is a ledger row here. A fixed-length reason, never payload text.
    recordHookFailure({ hook: 'session-snapshot', event, error: `threw: ${redactText(String(error?.message || error)).slice(0, 120)}` });
    process.stderr.write(`[session-snapshot] ${error?.message}\n`);
  };
  if (process.argv[2] === '--checkpoint-detached') {
    const event = process.argv[3] || 'SessionEnd';
    let job = {}; try { job = JSON.parse(process.env.RUVNET_CHECKPOINT_JOB || '{}'); } catch { /* invalid job: nothing to do */ }
    const brainHome = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
    if (typeof job.projectDir === 'string' && path.isAbsolute(job.projectDir)) {
      checkpointNow({ projectDir: job.projectDir, event, payload: { session_id: job.session_id }, env: process.env,
        deadlineAt: Date.now() + CAPTURE_BUDGET_MS, brainHome }).catch(loud(event));
    }
  } else {
    const event = process.argv[2] || 'SessionEnd';
    let payload = {};
    try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* malformed or absent input */ }
    runLifecycleBoundary(event, payload).catch(loud(event));
  }
}
