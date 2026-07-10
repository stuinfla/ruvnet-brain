// tests/unit/eval-brain-gate.test.mjs — the eval gate is what makes every other score believable,
// so its own math and rules get tests that would fail if the logic were quietly weakened.
//
// FROZEN-SET GUARANTEE (rUv's own pattern, ruflo harness-frozen-eval.ts): the held-out set's
// order-independent content hash is PINNED below. Editing any question — its text, stratum, or
// expectations — turns this file red. That is what "frozen" means mechanically. If the set is
// expanded deliberately (an ADR-0011-grade decision), re-pin the hash IN THE SAME COMMIT and
// re-record the baseline with --record.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson, gradeQuestion, aggregate, gateAgainst, heldOutHash, ABSTAIN_CE } from '../../scripts/eval-brain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/held-out.json'), 'utf8'));

// ── the pinned frozen hash (v2, 120 questions, 2026-07-09) ──────────────────────────────────────
const FROZEN_HELD_OUT_HASH = '5c5f457043295e4844844f0ded7a6a00e35ed467d9a3a157ff701d2c51a3a38d';

describe('frozen held-out set', () => {
  it('is exactly the pinned corpus — any edit turns this red', async () => {
    expect(await heldOutHash(SET.questions)).toBe(FROZEN_HELD_OUT_HASH);
  });
  it('hash is order-independent but tamper-evident', async () => {
    expect(await heldOutHash([...SET.questions].reverse())).toBe(FROZEN_HELD_OUT_HASH);
    const tampered = SET.questions.map((q, i) => (i === 0 ? { ...q, query: q.query + '?' } : q));
    expect(await heldOutHash(tampered)).not.toBe(FROZEN_HELD_OUT_HASH);
  });
  it('has 120 questions across the five strata, adversarial non-empty (ADR-0011 requires it)', () => {
    const by = {};
    for (const q of SET.questions) by[q.stratum] = (by[q.stratum] || 0) + 1;
    expect(SET.questions.length).toBe(120);
    expect(by.adversarial).toBeGreaterThanOrEqual(20);
    expect(by.provenance).toBeGreaterThanOrEqual(20);
    for (const q of SET.questions) {
      if (q.stratum !== 'adversarial') expect(q.expectRepo?.length, `${q.id} needs expectRepo`).toBeGreaterThan(0);
    }
  });
});

describe('wilson — the interval the gate stands on', () => {
  it('reproduces the n=12 numbers that motivated ADR-0011 (routed 10/12 → [55.2%, 95.3%])', () => {
    const w = wilson(10, 12);
    expect(w.lo).toBeCloseTo(0.552, 2);
    expect(w.hi).toBeCloseTo(0.953, 2);
  });
  it('12/12 lower bound is 75.7% — perfection at n=12 still is not certainty', () => {
    expect(wilson(12, 12).lo).toBeCloseTo(0.757, 2);
  });
  it('tightens with n: 100/120 has a far higher lower bound than 10/12 at the same rate', () => {
    expect(wilson(100, 120).lo).toBeGreaterThan(wilson(10, 12).lo + 0.15);
  });
  it('degenerate n=0 is the know-nothing interval, never a crash', () => {
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 1 });
  });
});

describe('gradeQuestion — one rule per stratum', () => {
  const cite = (repo, ce) => [{ repo, fullPath: `${repo}/x`, ce }];
  it('named/described/scenario pass only when grounded AND the owning repo answered', () => {
    const q = { stratum: 'named', expectRepo: ['ruvector', 'concepts'] };
    expect(gradeQuestion(q, { grounded: true, citations: cite('ruvector', 3) }).pass).toBe(true);
    expect(gradeQuestion(q, { grounded: true, citations: cite('qudag', 3) }).pass).toBe(false);
    expect(gradeQuestion(q, { grounded: false, citations: cite('ruvector', 3) }).pass).toBe(false);
  });
  it('adversarial passes only when the brain ABSTAINS (top ce below the cut, or no hits at all)', () => {
    const q = { stratum: 'adversarial' };
    expect(gradeQuestion(q, { grounded: true, citations: cite('ruflo', -4.2) }).pass).toBe(true);
    expect(gradeQuestion(q, { grounded: true, citations: cite('ruflo', 2.0) }).pass).toBe(false);
    expect(gradeQuestion(q, { grounded: false, citations: [] }).pass).toBe(true);
    expect(ABSTAIN_CE).toBe(0); // the cut is part of the frozen rule; changing it is a gate change
  });
  it('provenance: a winning GIST chunk must carry its banner; a better repo hit also passes', () => {
    const q = { stratum: 'provenance', expectRepo: ['ruv-gists', 'ruflo'] };
    expect(gradeQuestion(q, { grounded: true, citations: cite('ruv-gists', 4), bannerPresent: true }).pass).toBe(true);
    expect(gradeQuestion(q, { grounded: true, citations: cite('ruv-gists', 4), bannerPresent: false }).pass).toBe(false);
    expect(gradeQuestion(q, { grounded: true, citations: cite('ruflo', 4), bannerPresent: false }).pass).toBe(true);
  });
});

describe('aggregate + gateAgainst — fail-closed promotion on Wilson lower bounds', () => {
  const rows = (spec) => spec.flatMap(([stratum, pass, n]) =>
    Array.from({ length: n }, () => ({ stratum, pass, grounded: pass || stratum === 'adversarial' })));

  it('gates each metric on its LOWER BOUND, not the point estimate', () => {
    const base = aggregate(rows([['named', true, 50], ['adversarial', true, 20], ['provenance', true, 20]]));
    const worse = aggregate(rows([['named', true, 40], ['named', false, 10], ['adversarial', true, 20], ['provenance', true, 20]]));
    const g = gateAgainst(worse, base);
    expect(g.pass).toBe(false);
    expect(g.regressions.join(' ')).toMatch(/routed/);
  });
  it('refuses to promote against NO baseline', () => {
    const cur = aggregate(rows([['named', true, 10]]));
    expect(gateAgainst(cur, null).pass).toBe(false);
  });
  it('refuses an old-schema baseline instead of passing vacuously', () => {
    const cur = aggregate(rows([['named', true, 10], ['adversarial', true, 5], ['provenance', true, 5]]));
    expect(gateAgainst(cur, { total: 12, grounded: 12, routed: 10 }).pass).toBe(false);
  });
  it('an emptied stratum cannot pass by absence', () => {
    const base = aggregate(rows([['named', true, 50], ['adversarial', true, 20], ['provenance', true, 20]]));
    const noAdv = aggregate(rows([['named', true, 50], ['provenance', true, 20]]));
    const g = gateAgainst(noAdv, base);
    expect(g.pass).toBe(false);
    expect(g.regressions.join(' ')).toMatch(/abstain/);
  });
  it('equal-or-better lower bounds pass', () => {
    const base = aggregate(rows([['named', true, 45], ['named', false, 5], ['adversarial', true, 18], ['adversarial', false, 2], ['provenance', true, 20]]));
    const same = aggregate(rows([['named', true, 45], ['named', false, 5], ['adversarial', true, 18], ['adversarial', false, 2], ['provenance', true, 20]]));
    expect(gateAgainst(same, base).pass).toBe(true);
  });
});
