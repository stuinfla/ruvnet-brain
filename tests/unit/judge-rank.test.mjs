// tests/unit/judge-rank.test.mjs — the learned judge (kb/judge-rank.mjs) and its offline trainer
// (scripts/oracle/judge-train.mjs), ADR-099 arm C.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JUDGE_FEATURES, applyJudge, judgeFeatures, judgeLogit, loadJudge } from '../../kb/judge-rank.mjs';
import { chooseThreshold, decide, fitLogistic, isTarget, metrics, poolsByNeed } from '../../scripts/oracle/judge-train.mjs';

afterEach(() => { delete process.env.RUVNET_BRAIN_JUDGE; });

const identity = (bias = 0, weights = new Array(JUDGE_FEATURES.length).fill(0)) =>
  ({ features: JUDGE_FEATURES, weights, bias, mean: new Array(JUDGE_FEATURES.length).fill(0), std: new Array(JUDGE_FEATURES.length).fill(1) });

describe('judgeFeatures', () => {
  it('computes the pool-relative cross-encoder signals and the query/title-path overlap', () => {
    const [a, b] = judgeFeatures('vector search offline', [
      { ce: 2, dist: 0.4, lane: 'dense', title: 'Offline vector search', path: 'docs/search.md', len: 100 },
      { ce: -1, lane: 'bm25', title: 'Other', path: 'x/y.md', len: 0 },
    ]);
    expect(a.slice(0, 2)).toEqual([2, 0]);
    expect(b.slice(0, 2)).toEqual([-1, -3]);
    expect(b[2]).toBeCloseTo(Math.log(2));
    expect([a[3], b[3]]).toEqual([0.4, 1]);
    expect([a[4], b[4]]).toEqual([0, 1]);
    expect(a[6]).toBe(1);
    expect(b[6]).toBe(0);
  });
});

describe('applyJudge', () => {
  it('re-sorts by the judge logit, keeps the cross-encoder logit as ceRaw, and is a no-op without a model', () => {
    const ranked = [{ path: 'a', ceScore: 3, _lane: 'dense' }, { path: 'b', ceScore: 1, _lane: 'bm25' }];
    expect(applyJudge(null, 'q', ranked)).toBe(ranked);
    const w = new Array(JUDGE_FEATURES.length).fill(0);
    w[JUDGE_FEATURES.indexOf('laneBm25')] = 5; // a judge that prefers the keyword lane
    const out = applyJudge(identity(-1, w), 'q', ranked);
    expect(out.map((r) => r.path)).toEqual(['b', 'a']);
    expect(out[0]).toMatchObject({ ceRaw: 1, ceScore: 4, judged: true });
  });
});

describe('loadJudge', () => {
  it('loads only under RUVNET_BRAIN_JUDGE=1 and only weights trained on the current feature list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
    fs.writeFileSync(path.join(dir, 'judge-weights.json'), JSON.stringify(identity()));
    expect(loadJudge(dir)).toBeNull();
    process.env.RUVNET_BRAIN_JUDGE = '1';
    expect(loadJudge(dir)).toMatchObject({ bias: 0 });
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
    fs.writeFileSync(path.join(stale, 'judge-weights.json'), JSON.stringify({ ...identity(), features: ['ce'] }));
    expect(loadJudge(stale)).toBeNull();
  });
});

describe('judge-train', () => {
  const q = { id: 'n1', need: 'how do agents share memory', repo: 'RuView', path: 'docs/a.md', alternatives: [{ repo: 'ruflo', path: './b.md' }] };
  it('matches the gold file or a registered alternative, repository case-insensitively', () => {
    expect(isTarget(q, { repo: 'ruview', path: 'docs/a.md' })).toBe(true);
    expect(isTarget(q, { repo: 'ruflo', path: 'b.md' })).toBe(true);
    expect(isTarget(q, { repo: 'ruview', path: 'docs/c.md' })).toBe(false);
  });
  it('reads the last recorded pool per need and skips broken trace lines', () => {
    const text = [JSON.stringify({ query: q.need, cands: [{ path: 'old' }] }), '{broken', JSON.stringify({ query: q.need, cands: [{ path: 'new' }] })].join('\n');
    expect(poolsByNeed([q], text).get('n1')).toEqual([{ path: 'new' }]);
  });
  it('fits a separable signal and picks the smallest threshold meeting the precision target', () => {
    const X = [[1], [2], [3], [-1], [-2], [-3]];
    const m = fitLogistic(X, [true, true, true, false, false, false], { iters: 500 });
    expect(judgeLogit(m, [2])).toBeGreaterThan(0);
    expect(judgeLogit(m, [-2])).toBeLessThan(0);
    const rows = [{ top: 3, at1: true }, { top: 2, at1: false }, { top: 1, at1: true }, { top: 0, at1: false }];
    expect(chooseThreshold(rows, 0.6)).toBe(1); // answered {3,2,1}: 2/3 >= 0.6
    expect(chooseThreshold(rows, 1)).toBe(3);
    expect(chooseThreshold([{ top: 1, at1: false }], 0.8)).toBe(Infinity);
  });
  it('scores confident hits within 5 against all questions, untraced ones counting as abstained', () => {
    const pools = new Map([['n1', [{ repo: 'x', path: 'z', ce: 5 }, { repo: 'ruview', path: 'docs/a.md', ce: 1 }]]]);
    const rows = decide([q], pools, (_q, cands) => cands.map((c) => c.ce));
    expect(rows[0]).toMatchObject({ at1: false, within5: true, top: 5 });
    const m = metrics(rows, 2);
    expect([m.confidentHit.k, m.confidentHitTop1.k, m.confidentWrong.k, m.abstained.k, m.abstained.n]).toEqual([1, 0, 0, 1, 2]);
  });
});
