// tests/unit/abstain-threshold-sweep.test.mjs — replaying a measured run at another abstain threshold.
import { describe, expect, it } from 'vitest';
import { sweep } from '../../scripts/oracle/abstain-threshold-sweep.mjs';

const needs = [
  { cited: 1, topCe: 1.0, fileRank: 1 },          // confident hit at any t <= 1
  { cited: 1, topCe: -2.5, altFileRank: 3 },      // hit only once t <= -2.5
  { cited: 1, topCe: -1.0, fileRank: null, repoRank: 1 }, // a miss (right repo) that becomes "confident" at t <= -1
  { cited: 0, topCe: null, fileRank: null },      // no citation: never confident
];
const adversarial = [{ citedPath: 'a', ce: -4.6 }, { citedPath: null, ce: null }, { citedPath: 'c', ce: 1.5 }];
const heldout = [
  { stratum: 'described', citedPath: 'x', grounded: true, routed: true, ce: -0.5 },
  { stratum: 'named', citedPath: 'y', grounded: true, routed: false, ce: 3 },
  { stratum: 'named', citedPath: 'card', grounded: true, routed: true, ce: null }, // card answer: no logit, not abstained
  { stratum: 'adversarial', citedPath: 'z', grounded: true, routed: true, ce: 2 },
];

describe('sweep', () => {
  it('counts confident hits, confident misses and precision at each threshold', () => {
    const [t0, t1, t3] = sweep({ needs, adversarial, heldout }, [0, -1, -3]);
    expect([t0.needs.confidentHit.k, t0.needs.confidentMiss.k, t0.needs.precision.n]).toEqual([1, 0, 1]);
    expect([t1.needs.confidentHit.k, t1.needs.confidentMiss.k]).toEqual([1, 1]);
    expect(t1.needs.confidentRightRepo).toMatchObject({ k: 1, n: 2 });
    expect([t3.needs.confidentHit.k, t3.needs.confidentMiss.k, t3.needs.precision.k, t3.needs.precision.n]).toEqual([2, 1, 2, 3]);
  });
  it('counts off-topic abstentions and held-out routed passes under the same threshold', () => {
    const [t0, , t5] = sweep({ needs, adversarial, heldout }, [0, -1, -5]);
    expect(t0.offTopicAbstain.k).toBe(2);
    expect(t5.offTopicAbstain.k).toBe(1);
    expect(t0.heldOutRouted).toMatchObject({ k: 1, n: 3 });
    expect(t5.heldOutRouted).toMatchObject({ k: 2, n: 3 });
  });
});
