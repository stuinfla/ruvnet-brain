// ADR-041 acceptance test — recall and false-alarm as REAL numbers, in-fence.
//
// This is the deploy-gate escape ADR-041 found: recall and false-alarm are properties of the DETECTOR
// against a known machine state, not of production usage, so they are measurable behind the fence
// (unlike precision, which needs the real advocacy ledger). measure() builds a ground-truth scratch
// machine and runs the REAL capability-registry.mjs against it — see scripts/proactivity-metrics.mjs.
//
// The falsifiability of these numbers is proven separately, by tests/mutation/proactivity-detector-
// mutation.test.mjs (break the detector, watch the numbers move). Without that companion, a green here
// would be the "cannot fail on broken code" tautology the house rule bans — so read the two together.

import { describe, it, expect } from 'vitest';
import { measure } from '../../scripts/proactivity-metrics.mjs';

describe('ADR-041 ground-truth fixture machine — detector-layer recall + false-alarm', () => {
  it('RECALL = 1.00 (>= 0.80): the real detector calls every dormant cohort capability off', () => {
    const m = measure();
    expect(m.dormantSeen['session-capture']).toBe('unknown'); // uninspected runtime is never inferred absent
    expect(Object.entries(m.dormantSeen).filter(([,state])=>['off','idle'].includes(state))).toHaveLength(2);
    expect(m.missedDormant).toEqual([]);          // nothing dormant went unseen
    expect(m.recall).toBeGreaterThanOrEqual(0.80); // ADR-028 acceptance bar
    expect(m.recall).toBe(1);                      // and in fact all of them, on this cohort
  });

  it('FALSE-ALARM = 0: on a verified-healthy machine the detector raises no dormancy flag', () => {
    const m = measure();
    expect(m.falseAlarms).toEqual([]);
    expect(m.falseAlarmCount).toBe(0);             // ADR-028: non-negotiable zero
  });
});
