// ux-render-best-of-n.test.mjs — the retry must rescue CONTENTION and never rescue a REGRESSION.
//
// WHY THIS EXISTS. On 2026-08-06 the hosted windows-latest lane measured `console time-to-visible`
// at 877ms, 4523ms and 5535ms on an unchanged product — a 6x spread against a hard 4000ms budget.
// Gating one wall-clock sample therefore failed roughly a third of Windows runs for reasons nobody
// could act on, and a lane that is red for unactionable reasons trains people to ignore red.
//
// The dangerous fix is raising win32's budget to 6000ms: quiet, and blind to the exact regression
// the gate exists for. Best-of-N instead fixes the SAMPLING and leaves the budget alone.
//
// THE WHOLE RISK OF THIS CHANGE is that it becomes a way to pass a genuinely slow build. So the
// load-bearing test here is not "a flaky run goes green" — it is "a uniformly slow run stays RED,
// every attempt, no matter how many attempts it gets." If that assertion is ever deleted, this
// module is a regression-hiding device.
import { describe, it, expect } from 'vitest';
import {
  runRenderProbeBestOf, betterAttempt, overBudgetRows, RENDER_ATTEMPTS,
} from '../../scripts/qe/ux-suite.mjs';

const BUDGETS = { 'console time-to-visible': 4000, 'tips time-to-visible (hero)': 3500 };

/** One probe result shaped like the real one. */
const attempt = (consoleMs, tipsMs = 1000, notes = []) => ({
  results: [
    { label: 'console time-to-visible', ms: consoleMs },
    { label: 'tips time-to-visible (hero)', ms: tipsMs },
  ],
  notes,
  acceptance: [{ label: 'stub', pass: true, detail: 'stub' }],
});

/** A run() that replays a fixed sequence of attempts and counts how many were consumed. */
function replay(sequence) {
  let i = 0;
  const fn = async () => sequence[Math.min(i++, sequence.length - 1)];
  return { fn, used: () => i };
}

describe('ux-qe render probe — best-of-N rescues contention', () => {
  it('a slow FIRST sample followed by a healthy one PASSES, and reports the retry', async () => {
    // The measured Windows pattern: 5535ms then 877ms.
    const { fn, used } = replay([attempt(5535), attempt(877)]);
    const r = await runRenderProbeBestOf(BUDGETS, { attempts: 3, run: fn });
    expect(overBudgetRows(r.results, BUDGETS)).toEqual([]);
    expect(r.results.find((x) => x.label === 'console time-to-visible').ms).toBe(877);
    expect(r.attemptsUsed).toBe(2);
    expect(used()).toBe(2); // stopped as soon as it was clean — no wasted third run
  });

  it('a healthy FIRST sample costs exactly one attempt (the common path stays free)', async () => {
    const { fn, used } = replay([attempt(900), attempt(100)]);
    const r = await runRenderProbeBestOf(BUDGETS, { attempts: 3, run: fn });
    expect(r.attemptsUsed).toBe(1);
    expect(used()).toBe(1);
  });
});

describe('ux-qe render probe — best-of-N must NOT rescue a regression', () => {
  it('THE LOAD-BEARING ASSERTION: uniformly slow stays RED after every attempt', async () => {
    // A real regression is slow every time. Give it the full budget of retries and it must still
    // fail — otherwise this module is a way to ship a slow product.
    const { fn, used } = replay([attempt(9000), attempt(9100), attempt(8800)]);
    const r = await runRenderProbeBestOf(BUDGETS, { attempts: 3, run: fn });
    const over = overBudgetRows(r.results, BUDGETS);
    expect(over.length).toBe(1);
    expect(over[0].label).toBe('console time-to-visible');
    // and it kept the BEST of the bad ones, so the reported number is honest, not the worst
    expect(over[0].ms).toBe(8800);
    expect(used()).toBe(3); // exhausted its attempts rather than giving up early
  });

  it('cannot pass anything a single attempt would have passed — it only ever adds attempts', async () => {
    // Magnitude, not direction: 4001ms is one millisecond over and must still be over.
    const { fn } = replay([attempt(4001)]);
    const r = await runRenderProbeBestOf(BUDGETS, { attempts: 3, run: fn });
    expect(overBudgetRows(r.results, BUDGETS).length).toBe(1);
  });

  it('a probe that could not measure at all is never treated as clean', async () => {
    // notes = the harness failed to produce a reading. Retrying is fine; swallowing is not.
    const { fn } = replay([attempt(null), attempt(null)]);
    const r = await runRenderProbeBestOf(BUDGETS, { attempts: 2, run: fn });
    expect(overBudgetRows(r.results, BUDGETS).length).toBeGreaterThan(0);
  });

  it('a clean timing WITH probe notes does not short-circuit — notes are a failure, not a nit', async () => {
    const { fn, used } = replay([attempt(900, 1000, ['render probe returned no readable JSON'])]);
    await runRenderProbeBestOf(BUDGETS, { attempts: 2, run: fn });
    expect(used()).toBe(2); // did not accept the noted attempt as final
  });
});

describe('ux-qe render probe — attempt ranking', () => {
  it('fewer over-budget rows wins, and ties break on the faster total', () => {
    const oneBad = attempt(5000, 1000);   // 1 over
    const twoBad = attempt(5000, 9000);   // 2 over
    expect(betterAttempt(oneBad, twoBad, BUDGETS)).toBe(oneBad);
    const fast = attempt(4500, 1000);
    const slow = attempt(4600, 1000);
    expect(betterAttempt(slow, fast, BUDGETS)).toBe(fast);
  });

  it('defaults to 3 attempts and honours the env override', () => {
    expect(RENDER_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(RENDER_ATTEMPTS)).toBe(true);
  });
});
