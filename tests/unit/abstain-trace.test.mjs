// tests/unit/abstain-trace.test.mjs — the abstention classifier (scripts/oracle/abstain-trace.mjs).
// Each cause is decided by the first test that explains the abstention, in pipeline order.
import { describe, expect, it } from 'vitest';
import { classify, sampleEvenly } from '../../scripts/oracle/abstain-trace.mjs';

describe('classify', () => {
  it('names the first stage that explains an abstention', () => {
    expect(classify({ poolRank: null, ceProduction: 5, ceBestChunk: 5, ceSpan: 5 })).toBe('not-in-pool');
    expect(classify({ poolRank: 3, ceProduction: 0.1, ceBestChunk: -1, ceSpan: -1 })).toBe('outranked');
    expect(classify({ poolRank: 3, ceProduction: -2, ceBestChunk: 1.5, ceSpan: -1 })).toBe('window');
    expect(classify({ poolRank: 3, ceProduction: -2, ceBestChunk: -1, ceSpan: -0.5 })).toBe('calibration');
    expect(classify({ poolRank: 3, ceProduction: -2, ceBestChunk: -1, ceSpan: 2 })).toBe('chunking');
  });
  it('treats a logit of exactly 0 as not abstained (the product rule is ce < 0)', () => {
    expect(classify({ poolRank: 1, ceProduction: 0, ceBestChunk: 0, ceSpan: 0 })).toBe('outranked');
    expect(classify({ poolRank: 1, ceProduction: -0.01, ceBestChunk: 0, ceSpan: 0 })).toBe('window');
  });
});

describe('sampleEvenly', () => {
  it('spreads a deterministic sample over the whole list', () => {
    const list = Array.from({ length: 10 }, (_, i) => i);
    expect(sampleEvenly(list, 4)).toEqual([0, 2, 5, 7]);
    expect(sampleEvenly(list, 20)).toEqual(list);
  });
});
