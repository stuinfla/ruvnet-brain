// tests/unit/keyword-lane.test.mjs — the keyword lane (kb/keyword-lane.mjs). Pinned:
//   - its ranking is forge-hybrid's bm25Score over the same passages, ties in sidecar order;
//   - it picks the top-N FILES first (best chunk per file) and only then drops paths dense pooled;
//   - a sidecar rewritten in place (overlay, ingest, update) is re-indexed;
//   - at most KEYWORD_INDEX_STORES_MAX store indexes stay resident.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEYWORD_INDEX_STORES_MAX, keywordCandidates } from '../../kb/keyword-lane.mjs';
import { bm25Score, buildCorpusStats, tokenize } from '../../kb/forge-hybrid.mjs';

afterEach(() => { vi.restoreAllMocks(); });

function store(rows, name = 'alpha') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwlane-'));
  fs.writeFileSync(path.join(dir, `${name}.passages.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return dir;
}
const WORDS = ['vector', 'search', 'offline', 'laptop', 'memory', 'agents', 'swarm', 'graph', 'index', 'server', 'embeddings', 'browser'];

describe('keyword lane', () => {
  it('ranks files exactly as forge-hybrid bm25Score does, best chunk per file, sidecar order on ties', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const rows = Array.from({ length: 120 }, (_, i) => ({ path: `f${i % 37}.md`, title: `T${i}`,
      text: Array.from({ length: 5 + Math.floor(rnd() * 30) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ') }));
    const dir = store(rows);
    const query = 'search vector embeddings offline on a laptop without a server server';
    const toks = rows.map((r) => tokenize(r.text));
    const stats = buildCorpusStats(toks);
    const qt = tokenize(query);
    const reference = rows.map((r, i) => ({ path: r.path, s: bm25Score(qt, toks[i], stats) }))
      .sort((a, b) => b.s - a.s).filter((x) => x.s > 0);
    const want = [];
    for (const r of reference) { if (!want.includes(r.path)) want.push(r.path); if (want.length >= 8) break; }
    expect(keywordCandidates(dir, 'alpha', query).map((c) => c.path)).toEqual(want);
  });

  it('breaks an exact score tie by sidecar order', () => {
    const dir = store([
      { path: 'z.md', text: 'vector search' },
      { path: 'a.md', text: 'vector search' },
      { path: 'm.md', text: 'vector search' },
    ]);
    expect(keywordCandidates(dir, 'alpha', 'vector search').map((c) => c.path)).toEqual(['z.md', 'a.md', 'm.md']);
  });

  it('chooses the top-N files first and then drops the ones dense already pooled', () => {
    const dir = store([
      { path: 'a.md', text: 'vector search vector search' },
      { path: 'b.md', text: 'vector search' },
      { path: 'c.md', text: 'vector' },
    ]);
    const out = keywordCandidates(dir, 'alpha', 'vector search', { topN: 2, exclude: new Set(['a.md']) });
    expect(out.map((c) => c.path)).toEqual(['b.md']);
    expect(out[0]).toMatchObject({ _lane: 'bm25', fullText: 'vector search', title: undefined });
  });

  it('re-indexes a sidecar that an overlay rewrote in place', () => {
    const dir = store([{ path: 'old.md', text: 'graph index' }]);
    expect(keywordCandidates(dir, 'alpha', 'swarm agents').map((c) => c.path)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'alpha.passages.jsonl'), `${JSON.stringify({ path: 'new.md', text: 'swarm agents memory' })}\n`);
    expect(keywordCandidates(dir, 'alpha', 'swarm agents').map((c) => c.path)).toEqual(['new.md']);
  });

  it('keeps at most KEYWORD_INDEX_STORES_MAX store indexes resident', () => {
    const dirs = Array.from({ length: KEYWORD_INDEX_STORES_MAX + 1 }, () => store([{ path: 'a.md', text: 'vector search' }]));
    for (const d of dirs) keywordCandidates(d, 'alpha', 'vector');
    const reads = vi.spyOn(fs, 'readFileSync');
    keywordCandidates(dirs[0], 'alpha', 'vector');
    expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.passages.jsonl')).length).toBe(1);
    reads.mockClear();
    keywordCandidates(dirs[KEYWORD_INDEX_STORES_MAX], 'alpha', 'vector');
    expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.passages.jsonl')).length).toBe(0);
  });

  it('evicts the least recently used index when resident sidecars exceed the byte budget', () => {
    const big = 'vector search '.repeat(50000); // ~700 KB sidecar each
    const dirs = [1, 2, 3].map(() => store([{ path: 'a.md', text: big }]));
    process.env.RUVNET_BRAIN_KEYWORD_INDEX_BUDGET_MB = '1';
    try {
      keywordCandidates(dirs[0], 'alpha', 'vector');
      keywordCandidates(dirs[1], 'alpha', 'vector'); // 1.4 MB resident > 1 MB: dirs[0] is evicted
      const reads = vi.spyOn(fs, 'readFileSync');
      keywordCandidates(dirs[1], 'alpha', 'vector');
      expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.passages.jsonl')).length).toBe(0);
      keywordCandidates(dirs[0], 'alpha', 'vector');
      expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.passages.jsonl')).length).toBe(1);
    } finally { delete process.env.RUVNET_BRAIN_KEYWORD_INDEX_BUDGET_MB; }
  });

  it('adds nothing for a store without a sidecar or a question without a matching token', () => {
    const dir = store([{ path: 'a.md', text: 'vector search' }]);
    expect(keywordCandidates(dir, 'missing', 'vector')).toEqual([]);
    expect(keywordCandidates(dir, 'alpha', 'zebra quokka')).toEqual([]);
  });
});
