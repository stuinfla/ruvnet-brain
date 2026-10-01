// tests/unit/route-latency-warm.test.mjs — the paired latency summary (scripts/route-latency-warm.mjs).
// Pinned: deltas are B minus A on the SAME questions, failed rows are excluded from every arm,
// intervals contain the point estimate and are reproducible (fixed seed).
import { describe, expect, it } from 'vitest';
import { percentile, summarizeRows } from '../../scripts/route-latency-warm.mjs';

const row = (id, a, b, extra = {}) => ({ id, loadAt: 40, A: { ms: a, repos: 2 }, B: { ms: b, repos: 3 }, ...extra });

describe('summarizeRows', () => {
  it('reports B - A paired deltas with reproducible bootstrap intervals around the estimate', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`q${i}`, 1000 + 10 * i, 1500 + 10 * i));
    const s = summarizeRows(rows, ['A', 'B']);
    const d = s.deltas['B - A'];
    expect(d.medianPairedDiff).toBe(500);
    expect(d.medianPairedCI).toEqual([500, 500]);
    expect(d.p50).toBe(500);
    expect(d.p50CI[0]).toBeLessThanOrEqual(500);
    expect(d.p50CI[1]).toBeGreaterThanOrEqual(500);
    expect(d.bFaster).toBe('0/40');
    expect(s.arms.B.meanRepos).toBe(3);
    expect(summarizeRows(rows, ['A', 'B'])).toEqual(s);
  });

  it('prints the same intervals for the same rows (fixed seed), even when the differences vary', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`q${i}`, 1000 + ((i * 37) % 11) * 50, 1200 + ((i * 53) % 13) * 70));
    const one = summarizeRows(rows, ['A', 'B']).deltas['B - A'];
    const two = summarizeRows(rows, ['A', 'B']).deltas['B - A'];
    expect(one.p90CI[0]).toBeLessThan(one.p90CI[1]);
    expect(two).toEqual(one);
  });

  it('drops a question from every arm when any arm errored on it', () => {
    const rows = [row('q1', 100, 200), row('q2', 100, 9999, { B: { ms: 9999, repos: 3, err: 'timeout' } })];
    const s = summarizeRows(rows, ['A', 'B']);
    expect(s.nOk).toBe(1);
    expect(s.arms.B.p90).toBe(200);
    expect(s.arms.B.errors).toBe(1);
  });

  it('percentile is the nearest-rank value', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(10);
  });
});
