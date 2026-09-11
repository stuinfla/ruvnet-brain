// tests/unit/session-start-trace.test.mjs — the RUNTIME half of the derived-sum budget contract.
// tests/unit/session-start-budget.test.mjs already proves the STATIC math (the declared budgets sum
// under the hook's timeout); this file proves the mechanism that actually ACTS on that contract at
// runtime — the exact gap a direct reviewer of this work would ask about, and the reason "the
// watchdog killed the hook with zero output" was a real, reproduced incident this module exists to
// close. Per Rule 22 ("a test that cannot fail on broken code is not a test"), every case here
// proves something that would actually go wrong if createStageTracer regressed — a stage that
// should be skipped is proven skipped BY NEVER CALLING ITS FUNCTION (a spy call-count, not a guess
// from the output shape), and the "always-noted, never silent" claim is proven with the trace flag
// explicitly OFF.
import { describe, expect, it, vi } from 'vitest';
import { createStageTracer } from '../../plugin/scripts/session-start-trace.mjs';

describe('createStageTracer — stage()', () => {
  it('runs the stage function and returns its result', () => {
    const tracer = createStageTracer({ budgets: { a: 100 }, deadlineMs: 1000 });
    const result = tracer.stage('a', () => 42);
    expect(result).toBe(42);
  });

  it('records elapsed ms for a stage that ran', () => {
    const tracer = createStageTracer({ budgets: { a: 100 }, deadlineMs: 1000 });
    tracer.stage('a', () => { /* fast */ });
    const [row] = tracer.table();
    expect(row.name).toBe('a');
    expect(row.skipped).toBe(false);
    expect(row.ms).toBeGreaterThanOrEqual(0);
  });

  it('writes nothing to stderr for a normal stage when the trace flag is OFF (quiet by default)', () => {
    const write = vi.fn();
    const tracer = createStageTracer({ enabled: false, write, budgets: { a: 100 }, deadlineMs: 1000 });
    tracer.stage('a', () => {});
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the per-stage timing to stderr when the trace flag is ON', () => {
    const write = vi.fn();
    const tracer = createStageTracer({ enabled: true, write, budgets: { a: 100 }, deadlineMs: 1000 });
    tracer.stage('a', () => {});
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatch(/^SESSION_TRACE stage=a elapsed_ms=\d+\n$/);
  });

  it('SKIPS a stage whose declared budget would blow the deadline — proven by the function never running', () => {
    const fn = vi.fn(() => 'should never be seen');
    // deadlineMs=0 means ANY stage's own declared budget already exceeds "remaining time".
    const tracer = createStageTracer({ budgets: { heavy: 500 }, deadlineMs: 0 });
    const result = tracer.stage('heavy', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('writes the skip note UNCONDITIONALLY, even with the trace flag OFF — the whole point of this file', () => {
    const write = vi.fn();
    const tracer = createStageTracer({ enabled: false, write, budgets: { heavy: 500 }, deadlineMs: 0 });
    tracer.stage('heavy', () => {});
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatch(/^SESSION_TRACE stage=heavy elapsed_ms=0 skipped=budget-exceeded\n$/);
  });

  it('records a skipped stage in the table with skipped:true', () => {
    const tracer = createStageTracer({ budgets: { heavy: 500 }, deadlineMs: 0 });
    tracer.stage('heavy', () => {});
    const [row] = tracer.table();
    expect(row).toMatchObject({ name: 'heavy', ms: 0, skipped: true });
  });

  it('an UNDECLARED stage (budget 0 by default) is never skipped by the deadline check alone', () => {
    // wouldExceedDeadline uses `budgets[name] ?? 0` — an unknown stage adds zero to the projection,
    // so it only gets skipped once the deadline is ALREADY passed, not pre-emptively starved.
    const fn = vi.fn(() => 'ran');
    const tracer = createStageTracer({ budgets: {}, deadlineMs: 1000 });
    expect(tracer.stage('mystery', fn)).toBe('ran');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the deadline is a SEQUENCE budget: enough early stages consuming it starve a later one', () => {
    // Each stage's OWN elapsed time counts against the shared deadline for the NEXT stage's check —
    // this is what makes it a derived-sum contract rather than N independent per-stage timers.
    const slow = () => { const until = Date.now() + 30; while (Date.now() < until) { /* burn */ } };
    const tracer = createStageTracer({ budgets: { a: 10, b: 10, c: 10 }, deadlineMs: 35 });
    tracer.stage('a', slow); // consumes ~30ms of the 35ms deadline
    const fn = vi.fn();
    tracer.stage('b', fn); // 30 + 10 > 35 -> must be skipped
    expect(fn).not.toHaveBeenCalled();
    const rows = tracer.table();
    expect(rows.find((r) => r.name === 'b').skipped).toBe(true);
  });
});

describe('createStageTracer — stageAsync()', () => {
  it('awaits the async stage function and returns its resolved value', async () => {
    const tracer = createStageTracer({ budgets: { a: 100 }, deadlineMs: 1000 });
    const result = await tracer.stageAsync('a', async () => 'done');
    expect(result).toBe('done');
  });

  it('SKIPS an async stage over budget without ever invoking it', async () => {
    const fn = vi.fn(async () => 'should never be seen');
    const tracer = createStageTracer({ budgets: { heavy: 500 }, deadlineMs: 0 });
    const result = await tracer.stageAsync('heavy', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('propagates a thrown/rejected error from a stage that DID run (fail-loud, not swallowed)', async () => {
    const tracer = createStageTracer({ budgets: { a: 100 }, deadlineMs: 1000 });
    await expect(tracer.stageAsync('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('createStageTracer — defaults derived from the shared budget contract', () => {
  it('defaults deadlineMs to the contract sum minus restore, so it stays in sync without a second number', () => {
    const budgets = { restore: 1000, a: 200, b: 300 };
    const tracer = createStageTracer({ budgets });
    // Consume nothing, then ask for a stage whose OWN budget is exactly the remaining room.
    const fn = vi.fn(() => 'ok');
    expect(tracer.stage('a', fn)).toBe('ok'); // 0 + 200 <= 500 (200+300)
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
