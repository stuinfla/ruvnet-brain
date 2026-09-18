import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn(async () => []) }));
vi.mock('../../kb/forge-rerank.mjs', () => ({
  rerankPairs: vi.fn(async (_query, candidates) => candidates.map((row) => ({ ...row, ceScore: 6 }))),
  cePrefilterScores: vi.fn(),
}));
import { searchKb } from '../../kb/forge-ask.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';
import { overviewBm25Candidates, overviewLanePlan, sourceCardQueryMode, searchAll } from '../../kb/forge-ask-all.mjs';

describe('overview lexical candidate lane', () => {
  let dirs = [];
  afterEach(() => { vi.clearAllMocks(); vi.mocked(searchKb).mockResolvedValue([]); for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); dirs = []; });
  it('admits relevant document passages without path-specific rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-bm25-'));
  dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'fixture.passages.jsonl'), [
      { id: '1', path: 'generated/instructions.md', title: 'generated', text: 'automation runtime instructions' },
      { id: '2', path: 'docs/overview.md', title: 'overview', text: 'A browser automation tool solves web scraping and browser workflow problems.' },
      { id: '2b', path: 'docs/overview.md', title: 'overview', text: 'browser automation' },
      { id: '3', path: 'src/agent.py', title: 'agent', text: 'browser automation implementation details' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const candidates = overviewBm25Candidates(dir, 'fixture', 'what is browser automation and what problem does it solve?', 2);
    expect(candidates).toHaveLength(2);
    expect(candidates.filter((candidate) => candidate.path === 'docs/overview.md')).toHaveLength(1);
    expect(candidates[0].path).toBe('docs/overview.md');
    expect(candidates[0]._lane).toBe('bm25');
    expect(candidates.every((candidate) => /\.(?:md|mdx|html?|txt)$/i.test(candidate.path))).toBe(true);
  });

  it.each([
    'What is a browser automation tool and what problem does it solve?',
    'What is a browser automation tool, what problem does it solve, and how is it intended to be used?',
    'In the fixture repository, what is a browser automation tool and what problem does it solve?',
  ])('delivers lexical documents absent from dense retrieval to the common reranker: %s', async (query) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-search-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'fixture.rvf'), 'synthetic store; native retrieval mocked');
    fs.writeFileSync(path.join(dir, 'fixture.passages.jsonl'), JSON.stringify({
      id: '1', path: 'docs/purpose.md', title: 'Purpose', text: 'A browser automation tool solves browser workflow problems.',
    }) + '\n');
    vi.mocked(searchKb).mockClear();
    vi.mocked(rerankPairs).mockClear();
    const result = await searchAll({ dir, repos: ['fixture'], query, k: 2, pool: 2 });
    expect(searchKb).toHaveBeenCalled();
    expect(result.perRepo.fixture).toBe(1);
    expect(rerankPairs.mock.calls.at(-1)[1]).toEqual([
      expect.objectContaining({ path: 'docs/purpose.md', _lane: 'bm25' }),
    ]);
    expect(result.pooledAll).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe('docs/purpose.md');
  });
  function fixture(stores, rows = 70) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-bounds-'));
    dirs.push(dir);
    const repos = Array.from({ length: stores }, (_, i) => `fixture${i}`);
    for (const name of repos) {
      fs.writeFileSync(path.join(dir, `${name}.rvf`), 'synthetic; native retrieval mocked');
      fs.writeFileSync(path.join(dir, `${name}.passages.jsonl`), Array.from({ length: rows }, (_, i) =>
        JSON.stringify({ id: String(i), path: `docs/purpose-${i}.md`, kind: 'guide', text: 'browser automation solves workflow problems' })
      ).join('\n') + '\n');
    }
    return { dir, repos };
  }
  const query = 'What is browser automation and what problem does it solve?';
  it.each([2, 3, 200])('bounds actual reranker admission with %i stores and pool 1000', async (count) => {
    const input = fixture(count);
    const result = await searchAll({ ...input, query, pool: 1000, k: 2 });
    const candidates = rerankPairs.mock.calls.at(-1)[1];
    expect(candidates).toHaveLength(count === 2 ? 128 : 0);
    expect(result.pooledAll).toBe(candidates.length);
    expect(Object.keys(result.perRepo)).toHaveLength(count);
    expect(Object.values(result.perRepo).every(value => typeof value === 'number')).toBe(true);
    if (count === 2) expect(candidates.every(row => row.kind === 'guide' && row.id && row._source === 'overview-bm25')).toBe(true);
  });
  it('keeps dense retrieval when a lexical sidecar is corrupt', async () => {
    const input = fixture(1);
    fs.writeFileSync(path.join(input.dir, 'fixture0.passages.jsonl'), '{broken\n');
    vi.mocked(searchKb).mockResolvedValue([{ path: 'docs/dense.md', text: 'browser automation', bestDistance: 0.1 }]);
    const result = await searchAll({ ...input, query, pool: 2, k: 2 });
    expect(rerankPairs.mock.calls.at(-1)[1].map(row => row.path)).toEqual(['docs/dense.md']);
    expect(result.overviewDiagnostics).toEqual([expect.objectContaining({ store: 'fixture0', error: expect.any(String) })]);
  });
  it('does not duplicate a dense document with its lexical candidate', async () => {
    const input = fixture(1, 1);
    vi.mocked(searchKb).mockResolvedValue([{ path: 'docs/purpose-0.md', id: 'dense', text: 'browser automation', bestDistance: 0.1 }]);
    await searchAll({ ...input, query, pool: 2, k: 2 });
    expect(rerankPairs.mock.calls.at(-1)[1]).toEqual([expect.objectContaining({ id: 'dense' })]);
  });
  it('chooses the same passage under equal-score row reordering', () => {
    const input = fixture(2, 0);
    const rows = ['z', 'a'].map(id => ({ id, path: 'docs/purpose.md', kind: 'guide', text: 'browser automation workflow' }));
    for (const [index, name] of input.repos.entries()) {
      fs.writeFileSync(path.join(input.dir, `${name}.passages.jsonl`), (index ? [...rows].reverse() : rows).map(JSON.stringify).join('\n') + '\n');
    }
    expect(overviewBm25Candidates(input.dir, input.repos[0], query)).toEqual(overviewBm25Candidates(input.dir, input.repos[1], query));
    expect(overviewBm25Candidates(input.dir, input.repos[0], query)[0].id).toBe('a');
  });
  it('normalizes leading repository scopes while excluding quoted, mechanics and negative questions', () => {
    for (const prefix of ['', 'In the fixture repository, ', 'In fixture repo, ']) {
      expect(sourceCardQueryMode(prefix + query)).toBe('overview');
    }
    for (const text of ['Quoted: "' + query + '"', 'What is X and how does it work?', 'What is X and what problem does it not solve?']) {
      expect(overviewLanePlan({ storeCount: 1, pool: 1000, query: text }).enabled).toBe(false);
    }
  });

});
