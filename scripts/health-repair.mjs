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
import { distillLearning } from '../plugin/scripts/learning-store.mjs';
import { learningContext } from '../plugin/scripts/runtime-preferences.mjs';
import { resolveRuflo, rufloInvocation } from '../plugin/scripts/ruflo-bin.mjs';
import { projectDirectory } from '../plugin/scripts/project-identity.mjs';
import { newestSnapshot, snapshotInventory, MTIME_GRACE_MS } from './snapshot-freshness.mjs';

const HOME = os.homedir();
// The SAME project root the learning hook computes, by the same rule — the two halves of the flush
// have to agree about which project they mean or they address different queues (issue #104).
// RESIDUAL of #134: RUVNET_BRAIN_PROJECT_DIR is never set by real hook dispatch on either host, so
// consult `projectDirectory()` (project-identity.mjs) — the CLAUDE_PROJECT_DIR-with-containment
// rule #85/#107 already established, reused rather than trusting the variable unconditionally.
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const requestedProject = has('--project') ? argv[argv.indexOf('--project') + 1] : undefined;
const PROJECT = learningContext({ cwd: requestedProject || process.env.RUVNET_BRAIN_PROJECT_DIR || projectDirectory() }).projectDir;

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

/** One explicit training cycle in the same learner the Console measures. */
function trainLearning() {
  const context = learningContext({ cwd: PROJECT });
  if (!context.enabled) return { ok: true, noop: true, log: 'learning is switched off — queued evidence and learner are untouched' };
  if (!RUFLO) return { ok: false, log: 'ruflo is not on this machine — install it with `npm i -g ruflo@latest` to enable learning' };
  try {
    const evidence = distillLearning(RUFLO, context, { deadline: Date.now() + 18_000, allowed: () => {
      const current = learningContext({ cwd: PROJECT }); return current.enabled && current.scope === context.scope && current.queueDir === context.queueDir;
    } });
    const verified = evidence.completed && evidence.patternDelta > 0;
    return { ok: verified, log: verified
      ? `verified ${evidence.patternDelta} new structural patterns in ${evidence.db}; no ratified lessons claimed; snapshot ${evidence.snapshot}`
      : `distillation returned without measurable pattern progress in ${evidence.db}; recorded observations remain separate; snapshot retained` };
  } catch { return { ok: false, log: 'canonical distillation unavailable; observations and pending queue retained' }; }
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
    if (!receiptPath) return true;
    try {
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      fs.writeFileSync(receiptPath, JSON.stringify({ at: new Date().toISOString(), stores: receipt }, null, 2));
      return true;
    } catch { return false; }
  };

  for (const t of targets) {
    const dir = path.join(path.dirname(t.db), 'backups');
    const backupStartedAt = Date.now();
    let priorSnapshots;
    try { priorSnapshots = snapshotInventory(dir); }
    catch (error) { failed.push(`${t.name}: refused to distill — ${error.message}`); continue; }
    try { execFileSync(RUFLO, ['memory', 'backup', '--db', t.db, '--dir', dir], { env: RUFLO_ENV, stdio: 'ignore', timeout: 300_000 }); }
    catch (e) { failed.push(`${t.name}: refused to distill — snapshot failed (${String(e.message).slice(0, 80)})`); continue; }
    // `memory backup` exiting 0 is not proof a NEW file landed in `dir` — a stale snapshot from a
    // prior fleet run sitting there already would otherwise be silently accepted as this run's undo
    // (the exact gap `distill-project.mjs` was fixed for in PR #192, applied here to fleet's own,
    // separate call site — see the 2026-08-29 Dream Cycle report, "Next steps #1").
    const snapshot = newestSnapshot(dir, backupStartedAt, MTIME_GRACE_MS, priorSnapshots);
    if (!snapshot) {
      failed.push(`${t.name}: refused to distill — snapshot reported success but no fresh file landed in ${dir}`);
      continue;
    }
    // Record the snapshot BEFORE distilling, and flush after every store. If the process is killed
    // mid-fleet, the receipt still names every store already modified — a partial receipt is
    // recoverable, a missing one is not.
    receipt.push({ db: t.db, name: t.name, backupDir: dir, snapshot });
    if (!writeReceipt()) {
      failed.push(`${t.name}: refused to distill — requested undo receipt could not be written`);
      continue;
    }

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
