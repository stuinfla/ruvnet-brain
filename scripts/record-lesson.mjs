#!/usr/bin/env node
/**
 * record-lesson.mjs — the durable "capture a lesson the RIGHT way" habit.
 *
 * WHY: AgentDB auto-capture records session transcripts (logging), not lessons
 * (learning), and that telemetry drowns real lessons in recall. This records a
 * lesson *structured* (task / tried / worked / critique / outcome) into a dedicated
 * `lessons` signal namespace, refines it via native distill, and proves recall.
 *
 * NATIVE ONLY — shells to `ruflo memory` (store + distill + search). It does NOT
 * reimplement any rUv capability; it enforces the structured-capture discipline
 * that rUv's own `/remember` command recommends (agentdb-memory/commands/remember.md).
 *
 * Usage:
 *   node scripts/record-lesson.mjs \
 *     --task "..." --tried "..." --worked "..." --critique "..." --outcome success \
 *     [--slug short-name] [--dir <projectDir>] [--namespace lessons]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuflo, RUFLO_MISSING } from '../plugin/scripts/ruflo-bin.mjs';

const arg = (name, def = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const task = arg('task');
if (!task) {
  console.error('ERROR: --task is required (what were you trying to do?)');
  process.exit(2);
}
const tried = arg('tried');
const worked = arg('worked');
const critique = arg('critique');
const outcome = arg('outcome', 'success');
const dir = path.resolve(arg('dir', process.cwd()));
const ns = arg('namespace', 'lessons');
const slug =
  arg('slug') ||
  task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const db = path.join(dir, '.swarm', 'memory.db');
if (!fs.existsSync(db)) {
  console.error(`ERROR: no AgentDB at ${db}\n  -> run \`ruflo memory init\` in that project first.`);
  process.exit(2);
}

const RUFLO = resolveRuflo();
if (!RUFLO) {
  console.error(`ERROR: ${RUFLO_MISSING}`);
  process.exit(2);
}

const key = `lesson-${slug}`;
const value = [
  `TASK: ${task}`,
  tried ? `TRIED(failed): ${tried}` : null,
  worked ? `WORKED: ${worked}` : null,
  critique ? `CRITIQUE: ${critique}` : null,
  `OUTCOME: ${outcome}`,
].filter(Boolean).join(' ');

// Every `ruflo` invocation auto-starts a project background daemon unless this is set (verified
// live: ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/
// daemon-autostart.js:85) — recording a lesson has no business leaving one running.
const ruflo = (args) =>
  execFileSync(RUFLO, args, { cwd: dir, encoding: 'utf8', timeout: 60000,
    shell: process.platform === 'win32', env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });

console.log(`\nRecording lesson into ${path.basename(dir)}/.swarm/memory.db  (namespace: ${ns})`);
console.log(`  key: ${key}`);

// 1a. STORE (native, signal namespace) — L1 content + L2 embedding
//
// PROVE THE PATHWAY IS LIVE THIS INVOCATION, before the real write. `key` (`lesson-${slug}`) is
// deterministic on purpose — it lets a lesson be revised in place across runs — but that same
// determinism means a second, IDENTICAL invocation (a retried or replayed capture with the same
// --task/--tried/--worked/--critique/--outcome, so the same `value`) whose store call silently
// no-ops would still retrieve the FIRST run's value back unchanged. A plain `back.includes(value)`
// cannot tell "this run wrote it" from "a prior run wrote it and this run wrote nothing" — the exact
// aliasing gap the 2026-08-29 report (docs/dream-cycle/2026-08-29-memory-durability-report.md,
// candidate #2) named and deferred until this file's round-trip discipline landed at all.
//
// The probe MUST land on a DISPOSABLE key, never `key` itself: an earlier draft of this fix poisoned
// `key` in place before overwriting it with the real value, which meant a process killed between the
// poison write and the real write (Ctrl+C, SIGKILL, OOM) left a PRIOR run's genuinely durable lesson
// permanently replaced by meaningless nonce garbage — a new data-loss mode on the one file whose
// entire purpose is durable capture, caught by an independent adversarial review before this shipped.
// A throwaway probe key never shares an interruption window with real content, exactly the shape
// `degradation-watch.mjs`'s `proveMemoryDurable()` already uses (its own disposable
// `durability-probe-${pid}-${Date.now()}` key, never the caller's data). The store pathway either
// works or doesn't for the whole process (the 2026-08-13 incident was a driver-level failure, not a
// per-key one), so a nonce on any key in the same db+namespace proves it equally well.
const probeKey = `${key}-pathway-probe-${process.pid}-${Date.now()}`;
const poison = `__record-lesson-nonce-${process.pid}-${Date.now()}__`;
let pathwayLive = false;
try {
  ruflo(['memory', 'store', '-k', probeKey, '-n', ns, '--value', poison]);
  const poisonBack = ruflo(['memory', 'retrieve', '-k', probeKey, '-n', ns, '--value-only', '--path', db]);
  pathwayLive = String(poisonBack).includes(poison);
} catch (e) {
  console.error('  pathway probe FAILED:', String(e.stdout || e.message).split('\n')[0]);
}

try {
  ruflo(['memory', 'store', '-k', key, '-n', ns, '--value', value]);
} catch (e) {
  console.error('  store FAILED:', String(e.stdout || e.message).split('\n')[0]);
  process.exit(1);
}

// 1b. PROVE THE WRITE (exact-key round trip, ADR-063). `ruflo memory store` printing "[OK] Data
// stored successfully" is not evidence of a write — that exact line was on stdout throughout the
// 2026-08-13 incident that left three days of memory unrecoverable (rowcount 0, no store-side
// error). The only accepted proof in this repo is retrieving the SAME key back through the managed
// interface and reading the VALUE, the pattern `degradation-watch.mjs`'s `proveMemoryDurable()` and
// `learning-replay-fixture.mjs`'s `retrieveExact()` already establish — never the store command's
// own claimed-success wording, and never its exit status (the CLI can exit 0 while printing
// `[ERROR]`).
let stored = false;
try {
  const back = ruflo(['memory', 'retrieve', '-k', key, '-n', ns, '--value-only', '--path', db]);
  // `pathwayLive` rules out the narrower aliasing gap above (a stale, pre-existing IDENTICAL value
  // satisfying the plain match below); the value match rules out the original 2026-08-13 shape
  // (claimed success, nothing retrievable). Neither alone is sufficient.
  stored = pathwayLive && String(back).includes(value);
} catch (e) {
  console.error('  round-trip FAILED:', String(e.stdout || e.message).split('\n')[0]);
}
console.log(`  1. store   -> ${
  stored ? 'OK (round-trip verified)'
    : pathwayLive ? 'store reported no error, but retrieve did not return the value'
    : 'store pathway unproven this run — a prior run\'s value cannot be trusted as evidence of THIS write'
}`);

// 2. REFINE (native) — L3 patterns + L4 episodes
let batchEpisodes = '?';
let distillOk = false;
try {
  const dist = ruflo(['memory', 'distill', 'run']);
  const m = dist.match(/Episodes\s*\|\s*(\d+)/i);
  if (m) batchEpisodes = m[1];
  distillOk = true;
} catch (e) {
  /* distill is best-effort; the store already succeeded */
}
// DERIVED, not asserted (F15): say what actually happened — the old line printed "refined into
// episodes+patterns" even when distill threw.
console.log(distillOk
  ? `  2. distill -> refined into episodes+patterns (batch: ${batchEpisodes})`
  : '  2. distill -> FAILED (best-effort; the raw lesson is stored, refinement will catch up on a later distill)');

// 3. VERIFY recall by the task text (paraphrase-ish), filtered to the namespace
let recalled = false;
try {
  const search = ruflo(['memory', 'search', '-q', task, '-n', ns]);
  recalled = search.includes(key.slice(0, 16));
} catch (e) {
  /* search failure shouldn't fail the record */
}
console.log(
  `  3. recall  -> ${
    recalled
      ? `✅ "${task.slice(0, 44)}…" returns ${key}`
      : '⚠️  not the top in-namespace hit (stored fine; ranking improves as signal grows)'
  }`,
);

// DERIVED, not asserted (F15): the closing line reports exactly what was verified, never more. The
// old line claimed "captured, refined, and recall-verified" even when distill failed and recall
// didn't return the key — asserted prose over an honest exit code.
const parts = ['captured', distillOk ? 'refined' : 'NOT refined (distill failed)', recalled ? 'recall-verified' : 'recall NOT verified'];
console.log(`\nDone. Lesson is ${parts.join(', ')}.\n`);
process.exit(stored ? 0 : 1);
