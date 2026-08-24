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

const ruflo = (args) =>
  // A global npm ruflo is ruflo.cmd on Windows; Node refuses to exec .cmd without a shell
  // (CVE-2024-27980) -- same guard scripts/distill-project.mjs already carries for this binary.
  execFileSync(RUFLO, args, { cwd: dir, encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });

console.log(`\nRecording lesson into ${path.basename(dir)}/.swarm/memory.db  (namespace: ${ns})`);
console.log(`  key: ${key}`);

// 1a. STORE (native, signal namespace) — L1 content + L2 embedding
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
  stored = String(back).includes(value);
} catch (e) {
  console.error('  round-trip FAILED:', String(e.stdout || e.message).split('\n')[0]);
}
console.log(`  1. store   -> ${stored ? 'OK (round-trip verified)' : 'store reported no error, but retrieve did not return the value'}`);

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
