#!/usr/bin/env node
// session-start-trace.mjs — runtime enforcement of the STAGE_BUDGETS_MS contract
// (session-start-budget.mjs), plus the fine-grained diagnostic trace requested after the 2026-09-11
// incident where one SessionStart firing was silently killed by its own watchdog with zero output:
// nothing recorded WHICH stage was still running when the 5s hooks.json timeout hit.
//
// TWO JOBS, one small module (ADR-055 F16 — a gate and its evidence must not be two code paths):
//   1. stage(name, fn) — always runs fn and always records its elapsed ms. When
//      RUVNET_BRAIN_SESSION_START_TRACE=1 it also streams `SESSION_TRACE stage=<name>
//      elapsed_ms=<n>` to stderr — the exact substring scripts/selfcheck.mjs's assertContract()
//      already greps out of a slow hook's stderr (see its 'slow' violation), so a stage trace is
//      useful diagnostic detail on a stranger's machine even without the env flag set, the moment a
//      firing is already slow enough to be flagged.
//   2. A wall-clock DEADLINE derived from the very same STAGE_BUDGETS_MS: once the running total of
//      "budget that should already have been spent" would exceed the deadline, a stage is SKIPPED
//      with a one-line stderr note instead of being allowed to run past the hook's own timeout and
//      get killed with no explanation. Skipping is always safe here — every stage this file wraps is
//      advisory (SessionStart's whole contract is 'advisory'; nothing wrapped may block a session).
import { STAGE_BUDGETS_MS, sumBudgetsMs } from './session-start-budget.mjs';

/**
 * @param {object} opts
 * @param {boolean} [opts.enabled] - stream each stage's timing to stderr as it completes.
 * @param {(chunk: string) => void} [opts.write] - stderr sink (defaults to a no-op).
 * @param {Record<string, number>} [opts.budgets] - stage name -> budget ms (defaults to the shared
 *   contract in session-start-budget.mjs; a test seam only).
 * @param {number} [opts.deadlineMs] - total wall-clock budget for every WRAPPED stage combined,
 *   excluding `restore` (which runs before this tracer starts, outside session-start-core.mjs's
 *   try block). Defaults to the contract sum minus `restore`'s own budget.
 */
export function createStageTracer({
  enabled = false,
  write = () => {},
  budgets = STAGE_BUDGETS_MS,
  deadlineMs = sumBudgetsMs(budgets) - (budgets.restore || 0),
} = {}) {
  const stages = [];
  const bodyStart = Date.now();

  const record = (name, ms, extra = '') => {
    stages.push({ name, ms, skipped: Boolean(extra) });
    // A skip is an anomaly, not a diagnostic opt-in: it is the direct fix for "the watchdog killed
    // the hook with zero output", so it is written UNCONDITIONALLY, trace flag or not. Normal
    // per-stage timings stay opt-in behind RUVNET_BRAIN_SESSION_START_TRACE so a healthy hook's
    // stderr stays quiet by default.
    if (extra) write(`SESSION_TRACE stage=${name} elapsed_ms=${ms}${extra}\n`);
    else if (enabled) write(`SESSION_TRACE stage=${name} elapsed_ms=${ms}\n`);
  };

  /** Would running `name` now blow the shared wall-clock deadline? Checked against that stage's OWN
   * declared budget (not the actual runtime, which is not known until after it runs) — the same
   * "assume the worst case" posture the hooks.json timeout itself takes. */
  const wouldExceedDeadline = (name) => {
    const budget = budgets[name] ?? 0;
    return (Date.now() - bodyStart) + budget > deadlineMs;
  };

  const stage = (name, fn) => {
    if (wouldExceedDeadline(name)) {
      record(name, 0, ' skipped=budget-exceeded');
      return undefined;
    }
    const t0 = Date.now();
    const result = fn();
    record(name, Date.now() - t0);
    return result;
  };

  const stageAsync = async (name, fn) => {
    if (wouldExceedDeadline(name)) {
      record(name, 0, ' skipped=budget-exceeded');
      return undefined;
    }
    const t0 = Date.now();
    const result = await fn();
    record(name, Date.now() - t0);
    return result;
  };

  return {
    stage,
    stageAsync,
    table: () => stages.slice(),
    totalMs: () => Date.now() - bodyStart,
  };
}
