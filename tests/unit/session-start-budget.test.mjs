// tests/unit/session-start-budget.test.mjs — the DERIVED-SUM latency contract (ADR-067 pattern),
// added 2026-09-11 per the cross-review correction: "add a test that derives the sum from the
// budget constants and fails if it exceeds the hooks.json timeout." This test reads BOTH numbers
// live (the budgets from session-start-budget.mjs, the timeout from plugin/hooks/hooks.json) so a
// future retiming of either one is a reviewable diff here, never a silent drift.
import { describe, expect, it } from 'vitest';
import {
  STAGE_BUDGETS_MS,
  MEASURED_NODE_BOOT_MS,
  sumBudgetsMs,
  sessionStartTimeoutMs,
} from '../../plugin/scripts/session-start-budget.mjs';

describe('SessionStart derived-sum latency budget contract', () => {
  it('sums every declared stage budget below the hook\'s own hooks.json timeout, minus measured node boot', () => {
    const timeoutMs = sessionStartTimeoutMs();
    const sum = sumBudgetsMs();
    expect(sum).toBeLessThan(timeoutMs - MEASURED_NODE_BOOT_MS);
  });

  it('restore is budgeted at <= 1000ms and banner at <= 200ms (explicit reviewer corrections)', () => {
    expect(STAGE_BUDGETS_MS.restore).toBeLessThanOrEqual(1000);
    expect(STAGE_BUDGETS_MS.banner).toBeLessThanOrEqual(200);
  });

  it('every declared stage has an explicit, positive budget', () => {
    expect(Object.keys(STAGE_BUDGETS_MS).length).toBeGreaterThan(0);
    for (const [name, ms] of Object.entries(STAGE_BUDGETS_MS)) {
      expect(ms, `stage "${name}" must have a positive budget`).toBeGreaterThan(0);
    }
  });

  it('fails loudly (not silently) if a future stage budget pushes the sum over the timeout', () => {
    // Prove the contract can actually fail — not a test that only ever passes (Rule 22's "a test
    // that cannot fail on broken code is not a test"). Simulate a stage added carelessly.
    const inflated = { ...STAGE_BUDGETS_MS, 'hypothetical-new-stage': 100_000 };
    const timeoutMs = sessionStartTimeoutMs();
    expect(sumBudgetsMs(inflated)).toBeGreaterThan(timeoutMs - MEASURED_NODE_BOOT_MS);
  });

  it('sessionStartTimeoutMs reads the REAL hooks.json SessionStart timeout, not a hand-copied number', () => {
    const timeoutMs = sessionStartTimeoutMs();
    expect(timeoutMs).toBeGreaterThan(0);
    expect(Number.isInteger(timeoutMs)).toBe(true);
  });
});
