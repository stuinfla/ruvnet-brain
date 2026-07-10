#!/usr/bin/env node
// loop-checkpoint.mjs — the durable state of an unattended loop (ADR-0011 Phase 1 / ADR-0008).
//
// The loop's failure modes are opposites: halting to ask an empty room, and running forever with
// no finish line. This file is the contract that prevents both. Shape follows rUv's own durable
// execution (ruflo LongRunningWorker: saveCheckpoint/resumeFromCheckpoint; agenticow: roll back
// WITHOUT replaying completed steps):
//
//   { iteration, doneCriteria, next, blockers, noProgressCount, updatedAt }
//
//   read   → print the checkpoint (or {}) — the loop's FIRST act each iteration, so a killed run
//            resumes from `next` instead of re-deriving the plan from a cold context
//   write  → persist this iteration's state — the loop's LAST act each iteration. If `next` is
//            unchanged from the previous write, noProgressCount increments; else it resets.
//   check  → evaluate stop conditions. Exit codes are the protocol:
//              0 = continue      3 = DONE (doneCriteria command exited 0)
//              4 = NO-PROGRESS stop (two strikes)      2 = usage/state error
//
// doneCriteria is a SHELL COMMAND, not prose — "machine-checkable done" means exit code 0, not a
// model's opinion that it's finished.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DIR = arg('--dir', process.cwd());
const FILE = path.join(DIR, '.ruvnet-brain', 'checkpoint.json');

export function readCheckpoint(file = FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeCheckpoint({ iteration, doneCriteria, next, blockers }, file = FILE) {
  const prev = readCheckpoint(file);
  const noProgressCount = prev && prev.next === next ? (prev.noProgressCount ?? 0) + 1 : 0;
  const cp = {
    iteration: Number(iteration),
    doneCriteria: doneCriteria ?? prev?.doneCriteria ?? null,
    next: next ?? '',
    blockers: blockers ?? '',
    noProgressCount,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  fs.renameSync(tmp, file); // atomic — a kill mid-write never leaves a torn checkpoint
  return cp;
}

/** Stop-condition verdict. Pure decision from state + one real doneCriteria execution. */
export function checkCheckpoint(file = FILE, runner = (c) => spawnSync('sh', ['-c', c], { stdio: 'ignore' }).status) {
  const cp = readCheckpoint(file);
  if (!cp) return { code: 2, verdict: 'no checkpoint — the loop must write one before check' };
  if (cp.doneCriteria) {
    const status = runner(cp.doneCriteria);
    if (status === 0) return { code: 3, verdict: `DONE — doneCriteria passed: ${cp.doneCriteria}` };
  }
  if ((cp.noProgressCount ?? 0) >= 2) {
    return { code: 4, verdict: `NO-PROGRESS stop — 'next' unchanged for ${cp.noProgressCount} iterations: ${cp.next}` };
  }
  return { code: 0, verdict: `continue — iteration ${cp.iteration}, next: ${cp.next}` };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (cmd === 'read') {
    console.log(JSON.stringify(readCheckpoint() ?? {}, null, 2));
  } else if (cmd === 'write') {
    const iteration = arg('--iteration');
    if (iteration === null) { console.error('write: --iteration required'); process.exit(2); }
    const cp = writeCheckpoint({ iteration, doneCriteria: arg('--done-criteria'), next: arg('--next', ''), blockers: arg('--blockers', '') });
    console.log(JSON.stringify(cp, null, 2));
  } else if (cmd === 'check') {
    const r = checkCheckpoint();
    console.log(r.verdict);
    process.exit(r.code);
  } else {
    console.error('usage: loop-checkpoint.mjs <read|write|check> [--dir D] [--iteration N --done-criteria CMD --next "…" --blockers "…"]');
    process.exit(2);
  }
}
