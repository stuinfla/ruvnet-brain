// tests/unit/forge-big-sharding.test.mjs — kb/forge-big.mjs's shard math is the part of the
// large-repo ingest path most likely to silently drop or duplicate passages, and until 2026-09-14
// neither it, nor cosine(), nor the reader that feeds them had ever been tested.
//
// This file was a gap skeleton. It named three prerequisites — export cosine(), extract the inline
// modulo filter into a named shardAssign(), and stop the module from firing its MODE dispatch as an
// import side effect — and predicted the failure that then actually shipped: ruv-gists went out with
// 3,055 passages and 3,054 vectors, passage id 2740 unretrievable for six weeks.
//
// The measured cause was not the shard math. It was two guards that were blind in the same
// direction (see kb/forge-big.mjs's header):
//   1. readPassages() dropped any unparseable line with `catch { /* skip */ }` — no count, no
//      warning, no error.
//   2. ingestStore()'s reconciliation compared vector count against a passage count produced by
//      that same lossy reader, so a dropped line lowered both sides and the check said MATCH=true.
// So the suites below cover the shard math the skeleton asked for AND the two guards that failed,
// including the specific arithmetic shape that let a short store report success.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cosine, shardAssign, readPassages, reconcileStoreIds, readStoredIds } from '../../kb/forge-big.mjs';

const FORGE_BIG = path.resolve(import.meta.dirname, '../../kb/forge-big.mjs');

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-big-${label}-`));
}

describe('forge-big.mjs — module is importable without doing any work', () => {
  // The skeleton's stated blocker: `if (MODE === 'embed') { await embedShard(...) }` ran at top
  // level, so importing the file parsed argv, demanded --dir/--name, exited 2, and could fire real
  // embedding or ingest work. Cross-process on purpose — an in-process import cannot observe the
  // usage exit, and a guard that is only checked in the same process that already imported the
  // module proves nothing about a fresh one.
  it('a bare import exits 0 and neither parses argv nor prints the CLI banner', () => {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(FORGE_BIG)}); console.log('IMPORT_OK');`],
    { encoding: 'utf8', timeout: 60_000 });
    expect(probe.status, `stdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`).toBe(0);
    expect(probe.stdout).toContain('IMPORT_OK');
    expect(probe.stdout).not.toContain('[big] process priority');
    expect(probe.stderr).not.toContain('Usage: forge-big.mjs');
  });

  it('still dispatches, and still rejects a missing --dir/--name, when executed directly', () => {
    const cli = spawnSync(process.execPath, [FORGE_BIG, 'ingest'], { encoding: 'utf8', timeout: 60_000 });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('Usage: forge-big.mjs');
  });
});

