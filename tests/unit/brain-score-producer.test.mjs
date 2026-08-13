import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIMENSIONS, brainScore, composite, staleness } from '../../scripts/brain-score.mjs';

/**
 * A SCORE ABOUT THIS PRODUCT IS GENERATED, NEVER TYPED.
 *
 * Measured 2026-08-13: asked to grade the architecture, I counted files and reported 52/100 as an
 * architecture grade, with six graders unused in this repo. The number did not measure quality at
 * all — it measured CATALOGUE COVERAGE and wore a quality label. The owner was told his working
 * product was failing while his users reported it working, and both readings came from me.
 *
 * The guard therefore is not "remember to run the graders" — I was confident, and confidence is
 * exactly the state in which advice goes unread. It is that the two kinds of number CANNOT be
 * combined, and that a reading nobody refreshed cannot back a claim.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const dim = (over = {}) => ({ key: 'k', kind: 'quality', value: 90, status: 'current', ...over });

describe('a coverage number can never become a quality verdict', () => {
  it('TEETH: composite() REFUSES to average across kinds — this is the 52', () => {
    // The literal shape of the failure: 32.5% catalogue + 55% routable averaged into "52/100
    // architecture". Refused structurally, because prose in a header did not stop me.
    const dims = [
      dim({ key: 'grounded', kind: 'quality', value: 100 }),
      dim({ key: 'catalogue', kind: 'coverage', value: 32.5 }),
    ];
    const q = composite(dims, 'quality');
    const c = composite(dims, 'coverage');
    expect(q.value, 'quality must average ONLY quality dimensions').toBe(100);
    expect(c.value, 'coverage must average ONLY coverage dimensions').toBe(32.5);
    // …and there is no way to ask for one number across both.
    expect(composite(dims, 'everything').value).toBeNull();
    expect(composite(dims).refused, 'an unkinded score must be refused, not defaulted')
      .toMatch(/name WHICH question/i);
  });

  it('every dimension states the question it answers', () => {
    // A number whose question is unstated is the thing that produced the 52.
    for (const d of DIMENSIONS) {
      expect(d.question, `${d.key} must name its question`).toBeTruthy();
      expect(['quality', 'coverage'], `${d.key} must declare a kind`).toContain(d.kind);
      expect(d.maxAgeDays, `${d.key} must declare a freshness budget`).toBeGreaterThan(0);
    }
  });
});

describe('a stale reading cannot back a claim', () => {
  it('TEETH: the exact miss — a 34-day-old 100/100 quoted as current', () => {
    // evals/baseline.json was recorded 2026-07-10 and quoted on 2026-08-13 as the live answer. The
    // existing claims gate passed it because it checks k<=n and lo<=p<=hi, and never asks WHEN.
    const now = Date.parse('2026-08-13T00:00:00Z');
    const s = staleness('2026-07-10T00:53:32.431Z', 14, now);
    expect(s.stale, 'a 34-day-old reading past a 14-day budget is NOT current').toBe(true);
    expect(s.ageDays).toBeGreaterThan(30);
    expect(s.why).toMatch(/budget/);
  });

  it('a missing timestamp is stale, never assumed fresh', () => {
    // Silence here would read as "current", which is the empty-corpus lie on another surface.
    expect(staleness(null, 14).stale).toBe(true);
    expect(staleness('not a date', 14).stale).toBe(true);
  });

  it('a fresh reading inside its budget is current', () => {
    // Without this the fix could be "always stale", which is a different defect — a flag that is
    // always on gets ignored, and then it protects nothing.
    const now = Date.parse('2026-08-13T00:00:00Z');
    expect(staleness('2026-08-12T00:00:00Z', 14, now).stale).toBe(false);
  });

  it('TEETH: composite() refuses when ANY of its dimensions is stale, and names which', () => {
    const dims = [dim({ key: 'a' }), dim({ key: 'b', status: 'stale' })];
    const r = composite(dims, 'quality');
    expect(r.value, 'one stale input must void the composite, not be quietly dropped').toBeNull();
    expect(r.missing).toContain('b (stale)');
  });

  it('an unmeasured dimension voids the composite too', () => {
    // Averaging the graders that happened to run is how a partial answer becomes a confident one.
    const r = composite([dim({ key: 'a' }), dim({ key: 'b', status: 'unmeasured', value: null })], 'quality');
    expect(r.value).toBeNull();
    expect(r.missing).toContain('b (unmeasured)');
  });
});

describe('the producer reads real artifacts, and says so', () => {
  it('reports every dimension with a status, from the real repo', async () => {
    const dims = await brainScore();
    expect(dims.length).toBe(DIMENSIONS.length);
    for (const d of dims) expect(['current', 'stale', 'unmeasured']).toContain(d.status);
  });

  it('a value derived at read time is current by construction, never stale', async () => {
    // `routable` walks the live store root on every call. Reporting a read-now value as stale would
    // train the reader to ignore the stale flag, which costs more than the flag is worth.
    const routable = (await brainScore()).find((d) => d.key === 'routable');
    if (routable.value !== null) expect(routable.status, 'a read-now value cannot be stale').toBe('current');
  });

  it('TEETH: an absent artifact yields UNMEASURED, never a plausible number', async () => {
    // The failure the whole file exists to prevent: a number with nothing behind it. `orgTotalApprox:
    // 248` was that, and it was wrong by 48 in two producers at once.
    const fake = DIMENSIONS.find((d) => d.key === 'grounded').read(null);
    expect(fake.value, 'no artifact must mean no number').toBeNull();
  });
});

describe('a score presented as CURRENT carries the date it was measured', () => {
  /**
   * The rule is deliberately narrow, because the broad version flags history. A past grade
   * ("last independent grade: 70/100", "Stuart scored the pages 55/100 on 2026-07-17") is a
   * RECORD and stays true forever. What cannot stand is a reading presented as the live state
   * with nothing saying when it was taken — which is how a 2026-07-10 run was still being read
   * as today's answer on 2026-08-13, on the public README, by me.
   */
  const CURRENT = /\b(current|currently|today|now|live|latest|as of)\b/i;
  /**
   * Past-tense narrative is a RECORD, and records stay true. This guard's first run flagged
   * "Detection without a remedy is **now** structurally impossible. The console **used to** …
   * score it 49/100" — a sentence about a fixed defect, caught because it contains "now". A guard
   * that flags correct prose gets deleted, and then it protects nothing; the same review that
   * caught a sibling hook fabricating a diagnosis made exactly this point about credibility.
   */
  const PAST = /\b(used to|previously|before|was |were |shipped \d{4}|had )\b/i;

  it('TEETH: "Current baseline … 100/100" with no date is the exact public defect', () => {
    const bad = 'Current baseline (n=120): **grounded 100/100 · routed 63/80**';
    expect(CURRENT.test(bad) && !/\d{4}-\d{2}-\d{2}/.test(bad), 'the shipped line must be caught').toBe(true);
    const good = 'Baseline measured 2026-07-10 (n=120): **grounded 100/100**';
    expect(CURRENT.test(good) && !/\d{4}-\d{2}-\d{2}/.test(good), 'a dated line must pass').toBe(false);
  });

  it('no shipped surface claims a current score without saying when', () => {
    const offenders = [];
    for (const rel of ['README.md']) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(\d{1,3})\s*\/\s*(?:100|\d{1,3})\b/g)) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
        if (CURRENT.test(line) && !PAST.test(line) && !/\d{4}-\d{2}-\d{2}/.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(
      offenders,
      'this line presents a measurement as the live state without saying when it was taken. Add '
      + 'the date from the artifact (evals/baseline.json carries `recorded`), or drop the word '
      + '"current". A month-old reading quoted as today\'s is how 2026-08-13 went wrong.',
    ).toEqual([]);
  });
});
