// tests/unit/grounding-deadline.test.mjs — "every question ends" is a PROPERTY, so it gets a test
// that fails on the behaviour it replaced.
//
// The behaviour it replaced, measured 2026-09-11 against ~/.cache/ruvnet-brain/kb (SOURCE.json
// builtUtc 2026-08-20T07:16:20.675Z) at worktree HEAD 2eef2024: an unroutable query fanned out to
// 184 stores, pooled 6,691 (query, passage) pairs, and cross-encoded every one of them with no cap
// and no clock. Two runs produced NO OUTPUT in 15 minutes each.
//
// Each test below breaks if the guard it covers is removed:
//   • the pool budget test asserts a NUMBER (pooled <= 408 out of a >408 pool), so deleting the cap
//     fails it — a direction-only assertion would not have;
//   • the deadline tests assert the ERROR NAMES THE PHASE, so a bare timeout that says only "slow"
//     fails them;
//   • the scoped-lane test asserts the routed path is still UNCAPPED, so "cap everything" — the
//     change that would quietly degrade every answer in the held-out gate — also fails.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/forge-rerank.mjs', () => ({ rerankPairs: vi.fn(), cePrefilterScores: vi.fn() }));

import {
  FULL_CORPUS_MAX_PAIRS_DEFAULT,
  searchAll,
} from '../../kb/forge-ask-all.mjs';
import {
  DEADLINE_EXIT_CODE,
  DEFAULT_QUERY_DEADLINE_MS,
  QueryDeadlineExceeded,
  armProcessWatchdog,
  createDeadline,
  describeDeadline,
  resolveDeadlineMs,
} from '../../kb/query-deadline.mjs';
import { searchKb } from '../../kb/forge-ask.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';

function mkdirWith(names) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-'));
  for (const n of names) fs.writeFileSync(path.join(d, n), 'x');
  return d;
}
const hit = (over = {}) => ({ path: 'p/doc.md', title: 'T', fullText: 'body', bestDistance: 0.1, ...over });

beforeEach(() => {
  vi.mocked(searchKb).mockReset();
  vi.mocked(rerankPairs).mockReset();
  vi.mocked(rerankPairs).mockImplementation(async (_q, docs) =>
    docs.map((d, i) => ({ ...d, ceScore: 10 - i * 0.001 })));
});

describe('resolveDeadlineMs — the budget is configurable and can be switched off deliberately', () => {
  it('defaults to 20s when nothing is set', () => {
    expect(resolveDeadlineMs({})).toBe(DEFAULT_QUERY_DEADLINE_MS);
    expect(DEFAULT_QUERY_DEADLINE_MS).toBe(20_000);
  });
  it('honours an explicit budget', () => {
    expect(resolveDeadlineMs({ RUVNET_BRAIN_QUERY_DEADLINE_MS: '4500' })).toBe(4500);
  });
  it('treats 0 as "no deadline" — an offline evaluator must be able to say so out loud', () => {
    expect(resolveDeadlineMs({ RUVNET_BRAIN_QUERY_DEADLINE_MS: '0' })).toBe(0);
    expect(createDeadline({ ms: 0 })).toBeNull();
  });
});

describe('createDeadline — the error names the phase, not just the fact of being slow', () => {
  it('raises QueryDeadlineExceeded carrying the phase that was running', () => {
    let t = 1_000;
    const d = createDeadline({ ms: 100, now: () => t });
    d.check('route');          // inside budget
    t += 250;
    expect(() => d.check('retrieve:ruflo')).toThrow(QueryDeadlineExceeded);
    try { d.check('retrieve:ruflo'); } catch (e) {
      expect(e.phase).toBe('retrieve:ruflo');
      expect(e.code).toBe('QUERY_DEADLINE_EXCEEDED');
      expect(e.deadlineMs).toBe(100);
      expect(e.elapsedMs).toBeGreaterThanOrEqual(250);
    }
  });

  it('aborts its signal so in-flight work can be cancelled rather than orphaned', () => {
    let t = 0;
    const d = createDeadline({ ms: 10, now: () => t });
    expect(d.signal.aborted).toBe(false);
    t = 99;
    expect(() => d.check('rerank')).toThrow();
    expect(d.signal.aborted).toBe(true);
  });

  it('describes the timeout as a TIMEOUT, never as an empty corpus', () => {
    const line = describeDeadline(new QueryDeadlineExceeded({ phase: 'rerank', deadlineMs: 20_000, elapsedMs: 21_004 }));
    expect(line).toMatch(/QUERY DEADLINE EXCEEDED/);
    expect(line).toMatch(/phase "rerank"/);
    expect(line).toMatch(/do NOT conclude the ecosystem lacks this capability/i);
    expect(line).toMatch(/RUVNET_BRAIN_QUERY_DEADLINE_MS/);
  });
});

