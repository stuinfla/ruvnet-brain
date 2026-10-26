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
//   stale  → is `updatedAt` too old to trust (H3, ADR-0011 Phase 1's stale-resume gap)? Exit codes:
//              0 = fresh (safe to resume)      1 = stale (stdout: age in whole days)
//              2 = unknown (no checkpoint, or no parseable updatedAt — never treated as fresh OR stale)
//
// doneCriteria is a SHELL COMMAND, not prose — "machine-checkable done" means exit code 0, not a
// model's opinion that it's finished.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

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

// H3 (GitHub issue: AUTONOMOUS MODE injected into attended sessions + a stale checkpoint resumed as
// if it were live). ground-ruvnet.sh used to inject `.ruvnet-brain/checkpoint.json`'s raw content on
// every autonomous-flagged turn with no age check at all — a checkpoint from a loop that ended days
// or weeks ago would be resumed as though it were the current session's own state. This is the ONE
// place "how old is too old" is decided; ground-ruvnet.sh (via the `stale` CLI verb below) and
// scripts/single-source-check.mjs's E1 audit both judge staleness against this exact threshold and
// this exact field, so the two can never quietly disagree about what "stale" means.
export const CHECKPOINT_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Age verdict for a checkpoint object, judged by its OWN `updatedAt` claim — never by the file's
 * mtime, which a copy/rsync/restore can reset without the checkpoint's content actually changing.
 * `known: false` means there is nothing to judge (no checkpoint, or no parseable `updatedAt`); a
 * caller must treat "unknown" as neither proven-fresh nor proven-stale.
 */
export function checkpointStaleness(cp, now = Date.now()) {
  const updatedAtMs = cp && typeof cp.updatedAt === 'string' ? Date.parse(cp.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return { known: false, stale: false, ageMs: null, ageDays: null };
  const ageMs = now - updatedAtMs;
  return { known: true, stale: ageMs >= CHECKPOINT_STALE_MS, ageMs, ageDays: ageMs / 86_400_000 };
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

const invokedDirectly = isDirectInvocation(import.meta.url);
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
  } else if (cmd === 'stale') {
    // H3: the ONE place a caller (ground-ruvnet.sh, via `node loop-checkpoint.mjs stale`) asks "is
    // this checkpoint too old to resume from?" without re-deriving the 24h rule itself. Exit codes
    // are the protocol, same style as `check`: 0 = fresh (safe to inject/resume), 1 = stale (stdout
    // carries the whole age in days, floored, for a human-readable message), 2 = unknown — no
    // checkpoint, unparseable JSON, or no usable `updatedAt` to judge by. A caller must not treat 2
    // as either fresh or stale.
    const info = checkpointStaleness(readCheckpoint());
    if (!info.known) process.exit(2);
    if (info.stale) { console.log(String(Math.floor(info.ageDays))); process.exit(1); }
    process.exit(0);
  } else {
    console.error('usage: loop-checkpoint.mjs <read|write|check|stale> [--dir D] [--iteration N --done-criteria CMD --next "…" --blockers "…"]');
    process.exit(2);
  }
}
