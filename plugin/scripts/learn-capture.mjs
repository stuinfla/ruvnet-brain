#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { recordLearningObservation, distillObservations, observationKey, learningTarget } from './learning-store.mjs';
import { resolveRuflo } from './ruflo-bin.mjs';
import { recordHookFailure } from './hook-failures.mjs';
import { isDirectInvocation } from './entrypoint.mjs';

// LOAD BOUNDS (measured 2026-10-21: one busy session spawned hundreds of concurrent detached `ruflo memory store`
// children, which timed out against each other and wrote 826 ledger rows in a day). Owner ruling 2026-10-12 stands:
// no local queue, no replay — an observation that finds no slot is DROPPED and counted.
export const OBSERVE_SLOTS = 2;           // detached --observe children alive at once, per Brain home
export const SLOT_STALE_MS = 60_000;      // a slot older than this, or held by a dead pid, is reclaimed
export const COALESCE_MS = 10 * 60_000;   // an identical observation key inside this window does not spawn again
const GATE_WAIT_ARR = new Int32Array(new SharedArrayBuffer(4));
const ACTIVE_CAPTURE_GATES = new Set();
const defaultBrainHome = (env) => env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const learnDir = (brainHome, sub) => { const dir = path.join(brainHome, 'learn-capture', sub); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const shortHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

/** Capture-private atomic gate using mkdir(0o700). Never displaces a live PID by age; no unlocked fallback. */
export function withCaptureGate(brainHome, fn, { timeoutMs = 150 } = {}) {
  const resolvedHome = path.resolve(brainHome);
  const gateDir = path.join(resolvedHome, 'learn-capture', 'capture.gate');
  if (ACTIVE_CAPTURE_GATES.has(gateDir)) return fn();
  fs.mkdirSync(path.dirname(gateDir), { recursive: true, mode: 0o700 });
  const ownerFile = path.join(gateDir, 'owner.json');
  const token = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      fs.mkdirSync(gateDir, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, birth: Date.now() }), { mode: 0o600 });
      } catch (err) {
        try { fs.rmdirSync(gateDir); } catch { /* ignore */ }
        throw err;
      }
      ACTIVE_CAPTURE_GATES.add(gateDir);
      try {
        return fn();
      } finally {
        ACTIVE_CAPTURE_GATES.delete(gateDir);
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          if (owner?.token === token) fs.rmSync(gateDir, { recursive: true, force: true });
        } catch { /* not ours or removed */ }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let deadOwner = false;
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (!Number.isInteger(owner?.pid) || !isPidAlive(owner.pid)) deadOwner = true;
      } catch {
        try {
          // Only reclaim an ownerless empty dir if it outlived the creator's mkdir->writeFileSync step.
          if (Date.now() - fs.statSync(gateDir).mtimeMs > 1500) deadOwner = true;
        } catch { continue; }
      }
      if (deadOwner) {
        const reclaim = `${gateDir}.reclaim-${process.pid}-${token}`;
        try { fs.renameSync(gateDir, reclaim); fs.rmSync(reclaim, { recursive: true, force: true }); } catch { /* another claimant won */ }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('learn-capture gate timeout');
      Atomics.wait(GATE_WAIT_ARR, 0, 0, Math.min(5, remaining));
    }
  }
}

