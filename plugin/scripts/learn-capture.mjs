#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { recordLearningObservation, distillObservations, observationKey } from './learning-store.mjs';
import { resolveRuflo } from './ruflo-bin.mjs';
import { recordHookFailure } from './hook-failures.mjs';
import { isDirectInvocation } from './entrypoint.mjs';

// LOAD BOUNDS (measured 2026-10-21: one busy session spawned hundreds of concurrent detached `ruflo memory store`
// children, which timed out against each other and wrote 826 ledger rows in a day). Owner ruling 2026-10-12 stands:
// no local queue, no replay — an observation that finds no slot is DROPPED and counted.
export const OBSERVE_SLOTS = 2;           // detached --observe children alive at once, per Brain home
export const SLOT_STALE_MS = 60_000;      // a slot older than this, or held by a dead pid, is reclaimed
export const COALESCE_MS = 10 * 60_000;   // an identical observation key inside this window does not spawn again
const defaultBrainHome = (env) => env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const learnDir = (brainHome, sub) => { const dir = path.join(brainHome, 'learn-capture', sub); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };

/** Parent-side coalescing: marker file per key under `learn-capture/recent/`, pruned when it grows past 256 entries. */
export function recentlyCaptured(brainHome, key, now = Date.now()) {
  try { return now - fs.statSync(path.join(learnDir(brainHome, 'recent'), key)).mtimeMs < COALESCE_MS; } catch { return false; }
}
// #377 residual (sparkling, 2026-10-30): the parent used to call markCaptured() BEFORE the detached child stored
// anything, so a child whose store or exact readback failed left the key acknowledged as captured for the whole
// COALESCE_MS window. Now the parent only marks the key IN FLIGHT (`<key>.pending`, which is never an
// acknowledgement and expires with the child's slot), and the child acknowledges with markCaptured() only after
// recordLearningObservation() has completed its exact readback. A failed child clears the in-flight mark.
const inFlightMarker = (brainHome, key) => path.join(learnDir(brainHome, 'recent'), `${key}.pending`);
export function captureInFlight(brainHome, key, now = Date.now()) {
  try { return now - fs.statSync(inFlightMarker(brainHome, key)).mtimeMs < SLOT_STALE_MS; } catch { return false; }
}
export function markInFlight(brainHome, key) {
  try { fs.writeFileSync(inFlightMarker(brainHome, key), '', { mode: 0o600 }); } catch { /* best effort: coalescing only */ }
}
export function clearInFlight(brainHome, key) {
  try { fs.unlinkSync(inFlightMarker(brainHome, key)); } catch { /* already gone */ }
}
export function markCaptured(brainHome, key, now = Date.now()) {
  const dir = learnDir(brainHome, 'recent');
  try { fs.writeFileSync(path.join(dir, key), '', { mode: 0o600 }); } catch { return; }
  const names = fs.readdirSync(dir);
  if (names.length > 256) for (const name of names) { try { if (now - fs.statSync(path.join(dir, name)).mtimeMs >= COALESCE_MS) fs.unlinkSync(path.join(dir, name)); } catch { /* raced */ } }
}

