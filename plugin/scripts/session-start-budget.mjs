#!/usr/bin/env node
// session-start-budget.mjs — the DERIVED-SUM latency contract for SessionStart (ADR-067 pattern,
// added 2026-09-11 after two independent reviewers flagged the original per-stage timeouts as
// unaccountable numbers with no relationship to the hook's own declared budget).
//
// Every stage the hook can run declares its OWN cost HERE, once. Nothing downstream invents a
// second number: session-start-trace.mjs enforces these at runtime (skip-with-note on overrun),
// and tests/unit/session-start-budget.test.mjs sums them and fails the build the moment the total
// creeps past hooks.json's own declared SessionStart timeout — so a new stage, or a raised budget,
// is a reviewable diff instead of a silent latency regression nobody notices until a stranger's
// session hangs.
//
// `restore` is continuity's project-progression restore (plugin/scripts/project-progression-
// session-start.mjs) — accounted for HERE because it shares this hook's wall-clock budget, but the
// stage itself is NOT this lane's code and is not wrapped by session-start-trace.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOKS_JSON_PATH = path.resolve(HERE, '..', 'hooks', 'hooks.json');

/** SessionStart's own declared timeout in ms, read LIVE from hooks.json — never hand-copied, so a
 * future retiming there is the one and only place this contract has to agree with. */
export function sessionStartTimeoutMs(hooksJsonPath = HOOKS_JSON_PATH) {
  const doc = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const entry = doc?.hooks?.SessionStart?.[0]?.hooks?.[0];
  const timeoutSec = typeof entry?.timeout === 'number' ? entry.timeout : null;
  if (!timeoutSec) throw new Error(`${hooksJsonPath}: could not read SessionStart's declared timeout`);
  return timeoutSec * 1000;
}

// Per-stage budgets, ms. Every stage session-start-core.mjs (or continuity's restore) can run
// appears here exactly once. Reviewer-mandated ceilings: restore <= 1000, banner <= 200.
export const STAGE_BUDGETS_MS = {
  restore: 1000,          // continuity lane's project-progression restore — NOT this lane's code
  misc: 250,              // settings/nightly/health/console-offer/auto-pref/star — small fs reads
  // The cache read itself is budgeted at 100ms internally (session-start-issue-alert.mjs's own
  // ISSUE_POINTER_BUDGET_MS, per correction #2's exact wording); this stage's total also carries
  // the repo-scoping git check (session-start-repo-identity.mjs), bounded separately at up to
  // 1000ms under real load — never a network call either way.
  'issue-pointer': 1100,
  'signal-surface': 400,  // bounded CI-signal transition poll (see session-start-signals.mjs)
  'router-nudge': 50,     // one fs.existsSync + at-most-one-time write
  'stable-spine': 300,    // seed-dispatch decision + a single detach launch
  heartbeat: 300,         // update-check dispatch launch
  'ascii-drift': 300,     // optional ascii->svg drift advisory, already spawnSync-timeout bounded
  banner: 200,            // version/readiness/health banner assembly — pure fs reads, no subprocess
};

export function sumBudgetsMs(budgets = STAGE_BUDGETS_MS) {
  return Object.values(budgets).reduce((sum, ms) => sum + ms, 0);
}

// Measured node process boot (interpreter start + module graph load) BEFORE any stage code runs —
// real, unavoidable overhead the stage budgets above do not (and must not) account for. A named
// constant, not folded silently into one stage's budget, so a boot-time regression shows up as its
// own line instead of quietly eating an unrelated stage's headroom.
export const MEASURED_NODE_BOOT_MS = 250;
