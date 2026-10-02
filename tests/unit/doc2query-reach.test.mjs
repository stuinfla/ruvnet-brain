// tests/unit/doc2query-reach.test.mjs — ADR-099 arm A measurement helpers.
import { describe, expect, it } from 'vitest';
import { filesFromEntries, reachSummary } from '../../scripts/oracle/doc2query-reach.mjs';

describe('filesFromEntries', () => {
  it('collapses ranked question hits to distinct files in rank order, capped', () => {
    const paths = { 1: 'a.md', 2: 'a.md', 3: 'b.md', 4: 'c.md', 5: 'd.md' };
    const hits = [1, 2, 3, 4, 5].map((id) => ({ id }));
    expect(filesFromEntries(hits, (id) => paths[id], 3)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(filesFromEntries([{ id: 9 }, { id: 3 }], (id) => paths[id], 3)).toEqual(['b.md']);
  });
});

describe('reachSummary', () => {
  it('counts baseline, entry and union reach and what the entry lane alone gained', () => {
    const s = reachSummary([
      { baseline: true, entry: false }, { baseline: false, entry: true }, { baseline: true, entry: true }, { baseline: false, entry: false },
    ]);
    expect([s.baselineReach.k, s.entryReach.k, s.unionReach.k, s.gained, s.unionReach.n]).toEqual([2, 2, 3, 1, 4]);
  });
});
