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

// CI runners install only root deps — @ruvector/rvf lives in kb/node_modules and is a native
// module. When it is unresolvable, SKIP LOUDLY rather than fail the whole suite: the fixtures
// here require the real storage layer by design (no mocks), and the gate still runs for real
// locally, in self-update's [qa] step, and in the integration lane where kb deps exist.
let rvfAvailable = true;
try { await loadRvf(); } catch { rvfAvailable = false; }
const describeRvf = rvfAvailable ? describe : describe.skip;
if (!rvfAvailable) console.warn('[corpus-qa.test] SKIPPED: @ruvector/rvf not installed on this runner — real-fixture tests need it');

const DIMS = 8; // structural checks are dimension-agnostic; tiny vectors keep fixtures instant

let tmp;
let RvfDatabase;

function unitVec(seed) {
  const v = Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 31 + i * 7) + 0.01);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Create a real store fixture: .rvf with `vectors` rows, passages.jsonl with `rows`, embed.json.
 *  `vecs` (optional) supplies exact vectors so a test can engineer exact ranks and gaps. */
async function mkStore(name, { rows, vectors = rows.length, vecs = null }) {
  const rvf = path.join(tmp, `${name}.rvf`);
  const db = await RvfDatabase.create(rvf, { dimensions: DIMS, metric: 'cosine' });
  const batch = Array.from({ length: vectors }, (_, i) => ({ id: String(i + 1), vector: vecs ? vecs[i] : unitVec(i + 1) }));
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

describeRvf('corpus-qa — structural gate', () => {
  it('PASSes a well-formed store with no FULL_HINTS entry (counts match, no full-body floor demanded)', async () => {
    await mkStore('zzz-qa-good', { rows: [row(1), row(2), row(3)] });
    const r = await qaStore(tmp, 'zzz-qa-good', 'small', { roundtrip: false });
    expect(r.fails).toEqual([]);
    expect(r.passages).toBe(3);
    expect(r.vectors).toBe(3);
    expect(r.roundtrip).toBe('skipped');
  });

  it('PASSes a canonical big-only store with one unsuffixed passages sidecar', async () => {
    await mkStore('zzz-qa-canonical.big', { rows: [row(1), row(2)] });
    fs.renameSync(
      path.join(tmp, 'zzz-qa-canonical.big.passages.jsonl'),
      path.join(tmp, 'zzz-qa-canonical.passages.jsonl'),
    );
    const r = await qaStore(tmp, 'zzz-qa-canonical', 'big', { roundtrip: false });
    expect(r.fails).toEqual([]);
    expect(r.passages).toBe(2);
    expect(r.vectors).toBe(2);
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

describeRvf('corpus-qa — discovery + deterministic sampling', () => {
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

// R1 round-trip decision logic — the most bug-prone code in corpus-qa.mjs (the `matches()`
// triple-fallback, the NEAR_DUP_EPS photo-finish arm, and the wide-k crowd arm). This block was
// `describe.todo` until 2026-08-06, blocked on "getPipeline() calls the real ONNX pipeline with no
// injection seam". qaStore now takes an optional `pipeline` seam (production passes null), which is
// exactly the test-only mock the todo recommended — so the tier stays model-free and instant while
// the STORAGE layer stays real (real .rvf fixtures, same @ruvector/rvf the pipeline uses).
//
// Ranks and gaps are ENGINEERED, not hoped for: distances are measured exact to ~1e-8 against
// 1-cos(theta) in a real .rvf (verified before these tests were written), so a test that says
// "rank 15, Δ0.3000" is asserting the number the gate will actually print.

/** Unit vector at angle `theta` in the (e0,e1) plane; cosine distance from QUERY is 1-cos(theta). */
const vecAt = (theta) => [Math.cos(theta), Math.sin(theta), 0, 0, 0, 0, 0, 0];
const QUERY = vecAt(0);
const thetaFor = (d) => Math.acos(1 - d);

/**
 * Exact cosine distances for `n` rows placing `target` at 1-based `rank` with `targetDist` from
 * QUERY, and the rank-1 row sitting exactly ON the query (distance 0) so Δ-behind-#1 == targetDist.
 */
function distsForTargetRank(n, target, rank, targetDist) {
  const dists = new Array(n);
  dists[target] = targetDist;
  const others = [];
  for (let i = 0; i < n; i++) if (i !== target) others.push(i);
  others.forEach((idx, j) => {
    if (rank > 1 && j === 0) dists[idx] = 0;                        // #1, exactly on the query
    else if (rank > 1 && j < rank - 1) dists[idx] = (targetDist * j) / rank; // strictly inside (0, targetDist)
    else dists[idx] = targetDist + 0.1 + j * 1e-3;                  // strictly beyond the target
  });
  return dists;
}

const vecsFor = (dists) => dists.map((d) => vecAt(thetaFor(d)));

/** Fake embed pipeline matching getPipeline()'s resolved shape: (texts, opts) => {dims, data}. */
function fakePipe(vector, { dims } = {}) {
  const calls = [];
  const fn = async (texts, opts) => {
    calls.push({ texts, opts });
    return { dims: [1, dims ?? vector.length], data: Float32Array.from(vector) };
  };
  fn.calls = calls;
  return fn;
}

// A shared opening long enough that crowdKey()'s 200-char normalized prefix falls entirely inside
// it — siblings share the prefix but differ in their tails, so they crowd the ranking WITHOUT
// tripping matches()' exact-text fallback.
const SHARED_PREFIX = ('export PATH=/opt/miniconda3/envs/testbed/bin:/usr/bin:/bin '
  + 'export CONDA_PREFIX=/opt/miniconda3/envs/testbed CONDA_SHLVL=2 DEFAULT_ENV=testbed '
  + 'activate testbed and run the django test suite with the standard settings module ').slice(0, 250);

describeRvf('corpus-qa — R1 round-trip decision logic', () => {
  const N = 40;                    // wideKFor(40) = min(500, max(10, 20)) = 20
  const WIDE_K = 20;
  let uid = 0;
  const nextName = () => `zzz-r1-${uid++}`;

  /** Pick the row index qaStore will deterministically sample for this store name (samples=1). */
  const pickFor = (name) => sampleIndices(`${name}.small`, N, 1)[0];

  it('a rank-1 self-retrieval counts as a clean hit — no fails, and NO note (it is not a photo-finish)', async () => {
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    await mkStore(name, { rows, vecs: vecsFor(distsForTargetRank(N, p, 1, 0)) });

    const pipe = fakePipe(QUERY);
    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: pipe });
    expect(r.fails).toEqual([]);
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes).toEqual([]);                            // the top-3 arm, not the eps arm
    expect(pipe.calls.length).toBe(1);                      // it really went through the embed arm
    expect(pipe.calls[0].texts[0]).toContain(rows[p].text); // and embedded the SAMPLED row
  });

  it('top-3 rank match on exact id counts as a hit where ONLY the id clause can match (duplicate passage ids)', async () => {
    // Isolating the id clause needs a fixture where byId.get(r.id) is NOT r — i.e. two passages
    // sharing an id (last one wins the Map). With unique ids — which is what every real store has
    // today (metaharness.big: 8,979 rows / 8,979 distinct ids, checked 2026-08-06) — the id clause
    // is redundant: whenever it is true, byId.get(t.id) === r and the path AND text clauses are
    // true too. So this fixture is the only thing standing between that clause and dead code.
    const name = nextName();
    const p = pickFor(name);
    const q = p + 1 < N ? p + 1 : p - 1;
    expect(q).toBeGreaterThan(p);                           // later row must win the byId Map
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    rows[p] = { id: String(q + 1), path: 'src/target.rs', title: 'target.rs', text: 'target body' };
    const dists = distsForTargetRank(N, p, 30, 0.5);
    dists[q] = 0;                                           // the row carrying the shared id wins
    await mkStore(name, { rows, vecs: vecsFor(dists) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.fails).toEqual([]);
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes).toEqual([]);
    expect(rows[q].path).not.toBe(rows[p].path);            // path clause CANNOT have matched
    expect(rows[q].text).not.toBe(rows[p].text);            // text clause CANNOT have matched
  });

  it('top-3 rank match via path-equality fallback counts as a hit (id drifted, doc did not)', async () => {
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    // Decoy at rank 1: different id, different text, SAME path as the sampled row.
    const decoy = p === 0 ? 1 : 0;
    rows[decoy] = { ...rows[decoy], path: rows[p].path, text: `entirely different body ${decoy}` };
    const dists = distsForTargetRank(N, p, 30, 0.5);        // sampled row itself buried
    dists[decoy] = 0;                                       // decoy wins outright
    await mkStore(name, { rows, vecs: vecsFor(dists) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.fails).toEqual([]);
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes).toEqual([]);                            // rank 1 => clean top-3, never a note
    expect(rows[decoy].id).not.toBe(rows[p].id);            // proves it matched on path, not id
    expect(rows[decoy].text).not.toBe(rows[p].text);        // ...and not on text
  });

  it('top-3 rank match via exact-text fallback counts as a hit (overlapping chunk, different id/path)', async () => {
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    const decoy = p === 0 ? 1 : 0;
    rows[decoy] = { ...rows[decoy], text: rows[p].text };   // identical text, own id + own path
    const dists = distsForTargetRank(N, p, 30, 0.5);
    dists[decoy] = 0;
    await mkStore(name, { rows, vecs: vecsFor(dists) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.fails).toEqual([]);
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes).toEqual([]);
    expect(rows[decoy].id).not.toBe(rows[p].id);
    expect(rows[decoy].path).not.toBe(rows[p].path);        // proves it matched on text alone
  });

  it('a sampled row absent from the WIDE-k window is a hard FAIL, never forgiven by any arm', async () => {
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    // rank 25 of 40 — past top-10 AND past wide k=20. This is the class the gate exists for
    // (missing / zero / mis-slotted vector, broken read path): absent at ANY k.
    await mkStore(name, { rows, vecs: vecsFor(distsForTargetRank(N, p, 25, 0.5)) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.roundtrip).toBe('0/1');
    expect(r.fails.length).toBe(1);
    expect(r.fails[0]).toContain('R1 self-retrieval missed');
    expect(r.fails[0]).toContain(`ABSENT from top-${WIDE_K}`);
    expect(r.fails[0]).toContain(`id=${rows[p].id}`);
    expect(r.notes).toEqual([]);                            // no consolation note on a hard FAIL
  });

  it('a match ranked 4th+ within NEAR_DUP_EPS of rank 1 is a hit AND appends a near-dup `note` (photo-finish)', async () => {
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    const GAP = 0.016;                                      // inside NEAR_DUP_EPS (0.02), not trivially so
    await mkStore(name, { rows, vecs: vecsFor(distsForTargetRank(N, p, 5, GAP)) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.fails).toEqual([]);
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toMatch(/^near-dup crowd:/);         // the eps arm, NOT the wide-k arm
    expect(r.notes[0]).toContain('rank 5');
    const delta = Number(/Δ([0-9.]+)/.exec(r.notes[0])[1]); // bound the magnitude, not the direction
    expect(delta).toBeCloseTo(GAP, 4);
    expect(delta).toBeLessThanOrEqual(0.02);
    expect(delta).toBeGreaterThan(0.01);
  });

  it('a match ranked 4th+ and MORE than NEAR_DUP_EPS behind #1 still PASSes via wide-k, with a `deep crowd` note', async () => {
    // Behaviour CHANGED 2026-08-06 (ADR-0064). Previously a hard FAIL. A row at rank 5 with a big
    // gap is exactly as stored-and-readable as one at rank 188; failing the shallow crowd while
    // passing the deep one was the perverse edge the wide-k arm had to remove.
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    const GAP = 0.30;                                       // 15x NEAR_DUP_EPS — nowhere near a tie
    await mkStore(name, { rows, vecs: vecsFor(distsForTargetRank(N, p, 5, GAP)) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.fails).toEqual([]);
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toMatch(/^deep crowd:/);
    expect(r.notes[0]).toContain(`rank 5/${WIDE_K}`);
    expect(r.notes[0]).not.toContain('absent from top-10'); // it WAS in top-10, just far back
    const delta = Number(/Δ([0-9.]+)/.exec(r.notes[0])[1]);
    expect(delta).toBeCloseTo(GAP, 4);
    expect(delta).toBeGreaterThan(0.02);                    // provably outside the eps arm
  });

  it('WIDE-K ARM: a row absent from top-10 but present at wide k PASSes, and the note carries rank + crowd size', async () => {
    // The nightly-blocking case in miniature (metaharness.big chunk:2b7c2755…: ABSENT from top-10,
    // rank 188/500, 187/187 ahead of it near-duplicates of it). Here: rank 15/20, 14/14 siblings.
    const name = nextName();
    const p = pickFor(name);
    const rows = Array.from({ length: N }, (_, i) => ({
      id: String(i + 1), path: `src/u${i}.rs`, title: `u${i}.rs`, text: `unrelated body ${i}`,
    }));
    rows[p] = { ...rows[p], path: 'logs/django__django-13315/test_output.txt', text: `${SHARED_PREFIX} tail-target` };
    const dists = distsForTargetRank(N, p, 15, 0.4);
    // The 14 rows ranked ahead of it share its 200-char opening but differ in tail/id/path —
    // crowd members, not matches().
    const ahead = dists.map((d, i) => ({ d, i })).filter((x) => x.i !== p && x.d < dists[p])
      .sort((a, b) => a.d - b.d).map((x) => x.i);
    expect(ahead.length).toBe(14);
    for (const i of ahead) rows[i] = { ...rows[i], text: `${SHARED_PREFIX} tail-sibling-${i}` };
    await mkStore(name, { rows, vecs: vecsFor(dists) });

    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY) });
    expect(r.fails).toEqual([]);                            // the whole point: no longer a FAIL
    expect(r.roundtrip).toBe('1/1');
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toMatch(/^deep crowd:/);
    expect(r.notes[0]).toContain(`rank 15/${WIDE_K}`);
    expect(r.notes[0]).toContain('(absent from top-10)');   // loud about WHY it needed the wide arm
    expect(r.notes[0]).toContain('14/14 ahead are near-duplicates');
    expect(r.notes[0]).toContain(rows[p].path);
    const delta = Number(/Δ([0-9.]+)/.exec(r.notes[0])[1]);
    expect(delta).toBeCloseTo(0.4, 4);
  });

  it('an embed dimension mismatch is captured as an R1 error, not silently ignored', async () => {
    const name = nextName();
    const rows = Array.from({ length: N }, (_, i) => row(i + 1));
    await mkStore(name, { rows, vecs: vecsFor(distsForTargetRank(N, pickFor(name), 1, 0)) });

    // embed.json says 8 dims; the pipeline reports 4 — a real read-path/config divergence.
    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: fakePipe(QUERY, { dims: 4 }) });
    expect(r.roundtrip).toBe('error');
    expect(r.fails.length).toBe(1);
    expect(r.fails[0]).toContain('R1 round-trip error');
    expect(r.fails[0]).toContain(`embed dim 4 != ${DIMS}`);
  });

  it('roundtrip is "skipped" — genuinely NOT attempted — when an S3 vector-count mismatch already failed', async () => {
    const name = nextName();
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
    await mkStore(name, { rows, vectors: 4 });              // 6 passages, 4 vectors => S3 FAIL

    const pipe = fakePipe(QUERY);
    const r = await qaStore(tmp, name, 'small', { samples: 1, pipeline: pipe });
    expect(r.fails.some((f) => f.startsWith('S3') && f.includes('vectors=4 != passages=6'))).toBe(true);
    expect(r.roundtrip).toBe('skipped');
    expect(r.fails.some((f) => f.startsWith('R1'))).toBe(false);
    expect(pipe.calls.length).toBe(0);                      // "not attempted" means the embedder never ran
  });
});
