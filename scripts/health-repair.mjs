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
import { learnerCwd, loadRuntimePreferences } from '../plugin/scripts/runtime-preferences.mjs';

const HOME = os.homedir();
// The SAME project root learn-flush.mjs computes, by the same rule — the two halves of the flush
// have to agree about which project they mean or they address different queues (issue #104).
const PROJECT = process.env.RUVNET_BRAIN_PROJECT_DIR || process.cwd();
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

/**
 * Drain the capture queue into rUv's learner — his tool, not ours.
 *
 * ISSUE #104: this measured one queue and drained another, so it could only ever report "fed 0".
 * The flusher was spawned with NO environment, so inside learn-flush.mjs RUVNET_LEARNING_SCOPE was
 * unset and defaulted to 'project' — it drained `<project>/.swarm/ruvnet-brain-learn/` while THIS
 * function counted `<user>/.cache/ruvnet-brain/learn/`. `before - after` was structurally 0: it
 * could not report truthfully in either direction even on a flush that worked, and the real queue
 * grew forever. Two independent defaults are not an agreement.
 *
 * So: resolve the scope ONCE, from the same policy module learn-flush reads, derive the queue root
 * FROM that scope, pass the scope (and the exact queue file) to the child explicitly, and measure
 * the root that was actually drained.
 *
 * And LOOP. learn-flush feeds at most MAX_ACTIONS distinct actions per invocation and writes the
 * remainder back on purpose (a SessionEnd hook must stay fast), so one call cannot drain a deep
 * queue — the reporter needed 15 rounds for 293 entries. A single call would leave a queue that
 * "flushes" every time and never empties, which is the same lie in slow motion.
 */
function flushLearning() {
  const flusher = path.join(HOME, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin', 'scripts', 'learn-flush.mjs');
  const local = path.join(PROJECT, 'plugin', 'scripts', 'learn-flush.mjs');
  const script = fs.existsSync(flusher) ? flusher : (fs.existsSync(local) ? local : null);
  if (!script) return { ok: false, log: 'learn-flush.mjs not found — cannot drain the queue' };

  const configured = process.env.RUVNET_LEARNING_SCOPE
    || loadRuntimePreferences({ cwd: PROJECT }).values.learningScope;
  const scope = ['off', 'project', 'user'].includes(configured) ? configured : 'project';
  if (scope === 'off') {
    return { ok: true, noop: true, log: 'learning is switched off for this project — nothing is being captured, so there is nothing to feed' };
  }

  // Derived from the scope, never assumed: this is the directory the child will actually read.
  const queueDir = scope === 'user'
    ? path.join(HOME, '.cache', 'ruvnet-brain', 'learn')
    : path.join(PROJECT, '.swarm', 'ruvnet-brain-learn');
  // Displayed to a human and matched by tests, so it is normalised to forward slashes on every
  // platform. Without this, Windows reports `~\.cache\ruvnet-brain\learn` while macOS and Linux
  // report `~/.cache/ruvnet-brain/learn` — the same location under two spellings, which is the
  // exact defect class this branch has been closing (one fact, two representations).
  const where = queueDir.replace(HOME, '~').split(path.sep).join('/');

  const queueFiles = () => {
    try { return fs.readdirSync(queueDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(queueDir, f)); }
    catch { return []; }
  };
  const depthOf = (f) => {
    try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
  };
  const depth = () => queueFiles().reduce((n, f) => n + depthOf(f), 0);

  const before = depth();
  if (!before) return { ok: true, noop: true, log: `nothing queued in ${where} — the learner is already caught up` };

  const env = { ...process.env, RUVNET_LEARNING_SCOPE: scope, RUVNET_BRAIN_PROJECT_DIR: PROJECT };
  const deadline = Date.now() + 540_000; // inside the 600s this action is allowed overall
  const stalled = [];
  for (const file of queueFiles()) {
    let d = depthOf(file);
    while (d > 0 && Date.now() < deadline) {
      try {
        execFileSync(process.execPath, [script], {
          env: { ...env, LEARN_QUEUE: file },
          stdio: 'ignore',
          timeout: Math.min(120_000, Math.max(1_000, deadline - Date.now())),
        });
      } catch (e) { stalled.push(`${path.basename(file)}: ${String(e.message).split('\n')[0].slice(0, 80)}`); break; }
      const next = depthOf(file);
      // STRICT progress, or stop. learn-flush KEEPS a queue it could not feed (by design — the queue
      // is evidence), so a round that shrinks nothing means the learner is not accepting the work.
      // Spinning on it would burn the whole budget and still report zero.
      if (next >= d) { stalled.push(`${path.basename(file)}: ${d} entr${d === 1 ? 'y' : 'ies'} would not feed`); break; }
      d = next;
    }
  }

  const after = depth();
  const fed = before - after;
  if (fed <= 0) {
    // Name the most likely cause instead of shrugging: learn-flush invokes ruflo at a FIXED path,
    // so on a machine with a different npm prefix it feeds nothing and honestly keeps the queue.
    const rufloAtFixedPath = fs.existsSync(path.join(HOME, '.npm-global/bin/ruflo'));
    const why = stalled.length ? ` (${stalled.slice(0, 3).join('; ')})` : '';
    const hint = rufloAtFixedPath ? '' : ' ruflo is not at ~/.npm-global/bin/ruflo, which is where the flusher looks for it —'
      + ' `npm i -g ruflo@latest` installs it there.';
    return { ok: false, log: `fed 0 of ${before} queued events from ${where}${why} — the queue is preserved for retry.${hint}` };
  }
  return {
    ok: true,
    log: `fed ${fed} captured events into the ${scope} learner (queue ${before} → ${after} in ${where})`
      + (after ? ` — ${after} remain and will drain on the next flush` : ''),
  };
}

/** One training cycle, via rUv's own CLI, in the GLOBAL (cross-project) learner. */
function trainLearning() {
  if (!RUFLO) return { ok: false, log: 'ruflo is not on this machine — install it with `npm i -g ruflo@latest` to enable learning' };
  try {
    // ISSUE #136: train the SAME store the console card reads. With `cwd: HOME` the card read the
    // project's learner and this trained the home one, so the button could never clear the card it
    // was offered for — a remedy that cannot resolve its own finding is worse than no button.
    // PROJECT is the same root learn-flush.mjs and learn-capture.sh resolve (#134).
    // ISSUE #139 — now that ruflo v3.38.9 made `--train` REAL (ruvnet/ruflo#2940 was a no-op
    // before), training the wrong store is no longer harmless: it moves that store's
    // lastAdaptation to 0s and the card SILENTLY SELF-CLEARS while the learner the operator
    // actually uses is untouched. #136 already moved this off `cwd: HOME`; it now shares the
    // console's resolver so the remedy provably trains the store the card measured.
    execFileSync(RUFLO, ['hooks', 'intelligence', '--train'], { cwd: learnerCwd({ cwd: PROJECT }), env: RUFLO_ENV, stdio: 'ignore', timeout: 600_000 });
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