/** Parent-side coalescing: marker file per key under `learn-capture/recent/`, pruned when it grows past 256 entries. */
export function recentlyCaptured(brainHome, key, now = Date.now()) {
  return withCaptureGate(brainHome, () => {
    try { return now - fs.statSync(path.join(learnDir(brainHome, 'recent'), key)).mtimeMs < COALESCE_MS; } catch { return false; }
  });
}
// #377 residual (sparkling, 2026-10-30): the parent used to call markCaptured() BEFORE the detached child stored
// anything, so a child whose store or exact readback failed left the key acknowledged as captured for the whole
// COALESCE_MS window. Now the parent only marks the key IN FLIGHT (`<key>.pending`, which is never an
// acknowledgement and expires with the child's slot), and the child acknowledges with markCaptured() only after
// recordLearningObservation() has completed its exact readback. A failed child clears the in-flight mark.
const inFlightMarker = (brainHome, key) => path.join(learnDir(brainHome, 'recent'), `${key}.pending`);
export function captureInFlight(brainHome, key, now = Date.now()) {
  return withCaptureGate(brainHome, () => {
    try { return now - fs.statSync(inFlightMarker(brainHome, key)).mtimeMs < SLOT_STALE_MS; } catch { return false; }
  });
}
export function markInFlight(brainHome, key, token = crypto.randomBytes(12).toString('hex')) {
  return withCaptureGate(brainHome, () => {
    try {
      fs.writeFileSync(inFlightMarker(brainHome, key), JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 0o600 });
      return token;
    } catch { return token; /* best effort: coalescing only */ }
  });
}
export function clearInFlight(brainHome, key, token) {
  return withCaptureGate(brainHome, () => {
    const marker = inFlightMarker(brainHome, key);
    try {
      if (token) {
        const raw = fs.readFileSync(marker, 'utf8');
        if (raw) {
          const held = JSON.parse(raw);
          if (typeof held?.token === 'string' && held.token !== token) return false;
        }
      }
      fs.unlinkSync(marker);
      return true;
    } catch { return false; /* already gone */ }
  });
}
export function markCaptured(brainHome, key, now = Date.now()) {
  return withCaptureGate(brainHome, () => {
    const dir = learnDir(brainHome, 'recent');
    try { fs.writeFileSync(path.join(dir, key), '', { mode: 0o600 }); } catch { return; }
    const names = fs.readdirSync(dir);
    if (names.length > 256) {
      for (const name of names) {
        try {
          const p = path.join(dir, name);
          const stat = fs.statSync(p);
          if (name.endsWith('.pending')) {
            if (now - stat.mtimeMs >= SLOT_STALE_MS) fs.unlinkSync(p);
          } else if (now - stat.mtimeMs >= COALESCE_MS) {
            fs.unlinkSync(p);
          }
        } catch { /* raced */ }
      }
    }
  });
}

function slotStale(slot, now) {
  let held;
  try { held = JSON.parse(fs.readFileSync(slot, 'utf8')); } catch { try { return now - fs.statSync(slot).mtimeMs > SLOT_STALE_MS; } catch { return false; } }
  if (!Number.isInteger(held?.pid) || now - Number(held.at) > SLOT_STALE_MS) return true;
  return !isPidAlive(held.pid);
}
/** O_EXCL slot files `learn-capture/slots/slot-N`; a stale one is reclaimed by rename, so only one claimant wins it. */
export function acquireObserveSlot(brainHome, now = Date.now(), token = crypto.randomBytes(12).toString('hex')) {
  return withCaptureGate(brainHome, () => {
    const dir = learnDir(brainHome, 'slots');
    for (let i = 0; i < OBSERVE_SLOTS; i += 1) {
      const slot = path.join(dir, `slot-${i}`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { fs.writeFileSync(slot, JSON.stringify({ pid: process.pid, at: now, token }), { flag: 'wx', mode: 0o600 }); return slot; } catch (error) { if (error.code !== 'EEXIST') break; }
        if (!slotStale(slot, now)) break;
        const claim = `${slot}.reclaim-${process.pid}`;
        try { fs.renameSync(slot, claim); fs.unlinkSync(claim); } catch { break; } // another claimant took it
      }
    }
    return null;
  });
}
export function releaseObserveSlot(slot, owner = process.pid) {
  if (!slot) return false;
  const brainHome = path.resolve(slot, '..', '..', '..');
  const pid = typeof owner === 'number' ? owner : (owner?.pid ?? process.pid);
  const token = typeof owner === 'object' && owner !== null ? owner.token : undefined;
  return withCaptureGate(brainHome, () => {
    try {
      const held = JSON.parse(fs.readFileSync(slot, 'utf8'));
      if (token) {
        if (held?.token !== token) return false;
      } else if (held?.pid !== pid) {
        return false;
      }
      fs.unlinkSync(slot);
      return true;
    } catch { return false; /* reclaimed already */ }
  });
}

