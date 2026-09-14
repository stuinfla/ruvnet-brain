// tests/unit/forge-big-ingest-reconciliation.test.mjs — end-to-end proof, through the real CLI and
// a real RVF store, that `forge-big.mjs ingest` can no longer report success on a store that is
// missing a passage.
//
// THE INCIDENT. ruv-gists shipped for six weeks with 3,055 passages and 3,054 vectors. Passage id
// 2740 was present in the corpus and in the store's meta, had no vector, and was unretrievable:
// measured against the installed brain, idToLabel held 3,054 entries and nextLabel stood at 3,055.
// The build printed MATCH=true, exited 0, and cleaned its shards.
//
// These tests drive the actual command, not a stand-in: they write a corpus and hand-made vec
// shards into a tmpdir, run `node kb/forge-big.mjs ingest --dir <tmp> --name <n>` as a subprocess,
// and assert on the artifacts it leaves behind. No embedder is needed — ingest assembles vectors,
// it does not produce them — so this stays a fast unit-suite test while still exercising the real
// @ruvector/rvf create/ingest/index/persist path the shipped corpus goes through.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FORGE_BIG = path.resolve(import.meta.dirname, '../../kb/forge-big.mjs');
const DIM = 768;
const NAME = 'recon-fixture';

/** Deterministic unit-ish vector: a fixture must not vary run to run. */
function vectorFor(seed) {
  let x = (seed + 1) * 2654435761 % 4294967296;
  const v = new Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    x = (x * 1664525 + 1013904223) % 4294967296;
    const f = (x / 4294967296) * 2 - 1;
    v[i] = f; norm += f * f;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

/**
 * Stage a corpus plus one vec shard.
 * `omitVectorFor` reproduces the defect: the passage exists, its vector never made it into a shard.
 * `corruptPassageLine` reproduces the silent-discard path at the head of it.
 */
function stage({ ids, omitVectorFor = null, corruptPassageLine = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-big-ingest-'));
  const passageLines = ids.map((id, i) => (
    corruptPassageLine === i
      ? `{"id":"${id}","text":"Jailbreak any LLM using MathPrompt"`  // truncated: no closing brace
      : JSON.stringify({ id, text: `passage ${id}`, path: `p/${id}.md`, title: `T${id}` })
  ));
  fs.writeFileSync(path.join(dir, `${NAME}.passages.jsonl`), passageLines.join('\n') + '\n');

  const shardFile = path.join(dir, `${NAME}.big.vecs.0-1.jsonl`);
  const vecLines = ids
    .filter((id) => id !== omitVectorFor)
    .map((id, i) => JSON.stringify({ id, v: vectorFor(i) }));
  fs.writeFileSync(shardFile, vecLines.join('\n') + '\n');
  return { dir, shardFile, rvf: path.join(dir, `${NAME}.big.rvf`) };
}

function ingest(dir) {
  const r = spawnSync(process.execPath, [FORGE_BIG, 'ingest', '--dir', dir, '--name', NAME],
    { encoding: 'utf8', timeout: 180_000 });
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('forge-big.mjs ingest — passages in == vectors out', () => {
  it('builds the store and proves every passage id has a vector', () => {
    const ids = ['2739', '2740', '2741', '2742'];
    const { dir, shardFile, rvf } = stage({ ids });

    const run = ingest(dir);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('OK=true');
    expect(run.out).toContain(`every one of ${ids.length} passage ids has a vector`);

    // The artifact itself agrees — this is the exact structure the defect was visible in.
    const idmap = JSON.parse(fs.readFileSync(`${rvf}.idmap.json`, 'utf8'));
    expect(Object.keys(idmap.idToLabel).sort()).toEqual([...ids].sort());
    expect(Object.keys(idmap.idToLabel)).toHaveLength(ids.length);
    expect(fs.existsSync(`${rvf}.embed.json`)).toBe(true);
    expect(fs.existsSync(shardFile), 'shards are cleaned only on success').toBe(false);
  }, 180_000);
});

describe('forge-big.mjs ingest — a store missing one vector is REJECTED by id', () => {
  it('fails loudly, names the missing passage id, and leaves no shippable store behind', () => {
    const ids = ['2739', '2740', '2741', '2742'];
    const { dir, shardFile, rvf } = stage({ ids, omitVectorFor: '2740' });

    const run = ingest(dir);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('MISSING VECTOR for 1 passage id(s): 2740');
    expect(run.out).toContain('RECONCILE FAILED');

    // Nothing that looks finished may survive: the six-week defect persisted precisely because a
    // complete-looking .big.rvf sat on disk next to a nonzero exit code nobody checked.
    expect(fs.existsSync(rvf), 'the unverified store must be removed').toBe(false);
    expect(fs.existsSync(`${rvf}.embed.json`), 'no query-side config for an unverified store').toBe(false);
    // ...while the expensive embedding work is kept, so a corrected re-ingest is cheap.
    expect(fs.existsSync(shardFile), 'vec shards must be retained on failure').toBe(true);
  }, 180_000);

  // THE REGRESSION TEST FOR THE SHIPPED DEFECT. Measured against main on 2026-09-14, this exact
  // fixture produced:
  //     [ingest] vectors=2 passages=2 accepted=2 rejected=0 dupes=0 MATCH=true
  //     [ingest] OK — wrote blind.big.rvf (+embed.json); ... shards cleaned.
  //     exit 0        idToLabel: 2739,2741   nextLabel: 3
  // — a corpus of THREE passages shipped as a store of two, with no signal anywhere. That is the
  // ruv-gists failure reproduced end to end: the corpus loses a row in readPassages(), the `embed`
  // mode loses the same row because it reads the same corpus through the same reader, and the count
  // check then compares two numbers that both came from the shortened read and agrees with itself.
  it('REGRESSION: a lost corpus row, plus the short shard that same loss produces, is caught', () => {
    const ids = ['2739', '2740', '2741'];
    const { dir, rvf } = stage({ ids, corruptPassageLine: 1, omitVectorFor: '2740' });

    const run = ingest(dir);
    expect(run.status, run.out).not.toBe(0);
    expect(run.out).toMatch(/malformed JSON line/);
    expect(run.out, 'a short store must never report a match').not.toContain('MATCH=true');
    expect(run.out).not.toContain('OK=true');
    expect(fs.existsSync(rvf), 'no store may ship from a corpus that lost a row').toBe(false);
  }, 180_000);

  it('rejects a vector that has no passage, too (the duplicate/orphan direction)', () => {
    const ids = ['a', 'b'];
    const { dir } = stage({ ids });
    const shardFile = path.join(dir, `${NAME}.big.vecs.0-1.jsonl`);
    fs.appendFileSync(shardFile, JSON.stringify({ id: 'ghost', v: vectorFor(99) }) + '\n');

    const run = ingest(dir);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('VECTOR WITHOUT PASSAGE');
    expect(run.out).toContain('ghost');
  }, 180_000);
});

describe('forge-big.mjs ingest — a malformed corpus line is never silently dropped', () => {
  it('fails with the file, the line number and the parse error instead of building a short store', () => {
    const ids = ['2739', '2740', '2741'];
    const { dir, rvf } = stage({ ids, corruptPassageLine: 1 });

    const run = ingest(dir);
    expect(run.status, run.out).not.toBe(0);
    expect(run.out).toMatch(/recon-fixture\.passages\.jsonl:2 — malformed JSON line/);
    expect(run.out).toContain('Refusing to silently drop a row');
    expect(fs.existsSync(rvf), 'no store may be built from a corpus that could not be fully read').toBe(false);
  }, 180_000);
});
