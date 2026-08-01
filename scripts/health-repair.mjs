#!/usr/bin/env node
/**
 * health-repair.mjs — the EXECUTOR behind the console's health recommendations.
 *
 * The console used to detect a corrupt memory store, score it 49/100, render it into a card, and
 * offer nothing. Stuart, 2026-07-21: "when it finds a problem, the fact that it didn't recommend a
 * fix is unconscionable." This is the other half — the part that actually repairs.
 *
 * Three actions, each matching a recommendation id from console-engine.buildHealthRecommendations:
 *
 *   --repair-memory   REINDEX a corrupt AgentDB store (index damage, never data loss)
 *   --flush-learning  drain the capture queue into rUv's learner
 *   --train-learning  run one training cycle
 *
 * DISCIPLINE, learned the hard way tonight:
 *   • Back up BEFORE touching, using sqlite's own .backup — `cp` on a live WAL database silently
 *     truncates the newest transactions (standing lesson, proven by experiment).
 *   • Count rows before AND after, and refuse to report success if they differ.
 *   • Never hand-roll learning: the flush/train paths shell out to rUv's own `ruflo hooks`.
 *   • Every result is DERIVED from a re-measurement, never asserted from an exit code.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { findStores, diagnose } from './memory-doctor.mjs';

const HOME = os.homedir();
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/**
 * Find ruflo HONESTLY.
 *
 * This was hardcoded to `~/.npm-global/bin/ruflo` — Stuart's prefix, not everyone's. On any machine
 * with a different npm prefix (nvm, Homebrew, Volta, a plain `npm -g` on Linux), every learning
 * action reported "ruflo not found — install it to enable learning" to a user who had ruflo
 * installed and working. Telling someone their tool is missing when it is on their PATH is the
 * product lying, and it is unfalsifiable from their side: they cannot see why we looked in one place.
 *
 * Rule 21 still holds — ONE ruflo, the global one, never `npx ruflo@latest`. This resolves WHERE
 * that one global binary is rather than assuming a path.
 */
function resolveRuflo() {
  const preferred = path.join(HOME, '.npm-global/bin/ruflo');
  if (fs.existsSync(preferred)) return preferred;
  const which = spawnSync('sh', ['-lc', 'command -v ruflo'], { encoding: 'utf8', timeout: 10_000 });
  const found = String(which.stdout || '').trim().split('\n')[0];
  return found && fs.existsSync(found) ? found : null;
}
const RUFLO = resolveRuflo();
const RUFLO_ENV = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' };

const sqlite = (db, sql) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8', timeout: 120_000 }).trim();

/** Every AgentDB store this repo knows about: the project's own, plus any passed explicitly. */
function resolveDb() {
  const explicit = argv[argv.indexOf('--db') + 1];
  if (argv.includes('--db') && explicit) return explicit;
  return path.join(process.cwd(), '.swarm', 'memory.db');
}

/**
 * REINDEX a corrupt store. Index corruption ("wrong # of entries in index X") means the indexes
 * drifted from the table; the rows themselves are intact, so rebuilding indexes FROM the table is
 * lossless. Verified live: 1193 rows before, 1193 after, integrity_check ok.
 */
