// tests/unit/corpus-qa.test.mjs — the corpus QA gate (scripts/corpus-qa.mjs) is what turns the
// 2026-07-10 hand-verification ("18,491 passages / 0 full bodies shipped silently") into a
// permanent machine check. These tests build REAL tiny .rvf fixtures (via the same @ruvector/rvf
// the pipeline uses — no mocks of the storage layer) and exercise the structural checks in
// process. The heavy embed round-trip is exercised by the real full-corpus run (and per-store in
// self-update's [qa] step), not here — unit tier stays model-free and fast.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { qaStore, discoverStores, sampleIndices } from '../../scripts/corpus-qa.mjs';
import { loadRvf } from '../../kb/resolve-deps.mjs';

const DIMS = 8; // structural checks are dimension-agnostic; tiny vectors keep fixtures instant

let tmp;
let RvfDatabase;

function unitVec(seed) {
  const v = Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 31 + i * 7) + 0.01);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Create a real store fixture: .rvf with `vectors` rows, passages.jsonl with `rows`, embed.json. */
async function mkStore(name, { rows, vectors = rows.length }) {
  const rvf = path.join(tmp, `${name}.rvf`);
  const db = await RvfDatabase.create(rvf, { dimensions: DIMS, metric: 'cosine' });
  const batch = Array.from({ length: vectors }, (_, i) => ({ id: String(i + 1), vector: unitVec(i + 1) }));
  if (batch.length) await db.ingestBatch(batch);
  await db.close();
  fs.writeFileSync(path.join(tmp, `${name}.passages.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.writeFileSync(`${rvf}.embed.json`, JSON.stringify({
    model: 'test-model', dimensions: DIMS, metric: 'cosine', pooling: 'mean', normalize: true, queryPrefix: '',
  }));
}

const row = (id, opts = {}) => ({
  id: String(id),
  text: opts.fullBody ? `Source src/x${id}.rs (full body):\nfn main() {}` : `plain doc text ${id}`,
  path: `src/x${id}.rs`,
  title: `x${id}.rs`,
});

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-qa-')));
  ({ mod: { RvfDatabase } } = loadRvf());
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('corpus-qa — structural gate', () => {
  it('PASSes a well-formed store with no FULL_HINTS entry (counts match, no full-body floor demanded)', async () => {
    await mkStore('zzz-qa-good', { rows: [row(1), row(2), row(3)] });
    const r = await qaStore(tmp, 'zzz-qa-good', 'small', { roundtrip: false });
    expect(r.fails).toEqual([]);
    expect(r.passages).toBe(3);
    expect(r.vectors).toBe(3);
    expect(r.roundtrip).toBe('skipped');
  });

  it('FAILs (S2) a store that FULL_HINTS marks for full-body indexing but which has 0 full bodies — the exact 2026-07-10 silent-depth-loss class', async () => {
    // 'ruflo' has a real FULL_HINTS entry; a fixture named ruflo with zero '(full body):' passages
    // reproduces the shipped failure (18,491 passages / 0 full bodies) in miniature.
    await mkStore('ruflo', { rows: [row(1), row(2)] });
    const r = await qaStore(tmp, 'ruflo', 'small', { roundtrip: false });
    expect(r.fails.some((f) => f.startsWith('S2') && /0 full-body/.test(f))).toBe(true);
  });

  it('PASSes S2 for a hinted store as soon as it has >0 full-body passages', async () => {
    await mkStore('agentdb', { rows: [row(1, { fullBody: true }), row(2)] }); // agentdb is hinted
    const r = await qaStore(tmp, 'agentdb', 'small', { roundtrip: false });
    expect(r.fails.filter((f) => f.startsWith('S2'))).toEqual([]);
    expect(r.fullBodies).toBe(1);
  });

  it('FAILs (S3) on vector/passage count mismatch (missing rows in the .rvf)', async () => {
    await mkStore('zzz-qa-mismatch', { rows: [row(1), row(2), row(3)], vectors: 2 });
    const r = await qaStore(tmp, 'zzz-qa-mismatch', 'small', { roundtrip: false });
    expect(r.fails.some((f) => f.startsWith('S3') && f.includes('vectors=2 != passages=3'))).toBe(true);
  });

  it('FAILs (S1) when the passages sidecar is missing entirely (vector store without readable text = teaser, not knowledge)', async () => {
    const rvf = path.join(tmp, 'zzz-qa-nopass.rvf');
    const db = await RvfDatabase.create(rvf, { dimensions: DIMS, metric: 'cosine' });
    await db.ingestBatch([{ id: '1', vector: unitVec(1) }]);
    await db.close();
    const r = await qaStore(tmp, 'zzz-qa-nopass', 'small', { roundtrip: false });
    expect(r.fails.some((f) => f.startsWith('S1'))).toBe(true);
  });

  it('FAILs (S4) when <name>.rvf.embed.json is missing — the read path could not embed queries', async () => {
    await mkStore('zzz-qa-noembed', { rows: [row(1)] });
    fs.rmSync(path.join(tmp, 'zzz-qa-noembed.rvf.embed.json'));
    const r = await qaStore(tmp, 'zzz-qa-noembed', 'small', { roundtrip: false });
    expect(r.fails.some((f) => f.startsWith('S4'))).toBe(true);
  });
});

describe('corpus-qa — discovery + deterministic sampling', () => {
  it('discovers small and .big variants, and never silently drops an .rvf', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-qa-disc-'));
    for (const f of ['a.rvf', 'a.big.rvf', 'b.big.rvf', 'a.rvf.idmap.json']) fs.writeFileSync(path.join(d, f), '');
    const { stores } = discoverStores(d);
    expect(stores).toEqual([
      { store: 'a', variant: 'big' },
      { store: 'a', variant: 'small' },
      { store: 'b', variant: 'big' },
    ]);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('sampleIndices is deterministic (same store key => same picks) and yields k distinct in-range indices', () => {
    const a = sampleIndices('ruvector.small', 28018, 3);
    const b = sampleIndices('ruvector.small', 28018, 3);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    for (const i of a) { expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(28018); }
    expect(sampleIndices('tiny.small', 2, 3).length).toBe(2); // never demands more than the store has
  });
});

// The R1 round-trip block (qaStore's roundtrip=true path, lines ~138-173 of corpus-qa.mjs) is the
// most bug-prone logic in this file — the `matches()` triple-fallback (id, path, or exact text) and
// the NEAR_DUP_EPS photo-finish forgiveness arm — and it has ZERO coverage above. It's blocked the
// same way ~19 other files in this suite are: getPipeline() calls the real ONNX transformers
// pipeline with no injection seam, so exercising it needs either a live KB_MODEL_CACHE (the
// live-infra tier: prove.mjs, eval-brain.mjs, brain-grade-groundtruth.mjs) or exporting a pure
// decision function out of the loop (e.g. `classifyRoundtrip({rank, distances, sampleId, byId, row})`
// that qaStore calls) — a test-only mock of getPipeline's return value would make this instant and
// model-free, same recommendation this suite has made for every other DI-blocked file. Flagging,
// not performing — same sign-off norm as the rest of this suite.
describe.todo('corpus-qa — R1 round-trip decision logic (blocked: no DI seam for the embed pipeline)', () => {
  it.todo('top-3 rank match on exact id counts as a hit');
  it.todo('top-3 rank match via path-equality fallback counts as a hit (id drifted, doc did not)');
  it.todo('top-3 rank match via exact-text fallback counts as a hit (overlapping chunk, different id/path)');
  it.todo('a sampled row entirely absent from top-10 is a hard FAIL, never forgiven by the epsilon arm');
  it.todo('a match ranked 4th+ within NEAR_DUP_EPS of rank 1 counts as a hit AND appends a `notes` entry (photo-finish, not a broken store)');
  it.todo('a match ranked 4th+ but MORE than NEAR_DUP_EPS behind rank 1 is a hard FAIL (drift ≠ near-dup crowding)');
  it.todo('an embed dimension mismatch (out.dims[1] !== embedConf.dimensions) throws and is captured as an R1 error, not silently ignored');
  it.todo('roundtrip is reported "skipped" (not attempted) when an S3 vector-count-mismatch fail already exists, even if roundtrip=true was requested');
});
