// tests/unit/route-gold-rank.test.mjs — the route-only harness (scripts/route-gold-rank.mjs) scores the
// planner that search runs. Pinned: rank is 1-based over the PLANNED order, matching is
// case-insensitive (need sets say "RuView", the store is "ruview") and honours shipped aliases only,
// a declined route is counted, and the planner it measures is the one searchAll actually uses.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { goldRank, measureRouteRanks, reportIdentity, summarizeRoutes, unnameRecallQuery } from '../../scripts/route-gold-rank.mjs';
import { discoverRepos, planSourceRoute } from '../../kb/forge-ask-all.mjs';

describe('goldRank', () => {
  it('is the 1-based position of the first planned store matching any expected repo', () => {
    expect(goldRank(['a', 'b', 'c'], ['c'])).toBe(3);
    expect(goldRank(['a', 'b', 'c'], ['b', 'c'])).toBe(2);
    expect(goldRank(['a'], ['z'])).toBeNull();
    expect(goldRank([], ['a'])).toBeNull();
  });
  it('matches case-insensitively and through a shipped alias, never by similarity', () => {
    expect(goldRank(['ruflo', 'ruview'], ['RuView'])).toBe(2);
    expect(goldRank(['metaharness'], ['agent-harness-generator'], { 'agent-harness-generator': ['metaharness'] })).toBe(1);
    expect(goldRank(['ruview-pro'], ['RuView'])).toBeNull();
  });
});

describe('unnameRecallQuery', () => {
  it('removes the repository prefix and every spelling of the store key, but no other word', () => {
    expect(unnameRecallQuery('In the agentdb repository, Which memory operations does the AgentDB CLI describe?', 'agentdb'))
      .toBe('Which memory operations does the this project CLI describe?');
    expect(unnameRecallQuery('In the ruv-fann repository, how does ruv fann / RUV_FANN train?', 'ruv-fann'))
      .toBe('how does this project / this project train?');
    expect(unnameRecallQuery('In the ruvector repository, compare ruvector-core and ruvectors.', 'ruvector'))
      .toBe('compare this project-core and ruvectors.');
  });
});

describe('reportIdentity', () => {
  it('names the KB by its build stamp and never writes a local absolute path', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'route-id-'));
    fs.writeFileSync(path.join(kb, 'manifest.json'), JSON.stringify({ brainVersion: '9.9.9', generated: 'g1' }));
    const inside = reportIdentity({ impl: path.resolve('kb/forge-ask-all.mjs'), kbDir: kb });
    expect(inside).toEqual({ impl: 'kb/forge-ask-all.mjs', kbDir: '<kb>', kbBuild: { brainVersion: '9.9.9', generated: 'g1' } });
    const outside = reportIdentity({ impl: path.join(kb, 'forge-ask-all.mjs'), kbDir: kb });
    expect(outside.impl).toBe('<impl>');
    expect(JSON.stringify([inside, outside])).not.toContain(os.tmpdir());
  });
});

describe('summarizeRoutes', () => {
  it('counts gold within 1/3/5, declines, and mean stores opened, with Wilson intervals', () => {
    const rows = [
      { rank: 1, repos: ['a'], group: 'x' },
      { rank: 3, repos: ['b', 'c', 'a'], group: 'x' },
      { rank: 5, repos: ['b', 'c', 'd', 'e', 'a'], group: 'y' },
      { rank: null, repos: [], group: 'y' },
    ];
    const s = summarizeRoutes(rows);
    expect([s.all.goldAt1.k, s.all.goldAt3.k, s.all.goldAt5.k, s.all.declined.k]).toEqual([1, 2, 3, 1]);
    expect(s.all.goldAt3.n).toBe(4);
    expect(s.all.goldAt3.lo).toBeLessThan(0.5);
    expect(s.all.goldAt3.hi).toBeGreaterThan(0.5);
    expect(s.all.reposOpened).toBe(2.25);
    expect(s.byGroup.y.goldAt5.k).toBe(1);
  });
});

describe('measureRouteRanks over the real planner', () => {
  it('reports the stores planSourceRoute plans, in its order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-rank-'));
    for (const n of ['alpha.rvf', 'zeta.rvf', 'other.rvf']) fs.writeFileSync(path.join(dir, n), 'x');
    fs.writeFileSync(path.join(dir, 'zeta.meta.json'), JSON.stringify({ entries: {
      a: { title: 'Acoustic tomography calibration', preview: 'reconstructs scans' } } }));
    const { rows } = measureRouteRanks({ kbDir: dir, planSourceRoute, discoverRepos, questions: [
      { id: 'q1', group: 'g', query: 'acoustic tomography calibration reconstructs scans', expected: ['zeta'] },
      { id: 'q2', group: 'g', query: 'acoustic tomography calibration reconstructs scans', expected: ['alpha'] },
    ] });
    expect(rows[0].repos).toEqual(['zeta']);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBeNull();
  });
});
