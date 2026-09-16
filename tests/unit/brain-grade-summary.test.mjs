// tests/unit/brain-grade-summary.test.mjs — Dream Cycle 2026-09-16, DEEP=brain-currency (ISSUE #258
// write-side fast-follow).
//
// ISSUE #258 (2026-09-06): scripts/brain-score.mjs's readPanel() dated a panel from the checkout's
// file mtime, which `git clone`/checkout resets to "now" — so a panel graded weeks ago always read
// as freshly current. Commit 8caa157 fixed the READ side: readPanel() now prefers each grade file's
// own `summary.generatedAt` over mtime. But no producer ever WROTE that field — every real
// data/grade-*.json, and this exact producer (brain-grade-groundtruth.mjs), built its summary object
// without `generatedAt` (confirmed: tests/unit/brain-score-producer.test.mjs's own fixture comments
// "no generatedAt — every real data/grade-*.json today"). readPanel()'s recorded-time branch was
// therefore permanently unreachable in practice: every panel, past and future, fell back to mtime —
// the exact original defect, unchanged in effect, now sitting behind a comment that reads as fixed.
//
// Imports from brain-grade-summary.mjs, NOT brain-grade-groundtruth.mjs: the latter is 100%
// top-level script that calls OpenRouter over the network and requires a real questions file + repo
// clone as a side effect of being imported at all (see that module's own header, and the identical
// precedent in brain-stamp-resolve.mjs / tests/unit/brain-stamp-manifest.test.mjs).
import { describe, it, expect } from 'vitest';
import { buildGradeSummary } from '../../scripts/brain-grade-summary.mjs';

const valid = [
  { avgStrict: 90, avgRealUse: 85 },
  { avgStrict: 70, avgRealUse: 60 },
];

describe('brain-grade-summary.mjs — buildGradeSummary()', () => {
  it('TEETH: stamps generatedAt, the exact field readPanel() needs to escape the checkout-mtime fallback', () => {
    const before = Date.now();
    const summary = buildGradeSummary({ name: 'ruflo', variant: 'big', questions: 5, models: ['a', 'b'], valid, gtFail: 0 });
    expect(typeof summary.generatedAt).toBe('string');
    expect(Number.isFinite(Date.parse(summary.generatedAt)), 'generatedAt must be a parseable ISO timestamp').toBe(true);
    expect(Date.parse(summary.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(summary.generatedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('generatedAt is injectable for deterministic tests, and is the true measurement time, not a later read time', () => {
    const fixedNow = () => new Date('2026-01-15T00:00:00.000Z');
    const summary = buildGradeSummary({ name: 'ruflo', variant: 'big', questions: 5, models: ['a'], valid, gtFail: 0, now: fixedNow });
    expect(summary.generatedAt).toBe('2026-01-15T00:00:00.000Z');
  });

  it('preserves every pre-existing aggregate field and value, byte-identical to the inline computation it replaces', () => {
    const summary = buildGradeSummary({ name: 'ruflo', variant: 'big', questions: 5, models: ['gpt', 'llama'], valid, gtFail: 1 });
    expect(summary).toMatchObject({
      name: 'ruflo', variant: 'big', questions: 5, models: ['gpt', 'llama'],
      avgStrict: 80, avgRealUse: 72.5, minStrict: 70, minRealUse: 60,
      poisonStrict: 0, poisonRealUse: 0, groundTruthCitationFailures: 1,
    });
  });

  it('poison rule: an avgStrict or avgRealUse under 50 counts toward poisonStrict/poisonRealUse respectively', () => {
    const poisoned = [
      { avgStrict: 40, avgRealUse: 55 },
      { avgStrict: 90, avgRealUse: 30 },
    ];
    const summary = buildGradeSummary({ name: 'x', variant: 'big', questions: 2, models: ['m'], valid: poisoned, gtFail: 0 });
    expect(summary.poisonStrict).toBe(1);
    expect(summary.poisonRealUse).toBe(1);
  });
});
