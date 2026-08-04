#!/usr/bin/env node
/**
 * distill-project.mjs — the ONE genuinely offerable capability, made genuinely reversible.
 *
 * WHY THIS FILE EXISTS. ADR-047 proposed a system for offering dormant capabilities to the user
 * unprompted. Both duelists rejected it, and GPT-5.6-Sol's arithmetic is the reason: the registry has
 * five `turnOn` commands and ZERO verified inverses, so the honest launch surface was **zero**. Its
 * one claimed exception — memory distillation — sourced its undo from `remedy-registry.mjs`'s
 * RESTORE_STORE_BACKUPS, which restores snapshots that `health-repair.mjs --distill-fleet` takes,
 * while the OFFER handed the user raw `ruflo memory distill run`. Verified against `--help`: that
 * command has no backup option at all. **The offered action and the promised inverse were two
 * different execution paths.**
 *
 * An undo promise with no branch behind the action actually offered is this repo's origin sin. So
 * before any delivery system gets built, one capability has to be safe end to end. This is that one.
 *
 * WHAT IT IS NOT. It is not a reimplementation of distillation, and it does not hand-roll a backup.
 * `ruflo memory backup` is rUv's own snapshot and its `--help` states it is "WAL-safe, rotated" —
 * which matters, because `cp` on a live WAL database silently amputates the newest transactions (this
 * project has already lost data that way once). This file is a WRAPPER that sequences rUv's real
 * commands in the order that makes the operation reversible, and refuses to proceed when it cannot.
 *
 * THE SEQUENCE, and every step is there because skipping it breaks a guarantee:
 *
 *   1. status BEFORE     — the delta is meaningless without it, and "it worked" is unfalsifiable.
 *   2. WAL-safe snapshot — rUv's `memory backup --db --dir`. This is the undo. No snapshot, no run.
 *   3. receipt, FAIL-CLOSED — written and fsync'd BEFORE the mutation. `health-repair.mjs:185`
 *      catches its own receipt-write failure and distills anyway; that is how a mutation happens with
 *      no durable record of where its undo lives. Here a receipt that cannot be written ABORTS.
 *   4. distill run --db  — project-scoped, `--budget-usd 0` (the default), so nothing paid can fire.
 *   5. status AFTER + delta — verified, and reported as a measurement rather than a verdict.
 *   6. receipt completed — the same file, updated with the outcome and the exact restore command.
 *
 * `--restore <snapshot>` is the inverse, and it is tested. An undo nobody has run is a promise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveRuflo, RUFLO_MISSING } from '../plugin/scripts/ruflo-bin.mjs';

const HOME = os.homedir();
// Issue #99: this was `process.env.RUFLO_BIN || path.join(HOME, '.npm-global/bin/ruflo')`, so every
// install whose npm prefix is not the owner's (Homebrew, nvm, Volta, plain `npm -g`) was told its
// tool was missing while ruflo sat on their PATH. One resolver, shared — see ruflo-bin.mjs.
const RUFLO = resolveRuflo();
const RUFLO_ENV = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' };

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

const PROJECT = path.resolve(arg('--project', process.cwd()));
const DB = path.resolve(arg('--db', path.join(PROJECT, '.swarm', 'memory.db')));
const BACKUP_DIR = path.resolve(arg('--backup-dir', path.join(PROJECT, '.swarm', 'backups')));
const RECEIPTS = path.join(HOME, '.cache', 'ruvnet-brain', 'distill-receipts.jsonl');
const DRY = has('--dry-run');

const say = (s) => process.stdout.write(s + '\n');
const die = (s, code = 1) => { process.stderr.write(s + '\n'); process.exit(code); };

/** Run a ruflo subcommand, returning {ok, out, err}. Never throws — callers decide what a failure means. */
function ruflo(args, { timeout = 600_000 } = {}) {
  const r = spawnSync(RUFLO, args, { encoding: 'utf8', timeout, env: RUFLO_ENV, shell: process.platform === 'win32' }); // a global npm ruflo is ruflo.cmd on Windows; Node refuses .cmd without a shell (CVE-2024-27980)
  return { ok: !r.error && r.status === 0, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error.message) : '') };
}