describe('forge-big.mjs — cosine()', () => {
  it('returns 1 for two identical unit vectors', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12);
    const u = [0.6, 0.8];
    expect(cosine(u, u)).toBeCloseTo(1, 12);
  });

  it('returns 0 for two orthogonal vectors ([1,0], [0,1])', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it('returns -1 for opposed unit vectors, and the exact dot product otherwise', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    // Bound the MAGNITUDE, not just the sign: 1*4 + 2*5 + 3*6 = 32.
    expect(cosine([1, 2, 3], [4, 5, 6])).toBeCloseTo(32, 12);
    // On unit vectors the dot product IS the cosine — 45 degrees apart.
    expect(cosine([1, 0], [Math.SQRT1_2, Math.SQRT1_2])).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('forge-big.mjs — shardAssign()', () => {
  const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `t${i}` }));

  it('every row is assigned to EXACTLY ONE shard across shard 0..N-1 (no drops, no dupes)', () => {
    for (const nRows of [0, 1, 2, 3, 7, 8, 9, 31, 64, 100]) {
      for (const nShards of [1, 2, 3, 5, 8, 16, 101]) {
        const rows = rowsOf(nRows);
        const union = [];
        for (let s = 0; s < nShards; s++) union.push(...shardAssign(rows, s, nShards));
        const ids = union.map((r) => r.id);
        expect(new Set(ids).size, `duplicate rows at nRows=${nRows} nShards=${nShards}`).toBe(ids.length);
        expect(ids.length, `row count changed at nRows=${nRows} nShards=${nShards}`).toBe(nRows);
        expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.id)));
      }
    }
  });

  it('is deterministic — the same row always lands in the same shard for a given N', () => {
    const rows = rowsOf(50);
    for (const nShards of [1, 3, 7]) {
      for (let s = 0; s < nShards; s++) {
        const a = shardAssign(rows, s, nShards).map((r) => r.id);
        const b = shardAssign(rows, s, nShards).map((r) => r.id);
        expect(a).toEqual(b);
        // and the assignment is exactly index % nShards, not merely stable
        expect(a).toEqual(rows.filter((_, i) => i % nShards === s).map((r) => r.id));
      }
    }
  });

  it('with N=1, every row goes to shard 0 (the --smoke / single-process "both" mode)', () => {
    const rows = rowsOf(12);
    expect(shardAssign(rows, 0, 1)).toHaveLength(12);
    expect(shardAssign(rows, 0, 1).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('with N greater than the row count, the surplus shards are empty and nothing is lost', () => {
    const rows = rowsOf(3);
    const sizes = [];
    for (let s = 0; s < 10; s++) sizes.push(shardAssign(rows, s, 10).length);
    expect(sizes).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('refuses an out-of-range or non-integer shard index rather than silently returning nothing', () => {
    const rows = rowsOf(4);
    expect(() => shardAssign(rows, 2, 2)).toThrow(/shardIdx/);
    expect(() => shardAssign(rows, -1, 2)).toThrow(/shardIdx/);
    expect(() => shardAssign(rows, 0, 0)).toThrow(/nShards/);
    expect(() => shardAssign(rows, 0.5, 2)).toThrow(/shardIdx/);
    expect(() => shardAssign('not rows', 0, 1)).toThrow(/rows/);
  });
});

describe('forge-big.mjs — readPassages() must never drop a line in silence', () => {
  const write = (dir, name, lines) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };

  it('reads every well-formed row, ignoring blank lines', async () => {
    const dir = tmpdir('read-ok');
    const file = write(dir, 'a.jsonl', ['{"id":"1","text":"x"}', '', '{"id":"2","text":"y"}', '   ']);
    const rows = await readPassages(file);
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(rows.malformed).toEqual([]);
  });

  it('FAILS CLOSED on a malformed line, naming the file, the line number and the parse error', async () => {
    const dir = tmpdir('read-bad');
    const file = write(dir, 'a.jsonl', [
      '{"id":"2739","text":"ok"}',
      '{"id":"2740","text":"Jailbreak any LLM using MathPrompt"',   // truncated — no closing brace
      '{"id":"2741","text":"ok"}',
    ]);
    // This is the exact shape of the shipped defect: one unreadable row between two readable ones.
    // The predecessor returned [2739, 2741] and reported nothing at all.
    await expect(readPassages(file)).rejects.toThrow(/a\.jsonl:2 — malformed JSON line/);
    await expect(readPassages(file)).rejects.toThrow(/Refusing to silently drop a row/);
  });

  it('tolerates malformed lines ONLY on explicit opt-in, and still counts and reports them', async () => {
    const dir = tmpdir('read-tolerant');
    const file = write(dir, 'a.jsonl', ['{"id":"1"}', 'NOT JSON', '{"id":"3"}']);
    const seen = [];
    const rows = await readPassages(file, 0, { tolerateMalformed: true, onMalformed: (m) => seen.push(m) });
    expect(rows.map((r) => r.id)).toEqual(['1', '3']);
    expect(rows.malformed).toHaveLength(1);
    expect(rows.malformed[0].lineNo).toBe(2);
    expect(seen).toHaveLength(1);            // the count reaches the caller — tolerance is never silent
    expect(seen[0].error).toMatch(/JSON/i);
  });

  it('honours `limit` without reading or rejecting the rest of the file', async () => {
    const dir = tmpdir('read-limit');
    const file = write(dir, 'a.jsonl', ['{"id":"1"}', '{"id":"2"}', 'STILL NOT JSON']);
    const rows = await readPassages(file, 2);
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
  });
});

describe('forge-big.mjs — reconcileStoreIds() is the check that would have caught ruv-gists', () => {
  it('passes when every passage id has a vector', () => {
    const ids = ['a', 'b', 'c'];
    const r = reconcileStoreIds({ expectedIds: ids, storedIds: ids, totalVectors: 3, accepted: 3 });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('FAILS and names the exact missing id — the ruv-gists shape (3,055 passages, 3,054 vectors)', () => {
    const expectedIds = Array.from({ length: 3055 }, (_, i) => String(i));
    const storedIds = expectedIds.filter((id) => id !== '2740');
    const r = reconcileStoreIds({ expectedIds, storedIds, totalVectors: 3054, accepted: 3054 });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['2740']);
    expect(r.report).toContain('MISSING VECTOR for 1 passage id(s): 2740');
  });

  it('REGRESSION: fails even when the vector and accepted counts agree with each other', () => {
    // The shipped check was `status.totalVectors === totalPassages && accepted === totalPassages`
    // with totalPassages coming from the SAME lossy read that dropped the row — so every number it
    // compared was 3,054 and it printed MATCH=true. Reconciling by id makes that arithmetic
    // irrelevant: the corpus says 3 ids, the store holds 2, and the id set is the arbiter.
    const r = reconcileStoreIds({
      expectedIds: ['x', 'y', 'z'], storedIds: ['x', 'z'], totalVectors: 2, accepted: 2, rejected: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['y']);
  });

  it('flags a vector with no passage, a duplicated passage id, and any rejected vector', () => {
    const orphan = reconcileStoreIds({ expectedIds: ['a'], storedIds: ['a', 'ghost'], totalVectors: 2, accepted: 1 });
    expect(orphan.ok).toBe(false);
    expect(orphan.unexpected).toEqual(['ghost']);

    const dupe = reconcileStoreIds({ expectedIds: ['a', 'a', 'b'], storedIds: ['a', 'b'], totalVectors: 2, accepted: 2 });
    expect(dupe.ok).toBe(false);
    expect(dupe.duplicateExpected).toEqual(['a']);
    expect(dupe.report).toContain('DUPLICATE passage id');

    const rejected = reconcileStoreIds({ expectedIds: ['a'], storedIds: ['a'], totalVectors: 1, accepted: 1, rejected: 1 });
    expect(rejected.ok).toBe(false);
    expect(rejected.report).toContain('REJECTED 1 vector');
  });

  it('compares ids as strings, so a numeric passage id still matches its idmap key', () => {
    const r = reconcileStoreIds({ expectedIds: [2740, 2741], storedIds: ['2740', '2741'], totalVectors: 2, accepted: 2 });
    expect(r.ok).toBe(true);
  });
});

describe('forge-big.mjs — readStoredIds() reads the artifact, not a counter', () => {
  it('returns the idmap keys a reader will actually resolve', () => {
    const dir = tmpdir('idmap');
    const rvf = path.join(dir, 's.big.rvf');
    fs.writeFileSync(`${rvf}.idmap.json`, JSON.stringify({ idToLabel: { a: 0, b: 1 }, labelToId: {}, nextLabel: 2 }));
    expect(readStoredIds(rvf).sort()).toEqual(['a', 'b']);
  });

  it('refuses to report success when the idmap is missing or unusable', () => {
    const dir = tmpdir('idmap-bad');
    const rvf = path.join(dir, 's.big.rvf');
    expect(() => readStoredIds(rvf)).toThrow(/cannot prove the store contains every passage/);
    fs.writeFileSync(`${rvf}.idmap.json`, '{ not json');
    expect(() => readStoredIds(rvf)).toThrow(/unreadable/);
    fs.writeFileSync(`${rvf}.idmap.json`, JSON.stringify({ nextLabel: 2 }));
    expect(() => readStoredIds(rvf)).toThrow(/no idToLabel/);
  });
});
