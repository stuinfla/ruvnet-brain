import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyCausalRecall,
  applyMmrDiversity,
  createRetrievalReceipt,
  getRsiStats,
  promoteVerifiedLedgerEntries,
  queryEntryIndexes,
  rollbackRsiLearned,
} from '../../kb/rsi-retrieval-loop.mjs';
import { recommendForProject, scanCodebase } from '../../plugin/scripts/codebase-recommender.mjs';

describe('kb/rsi-retrieval-loop (adversarial + end-to-end)', () => {
  it('returns empty array gracefully when entry index files are absent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-loop-test-'));
    try {
      const hits = await queryEntryIndexes({ dir: tmp, queryVec: new Float32Array(768), RvfDatabase: {} });
      expect(hits).toEqual([]);
      const stats = getRsiStats(tmp);
      expect(stats.baseEntries).toBe(0);
      expect(stats.learnedEntries).toBe(0);
      expect(stats.rollbackAvailable).toBe(false);
      expect(rollbackRsiLearned(tmp).ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('MMRDiversityRanker preserves #1, respects k bounds, handles NaN/null, and never promotes negative-logit above positive-logit', () => {
    expect(applyMmrDiversity('bad')).toEqual([]);
    expect(applyMmrDiversity([{ repo: 'a', ceScore: 3 }], { k: 0 })).toEqual([]);
    expect(applyMmrDiversity([{ repo: 'a', ceScore: 3 }, { repo: 'b', ceScore: 2 }], { k: 1 })).toHaveLength(1);
    expect(applyMmrDiversity([{ repo: 'a', ceScore: 3 }, { repo: 'b', ceScore: 2 }, { repo: 'c', ceScore: 1 }], null)).toHaveLength(3);

    // Must promote diverse positive-logit repo over near-duplicate
    const ranked = [
      { repo: 'ruvector', path: 'README.md', title: 'RuVector HNSW', fullText: 'SIMD HNSW vector search in RVF binary file', ceScore: 5.0 },
      { repo: 'ruvector', path: 'docs/README.md', title: 'RuVector HNSW', fullText: 'SIMD HNSW vector search in RVF binary file', ceScore: 4.9 },
      { repo: 'agentdb', path: 'README.md', title: 'AgentDB memory', fullText: 'SQLite and HNSW persistent agent memory across hosts', ceScore: 4.7 },
    ];
    const diverse = applyMmrDiversity(ranked, { k: 2, lambda: 0.75 });
    expect(diverse.map((r) => r.repo)).toEqual(['ruvector', 'agentdb']);

    // Must NEVER promote negative-logit hit above positive-logit hit even across different repos
    const mixed = [
      { repo: 'ruvector', path: 'a.md', title: 'A', fullText: 'same topic', ceScore: 5.0 },
      { repo: 'ruvector', path: 'b.md', title: 'A', fullText: 'same topic', ceScore: 0.2 },
      { repo: 'other', path: 'c.md', title: 'Z', fullText: 'unrelated', ceScore: -1.0 },
    ];
    const safe = applyMmrDiversity(mixed, { k: 3, lambda: Number.NaN });
    expect(safe.map((r) => r.ceScore)).toEqual([5.0, 0.2, -1.0]);
  });

  it('CausalRecall applies bounded uplift, keeps ceScore pure, handles null/Infinity, and ignores evals/runs', () => {
    expect(applyCausalRecall('bad')).toEqual([]);
    expect(applyCausalRecall([{ repo: 'a', path: 'x.md', ceScore: 2 }], null)).toHaveLength(1);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-causal-'));
    const ledger = path.join(tmp, 'ledger.jsonl');
    try {
      const rows = [
        { grounded: true, repo: 'agentdb', path: 'docs/memory.md', ceScore: 3.5 },
        { grounded: true, repo: 'agentdb', path: 'docs/memory.md', ceScore: 4.1 },
        { grounded: true, repo: 'evals', path: 'evals/runs/leak.md', ceScore: 5.0 },
        { grounded: true, repo: 'bad', path: 'noise.md', ceScore: 3.2 },
      ];
      fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const cands = [
        { repo: 'other', path: 'a.md', ceScore: 2.1 },
        { repo: 'agentdb', path: 'docs/memory.md', ceScore: 2.0 },
        { repo: 'bad', path: 'noise.md', ceScore: -1.5 },
        { repo: 'evals', path: 'evals/runs/leak.md', ceScore: 2.0 },
        { repo: 'inf', path: 'inf.md', ceScore: Number.POSITIVE_INFINITY },
      ];
      const out = applyCausalRecall(cands, { ledgerPath: ledger });
      expect(out[0].repo).toBe('inf');
      expect(out[1].repo).toBe('agentdb');
      expect(out[1].ceScore).toBe(2.0); // pure ceScore untouched
      expect(out[1]._causalUplift).toBeGreaterThan(0);
      expect(out[1]._causalUplift).toBeLessThanOrEqual(0.35);
      expect(out.find((x) => x.repo === 'bad')._causalUplift).toBeUndefined();
      expect(out.find((x) => x.repo === 'evals')._causalUplift).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits independently verifiable 64-char SHA-256 ADR-304 witness-chained retrieval receipts', () => {
    expect(() => createRetrievalReceipt()).not.toThrow();
    expect(createRetrievalReceipt({ results: null }).resultCount).toBe(0);
    const r1 = createRetrievalReceipt({ query: 'how does ruvector work', results: [{ repo: 'ruvector', path: 'README.md', ceScore: 4.2 }], lane: 'full-corpus' });
    const r2 = createRetrievalReceipt({ query: 'how does agentdb work', results: [{ repo: 'agentdb', path: 'README.md', ceScore: 3.9 }], lane: 'scoped-search' });
    expect(r1.receiptHash).toHaveLength(64);
    expect(r2.prevHash).toBe(r1.receiptHash);
    // Independently recompute r2's SHA-256 hash from its public fields
    const recomputed = crypto.createHash('sha256').update(JSON.stringify({
      schema: r2.schema,
      prevHash: r2.prevHash,
      ts: r2.ts,
      queryHash: r2.queryHash,
      lane: r2.lane,
      resultCount: r2.resultCount,
      items: r2.items,
    })).digest('hex');
    expect(recomputed).toBe(r2.receiptHash);
  });

  it('shadow-verifies promotions (exact ID + distance), refuses failed shadows without harming .bak, and rolls back cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-shadow-'));
    const ledger = path.join(tmp, 'ledger.jsonl');
    const embedFn = async (q) => {
      const v = new Float32Array(768);
      const slot = /agentdb/i.test(q) ? 1 : 0;
      v[slot] = 1;
      return v;
    };
    const fakeStore = new Map();
    const makeFakeRvf = ({ failVerify = false } = {}) => ({
      async create(filePath) {
        fs.writeFileSync(filePath, 'RVF_OK');
        fs.writeFileSync(`${filePath}.idmap.json`, JSON.stringify({ ok: true }));
        const rows = [];
        return {
          async ingestBatch(batch) { rows.push(...batch); },
          async close() { fakeStore.set(filePath, rows); },
        };
      },
      async openReadonly(filePath) {
        if (failVerify) throw new Error('corrupt shadow');
        const rows = fakeStore.get(filePath) || [];
        return {
          async query(qVec) {
            return rows
              .map((r) => {
                let dot = 0;
                for (let i = 0; i < 8; i++) dot += (qVec[i] || 0) * (r.vector[i] || 0);
                return { id: r.id, distance: 1 - dot };
              })
              .sort((a, b) => a.distance - b.distance);
          },
          async close() {},
        };
      },
    });
    try {
      fs.writeFileSync(ledger, JSON.stringify({ grounded: true, repo: 'ruvector', path: 'README.md', query: 'how does ruvector work locally', ceScore: 3.4 }) + '\n');
      const ok1 = await promoteVerifiedLedgerEntries({ dir: tmp, ledgerPath: ledger, embedFn, RvfDatabase: makeFakeRvf() });
      expect(ok1.promoted).toBe(1);
      expect(ok1.shadowVerified).toBe(true);

      // Failed second promotion must leave live meta intact and clean up .shadow
      fs.appendFileSync(ledger, JSON.stringify({ grounded: true, repo: 'agentdb', path: 'README.md', query: 'how does agentdb share memory across hosts', ceScore: 3.9 }) + '\n');
      const bad = await promoteVerifiedLedgerEntries({ dir: tmp, ledgerPath: ledger, embedFn, RvfDatabase: makeFakeRvf({ failVerify: true }) });
      expect(bad.shadowVerified).toBe(false);
      expect(bad.promoted).toBe(0);
      expect(fs.existsSync(path.join(tmp, 'rsi-learned.d2q.rvf.shadow'))).toBe(false);
      expect(getRsiStats(tmp).learnedEntries).toBe(1);

      // Successful second promotion creates .bak and rollback restores v1
      const ok2 = await promoteVerifiedLedgerEntries({ dir: tmp, ledgerPath: ledger, embedFn, RvfDatabase: makeFakeRvf() });
      expect(ok2.promoted).toBe(1);
      expect(getRsiStats(tmp).learnedEntries).toBe(2);
      expect(rollbackRsiLearned(tmp).ok).toBe(true);
      expect(getRsiStats(tmp).learnedEntries).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('proactively detects JS/Python anti-patterns in src/, skips tests/ & comments, and exposes them in recommendForProject', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antipattern-'));
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { openai: '^4.0.0' } }));
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.mkdirSync(path.join(tmp, 'tests'));
      fs.writeFileSync(path.join(tmp, 'src', 'search.py'), '# gpt-4o comment ignored\nclient = QdrantClient(url="http://x")\nmodel = "openai/gpt-4o"\n');
      fs.writeFileSync(path.join(tmp, 'tests', 'mock.test.js'), 'const m = "gpt-4o"; cosineSimilarity(a, b);\n');
      const scan = scanCodebase(tmp);
      expect(scan.antipatterns.some((a) => a.kind === 'cloud-vector-lockin' && a.location === 'src/search.py:2')).toBe(true);
      expect(scan.antipatterns.some((a) => a.kind === 'hardcoded-model-id' && a.location === 'src/search.py:3')).toBe(true);
      expect(scan.antipatterns.some((a) => a.file.startsWith('tests/'))).toBe(false);
      const rec = recommendForProject({ cwd: tmp, prompt: 'make search faster' });
      expect(Array.isArray(rec.antipatterns)).toBe(true);
      expect(rec.antipatterns.length).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
