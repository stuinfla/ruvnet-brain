// Canonical workflow observations; existing Ruflo is the sole writer, never the legacy JSON hook store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { rufloInvocation, rufloRunDir, resolveRuflo } from './ruflo-bin.mjs';
import { loadRuntimePreferences } from './runtime-preferences.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { captureFailureReason } from './turn-capture-privacy.mjs';

export const LEARNING_NAMESPACE = 'learning-observations';
export function learningTarget(context, { env = process.env, explicitLegacyApply = false } = {}) {
  if (!context.enabled) throw new Error('learning consent disabled');
  if (context.scope === 'project') return resolveProjectStore({ projectDir: context.projectDir, gitTimeoutMs: 1000 }).canonicalAgentDbPath;
  const root = path.join(context.home, '.claude', 'global-memory');
  const chosen = loadRuntimePreferences({ env, cwd: context.projectDir }).values.learningScope === 'user';
  if (!chosen && !explicitLegacyApply) throw new Error('user learning requires persisted user consent or explicit legacy Apply');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('user learning root is not a real directory');
  const db = path.join(root, '.swarm', 'memory.db');
  if (!fs.lstatSync(db).isFile()) throw new Error('user store not adopted');
  const resolved = resolveProjectStore({ projectDir: root, requestedStorePath: db, gitTimeoutMs: 1000 });
  if (resolved.projectRoot !== root) throw new Error('foreign global learner root');
  return resolved.canonicalAgentDbPath;
}

