// Canonical workflow observations; existing Ruflo is the sole writer, never the legacy JSON hook store.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { rufloRunDir } from './project-progression-store.mjs';
import { rufloInvocation } from './ruflo-bin.mjs';
import { loadRuntimePreferences } from './runtime-preferences.mjs';
import { loadNodeSqlite } from './node-sqlite.mjs';
import { safeQueue, writeAtomic } from './learning-queue.mjs';

export const LEARNING_NAMESPACE = 'learning-observations';
export function learningTarget(context, { env = process.env, explicitLegacyApply = false } = {}) {
  if (!context.enabled) throw new Error('learning consent disabled');
  if (context.scope === 'project') return resolveProjectStore({ projectDir: context.projectDir, gitTimeoutMs: 1000 }).canonicalAgentDbPath;
  const root = path.join(context.home, '.claude', 'global-memory');
  const chosen = loadRuntimePreferences({ env, cwd: context.projectDir }).values.learningScope === 'user';
  if (!chosen && !explicitLegacyApply) throw new Error('user learning requires persisted user consent or explicit legacy Apply');
  safeQueue({ scope: 'user', home: context.home, queueDir: root });
  const db = path.join(root, '.swarm', 'memory.db');
  if (!fs.lstatSync(db).isFile()) throw new Error('user store not adopted');
  const resolved = resolveProjectStore({ projectDir: root, requestedStorePath: db, gitTimeoutMs: 1000 });
  if (resolved.projectRoot !== root) throw new Error('foreign global learner root');
  return resolved.canonicalAgentDbPath;
}

export function runLearningRuflo(binary, args, db, { env = process.env, deadline = Date.now() + 18_000 } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('learning deadline exhausted');
  const cwd = rufloRunDir(db, { root: env.RUVNET_RUFLO_CWD_ROOT || path.join(env.HOME, '.cache', 'ruvnet-brain', 'learning-ruflo') });
  try {
    const invocation = rufloInvocation(binary, args);
    return spawnSync(invocation.executable, invocation.args, { cwd, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0' },
      encoding: 'utf8', shell: false, timeout: Math.min(6000, remaining), killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true });
  } finally { fs.rmSync(cwd, { force: true, recursive: true }); }
}

export function recordLearningObservation(binary, context, file, record, row, options = {}) {
  const db = learningTarget(context, options);
  const key = 'workflow-' + createHash('sha256').update(path.basename(file) + ':' + record.key).digest('hex');
  const value = JSON.stringify({ schemaVersion: 1, tool: row.tool, action: row.action, scope: context.scope,
    authoritative: false, provenance: 'system-observation', outcome: 'host-reported-success' });
  const run = args => { if (options.allowed && !options.allowed()) throw new Error('learning consent changed'); return runLearningRuflo(binary, args, db, options); };
  const existing = withProgressionReader(db, reader => reader.readContent(LEARNING_NAMESPACE, key));
  if (!(existing.ok && existing.value === value)) {
    const stored = run(['memory', 'store', '--key', key, '--value', value, '--namespace', LEARNING_NAMESPACE,
      '--no-upsert', '--provenance', 'system_observation', '--path', db]);
    if (stored.error || stored.status !== 0) throw new Error('canonical observation write failed');
  }
  const retrieved = run(['memory', 'retrieve', '--key', key, '--namespace', LEARNING_NAMESPACE, '--value-only', '--path', db]);
  if (retrieved.error || retrieved.status !== 0 || retrieved.stdout.trim() !== value) throw new Error('canonical exact CLI readback failed');
  const independent = withProgressionReader(db, reader => reader.readContent(LEARNING_NAMESPACE, key));
  if (!independent.ok || independent.value !== value) throw new Error('canonical independent row readback failed');
  return { db, key, digest: createHash('sha256').update(value).digest('hex'), exactCli: true, independentRow: true };
}