function slotStale(slot, now) {
  let held;
  try { held = JSON.parse(fs.readFileSync(slot, 'utf8')); } catch { try { return now - fs.statSync(slot).mtimeMs > SLOT_STALE_MS; } catch { return false; } }
  if (!Number.isInteger(held?.pid) || now - Number(held.at) > SLOT_STALE_MS) return true;
  try { process.kill(held.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
/** O_EXCL slot files `learn-capture/slots/slot-N`; a stale one is reclaimed by rename, so only one claimant wins it. */
export function acquireObserveSlot(brainHome, now = Date.now()) {
  const dir = learnDir(brainHome, 'slots');
  for (let i = 0; i < OBSERVE_SLOTS; i += 1) {
    const slot = path.join(dir, `slot-${i}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { fs.writeFileSync(slot, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 }); return slot; } catch (error) { if (error.code !== 'EEXIST') break; }
      if (!slotStale(slot, now)) break;
      const claim = `${slot}.reclaim-${process.pid}`;
      try { fs.renameSync(slot, claim); fs.unlinkSync(claim); } catch { break; } // another claimant took it
    }
  }
  return null;
}
export function releaseObserveSlot(slot, pid = process.pid) {
  try { if (JSON.parse(fs.readFileSync(slot, 'utf8')).pid === pid) fs.unlinkSync(slot); } catch { /* reclaimed already */ }
}

/** Every shed is one fixed-string ledger call; hook-failures.mjs's own window counts the repeats on one row. */
export const SHED_ERROR = 'shed observation (load)';
export function shedObservation(brainHome) {
  recordHookFailure({ hook: 'learn-capture', event: 'PostToolUse', error: SHED_ERROR }, { brainHome });
  return false;
}

// Fixed vocabulary: arbitrary executable names, arguments, basenames and paths never persist.
const verbs = new Set('git npm node python python3 cargo rustc go gh cd ls rg cat export mkdir rm cp mv bash sh curl wget npx ruflo'.split(' '));
const subs = new Set('status diff log show add commit push pull fetch checkout switch branch test run install ci build check fmt clippy auth workflow release memory hooks'.split(' '));
export function safeAction(tool, value) {
  if (typeof value !== 'string') return null;
  if (tool === 'Bash') {
    const [verb, sub] = value.trim().split(/\s+/, 3);
    if (!verbs.has(verb)) return 'command';
    return subs.has(sub) ? `${verb} ${sub}` : verb;
  }
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) return null;
  // Legacy action is minimized again before invocation; no private basename reaches Ruflo argv.
  return 'edit file';
}

/**
 * One PostToolUse observation, written DIRECTLY with `ruflo memory store` + exact-key readback (owner
 * ruling 2026-10-12: no local queue, no flush worker, no replay). It runs in-process from
 * session-snapshot's PostToolUse boundary. learningContext() owns consent and brain-off. A refused or
 * unverified write is LOUD: one row in the hook-failures ledger, summarized at the next SessionStart.
 */
export function captureLearning(input, { env = process.env, binary = resolveRuflo({ env }), brainHome = defaultBrainHome(env), detach = false } = {}) {
  let tool; let action;
  try {
    const context = learningContext();
    if (!context.enabled || !input || typeof input !== 'object') return false;
    if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return false;
    const response = input.tool_response;
    if (typeof response === 'string') {
      const exit = /^Process exited with code (-?\d+)\s*$/m.exec(response);
      if ((exit && Number(exit[1]) !== 0) || /Process running with session ID/.test(response)) return false;
    }
    if (input.error || input.is_error === true || response?.error || response?.interrupted === true || response?.signal
      || response?.success === false || response?.is_error === true || response?.isError === true
      || [response?.exit_code, response?.exitCode, response?.status].some(value => Number.isInteger(value) && value !== 0)) return false;
    tool = input.tool_name;
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return false;
    action = safeAction(tool, tool === 'Bash' ? input.tool_input?.command : 'edit file');
    if (!action) return false;
    if (!binary) throw new Error('ruflo not found'); // one ledger row per 10 min: recordHookFailure counts the repeats
    const observation = { tool, action, session: String(input.session_id || '') };
    const key = observationKey(observation);
    if (recentlyCaptured(brainHome, key)) return true; // identical observation already captured this window: no process
    if (detach && captureInFlight(brainHome, key)) return true; // the same observation is being stored right now
    // Review M3: on the hook path the store + exact readback run in a detached, bounded child, so the
    // tool call returns at once; that child writes the ledger row if the write is refused or unverified.
    if (detach) {
      const slot = acquireObserveSlot(brainHome);
      if (!slot) return shedObservation(brainHome);
      markInFlight(brainHome, key); // NOT an acknowledgement: only the child's exact readback acknowledges (#377)
      return detachLearning('--observe', { env: { ...env, RUFLO_BIN: binary }, brainHome, observation, slot });
    }
    recordLearningObservation(binary, context, observation, { env, deadline: Date.now() + 6000 });
    markCaptured(brainHome, key);
    return true;
  } catch (error) {
    if (tool && action) recordHookFailure({ hook: 'learn-capture', event: 'PostToolUse', error: String(error?.message || error).slice(0, 160) }, { brainHome });
    return false;
  }
}

/**
 * Detached, bounded child (`--observe` one observation, `--distill` the namespace). Only fixed-vocabulary fields
 * cross. The parent's resolved ruflo travels as RUFLO_BIN (resolveRuflo's authoritative seam), so the child never
 * re-resolves it; the slot it holds travels as RUVNET_LEARN_SLOT and is re-stamped with the child's pid.
 */
export function detachLearning(mode, { env = process.env, brainHome, observation, slot } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...env, ...(observation ? { RUVNET_LEARN_OBSERVATION: JSON.stringify(observation) } : {}), ...(brainHome ? { RUVNET_BRAIN_HOME: brainHome } : {}), ...(slot ? { RUVNET_LEARN_SLOT: slot } : {}) } });
  child.unref();
  if (slot) { try { fs.writeFileSync(slot, JSON.stringify({ pid: child.pid, at: Date.now() }), { mode: 0o600 }); } catch { /* reclaimed by age */ } }
  return true;
}

function runDetached(mode) {
  const brainHome = defaultBrainHome(process.env);
  let observation = null;
  const fail = (error) => recordHookFailure({ hook: mode === '--distill' ? 'learn-distill' : 'learn-capture', event: mode === '--distill' ? 'SessionEnd' : 'PostToolUse', error: String(error?.message || error).slice(0, 160) });
  try {
    const context = learningContext(); // consent is re-read: a withdrawn consent writes nothing
    if (!context.enabled) return;
    const binary = resolveRuflo({ env: process.env });
    if (!binary) throw new Error('ruflo not found');
    if (mode === '--distill') { distillObservations(binary, context, { env: process.env }); return; }
    const o = JSON.parse(process.env.RUVNET_LEARN_OBSERVATION || '{}');
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(o.tool) || typeof o.action !== 'string') throw new Error('invalid detached observation');
    observation = { tool: o.tool, action: o.action, session: String(o.session || '') };
    recordLearningObservation(binary, context, observation, { env: process.env, deadline: Date.now() + 14_000, allowed: () => learningContext().enabled });
    markCaptured(brainHome, observationKey(observation)); // acknowledged only after the exact readback succeeded (#377)
  } catch (error) { fail(error); } finally {
    if (observation) clearInFlight(brainHome, observationKey(observation));
    if (process.env.RUVNET_LEARN_SLOT) releaseObserveSlot(process.env.RUVNET_LEARN_SLOT);
  }
}

const isMain = isDirectInvocation(import.meta.url);
if (isMain && ['--observe', '--distill'].includes(process.argv[2])) {
  runDetached(process.argv[2]);
  process.exit(0);
} else if (isMain) {
  try {
    if (learningContext().enabled) captureLearning(JSON.parse((await readStdinBounded({ maxBytes: 65536, emptyMs: 150 })).toString()));
  } catch { /* malformed input produces no persisted payload */ }
  process.exit(0);
}