function repairMemory() {
  const db = resolveDb();
  if (!fs.existsSync(db)) return { ok: false, log: `no memory store at ${db.replace(HOME, '~')}` };

  const before = sqlite(db, 'PRAGMA integrity_check;').split('\n')[0];
  if (before === 'ok') return { ok: true, log: 'store was already clean — nothing to repair', noop: true };

  const rowsBefore = Number(sqlite(db, 'SELECT COUNT(*) FROM memory_entries;'));

  // Backup FIRST, via sqlite's own backup (never cp — a live WAL db loses its newest transactions).
  const backup = `${db}.rescue-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { sqlite(db, `.backup '${backup}'`); }
  catch (e) { return { ok: false, log: `refusing to repair — could not back up first: ${e.message}` }; }

  try { sqlite(db, 'REINDEX;'); }
  catch (e) { return { ok: false, log: `REINDEX failed: ${e.message}. Your backup is at ${backup.replace(HOME, '~')}`, backup }; }

  // PROVE it, rather than trusting REINDEX's exit code.
  const after = sqlite(db, 'PRAGMA integrity_check;').split('\n')[0];
  const rowsAfter = Number(sqlite(db, 'SELECT COUNT(*) FROM memory_entries;'));

  if (after !== 'ok') return { ok: false, log: `still corrupt after REINDEX: ${after}. Backup: ${backup.replace(HOME, '~')}`, backup };
  if (rowsAfter !== rowsBefore) {
    return { ok: false, log: `ROW COUNT CHANGED (${rowsBefore} → ${rowsAfter}) — treating as data loss. Restore: ${backup.replace(HOME, '~')}`, backup };
  }
  return { ok: true, log: `repaired — integrity ok, ${rowsAfter} entries intact (was ${rowsBefore}). Backup: ${backup.replace(HOME, '~')}`, backup };
}

/** Drain the capture queue into rUv's learner — his tool, not ours. */
function flushLearning() {
  const flusher = path.join(HOME, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin', 'scripts', 'learn-flush.mjs');
  const local = path.join(process.cwd(), 'plugin', 'scripts', 'learn-flush.mjs');
  const script = fs.existsSync(flusher) ? flusher : (fs.existsSync(local) ? local : null);
  if (!script) return { ok: false, log: 'learn-flush.mjs not found — cannot drain the queue' };

  const queueDir = path.join(HOME, '.cache', 'ruvnet-brain', 'learn');
  const depth = () => {
    try {
      return fs.readdirSync(queueDir).filter((f) => f.endsWith('.jsonl'))
        .reduce((n, f) => n + fs.readFileSync(path.join(queueDir, f), 'utf8').split('\n').filter(Boolean).length, 0);
    } catch { return 0; }
  };
  const before = depth();
  try { execFileSync(process.execPath, [script], { stdio: 'ignore', timeout: 600_000 }); }
  catch (e) { return { ok: false, log: `flush failed: ${e.message} — the queue is preserved for retry` }; }
  const after = depth();
  return { ok: true, log: `fed ${Math.max(0, before - after)} captured events into the learner (queue ${before} → ${after})` };
}

/** One training cycle, via rUv's own CLI, in the GLOBAL (cross-project) learner. */
function trainLearning() {
  if (!RUFLO) return { ok: false, log: 'ruflo is not on this machine — install it with `npm i -g ruflo@latest` to enable learning' };
  try {
    execFileSync(RUFLO, ['hooks', 'intelligence', '--train'], { cwd: HOME, env: RUFLO_ENV, stdio: 'ignore', timeout: 600_000 });
  } catch (e) { return { ok: false, log: `training cycle failed: ${e.message}` }; }
  return { ok: true, log: 'ran one training cycle in the cross-project learner' };
}

/**
 * Distill every store that is embedded but has never been mined into patterns.
 *
 * This is the executor for ADR-027's North Star case: 87 stores holding 154,106 memories while
 * learning nothing. The fix is NOT ours — it is rUv's ADR-174 distillation pipeline
 * (`ruflo memory distill run`), which memory-doctor has been printing as the remedy all along while
 * the console stayed quiet. We wire it; we do not reimplement it.
 *
 * Discipline, same as repairMemory():
 *   • Snapshot each store FIRST with `ruflo memory backup` — rUv's own WAL-safe snapshotter, not cp.
 *   • Skip stores distillation cannot help (cover < 50%): running there would burn minutes and then
 *     truthfully report zero, which reads as failure. Not attempting is more honest than attempting.
 *   • Re-diagnose after, and report the DERIVED pattern delta — never the exit code.
 *   • $0: --judge defaults to 'structural' and --budget-usd defaults to 0. Nothing bills, nothing
 *     leaves the machine. We pass both explicitly anyway so a future default change cannot silently
 *     start spending a user's money.
 */
function distillFleet() {
  if (!RUFLO) return { ok: false, log: 'ruflo is not on this machine — install it with `npm i -g ruflo@latest` to distill' };

  const scope = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]) : null;
  const targets = [];
  const corrupt = [];
  let found = [];
  try { found = scope ? findStores(scope) : findStores(); } catch { found = []; }
  for (const db of found) {
    const resolved = path.resolve(db);
    let d;
    try { d = diagnose(resolved); } catch { continue; }
    if (d.unreadable || d.schemaless || !d.total) continue;
    if (d.cover < 0.5 || (d.patterns ?? 0) > 0) continue;
    // A corrupt store CANNOT be distilled — ruflo refuses it outright ("memory DB reports
    // corruption — run recoverMemoryDatabase first"). Attempting anyway burns minutes, writes
    // nothing, and returns a zero that reads as "distillation doesn't work". The honest answer is
    // that repair comes FIRST, so name these instead of silently failing on them.
    if (d.integrity && d.integrity !== 'ok') { corrupt.push(d.name); continue; }
    targets.push({ db: resolved, name: d.name, before: d.patterns ?? 0 });
  }
  const corruptNote = corrupt.length
    ? ` ${corrupt.length} store${corrupt.length === 1 ? ' was' : 's were'} skipped as corrupt and must be repaired before ${corrupt.length === 1 ? 'it' : 'they'} can be distilled: ${corrupt.slice(0, 5).join(', ')}${corrupt.length > 5 ? '…' : ''}.`
    : '';
  if (!targets.length) {
    return { ok: !corrupt.length, log: `no stores were distillable — every embedded store already has patterns.${corruptNote}`, noop: true };
  }

  const done = [];
  const failed = [];
  const receiptPath = argv.includes('--receipt') ? argv[argv.indexOf('--receipt') + 1] : null;
  const receipt = [];
  const writeReceipt = () => {
    if (!receiptPath) return;
    try {
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      fs.writeFileSync(receiptPath, JSON.stringify({ at: new Date().toISOString(), stores: receipt }, null, 2));
    } catch { /* the receipt is for undo; failing to write it must not fail the repair itself */ }
  };

  for (const t of targets) {
    const dir = path.join(path.dirname(t.db), 'backups');
    try { execFileSync(RUFLO, ['memory', 'backup', '--db', t.db, '--dir', dir], { env: RUFLO_ENV, stdio: 'ignore', timeout: 300_000 }); }
    catch (e) { failed.push(`${t.name}: refused to distill — snapshot failed (${String(e.message).slice(0, 80)})`); continue; }
    // Record the snapshot BEFORE distilling, and flush after every store. If the process is killed
    // mid-fleet, the receipt still names every store already modified — a partial receipt is
    // recoverable, a missing one is not.
    receipt.push({ db: t.db, name: t.name, backupDir: dir });
    writeReceipt();

    try {
      execFileSync(RUFLO, ['memory', 'distill', 'run', '--db', t.db, '--judge', 'structural', '--budget-usd', '0'],
        { env: RUFLO_ENV, stdio: 'ignore', timeout: 1_800_000 });
    } catch (e) { failed.push(`${t.name}: distill failed (${String(e.message).slice(0, 80)}); snapshot kept in ${dir.replace(HOME, '~')}`); continue; }

    // PROVE it moved. An exit code of 0 is not evidence that anything was learned.
    //
    // Measured with a READ-WRITE sqlite3 connection, NOT memory-doctor's diagnose(). diagnose()
    // opens `mode=ro`, and a read-only connection cannot build the WAL index for a database another
    // process just wrote — so it read 0 patterns moments after distillation had in fact written 684.
    // This executor then reported "produced no new patterns" about a run that worked perfectly.
    // Caught live 2026-07-21. It is the standing lesson exactly: verify by the mechanism, not by a
    // convenient instance of it — a probe that cannot see the write is not a verification.
    let after = t.before;
    try { after = Number(sqlite(t.db, 'SELECT count(*) FROM reasoning_patterns;')) || 0; } catch { /* unreadable — leave unchanged so we claim nothing */ }
    if (after > t.before) done.push(`${t.name}: +${after - t.before} patterns`);
    else failed.push(`${t.name}: ran but produced no new patterns (still ${after})`);
  }

  const log = [
    done.length ? `distilled ${done.length} store${done.length === 1 ? '' : 's'} — ${done.join(', ')}` : 'no store gained patterns',
    failed.length ? `${failed.length} did not: ${failed.join('; ')}` : '',
    corruptNote.trim(),
  ].filter(Boolean).join('. ');
  return { ok: done.length > 0, log };
}

const action = has('--repair-memory') ? repairMemory
  : has('--flush-learning') ? flushLearning
    : has('--train-learning') ? trainLearning
      : has('--distill-fleet') ? distillFleet
        : null;

if (!action) {
  console.log('health-repair — repair actions behind the console\'s health recommendations\n');
  console.log('  --repair-memory [--db <path>]   REINDEX a corrupt AgentDB store (backs up first, proves row count)');
  console.log('  --flush-learning                drain the capture queue into the learner');
  console.log('  --train-learning                run one training cycle');
  console.log('  --distill-fleet [--root <dir>]  distill embedded-but-unmined stores (snapshots each first)');
  process.exit(2);
}

const res = action();
console.log(res.log);
process.exit(res.ok ? 0 : 1);
