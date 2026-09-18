import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/forge-rerank.mjs', () => ({ rerankPairs: vi.fn() }));

import { searchAll, selectResults } from '../../kb/forge-ask-all.mjs';
import { searchKb } from '../../kb/forge-ask.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';

const roots = [];
afterEach(() => {
  delete process.env.KB_RETRIEVAL_STAGE_TRACE;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('opt-in retrieval stage trace', () => {
  it('records pool and post-selection stages without passage text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-stage-trace-'));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'sample.rvf'), 'fixture');
    const trace = path.join(dir, 'trace.jsonl');
    process.env.KB_RETRIEVAL_STAGE_TRACE = trace;
    vi.mocked(searchKb).mockResolvedValue([{
      repo: 'sample', path: 'answer.md', title: 'Answer', text: 'PRIVATE PASSAGE BODY',
      fullText: 'PRIVATE PASSAGE BODY', bestDistance: 0.2, _rawRank: 3,
    }]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 1 })));

    await searchAll({ dir, repos: ['sample'], query: 'sample question', k: 1, pool: 1, allowFullCorpus: false });

    const records = fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.stage)).toEqual([
      'candidate-pool-before-cap', 'candidate-pool-after-cap', 'post-selection',
    ]);
    expect(records[0].candidates[0]).toMatchObject({ repo: 'sample', path: 'answer.md', rawRank: 3 });
    expect(records[2].kept).toEqual([expect.objectContaining({ repo: 'sample', path: 'answer.md', ceOriginal: 1, ceFinal: 3 })]);
    expect(JSON.stringify(records)).not.toContain('PRIVATE PASSAGE BODY');
  });

  it('does not write a trace when the opt-in variable is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-stage-no-trace-'));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'sample.rvf'), 'fixture');
    vi.mocked(searchKb).mockResolvedValue([]);
    vi.mocked(rerankPairs).mockResolvedValue([]);
    await searchAll({ dir, repos: ['sample'], query: 'sample question', k: 1, pool: 1, allowFullCorpus: false });
    expect(fs.readdirSync(dir)).toEqual(['sample.rvf']);
  });

  it('keeps retrieval available when the optional trace destination fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-stage-trace-failure-'));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'sample.rvf'), 'fixture');
    process.env.KB_RETRIEVAL_STAGE_TRACE = path.join(dir, 'trace.jsonl');
    vi.mocked(searchKb).mockResolvedValue([]);
    vi.mocked(rerankPairs).mockResolvedValue([]);
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('read-only trace'); });
    await expect(searchAll({ dir, repos: ['sample'], query: 'sample question', k: 1, pool: 1,
      allowFullCorpus: false })).resolves.toMatchObject({ results: [] });
  });
});


describe('selection trace follows the production collapse and pruning owners', () => {
  const row = (repo, name, ceScore, body, index) => ({ repo, path: name, ceScore,
    text: body, fullText: body, _poolIdx: index });
  const capture = (request) => {
    let trace;
    const result = selectResults({ ...request, traceWriter: (record) => { trace = record; } });
    expect(result).toEqual(selectResults(request));
    return { result, trace };
  };

  it('retains original scores through real duplicate collapse and reports discarded equivalents', () => {
    const { trace, result } = capture({ query: 'sample mechanisms', k: 3, ranked: [
      row('sample', 'guide.md', 4, 'identical complete documentation', 0),
      row('sample', 'copy.md', 3, 'identical complete documentation', 1),
      row('sample', 'other.md', 1, 'different complete documentation', 2),
    ] });
    expect(result.results).toHaveLength(2);
    expect(trace.kept[0]).toMatchObject({ path: 'guide.md', ceOriginal: 4, ceFinal: 6,
      alternatives: ['copy.md'] });
    expect(trace.allRows.find((r) => r.path === 'copy.md')).toMatchObject({
      ceOriginal: 3, ceFinal: 5, disposition: 'collapsed-equivalent', pruneReason: null });
    expect(trace.beforeCollapse).toHaveLength(3);
    expect(trace.beforeCollapse[0]).toMatchObject({ nameBoosted: true, inventoryBoosted: false,
      quotedClaimsBoosted: false, exactAdrBoosted: false, sourceDetailBoosted: false, identifierBoosted: null });
    expect(trace.afterCollapse).toHaveLength(2);
  });

  it('reports an ADR collision representative as kept even outside the initial top k', () => {
    const { trace, result } = capture({ query: 'ADR-085', k: 2, ranked: [
      row('alpha', 'ADR-085.md', 8, 'first architecture decision', 0),
      row('alpha', 'guide.md', 7, 'a different guide', 1),
      row('beta', 'ADR-085.md', 1, 'second architecture decision', 2),
    ] });
    expect(result.results.map((r) => r.repo)).toEqual(['alpha', 'beta']);
    expect(trace.allRows.find((r) => r.repo === 'beta')).toMatchObject({
      ceOriginal: 1, ceFinal: 1, disposition: 'kept', pruneReason: null });
    expect(trace.allRows.find((r) => r.path === 'guide.md')).toMatchObject({
      disposition: 'outside-selection', pruneReason: null });
  });

  it('distinguishes negative candidates pruned after selection from candidates never selected', () => {
    const { trace } = capture({ query: 'neutral question', k: 2, ranked: [
      row('alpha', 'good.md', 8, 'useful evidence', 0),
      row('beta', 'bad.md', -1, 'irrelevant evidence', 1),
      row('gamma', 'outside.md', -2, 'unselected evidence', 2),
    ] });
    expect(trace.pruned).toBe(1);
    expect(trace.allRows.find((r) => r.path === 'bad.md')).toMatchObject({
      disposition: 'pruned', pruneReason: 'negative-score-after-selection' });
    expect(trace.allRows.find((r) => r.path === 'outside.md')).toMatchObject({
      disposition: 'outside-selection', pruneReason: null });
  });
});