/** Every shed is one fixed-string ledger call; hook-failures.mjs's own window counts the repeats on one row. */
export const SHED_ERROR = 'shed observation (load)';
export function shedObservation(brainHome, corr = {}) {
  recordHookFailure({
    hook: 'learn-capture',
    event: 'PostToolUse',
    error: SHED_ERROR,
    ...(corr.store ? { store: corr.store } : {}),
    ...(corr.project ? { project: corr.project } : {}),
    ...(corr.session ? { session: corr.session } : {}),
  }, { brainHome });
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
  let tool; let action; let corr = {};
  try {
    const context = learningContext({ env });
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
    let store;
    try { store = shortHash(learningTarget(context, { env })); } catch { /* user store may not exist yet */ }
    const observation = { tool, action, session: String(input.session_id || '') };
    const key = observationKey(observation);
    corr = {
      ...(store ? { store } : {}),
      ...(context.projectDir ? { project: shortHash(context.projectDir) } : {}),
      ...(observation.session ? { session: shortHash(observation.session) } : {}),
      key,
    };
    if (!binary) throw new Error('ruflo not found'); // one ledger row per 10 min: recordHookFailure counts the repeats
    if (detach) {
      const decision = withCaptureGate(brainHome, () => {
        if (recentlyCaptured(brainHome, key)) return { kind: 'done', value: true };
        if (captureInFlight(brainHome, key)) return { kind: 'done', value: true };
        const token = crypto.randomBytes(12).toString('hex');
        const slot = acquireObserveSlot(brainHome, Date.now(), token);
        if (!slot) return { kind: 'shed' };
        markInFlight(brainHome, key, token); // NOT an acknowledgement: only the child's exact readback acknowledges (#377)
        return { kind: 'spawn', slot, token };
      });
      if (decision.kind === 'done') return decision.value;
      if (decision.kind === 'shed') return shedObservation(brainHome, corr);
      return detachLearning('--observe', { env: { ...env, RUFLO_BIN: binary }, brainHome, observation, slot: decision.slot, key, token: decision.token, correlation: corr });
    }
    if (recentlyCaptured(brainHome, key)) return true;
    recordLearningObservation(binary, context, observation, { env, deadline: Date.now() + 6000 });
    markCaptured(brainHome, key);
    return true;
  } catch (error) {
    if (tool && action) recordHookFailure({ hook: 'learn-capture', event: 'PostToolUse', error: String(error?.message || error).slice(0, 160), ...corr }, { brainHome });
    return false;
  }
}

/**
 * Detached, bounded child (`--observe` one observation, `--distill` the namespace). Only fixed-vocabulary fields
 * cross. The parent's resolved ruflo travels as RUFLO_BIN (resolveRuflo's authoritative seam), so the child never
 * re-resolves it; the slot it holds travels as RUVNET_LEARN_SLOT and is re-stamped with the child's pid.
 */