export function runLearningRuflo(binary, args, db, { env = process.env, deadline = Date.now() + 18_000, maxStepMs = 6000 } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('learning deadline exhausted');
  const cwd = rufloRunDir(db, { root: env.RUVNET_RUFLO_CWD_ROOT || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.cache', 'ruvnet-brain', 'learning-ruflo') });
  try {
    const invocation = rufloInvocation(binary, args);
    return spawnSync(invocation.executable, invocation.args, { cwd, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0' },
      encoding: 'utf8', shell: false, timeout: Math.min(maxStepMs, remaining), killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true });
  } finally { fs.rmSync(cwd, { force: true, recursive: true }); }
}

/**
 * One observation, written DIRECTLY through `ruflo memory store` and proven by exact-key CLI readback.
 * No local queue, no worker, no replay (owner ruling 2026-10-12): a failure throws to the caller, which
 * records it in the hook-failures ledger so SessionStart reports it.
 */
// DETERMINISTIC per (session, tool, action) (review N1): with --no-upsert, rUv's store itself dedupes, so a
// session holds at most one row per distinct pair and concurrent writers of the same pair collapse.
export const observationKey = ({ session = '', tool, action }) => 'workflow-' + createHash('sha256').update(JSON.stringify([String(session), tool, action])).digest('hex');

export function recordLearningObservation(binary, context, { tool, action, session = '' }, options = {}) {
  const db = learningTarget(context, options);
  const key = observationKey({ session, tool, action });
  const value = JSON.stringify({ schemaVersion: 1, tool, action, scope: context.scope,
    authoritative: false, provenance: 'system-observation', outcome: 'host-reported-success' });
  const run = args => { if (options.allowed && !options.allowed()) throw new Error('learning consent changed'); return runLearningRuflo(binary, args, db, options); };
  const stored = run(['memory', 'store', '--key', key, '--value', value, '--namespace', LEARNING_NAMESPACE,
    '--no-upsert', '--provenance', 'system_observation', '--path', db]);
  const retrieved = run(['memory', 'retrieve', '--key', key, '--namespace', LEARNING_NAMESPACE, '--value-only', '--path', db]);
  const readBack = !retrieved.error && retrieved.status === 0 ? String(retrieved.stdout || '').trim() : null;
  const exact = readBack === value;
  // A refused store whose key already holds these exact bytes is the dedupe working, not a failure (idempotent).
  // Measured 2026-10-21: 141 ledger rows said "already exists" because the readback itself had timed out, so the
  // row blamed the store; the reason names which step failed, and a key holding DIFFERENT bytes stays a failure.
  if (stored.error || stored.status !== 0) {
    if (exact) return { db, key, digest: createHash('sha256').update(value).digest('hex'), exactCli: true, alreadyStored: true };
    const reason = captureFailureReason(stored, stored.status);
    if (/already exists/i.test(reason)) {
      if (readBack !== null) throw new Error('duplicate key holds a different observation');
      throw new Error(`exact readback of the existing key failed: ${captureFailureReason(retrieved, retrieved.status)}`);
    }
    throw new Error(`ruflo memory store refused the observation: ${reason}`);
  }
  if (!exact) throw new Error('canonical exact CLI readback failed');
  return { db, key, digest: createHash('sha256').update(value).digest('hex'), exactCli: true };
}

/** Observation count through `ruflo memory list` (no direct SQLite). Unknown stays unknown. */
export function learningStoreStatus(db, { binary = resolveRuflo(), env = process.env } = {}) {
  if (!binary) return { known: false, observations: 0, patterns: null, lastDistillAt: null };
  try {
    const listed = runLearningRuflo(binary, ['memory', 'list', '--namespace', LEARNING_NAMESPACE, '--limit', '100000', '--format', 'json', '--path', db], db, { env });
    const text = String(listed.stdout || ''); const at = text.indexOf('[');
    if (listed.status !== 0 || at < 0) return { known: false, observations: 0, patterns: null, lastDistillAt: null };
    return { known: true, observations: JSON.parse(text.slice(at)).length, patterns: null, lastDistillAt: null };
  } catch { return { known: false, observations: 0, patterns: null, lastDistillAt: null }; }
}

/** `ruflo memory backup` then `ruflo memory distill run`; both are rUv's own commands. */
export function distillLearning(binary, context, options = {}) {
  const db = learningTarget(context, options);
  const run = args => { if (options.allowed && !options.allowed()) throw new Error('learning consent changed'); return runLearningRuflo(binary, args, db, options); };
  const backupDir = path.join(path.dirname(db), 'learning-backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = run(['memory', 'backup', '--db', db, '--dir', backupDir, '--keep', '3']);
  if (backup.error || backup.status !== 0) throw new Error('distillation backup failed');
  const distilled = run(['memory', 'distill', 'run', '--db', db, '--namespace', LEARNING_NAMESPACE,
    '--max-entries', '8', '--judge', 'structural', '--budget-usd', '0']);
  return { db, completed: !distilled.error && distilled.status === 0, ratifiedLessons: 0 };
}

/**
 * Distill the observation rows with rUv's own `ruflo memory distill run` (incremental cursor, $0
 * structural judge), bounded. Run detached at SessionEnd/PreCompact (review M3). No backup on this path:
 * a whole-DB copy per session end costs more than the distill. A failure throws to the caller (ledger).
 */
export function distillObservations(binary, context, options = {}) {
  const db = learningTarget(context, options);
  const r = runLearningRuflo(binary, ['memory', 'distill', 'run', '--db', db, '--namespace', LEARNING_NAMESPACE,
    '--max-entries', '500', '--judge', 'structural', '--budget-usd', '0'], db, { ...options, maxStepMs: 60_000, deadline: Date.now() + 60_000 });
  if (r.error || r.status !== 0) throw new Error(`ruflo memory distill run did not complete (${r.error?.code || `exit ${r.status}`})`);
  return { db, completed: true };
}

/** What the console shows: consent, target and the observation count. There is no local queue. */
export function observeLearning(options = {}) {
  const env = options.env ?? process.env;
  const context = learningContext(options);
  const result = { ...context, queueDepth: 0, queueKnown: true, legacyUserDepth: 0, legacyUserKnown: true, lastTrainSeconds: null, trajectories: 0, statusKnown: false };
  if (!context.enabled) return result;
  try {
    result.learningDb = learningTarget(context, { env });
    const state = learningStoreStatus(result.learningDb, { env });
    result.statusKnown = state.known; result.trajectories = state.observations; result.observations = state.observations;
    result.patterns = state.patterns; result.lastDistillAt = state.lastDistillAt;
  } catch { /* Missing consent/store/readback remains unknown. */ }
  return result;
}
