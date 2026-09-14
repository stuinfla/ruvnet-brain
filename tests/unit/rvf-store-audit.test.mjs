// Step 13 — the C2 "stores them correctly" gate. Every case below is built on a REAL RVF store
// created with the installed @ruvector/rvf, then damaged in one specific way; the audit must reject
// it and name the reason. Segment presence alone is never accepted as proof (Dual correction A4).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RVF_HNSW_THRESHOLD,
  auditCorpusStores,
  checkPrivateExclusion,
  isPassingState,
  measureRecall,
} from '../../scripts/rvf-index-audit.mjs';

const requireFromKb = createRequire(new URL('../../kb/package.json', import.meta.url));
const { RvfDatabase } = requireFromKb('@ruvector/rvf');

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmpdir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvf-store-audit-')); dirs.push(dir); return dir; };

const DIM = 16;

// A deterministic stand-in for the pinned sentence embedder: the same text always yields the same
// unit vector, in-process and across processes. It lets the passage<->vector probe be exercised
// without downloading a 100 MB model, while `embeds a passage deterministically across processes`
// below proves the REAL pinned model has the same property the probe depends on.
function fakeEmbed(text) {
  const vector = new Float32Array(DIM);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let s = h || 1;
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    vector[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) vector[i] /= norm;
  return vector;
}
const fakeEmbedder = async (texts) => texts.map(fakeEmbed);

/**
 * A complete, honest store: real .big.rvf (+ the SDK's own idmap sidecar), embed.json, passages.jsonl
 * whose text actually produced the vectors, and meta.json binding every chunk id to its source path.
 * `count >= RVF_HNSW_THRESHOLD` also materializes and persists a real HNSW INDEX_SEG the way
 * kb/rvf-index.mjs does (open read-write, query once, close).
 */