export function detachLearning(mode, { env = process.env, brainHome, observation, slot, key, token, correlation } = {}) {
  const bh = brainHome || defaultBrainHome(env);
  const effectiveKey = key || (observation ? observationKey(observation) : null);
  let effectiveToken = token;
  if (!effectiveToken && slot) {
    try { effectiveToken = JSON.parse(fs.readFileSync(slot, 'utf8'))?.token; } catch { /* legacy slot */ }
  }
  const failError = (err) => recordHookFailure({
    hook: mode === '--distill' ? 'learn-distill' : 'learn-capture',
    event: mode === '--distill' ? 'SessionEnd' : 'PostToolUse',
    error: String(err?.message || err || 'spawn failed').slice(0, 160),
    ...(correlation || {}),
    ...(effectiveKey ? { key: effectiveKey } : {}),
  }, { brainHome: bh });
  const releaseOwned = () => {
    try {
      withCaptureGate(bh, () => {
        if (effectiveKey) clearInFlight(bh, effectiveKey, effectiveToken);
        if (slot) releaseObserveSlot(slot, effectiveToken ? { token: effectiveToken } : process.pid);
      });
    } catch { /* gate unavailable */ }
  };
  let child;
  let spawned = false;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        ...(observation ? { RUVNET_LEARN_OBSERVATION: JSON.stringify(observation) } : {}),
        ...(bh ? { RUVNET_BRAIN_HOME: bh } : {}),
        ...(slot ? { RUVNET_LEARN_SLOT: slot } : {}),
        ...(effectiveToken ? { RUVNET_LEARN_TOKEN: effectiveToken } : {}),
      },
    });
  } catch (error) {
    releaseOwned();
    failError(error);
    return false;
  }
  const stampChildPid = () => {
    if (!slot || !Number.isInteger(child.pid)) return;
    try {
      withCaptureGate(bh, () => {
        try {
          const held = JSON.parse(fs.readFileSync(slot, 'utf8'));
          if (effectiveToken && held?.token !== effectiveToken) return;
          fs.writeFileSync(slot, JSON.stringify({ pid: child.pid, at: Date.now(), ...(held?.token ? { token: held.token } : {}) }), { mode: 0o600 });
        } catch { /* slot released or replaced */ }
      });
    } catch { /* gate timeout; slot expires naturally */ }
  };
  stampChildPid();
  child.once('spawn', () => {
    spawned = true;
    stampChildPid();
  });
  child.once('error', (error) => {
    if (!spawned) {
      releaseOwned();
      failError(error);
    }
  });
  child.unref();
  return true;
}

function runDetached(mode) {
  const brainHome = defaultBrainHome(process.env);
  const token = process.env.RUVNET_LEARN_TOKEN || undefined;
  let observation = null;
  let obsKey;
  let corr = {};
  const fail = (error) => recordHookFailure({
    hook: mode === '--distill' ? 'learn-distill' : 'learn-capture',
    event: mode === '--distill' ? 'SessionEnd' : 'PostToolUse',
    error: String(error?.message || error).slice(0, 160),
    ...corr,
    ...(obsKey ? { key: obsKey } : {}),
  }, { brainHome });
  try {
    const context = learningContext(); // consent is re-read: a withdrawn consent writes nothing
    if (!context.enabled) return;
    try { corr.store = shortHash(learningTarget(context, { env: process.env })); } catch { /* store unavailable */ }
    if (context.projectDir) corr.project = shortHash(context.projectDir);
    const binary = resolveRuflo({ env: process.env });
    if (!binary) throw new Error('ruflo not found');
    if (mode === '--distill') { distillObservations(binary, context, { env: process.env }); return; }
    const o = JSON.parse(process.env.RUVNET_LEARN_OBSERVATION || '{}');
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(o.tool) || typeof o.action !== 'string') throw new Error('invalid detached observation');
    observation = { tool: o.tool, action: o.action, session: String(o.session || '') };
    obsKey = observationKey(observation);
    if (observation.session) corr.session = shortHash(observation.session);
    recordLearningObservation(binary, context, observation, { env: process.env, deadline: Date.now() + 14_000, allowed: () => learningContext().enabled });
    markCaptured(brainHome, obsKey); // acknowledged only after the exact readback succeeded (#377)
  } catch (error) { fail(error); } finally {
    if (observation) clearInFlight(brainHome, obsKey || observationKey(observation), token);
    if (process.env.RUVNET_LEARN_SLOT) releaseObserveSlot(process.env.RUVNET_LEARN_SLOT, token ? { pid: process.pid, token } : process.pid);
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
