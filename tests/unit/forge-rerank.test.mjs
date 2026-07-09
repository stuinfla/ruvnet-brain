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
// AutoModelForSequenceClassification as plain functions, matching how ceScoreBatch/ceScore call them:
// the batched primary path passes ARRAYS (`ce.tok([q,q,...], {text_pair: [p1,p2,...]})`, one model
// call returning `logits.dims=[n,1]` + flat `data`), the per-pair fallback (after a batch throws)
// passes single strings (`ce.tok(q, {text_pair: p})`, `logits.data=[score]`, no `dims`) — this mock
// handles both by checking whether `opts.text_pair` is an array.
const SCORES = { low: 1, mid: 5, high: 9, 'text-field': 9 };
// Score lookup extended to also accept a bare numeric string ("0".."16") as its own score, so the
// chunk-boundary test below can give each of 17 passages a distinct, order-revealing value without
// growing the SCORES table by hand.
const scoreFor = (p) => (p in SCORES ? SCORES[p] : (Number.isNaN(Number(p)) ? 0 : Number(p)));
function fakeT() {
  const tok = (query, opts) => ({ passage: opts.text_pair });
  const model = async (inputs) => {
    if (Array.isArray(inputs.passage)) {
      // batched call: one whole-batch throw (mirrors a real ONNX forward pass — no partial results)
      // if ANY passage in the chunk is the throw sentinel, so callers see the same per-item fallback
      // behavior as a genuinely single-pair-scored model.
      if (inputs.passage.includes('__THROW__')) throw new Error('model inference failed');
      return { logits: { dims: [inputs.passage.length, 1], data: inputs.passage.map(scoreFor) } };
    }
    if (inputs.passage === '__THROW__') throw new Error('model inference failed');
    return { logits: { data: [scoreFor(inputs.passage)] } };
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

  // GAP closed (perf-audit pass 16 introduced ceScoreBatch/CE_BATCH_SIZE=16; no prior test ever sent
  // more than 4 candidates through it, so a chunk-stitching bug — scores landing at the wrong index
  // once a SECOND ONNX call is involved — would have shipped silently. Cross-repo pools regularly
  // exceed 200 candidates (pool * ~27 repos, per forge-rerank.mjs's own CE_BATCH_SIZE comment), so this
  // is the realistic production shape, not an edge case.
  it('stitches scores correctly across a CE_BATCH_SIZE chunk boundary, isolating a whole-chunk fallback to just the broken item', async () => {
    // 17 passages -> chunk0 = indices 0-15 (16 items, one is the throw sentinel), chunk1 = index 16
    // (1 item). chunk0's batched call throws (poisoned by '__THROW__' at index 5) and falls back to
    // per-pair scoring for every OTHER item in that chunk; chunk1 is untouched and scores via the true
    // batched path — proving the two chunks are independent and `scores[start + i]` lands correctly.
    const docs = Array.from({ length: 17 }, (_, i) => doc({ path: `p${i}`, fullText: i === 5 ? '__THROW__' : String(i) }));
    const r = await rerankPairs('q', docs);
    expect(r.map((d) => d.fullText)).toEqual(
      ['16', '15', '14', '13', '12', '11', '10', '9', '8', '7', '6', '4', '3', '2', '1', '0', '__THROW__']
    );
    expect(r[0].ceScore).toBe(16); // chunk1's lone item, scored via the real batched path (not fallback)
    expect(r.at(-1).ceScore).toBe(-Infinity); // the one broken item in chunk0, isolated by per-pair fallback
  });
});

// GAPS below are genuinely blocked the same way as this repo's other module-private functions
// (ceScoreBatch/CE_BATCH_SIZE are not exported from forge-rerank.mjs) — flagged per this suite's
// established sign-off norm, not applied here.
describe('ceScoreBatch — internals not reachable through rerankKb/rerankPairs alone (blocked: see note above)', () => {
  it.todo('a cross-encoder checkpoint returning dims=[n, numLabels>1] (multi-label logits) picks the intended label index, not just index 0 of a flattened array — every test so far uses dims=[n,1]');
  it.todo('logs via console.error only when CE_DEBUG is set, and stays silent otherwise, on a batch-scoring fallback');
  it.todo('its own `if (!passages.length) return []` guard is dead code against BOTH current callers (rerankKb short-circuits at base.length<=1 before calling it; rerankPairs short-circuits at docs.length===0) — worth exporting ceScoreBatch directly if this guard is ever meant to be relied on, or removing it if not');
});