async function buildStore({ dir, name = 'alpha', count = RVF_HNSW_THRESHOLD, withIndex = true }) {
  const rvfPath = path.join(dir, `${name}.big.rvf`);
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `chunk:${name}-${index}`,
    text: `${name} passage number ${index} about vectors and retrieval`,
    path: `docs/${name}-${index % 7}.md`,
    title: `${name} ${index}`,
  }));
  const db = await RvfDatabase.create(rvfPath, { dimensions: DIM, metric: 'cosine' });
  await db.ingestBatch(rows.map((row) => ({ id: row.id, vector: fakeEmbed(row.text) })));
  await db.close();
  if (withIndex && count >= RVF_HNSW_THRESHOLD) {
    const indexer = await RvfDatabase.open(rvfPath);
    await indexer.query(fakeEmbed(rows[0].text), 1);
    await indexer.close();
  }
  fs.writeFileSync(`${rvfPath}.embed.json`, JSON.stringify({ model: 'fixture-embedder', dimensions: DIM, metric: 'cosine', pooling: 'cls', normalize: true }));
  fs.writeFileSync(path.join(dir, `${name}.passages.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const files = {};
  for (const row of rows) (files[row.path] ||= { chunkIds: [] }).chunkIds.push(row.id);
  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify({ model: 'fixture-embedder', dimensions: DIM, metric: 'cosine', name, incremental: { schemaVersion: 2, files } }));
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['cognitum-seed'] }));
  return { rvfPath, rows };
}

const audit = (dir, options = {}) => auditCorpusStores({ dir, embedder: fakeEmbedder, sampleSize: 25, ...options });
const only = (result) => result.stores[0];
const kinds = (row) => [...new Set(row.failures.map((failure) => failure.kind))];
const rewriteJson = (file, mutate) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(mutate(value) ?? value));
};

describe('C2 store audit — measured recall', () => {
  it('(a) passes a healthy indexed store and reports a real recall figure, not a segment presence flag', async () => {
    const dir = tmpdir();
    await buildStore({ dir });
    const result = await audit(dir);

    const row = only(result);
    expect(row.failures).toEqual([]);
    expect(row.state).toBe('PASS');
    expect(result.state).toBe('PASS');
    // The gate's whole point: a NUMBER, above the Layer C contract, from executed queries.
    expect(row.recall.recallAtK).toBeGreaterThanOrEqual(0.95);
    expect(row.recall.minRecall).toBeGreaterThanOrEqual(0.95);
    expect(row.recall.queries).toBe(25);
    expect(row.recall.hasIndex).toBe(true);
    expect(row.recall.indexRequired).toBe(true);
    expect(row.recall.segmentsHashVerified).toBeGreaterThan(0);
    expect(row.recall.p50Ms).toBeGreaterThan(0);
    expect(row.passageProbe.state).toBe('PASS');
    expect(row.correspondence.counts).toMatchObject({ idmapIds: RVF_HNSW_THRESHOLD, storedVectors: RVF_HNSW_THRESHOLD, passages: RVF_HNSW_THRESHOLD });
  });

  it('(g) marks a sub-threshold store PASS-SMALL-STORE — the exact-scan exception is never folded into PASS', async () => {
    const dir = tmpdir();
    await buildStore({ dir, count: 64 });
    const result = await audit(dir);

    const row = only(result);
    expect(row.state).toBe('PASS-SMALL-STORE');
    expect(row.state).not.toBe('PASS');
    expect(isPassingState(row.state)).toBe(true);
    expect(result.smallStoreExceptions).toEqual(['alpha']);
    // Brute force IS the index below the threshold, so recall must be exact — and still measured.
    expect(row.recall.recallAtK).toBe(1);
    expect(row.recall.indexRequired).toBe(false);
    expect(row.recall.hasIndex).toBe(false);
  });

  it('(h1) efSearch cannot degrade recall on this engine — the knob is floored, so it is not a valid low-recall proof', async () => {
    const dir = tmpdir();
    await buildStore({ dir });
    const rvfPath = path.join(dir, 'alpha.big.rvf');

    const baseline = await measureRecall({ rvfPath, RvfDatabase, sampleSize: 25 });
    const starved = await measureRecall({ rvfPath, RvfDatabase, sampleSize: 25, efSearch: 1 });

    // rvf-runtime floors ef_search at INDEX_MIN_EF_SEARCH = 256 (index_path.rs:48, store.rs:793-797),
    // so efSearch=1 is NOT honoured downward and recall does not move. Measured, not assumed.
    expect(baseline.recallAtK).toBeGreaterThanOrEqual(0.95);
    expect(starved.recallAtK).toBeGreaterThanOrEqual(0.95);
    expect(starved.efSearch).toBe(1);
    expect(starved.recallAtK).toBeCloseTo(baseline.recallAtK, 10);
  });

  it('(h2) fails closed, by magnitude, when the engine returns degraded neighbours', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir });

    // Stand in for an index that genuinely answers badly (the case efSearch cannot produce here):
    // keep one true neighbour, fill the rest with far-away ids. Recall must land near 1/k, and the
    // gate must reject it — a threshold that only reads "below 0.95" would also pass a 0.94 fake,
    // so the measured value itself is asserted.
    const degraded = {
      openReadonly: async (file) => {
        const db = await RvfDatabase.openReadonly(file);
        const size = (await db.status()).totalVectors;
        return Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
          query: async (vector, k, options) => {
            const honest = await db.query(vector, k, options);
            return honest.slice(0, 1).concat(
              Array.from({ length: k - 1 }, (_, index) => ({ id: `chunk:alpha-${(size - 1) - index}`, distance: 9 + index })),
            );
          },
        });
      },
    };

    const result = await measureRecall({ rvfPath, RvfDatabase: degraded, sampleSize: 25 });
    expect(result.state).toBe('FAIL');
    expect(result.recallAtK).toBeLessThan(0.3);
    expect(result.recallAtK).toBeGreaterThan(0);
    expect(kinds(result)).toContain('recall-below-threshold');
    expect(result.failures.find((f) => f.kind === 'recall-below-threshold').detail).toMatch(/persisted queries/);
  });
});

describe('C2 store audit — damaged stores are rejected', () => {
  it('(b1) rejects a store whose persisted index was truncated away', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir });
    expect(only(await audit(dir)).state).toBe('PASS');

    const inspect = await RvfDatabase.openReadonly(rvfPath);
    const segments = await inspect.segments();
    await inspect.close().catch(() => {});
    const indexSeg = segments.find((segment) => segment.segType === 'index');
    expect(indexSeg, 'fixture must really have persisted an index, or this test guards nothing').toBeTruthy();
    const fd = fs.openSync(rvfPath, 'r+');
    fs.ftruncateSync(fd, indexSeg.offset);
    fs.closeSync(fd);

    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('index-missing');
  });

  it('(b2) rejects a store whose index segment bytes were corrupted in place — which recall alone cannot see', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir });
    const inspect = await RvfDatabase.openReadonly(rvfPath);
    const segments = await inspect.segments();
    await inspect.close().catch(() => {});
    const indexSeg = segments.find((segment) => segment.segType === 'index');

    // Overwrite the middle of the INDEX_SEG payload. The engine silently rebuilds the graph in
    // memory on the next query (store.rs:761-780), so queries still answer perfectly — measured
    // below. Only the segment content hash (hashing.rs:22-33) catches the damaged persisted bytes.
    const fd = fs.openSync(rvfPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(Math.floor(indexSeg.payloadLength / 4), 0xab), 0, Math.floor(indexSeg.payloadLength / 4), indexSeg.offset + 64 + Math.floor(indexSeg.payloadLength / 3));
    fs.closeSync(fd);

    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('segment-content-hash-mismatch');
    expect(row.recall.hasIndex, 'the damaged index segment is still PRESENT — presence is why this gate cannot rely on it').toBe(true);
    expect(row.recall.recallAtK, 'queries still answer well, so recall alone would have passed this store').toBeGreaterThanOrEqual(0.95);
  });

  it('(c1) rejects an id map swapped into a state that no longer matches the stored vectors', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir });
    rewriteJson(`${rvfPath}.idmap.json`, (map) => {
      map.idToLabel['chunk:alpha-0'] = map.nextLabel + 500; // points at a label no vector carries
      return map;
    });

    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toEqual(expect.arrayContaining(['idmap-label-out-of-range', 'idmap-not-bijective']));
  });

  it('(c2) rejects a CONSISTENTLY swapped id map — invisible to recall, caught by re-embedding the passage', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir });
    rewriteJson(`${rvfPath}.idmap.json`, (map) => {
      const [a, b] = ['chunk:alpha-0', 'chunk:alpha-1'];
      const [la, lb] = [map.idToLabel[a], map.idToLabel[b]];
      map.idToLabel[a] = lb; map.idToLabel[b] = la;         // swap both directions, so the map stays
      map.labelToId[String(la)] = b; map.labelToId[String(lb)] = a; // bijective and every label resolves
      return map;
    });

    const row = only(await audit(dir, { probeSampleSize: RVF_HNSW_THRESHOLD }));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('vector-passage-mismatch');
    expect(row.recall.recallAtK, 'a consistent swap leaves label-level recall intact — which is why the probe exists').toBeGreaterThanOrEqual(0.95);
    expect(row.failures.find((f) => f.kind === 'vector-passage-mismatch').id).toMatch(/^chunk:alpha-[01]$/);
  });

  it('(d) rejects an omitted passage and names the id', async () => {
    const dir = tmpdir();
    await buildStore({ dir });
    const passagesFile = path.join(dir, 'alpha.passages.jsonl');
    const lines = fs.readFileSync(passagesFile, 'utf8').split('\n').filter(Boolean);
    const dropped = JSON.parse(lines[5]).id;
    fs.writeFileSync(passagesFile, `${lines.filter((_, index) => index !== 5).join('\n')}\n`);

    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('passage-missing');
    expect(row.failures.some((failure) => failure.kind === 'passage-missing' && failure.id === dropped)).toBe(true);
  });

  it('(e) rejects an altered source mapping', async () => {
    const dir = tmpdir();
    await buildStore({ dir });
    const passagesFile = path.join(dir, 'alpha.passages.jsonl');
    const lines = fs.readFileSync(passagesFile, 'utf8').split('\n').filter(Boolean);
    const row3 = JSON.parse(lines[3]);
    lines[3] = JSON.stringify({ ...row3, path: 'docs/not-the-file-this-chunk-came-from.md' });
    fs.writeFileSync(passagesFile, `${lines.join('\n')}\n`);

    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('source-map-mismatch');
    expect(row.failures.find((failure) => failure.kind === 'source-map-mismatch').id).toBe(row3.id);
  });

  it('(e2) rejects a source path that escapes the archive', async () => {
    const dir = tmpdir();
    await buildStore({ dir });
    const passagesFile = path.join(dir, 'alpha.passages.jsonl');
    const lines = fs.readFileSync(passagesFile, 'utf8').split('\n').filter(Boolean);
    lines[2] = JSON.stringify({ ...JSON.parse(lines[2]), path: '../../etc/passwd' });
    fs.writeFileSync(passagesFile, `${lines.join('\n')}\n`);

    expect(kinds(only(await audit(dir)))).toContain('source-path-malformed');
  });

  it('(f) rejects a fenced private store present in the directory', async () => {
    const dir = tmpdir();
    await buildStore({ dir });
    await buildStore({ dir, name: 'cognitum-seed', count: 8 });

    const result = await audit(dir);
    expect(result.state).toBe('FAIL');
    expect(result.privateExclusion).toMatchObject({ state: 'FAIL', leaks: ['cognitum-seed'] });
    // Case-folded, so a differently-cased filename cannot slip the fence.
    expect(checkPrivateExclusion({ dir, privateStores: ['CogNituM-SeeD'], rvfFiles: ['cognitum-seed.big.rvf'] }).leaks).toEqual(['cognitum-seed']);
  });

  it('rejects a store whose vector bytes were tampered with after the ledger hashed them', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir, count: 64 });
    const inspect = await RvfDatabase.openReadonly(rvfPath);
    const vecSeg = (await inspect.segments()).find((segment) => segment.segType === 'vec');
    await inspect.close().catch(() => {});
    const fd = fs.openSync(rvfPath, 'r+');
    fs.writeSync(fd, Buffer.from([0x7f, 0x7f, 0x7f, 0x7f]), 0, 4, vecSeg.offset + 64 + 32);
    fs.closeSync(fd);

    // Here the ENGINE catches it first (it verifies segment hashes on load and refuses to open:
    // "Segment hash verification failed ... InvalidChecksum"), unlike the corrupted INDEX_SEG in
    // (b2), which it rebuilds silently. Both paths must land on the same finding.
    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('segment-content-hash-mismatch');
    expect(row.failures[0].detail).toMatch(/checksum|hash verification/i);
  });

  it('reports a missing id map sidecar instead of letting the SDK quarantine it', async () => {
    const dir = tmpdir();
    const { rvfPath } = await buildStore({ dir, count: 64 });
    fs.rmSync(`${rvfPath}.idmap.json`);

    const row = only(await audit(dir));
    expect(row.state).toBe('FAIL');
    expect(kinds(row)).toContain('idmap-missing');
    expect(fs.existsSync(`${rvfPath}.idmap.json`), 'the audit must not have caused the SDK to rewrite the sidecar').toBe(false);
  });

  it('refuses to audit a directory with no private-store fence rather than passing it', async () => {
    const dir = tmpdir();
    await buildStore({ dir, count: 8 });
    fs.rmSync(path.join(dir, 'PRIVATE-STORES.json'));
    await expect(auditCorpusStores({ dir, embedder: fakeEmbedder })).rejects.toThrow(/private-store fence/i);
  });

  // The passage<->vector probe re-embeds a passage and compares it with the stored vector, which is
  // only sound if the pinned embedder is deterministic ACROSS PROCESSES (the stored vectors were
  // produced by a different process, months earlier). Prove that rather than assume it: embed the
  // same text in two fresh child processes and require bit-identical float32 output. Runs only where
  // the pinned model is already cached — never silently, and never as a download.
  it('embeds a passage deterministically across processes (the assumption the probe rests on)', async () => {
    const { chooseModelCache } = await import('../../kb/resolve-deps.mjs');
    const { BGE_MODEL, modelCacheReady } = await import('../../kb/model-requirements.mjs');
    const cache = chooseModelCache();
    if (!modelCacheReady(cache, BGE_MODEL)) {
      expect(modelCacheReady(cache, BGE_MODEL), `SKIPPED: ${BGE_MODEL} is not cached at ${cache}`).toBe(false);
      return;
    }
    const { execFileSync } = await import('node:child_process');
    const script = new URL('../helpers/embed-once.mjs', import.meta.url);
    const run = () => execFileSync(process.execPath, [script.pathname, 'the corpus seed pipeline stores vectors'], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname }).trim();
    const [first, second] = [run(), run()];
    expect(first).toHaveLength(64);
    expect(second).toBe(first);
  }, 180000);

  it('reports the passage probe as NOT-RUN rather than PASS when no embedder is available', async () => {
    const dir = tmpdir();
    await buildStore({ dir, count: 64 });
    const row = only(await auditCorpusStores({ dir, embedder: null, sampleSize: 10 }));
    expect(row.passageProbe.state).toBe('NOT-RUN');
    expect(row.passageProbe.reason).toMatch(/embedder/i);
    expect(row.state).toBe('PASS-SMALL-STORE');
  });
});
