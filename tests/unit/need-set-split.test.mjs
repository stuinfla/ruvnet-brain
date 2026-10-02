// tests/unit/need-set-split.test.mjs — the frozen train / held-out split used by every learning arm.
import { describe, expect, it } from 'vitest';
import { splitNeedSet } from '../../scripts/oracle/need-set-split.mjs';

const qs = [
  ...Array.from({ length: 7 }, (_, i) => ({ id: `ruflo:${i}`, repo: 'ruflo' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `RuView:${i}`, repo: 'RuView' })),
];

describe('splitNeedSet', () => {
  it('is stratified by repository and disjoint, covering every question once', () => {
    const s = splitNeedSet(qs);
    expect(s.train.filter((id) => id.startsWith('ruflo')).length).toBe(4); // round(3.5)
    expect(s.train.filter((id) => id.startsWith('RuView')).length).toBe(2);
    expect(new Set([...s.train, ...s.heldout]).size).toBe(qs.length);
    expect(s.train.some((id) => s.heldout.includes(id))).toBe(false);
  });
  it('rounds per repository, not over the whole set', () => {
    const s = splitNeedSet([{ id: 'a:1', repo: 'a' }, { id: 'b:1', repo: 'b' }, { id: 'c:1', repo: 'c' }]);
    expect(s.train.length).toBe(3); // round(0.5) = 1 in every repository; a global cut would give 2
  });

  it('is a pure function of ids and salt, independent of input order', () => {
    expect(splitNeedSet([...qs].reverse())).toEqual(splitNeedSet(qs));
    expect(splitNeedSet(qs, { salt: 'v2' }).train).not.toEqual(splitNeedSet(qs).train);
  });
});