export function learningStoreStatus(db) {
  const rows = withProgressionReader(db, reader => reader.listKeys(LEARNING_NAMESPACE, { maxEntries: 100_000 }).length);
  if (!rows.ok) return { known: false, observations: 0, patterns: null, lastDistillAt: null };
  const sqlite = loadNodeSqlite(); let connection;
  try {
    connection = new sqlite.DatabaseSync(db, { readOnly: true });
    const present = name => !!connection.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name);
    const patterns = present('reasoning_patterns') ? connection.prepare('SELECT count(*) AS n FROM reasoning_patterns WHERE json_valid(metadata) AND json_extract(metadata,?)=?').get('$.namespace', LEARNING_NAMESPACE).n : 0;
    const at = present('distill_state') ? connection.prepare('SELECT last_run_at AS at FROM distill_state WHERE namespace=?').get(LEARNING_NAMESPACE)?.at : null;
    return { known: true, observations: rows.value, patterns, lastDistillAt: at ?? null };
  } catch { return { known: false, observations: rows.value, patterns: null, lastDistillAt: null }; }
  finally { connection?.close(); }
}

/** Existing $0 structural distiller, with a verified native WAL-safe snapshot before mutation. */
export function distillLearning(binary, context, options = {}) {
  const db = learningTarget(context, options);
  const warning = 'Exact inverse is unverified; a retained snapshot is recovery evidence, not automatic rollback.';
  if (options.automatic === true) return { db, completed: false, capability: 'restricted', inverseState: 'UNVERIFIED',
    deferred: 'automatic distillation restricted: exact inverse is unverified', warning, patternDelta: 0, ratifiedLessons: 0 };
  process.stderr.write(`[learning] Manual distillation: ${warning}\n`);
  const before = learningStoreStatus(db);
  if (!before.known) throw new Error('distillation baseline unavailable');
  if (options.automatic && before.lastDistillAt !== null && Date.now() - before.lastDistillAt < 3600_000) {
    return { db, completed: false, deferred: 'automatic cadence: at most hourly', patternDelta: 0, ratifiedLessons: 0 };
  }
  const backupDir = path.join(path.dirname(db), 'learning-backups');
  const run = args => { if (options.allowed && !options.allowed()) throw new Error('learning consent changed'); return runLearningRuflo(binary, args, db, options); };
  if (options.allowed && !options.allowed()) throw new Error('learning consent changed');
  safeQueue({ scope: 'project', projectDir: path.dirname(path.dirname(db)), queueDir: backupDir }, true);
  const prior = new Set(fs.readdirSync(backupDir));
  const backup = run(['memory', 'backup', '--db', db, '--dir', backupDir, '--keep', '3', '--verbose']);
  if (backup.error || backup.status !== 0) throw new Error('distillation backup failed');
  if (!backup.stdout.includes('memory DB backed up → ') || backup.stdout.includes('byte-copy')) throw new Error('native online backup mode unverified');
  const images = fs.readdirSync(backupDir).filter(name => name.endsWith('.db') && !prior.has(name));
  if (images.length !== 1) throw new Error('fresh distillation snapshot absent');
  const image = path.join(backupDir, images[0]);
  fs.chmodSync(image, 0o600);
  // The source-bound verbose marker above distinguishes native online backup from
  // Ruflo's byte-copy fallback. Row verification is additional observation evidence,
  // not a claim that this subset alone proves whole-database rollback.
  const source = withProgressionReader(db, reader => reader.listKeys(LEARNING_NAMESPACE, { maxEntries: 100_000 }).map(key => [key, reader.readContent(LEARNING_NAMESPACE, key)]));
  const copy = withProgressionReader(image, reader => reader.listKeys(LEARNING_NAMESPACE, { maxEntries: 100_000 }).map(key => [key, reader.readContent(LEARNING_NAMESPACE, key)]));
  if (!source.ok || !copy.ok || JSON.stringify(source.value) !== JSON.stringify(copy.value)) throw new Error('distillation snapshot row verification failed');
  writeAtomic(path.join(backupDir, 'latest-receipt.json'), JSON.stringify({ db, before, snapshot: image, providerMode: 'native-online-backup', observationsVerified: true, retainedSnapshots: 3, restore: 'automatic exact restore unavailable' }));
  const distilled = run(['memory', 'distill', 'run', '--db', db, '--namespace', LEARNING_NAMESPACE,
    '--max-entries', '8', '--judge', 'structural', '--budget-usd', '0']);
  const after = learningStoreStatus(db);
  return { db, before, after, completed: !distilled.error && distilled.status === 0,
    patternDelta: before.known && after.known ? after.patterns - before.patterns : null,
    snapshot: image, inverseState: 'UNVERIFIED', warning, ratifiedLessons: 0 };
}
