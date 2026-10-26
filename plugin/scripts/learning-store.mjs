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
  // #377: the user store is a FIXED path, validated directly. It is not a project, so no Git root is
  // resolved (a ~/.claude that is itself a Git checkout made every user write "foreign global learner
  // root"), and a missing store says so instead of surfacing a raw lstat ENOENT.
  const db = path.join(root, '.swarm', 'memory.db');
  const entry = (file) => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const [rootStat, swarmStat, dbStat] = [root, path.dirname(db), db].map(entry);
  if (!rootStat || !swarmStat || !dbStat) throw new Error(`user store not adopted (no ${db})`);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('user learning root is not a real directory');
  if (!swarmStat.isDirectory() || swarmStat.isSymbolicLink()) throw new Error('user learning .swarm is not a real directory');
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink !== 1) throw new Error('user store is not an exclusive regular file');
  const canonicalRoot = path.join(fs.realpathSync.native(context.home), '.claude', 'global-memory');
  if (fs.realpathSync.native(root) !== canonicalRoot) throw new Error('user learning root is reached through a link');
  return path.join(canonicalRoot, '.swarm', 'memory.db');
}

export function runLearningRuflo(binary, args, db, { env = process.env, deadline = Date.now() + 18_000, maxStepMs = 6000, maxBuffer = 65536 } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('learning deadline exhausted');
  const cwd = rufloRunDir(db, { root: env.RUVNET_RUFLO_CWD_ROOT || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.cache', 'ruvnet-brain', 'learning-ruflo') });
  try {
    const invocation = rufloInvocation(binary, args);
    return spawnSync(invocation.executable, invocation.args, { cwd, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false' },
      encoding: 'utf8', shell: false, timeout: Math.min(maxStepMs, remaining), killSignal: 'SIGKILL', maxBuffer, windowsHide: true });
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

/**
 * The namespace's last distillation from `ruflo memory distill status --db` (#377). That command has
 * only a table output: the `distill_state cursor` table's Namespace column is 20 wide, so
 * `learning-observations` prints as `learning-observat...`; a truncated cell matches by prefix, and
 * an ambiguous or unreadable answer stays unknown. `null` with known=true means never distilled.
 */
export function parseDistillStatus(text, namespace = LEARNING_NAMESPACE) {
  const lines = String(text || '').replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /distill_state cursor/.test(line));
  if (start < 0) return /No distill_state cursor rows yet/.test(lines.join('\n')) ? { known: true, lastDistillAt: null } : { known: false, lastDistillAt: null };
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 5 || cells[1] === 'Namespace') continue;
    rows.push({ name: cells[1], lastRun: cells[3] });
  }
  const exact = rows.filter((row) => row.name === namespace);
  const truncated = rows.filter((row) => row.name.endsWith('...') && namespace.startsWith(row.name.slice(0, -3)));
  const matches = exact.length ? exact : truncated;
  if (!matches.length) return { known: true, lastDistillAt: null };
  if (matches.length > 1) return { known: false, lastDistillAt: null };
  if (matches[0].lastRun === 'never') return { known: true, lastDistillAt: null };
  const at = Date.parse(matches[0].lastRun);
  return Number.isFinite(at) ? { known: true, lastDistillAt: new Date(at).toISOString() } : { known: false, lastDistillAt: null };
}

/** Observation count through `ruflo memory list` and the last distillation through `ruflo memory distill status` (no direct SQLite). Unknown stays unknown. */
export function learningStoreStatus(db, { binary = resolveRuflo(), env = process.env, run = runLearningRuflo } = {}) {
  const unknown = { known: false, observations: 0, patterns: null, lastDistillAt: null, distillKnown: false, pendingObservations: null, oldestPendingAt: null };
  if (!binary) return unknown;
  try {
    const listed = run(binary, ['memory', 'list', '--namespace', LEARNING_NAMESPACE, '--limit', '100000', '--format', 'json', '--path', db], db, { env, maxBuffer: 64 * 1024 * 1024 });
    const text = String(listed.stdout || ''); const at = text.indexOf('[');
    if (listed.status !== 0 || at < 0) return unknown;
    const rows = JSON.parse(text.slice(at));
    let distill = { known: false, lastDistillAt: null };
    try {
      const status = run(binary, ['memory', 'distill', 'status', '--db', db], db, { env });
      if (!status.error && status.status === 0) distill = parseDistillStatus(status.stdout);
    } catch { /* distillation state stays unknown */ }
    const since = distill.lastDistillAt ? Date.parse(distill.lastDistillAt) : -Infinity;
    // Observations recorded after the last distillation are the ones still waiting for it.
    const pending = distill.known ? rows.filter((row) => !(Number(row?.createdAt) <= since)) : null;
    const oldest = pending ? Math.min(...pending.map((row) => Number(row?.createdAt)).filter(Number.isFinite)) : Infinity;
    return { known: true, observations: rows.length, patterns: null, lastDistillAt: distill.lastDistillAt, distillKnown: distill.known,
      pendingObservations: pending ? pending.length : null, oldestPendingAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null };
  } catch { return unknown; }
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
    const state = learningStoreStatus(result.learningDb, { env, ...(options.binary ? { binary: options.binary } : {}), ...(options.run ? { run: options.run } : {}) });
    result.statusKnown = state.known; result.trajectories = state.observations; result.observations = state.observations;
    result.patterns = state.patterns; result.lastDistillAt = state.lastDistillAt;
    result.distillKnown = state.distillKnown; result.pendingObservations = state.pendingObservations; result.oldestPendingAt = state.oldestPendingAt;
    if (state.lastDistillAt) result.lastTrainSeconds = Math.max(0, Math.round(((options.now ?? Date.now()) - Date.parse(state.lastDistillAt)) / 1000));
  } catch { /* Missing consent/store/readback remains unknown. */ }
  return result;
}
