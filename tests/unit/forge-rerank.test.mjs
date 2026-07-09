// tests/unit/forge-rerank.test.mjs — kb/forge-rerank.mjs (the cross-encoder reranker sitting on top
// of searchKb) had ZERO test coverage anywhere in the repo (confirmed 2026-07-08: not in
// vitest.config.mjs's coverage.include, no test file imports it, and the plugin/test/run-tests.mjs
// CI-integration battery only exercises forge-mcp-all → forge-ask-all → forge-ask — it never pools/
// reranks, so forge-rerank.mjs's own logic runs in zero automated path). Unlike most of this repo's
// CLI-style scripts, rerankKb/rerankPairs are ALREADY exported and side-effect-free at import time,
// so this is a real test file, not a .todo skeleton. Mocking style matches
// tests/unit/forge-ask-all.test.mjs (mock the two heavy collaborators by the exact relative path
// forge-rerank.mjs imports them from, then statically import the thing under test).
//
// ORDERING NOTE (read before adding tests): rerankKb/rerankPairs cache the loaded cross-encoder in a
// module-scope `_ce` singleton (`let _ce = null` in forge-rerank.mjs) — once ANY test lets loadCE()
// succeed, `_ce` stays populated for the rest of this file's run (it's real module state, not a mock,
// so vi.clearAllMocks() doesn't touch it). So every "the cross-encoder never loads" case
// (short-circuit, skip-regex, load failure) is grouped and run BEFORE the one test that lets it
// succeed; everything after that point shares the ONE fakeT() score table below.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/resolve-deps.mjs', () => ({ loadTransformers: vi.fn() }));

import { searchKb } from '../../kb/forge-ask.mjs';
import { loadTransformers } from '../../kb/resolve-deps.mjs';
import { rerankKb, rerankPairs } from '../../kb/forge-rerank.mjs';

beforeEach(() => { vi.clearAllMocks(); });

const doc = (over = {}) => ({ path: 'p/doc.md', title: 'T', fullText: 'body text', bestDistance: 0.1, ...over });

// Score table shared by every test that runs AFTER the cross-encoder first loads successfully (see
// ordering note above) — passage text -> fake relevance logit. Fakes AutoTokenizer/
// AutoModelForSequenceClassification as plain functions, matching how loadCE calls them
// (`ce.tok(query, opts)`, `await ce.model(inputs)`).
const SCORES = { low: 1, mid: 5, high: 9, 'text-field': 9 };
function fakeT() {
  const tok = (query, opts) => ({ passage: opts.text_pair });
  const model = async (inputs) => {
    if (inputs.passage === '__THROW__') throw new Error('model inference failed');
    return { logits: { data: [SCORES[inputs.passage] ?? 0] } };
  };
  return {
    env: {}, // loadCE() does `T.env.allowRemoteModels = true` before touching tok/model — must exist
    AutoTokenizer: { from_pretrained: vi.fn(async () => tok) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) },
  };
}

describe('rerankKb / rerankPairs — before the cross-encoder ever loads', () => {
  it('rerankKb short-circuits without loading the cross-encoder when searchKb returns 0 or 1 candidates', async () => {
    searchKb.mockResolvedValue([doc()]);
    const r = await rerankKb({ dir: '.', name: 'x', query: 'anything', k: 6 });
    expect(r).toEqual([doc()]);
    expect(loadTransformers).not.toHaveBeenCalled();
  });

  it('rerankKb skips reranking for ADR-status queries and returns base order untouched', async () => {
    searchKb.mockResolvedValue([doc({ path: 'a' }), doc({ path: 'b' })]);
    const r = await rerankKb({ dir: '.', name: 'x', query: 'is ADR-014 proposed or accepted?', k: 6 });
    expect(r.map((d) => d.path)).toEqual(['a', 'b']);
    expect(loadTransformers).not.toHaveBeenCalled();
  });

  it('rerankKb skips reranking for "where is the ... documentation" queries', async () => {
    searchKb.mockResolvedValue([doc({ path: 'a' }), doc({ path: 'b' })]);
    const r = await rerankKb({ dir: '.', name: 'x', query: 'where is the documentation for this', k: 6 });
    expect(r.map((d) => d.path)).toEqual(['a', 'b']);
    expect(loadTransformers).not.toHaveBeenCalled();
  });

  it('rerankKb falls back to base order when the cross-encoder fails to load', async () => {
    searchKb.mockResolvedValue([doc({ path: 'a' }), doc({ path: 'b' })]);
    loadTransformers.mockRejectedValue(new Error('model download failed'));
    const r = await rerankKb({ dir: '.', name: 'x', query: 'how does witness chaining work', k: 6 });
    expect(r.map((d) => d.path)).toEqual(['a', 'b']);
  });

  it('rerankPairs returns [] for a non-array input without touching the cross-encoder', async () => {
    const r = await rerankPairs('q', null);
    expect(r).toEqual([]);
    expect(loadTransformers).not.toHaveBeenCalled();
  });

  it('rerankPairs returns [] for an empty array', async () => {
    expect(await rerankPairs('q', [])).toEqual([]);
  });

  it('rerankPairs falls back to ceScore:null on every item, preserving input order, when the CE fails to load', async () => {
    loadTransformers.mockRejectedValue(new Error('no network'));
    const docs = [doc({ path: 'a' }), doc({ path: 'b' })];
    const r = await rerankPairs('q', docs);
    expect(r.map((d) => d.path)).toEqual(['a', 'b']);
    expect(r.every((d) => d.ceScore === null)).toBe(true);
  });
});

describe('rerankKb — once the cross-encoder loads successfully (cached for the rest of this file)', () => {
  it('reorders by cross-encoder score (high first) and isolates a per-passage failure to -Infinity', async () => {
    searchKb.mockResolvedValue([
      doc({ path: 'broken', fullText: '__THROW__' }),
      doc({ path: 'low', fullText: 'low' }),
      doc({ path: 'high', fullText: 'high' }),
    ]);
    loadTransformers.mockResolvedValue({ T: fakeT() });
    const r = await rerankKb({ dir: '.', name: 'x', query: 'a real question', k: 6 });
    expect(r.map((d) => d.path)).toEqual(['high', 'low', 'broken']);
  });
});

describe('rerankPairs — after the cross-encoder is cached', () => {
  it('reads d.text when d.fullText is absent', async () => {
    const r = await rerankPairs('q', [{ path: 'x', text: 'text-field' }]);
    expect(r[0].ceScore).toBe(9);
  });

  it('sorts pooled cross-repo candidates by ceScore descending', async () => {
    const docs = [doc({ path: 'low', fullText: 'low' }), doc({ path: 'high', fullText: 'high' }), doc({ path: 'mid', fullText: 'mid' })];
    const r = await rerankPairs('q', docs);
    expect(r.map((d) => d.path)).toEqual(['high', 'mid', 'low']);
  });
});
