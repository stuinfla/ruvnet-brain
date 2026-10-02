// tests/unit/sona-query-adapter-eval.test.mjs — ADR-099 arm B experiment helpers.
import { describe, expect, it } from 'vitest';
import { compareRanks, rankOf } from '../../scripts/oracle/sona-query-adapter-eval.mjs';

describe('rankOf', () => {
  it('is 1-based and null when the gold file is not within depth', () => {
    expect(rankOf(['a', 'b', 'c'], 'c')).toBe(3);
    expect(rankOf(['a'], 'z')).toBeNull();
  });
});

describe('compareRanks', () => {
  it('counts paired gains and losses inside the cut, and in-depth presence', () => {
    const s = compareRanks([1, 9, null, 4], [2, 3, 7, null], 5);
    expect([s.base.k, s.adapted.k, s.gained, s.lost]).toEqual([2, 2, 1, 1]);
    expect([s.inDepthBase, s.inDepthAdapted]).toEqual([3, 3]);
  });
});