/**
 * Read the distilled-table counts. Parsed from `memory distill status`, and a parse failure is
 * reported as UNKNOWN rather than 0 — a fabricated zero here would turn "we could not read it" into
 * "there was nothing", which is the exact lie this repo's registry rule exists to kill.
 */
function distillCounts() {
  const r = ruflo(['memory', 'distill', 'status', '--db', DB], { timeout: 120_000 });
  if (!r.ok) return { readable: false, why: r.err.trim().split('\n')[0] || 'distill status failed', raw: r.out };
  const num = (label) => {
    const m = new RegExp(`${label}[^0-9]{0,40}(\\d[\\d,]*)`, 'i').exec(r.out);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  return {
    readable: true,
    patterns: num('reasoning_patterns') ?? num('patterns'),
    episodes: num('episodes'),
    raw: r.out.trim(),
  };
}

/** Append a receipt line, fsync'd. Returns false if it cannot be durably written — the caller ABORTS. */
function writeReceipt(rec) {
  try {
    fs.mkdirSync(path.dirname(RECEIPTS), { recursive: true });
    const fd = fs.openSync(RECEIPTS, 'a');
    try { fs.writeSync(fd, JSON.stringify(rec) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return true;
  } catch { return false; }
}

/** The newest snapshot this project has, or null. Used to tell the user what `--restore` would take. */
function newestSnapshot() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /\.(db|sqlite|bak)$/i.test(f) || /memory.*\d/.test(f))
      .map((f) => ({ f, p: path.join(BACKUP_DIR, f), t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].p : null;
  } catch { return null; }
}

// ── RESTORE — the inverse. Deliberately first, because an undo you cannot reach is not an undo. ────
if (has('--restore')) {
  const snap = arg('--restore', null) || newestSnapshot();
  if (!snap) die(`no snapshot to restore from — looked in ${BACKUP_DIR.replace(HOME, '~')}`);
  if (!fs.existsSync(snap)) die(`snapshot not found: ${snap}`);
  if (DRY) { say(`[dry-run] would restore ${snap.replace(HOME, '~')} → ${DB.replace(HOME, '~')}`); process.exit(0); }

  // Snapshot the CURRENT state before overwriting it. Restoring is itself a mutation, and an undo
  // that destroys the thing it replaces leaves the user with no way back if they restored by mistake.
  const pre = path.join(BACKUP_DIR, `pre-restore-${Date.now()}.db`);
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.copyFileSync(DB, pre); }
  catch (e) { die(`refusing to restore — could not snapshot the current DB first (${e.message})`); }

  try { fs.copyFileSync(snap, DB); }
  catch (e) { die(`restore FAILED (${e.message}). Your pre-restore copy is at ${pre.replace(HOME, '~')}`); }

  writeReceipt({ at: new Date().toISOString(), action: 'restore', db: DB, from: snap, preRestore: pre });
  say(`restored ${snap.replace(HOME, '~')} → ${DB.replace(HOME, '~')}`);
  say(`the state you replaced is at ${pre.replace(HOME, '~')} if you need it back`);
  process.exit(0);
}

// ── PRE-FLIGHT ─────────────────────────────────────────────────────────────────────────────────────
// Two different facts, so two different sentences. `null` means we looked everywhere and found
// nothing; a path that does not exist means the user pointed RUFLO_BIN somewhere empty, and naming
// that exact path back to them is the whole value of the message.
if (!RUFLO) die(RUFLO_MISSING);
if (!fs.existsSync(RUFLO)) die(`ruflo is not at ${RUFLO.replace(HOME, '~')} — install it with \`npm i -g ruflo@latest\``);
if (!fs.existsSync(DB)) die(`no memory store at ${DB.replace(HOME, '~')} — nothing to distill for this project`);

say(`project : ${PROJECT.replace(HOME, '~')}`);
say(`store   : ${DB.replace(HOME, '~')}`);

const before = distillCounts();
if (!before.readable) {
  // Refuse rather than guess. A delta computed from an unreadable baseline is a fabricated number.
  die(`cannot read distill status for this store (${before.why}) — refusing to run, because without a baseline the result would be unverifiable`);
}
say(`before  : ${before.patterns ?? '?'} patterns, ${before.episodes ?? '?'} episodes`);

if (DRY) {
  const r = ruflo(['memory', 'distill', 'run', '--db', DB, '--dry-run']);
  say('');
  say(r.out.trim() || '(no dry-run output)');
  say('');
  say('[dry-run] nothing was written, and no snapshot was taken.');
  process.exit(r.ok ? 0 : 1);
}

// ── 1. SNAPSHOT FIRST. This is the undo; without it the operation is not offerable. ────────────────
say('snapshot: taking a WAL-safe copy via `ruflo memory backup` before touching anything…');
const bk = ruflo(['memory', 'backup', '--db', DB, '--dir', BACKUP_DIR]);
if (!bk.ok) {
  die(`REFUSING TO DISTILL — the snapshot failed (${bk.err.trim().split('\n')[0] || 'unknown error'}).\n`
    + 'This is deliberate: distillation without a verified undo is exactly the unsafe offer this wrapper exists to prevent.');
}
const snapshot = newestSnapshot();
if (!snapshot) die('REFUSING TO DISTILL — `memory backup` reported success but no snapshot file is present, so the undo cannot be located.');
say(`snapshot: ${snapshot.replace(HOME, '~')}`);

// ── 2. RECEIPT, FAIL-CLOSED, BEFORE THE MUTATION. ─────────────────────────────────────────────────
// health-repair.mjs:185 catches its own receipt-write failure and distills anyway. That is how a
// mutation happens with no durable record of where its undo lives. Here, no receipt means no run.
const startedAt = new Date().toISOString();
if (!writeReceipt({ at: startedAt, action: 'distill:start', db: DB, snapshot, before: { patterns: before.patterns, episodes: before.episodes } })) {
  die(`REFUSING TO DISTILL — could not durably write a receipt to ${RECEIPTS.replace(HOME, '~')}.\n`
    + 'A mutation with no record of its undo is worse than no mutation. Fix the path and re-run.');
}

// ── 3. THE ACTUAL WORK — rUv's command, project-scoped, $0 by default. ────────────────────────────
say('distill : running `ruflo memory distill run` against this project only…');
const run = ruflo(['memory', 'distill', 'run', '--db', DB]);
if (run.out.trim()) say(run.out.trim());

// ── 4. VERIFY THE DELTA. A measurement, not a verdict. ────────────────────────────────────────────
const after = distillCounts();
const delta = (before.readable && after.readable && before.patterns != null && after.patterns != null)
  ? after.patterns - before.patterns : null;

const outcome = {
  at: new Date().toISOString(), action: 'distill:done', db: DB, snapshot, startedAt,
  ok: run.ok,
  before: { patterns: before.patterns, episodes: before.episodes },
  after: after.readable ? { patterns: after.patterns, episodes: after.episodes } : { unreadable: after.why },
  deltaPatterns: delta,
  restore: `node ${path.join(path.dirname(new URL(import.meta.url).pathname))}/distill-project.mjs --restore ${snapshot}`,
};
writeReceipt(outcome);

say('');
if (!run.ok) {
  say(`distill did NOT complete cleanly: ${run.err.trim().split('\n')[0] || 'unknown error'}`);
  say(`your store is unchanged or partially changed; restore with:\n  ${outcome.restore}`);
  process.exit(1);
}
if (delta === null) say('after   : counts could not be re-read, so the change is UNVERIFIED — the snapshot above is still your undo.');
else if (delta > 0) say(`after   : ${after.patterns} patterns (+${delta}) — measured, not asserted.`);
else say(`after   : ${after.patterns} patterns (no change). Distillation ran and found nothing new to mine; that is a real answer, not a failure.`);
say(`undo    : ${outcome.restore}`);