describe('searchAll — the deadline reaches every phase of a real query', () => {
  it('refuses before touching a store when the budget is already spent', async () => {
    const d = mkdirWith(['alpha.rvf', 'beta.rvf']);
    let t = 0;
    const deadline = createDeadline({ ms: 5, now: () => (t += 100) });
    await expect(searchAll({ dir: d, query: 'anything at all', deadline }))
      .rejects.toThrow(/phase "route"/);
    expect(searchKb).not.toHaveBeenCalled();
  });

  it('interrupts the fanout BETWEEN repos and names the repo it stopped at', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `store${String(i).padStart(2, '0')}.rvf`);
    const d = mkdirWith(names);
    vi.mocked(searchKb).mockResolvedValue([hit()]);
    // A clock that only advances when a phase checks in: route is free, then each repo costs 10ms.
    let t = 0;
    const deadline = createDeadline({ ms: 50, now: () => t });
    const realCheck = deadline.check.bind(deadline);
    deadline.check = (phase) => { const r = realCheck(phase); t += 10; return r; };
    let raised = null;
    try { await searchAll({ dir: d, query: 'a broad unroutable question about things', deadline }); }
    catch (e) { raised = e; }
    expect(raised).toBeInstanceOf(QueryDeadlineExceeded);
    expect(raised.phase).toMatch(/^retrieve:store\d\d$/);
    expect(rerankPairs).not.toHaveBeenCalled();
  });

  it('hands the deadline to the reranker, so the longest phase is interruptible too', async () => {
    const d = mkdirWith(['alpha.rvf', 'beta.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit()]);
    const deadline = createDeadline({ ms: 60_000 });
    await searchAll({ dir: d, query: 'a broad unroutable question about things', deadline });
    expect(rerankPairs).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { deadline });
  });
});

describe('the full-corpus fallback carries a pair budget; the routed lane does not', () => {
  const bigBundle = () => {
    const names = Array.from({ length: 120 }, (_, i) => `store${String(i).padStart(3, '0')}.rvf`);
    return mkdirWith(names);
  };
  // 120 stores x 8 hits = 960 pooled pairs — comfortably past the 408 budget, so the assertion is
  // about a MAGNITUDE, not a direction.
  const eightHits = (repoSeed) => Array.from({ length: 8 }, (_, i) => hit({
    path: `p/${repoSeed}-${i}.md`, title: `T${i}`, bestDistance: 0.1 + i * 0.01,
  }));

  it('caps the unscoped fanout at the measured B=408 and reports what it withheld', async () => {
    const d = bigBundle();
    let n = 0;
    vi.mocked(searchKb).mockImplementation(async () => eightHits(n++));
    const out = await searchAll({ dir: d, query: 'a broad unroutable question about many things' });
    expect(out.pooledAll).toBeGreaterThan(FULL_CORPUS_MAX_PAIRS_DEFAULT);
    expect(out.pooled).toBe(FULL_CORPUS_MAX_PAIRS_DEFAULT);
    expect(out.cappedOut).toBe(out.pooledAll - FULL_CORPUS_MAX_PAIRS_DEFAULT);
    expect(FULL_CORPUS_MAX_PAIRS_DEFAULT).toBe(408);
  });

  it('leaves an explicitly scoped search UNCAPPED — the held-out gate runs on that lane', async () => {
    const d = bigBundle();
    const repos = Array.from({ length: 120 }, (_, i) => `store${String(i).padStart(3, '0')}`);
    let n = 0;
    vi.mocked(searchKb).mockImplementation(async () => eightHits(n++));
    const out = await searchAll({ dir: d, query: 'a broad unroutable question about many things', repos });
    expect(out.pooledAll).toBeGreaterThan(FULL_CORPUS_MAX_PAIRS_DEFAULT);
    expect(out.pooled).toBe(out.pooledAll);
    expect(out.cappedOut).toBe(0);
  });

  it('lets an operator override the budget explicitly', async () => {
    const d = bigBundle();
    let n = 0;
    vi.mocked(searchKb).mockImplementation(async () => eightHits(n++));
    process.env.KB_FULL_CORPUS_MAX_PAIRS = '200';
    try {
      const out = await searchAll({ dir: d, query: 'a broad unroutable question about many things' });
      expect(out.pooled).toBe(200);
    } finally { delete process.env.KB_FULL_CORPUS_MAX_PAIRS; }
  });
});

describe('armProcessWatchdog — the backstop for a phase that blocks the event loop', () => {
  it('reaps forked children BEFORE exiting, so a forced timeout orphans nothing', async () => {
    vi.useFakeTimers();
    try {
      const order = [];
      const deadline = createDeadline({ ms: 20 });
      const disarm = armProcessWatchdog(deadline, {
        graceMs: 5,
        onExpire: async () => { order.push('reap'); },
        exit: (code) => { order.push(`exit:${code}`); },
        log: () => {},
      });
      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(1);
      disarm();
      expect(order[0]).toBe('reap');
      expect(order).toContain(`exit:${DEADLINE_EXIT_CODE}`);
    } finally { vi.useRealTimers(); }
  });

  it('never fires once disarmed — a finished query must not be killed by its own backstop', async () => {
    vi.useFakeTimers();
    try {
      const exits = [];
      const deadline = createDeadline({ ms: 10 });
      const disarm = armProcessWatchdog(deadline, { graceMs: 1, exit: (c) => exits.push(c), log: () => {} });
      disarm();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(exits).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('is a no-op when the deadline is disabled', () => {
    expect(typeof armProcessWatchdog(null)).toBe('function');
    expect(armProcessWatchdog(null)()).toBeUndefined();
  });
});
