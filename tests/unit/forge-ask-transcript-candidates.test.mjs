import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/forge-rerank.mjs', () => ({ rerankPairs: vi.fn() }));

import { searchAll } from '../../kb/forge-ask-all.mjs';
import { searchKb } from '../../kb/forge-ask.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';

const roots = [];
afterEach(() => {
  vi.clearAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('transcript BM25 augmentation', () => {
  it('preserves earlier quoted candidates and deduplicates lexical additions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-transcript-cands-'));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'ruv-meetings.rvf'), 'fixture');
    const passages = [
      { path: 'quoted.md', title: 'quoted claim', text: 'Measured result was 2x faster and 3% smaller.' },
      { path: 'bm25.md', title: 'meeting note', text: 'The 2x and 3% measurements came from the meeting.' },
    ];
    fs.writeFileSync(path.join(dir, 'ruv-meetings.passages.jsonl'),
      passages.map((row) => JSON.stringify(row)).join('\n') + '\n');
    vi.mocked(searchKb).mockResolvedValue([
      { path: 'dense.md', title: 'dense result', fullText: 'dense result', text: 'dense result', bestDistance: 0.1 },
    ]);
    let rerankInput;
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) => {
      rerankInput = candidates;
      return candidates.map((candidate) => ({ ...candidate, ceScore: 1 }));
    });

    await searchAll({
      dir,
      repos: ['ruv-meetings'],
      query: 'Which result measured 2x and 3% improvement?',
      k: 5,
      pool: 8,
      allowFullCorpus: false,
    });

    const paths = rerankInput.map((candidate) => candidate.path);
    expect(paths).toContain('dense.md');
    expect(paths).toContain('quoted.md');
    expect(paths).toContain('bm25.md');
    expect(new Set(paths).size).toBe(paths.length);
    expect(rerankInput.find((candidate) => candidate.path === 'quoted.md')).toMatchObject({
      _lane: 'rescue', _quotedClaims: true,
    });
  });
});
