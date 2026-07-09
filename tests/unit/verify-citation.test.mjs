// tests/unit/verify-citation.test.mjs — this module is the line between "the brain answered" and
// "the brain answered FROM SOURCE". Everything downstream (--doctor's green light, the eval gate)
// trusts its verdict, so its rejections matter more than its acceptances: a gate that only ever
// says yes is decoration. Tests run against a real temp KB, no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCitations, passagesFilesFor, citationResolves, verifyGrounding } from '../../kb/verify-citation.mjs';

// Exactly the shape forge-ask-all.mjs prints. Note `path :` carries a `<repo>/` prefix that the
// stored passage does NOT have — getting that wrong makes every citation look fabricated.
const READER_OUT = `=== RuvNet Brain (cross-repo) — "how do I store embeddings?" ===
repos searched: concepts, ruvector  |  pooled candidates: 240

#1  repo=concepts  ce=0.201  vec=0.8686  kind=doc
path : concepts/ruvector/CARD/ruvector-card
title: ruvector — Capability
chars: 614 | chunks: 1
----- full document -----
ruvector — RuvNet's vector database…
===================================================================
#2  repo=ruvector  ce=0.150  vec=0.7000  kind=code
path : ruvector/crates/rvf/src/lib.rs
title: rvf lib
`;

let kb;
const writeStore = (repo, paths, { big = false } = {}) => {
  const file = path.join(kb, `${repo}${big ? '.big' : ''}.passages.jsonl`);
  fs.writeFileSync(file, paths.map((p, i) => JSON.stringify({ id: i, text: 'x', path: p, title: 't' })).join('\n') + '\n');
};

beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-test-')); });
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }); });

describe('parseCitations — read the reader’s own output', () => {
  it('extracts every hit with rank, repo, scores and title', () => {
    const c = parseCitations(READER_OUT);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ rank: 1, repo: 'concepts', kind: 'doc', ce: 0.201, vec: 0.8686, title: 'ruvector — Capability' });
    expect(c[1]).toMatchObject({ rank: 2, repo: 'ruvector', kind: 'code' });
  });
  it('strips the `<repo>/` prefix the reader prints, since the store does not have it', () => {
    const [first] = parseCitations(READER_OUT);
    expect(first.fullPath).toBe('concepts/ruvector/CARD/ruvector-card');
    expect(first.docPath).toBe('ruvector/CARD/ruvector-card');
  });
  it('returns [] for prose with no citations — the hallucination case', () => {
    expect(parseCitations('Just use RVF, it needs no server.')).toEqual([]);
    expect(parseCitations('')).toEqual([]);
    expect(parseCitations(undefined)).toEqual([]);
  });
});

describe('passagesFilesFor — find a repo’s stores', () => {
  it('returns nothing when the repo was never indexed', () => {
    expect(passagesFilesFor('pineconedb', kb)).toEqual([]);
  });
  it('finds both the slim store and the deep `.big` store when present', () => {
    writeStore('concepts', ['a/b']);
    writeStore('concepts', ['c/d'], { big: true });
    expect(passagesFilesFor('concepts', kb).map((p) => path.basename(p)))
      .toEqual(['concepts.passages.jsonl', 'concepts.big.passages.jsonl']);
  });
});

describe('citationResolves — does the cited passage exist on disk?', () => {
  it('resolves an exact path match and reports which file proved it', async () => {
    writeStore('concepts', ['ruvector/CARD/ruvector-card']);
    const r = await citationResolves({ repo: 'concepts', docPath: 'ruvector/CARD/ruvector-card' }, kb);
    expect(r).toMatchObject({ resolved: true, file: 'concepts.passages.jsonl' });
  });
  it('resolves a chunked passage, whose stored path carries a `#N` suffix', async () => {
    writeStore('agentdb', ['agentdb/L2/core-concepts#0', 'agentdb/L2/core-concepts#1']);
    const r = await citationResolves({ repo: 'agentdb', docPath: 'agentdb/L2/core-concepts' }, kb);
    expect(r.resolved).toBe(true);
    expect(r.storedPath).toBe('agentdb/L2/core-concepts#0');
  });
  it('falls through to the `.big` store when the slim one lacks the passage', async () => {
    writeStore('ruvector', ['README.md']);
    writeStore('ruvector', ['crates/rvf/src/lib.rs'], { big: true });
    const r = await citationResolves({ repo: 'ruvector', docPath: 'crates/rvf/src/lib.rs' }, kb);
    expect(r).toMatchObject({ resolved: true, file: 'ruvector.big.passages.jsonl' });
  });
  it('REJECTS a fabricated path inside a real repo', async () => {
    writeStore('concepts', ['ruvector/CARD/ruvector-card']);
    const r = await citationResolves({ repo: 'concepts', docPath: 'totally/made/up' }, kb);
    expect(r).toMatchObject({ resolved: false, reason: 'path-not-in-store' });
  });
  it('REJECTS a repo that was never indexed', async () => {
    const r = await citationResolves({ repo: 'pineconedb', docPath: 'README.md' }, kb);
    expect(r).toMatchObject({ resolved: false, reason: 'no-store' });
  });
  it('does not treat a path PREFIX as a match (a/b must not satisfy a/bc)', async () => {
    writeStore('r', ['a/bc']);
    expect((await citationResolves({ repo: 'r', docPath: 'a/b' }, kb)).resolved).toBe(false);
  });
  it('skips malformed JSON lines instead of throwing', async () => {
    fs.writeFileSync(path.join(kb, 'r.passages.jsonl'), `{not json\n\n${JSON.stringify({ path: 'a/b' })}\n`);
    expect((await citationResolves({ repo: 'r', docPath: 'a/b' }, kb)).resolved).toBe(true);
  });
});

describe('verifyGrounding — the gate', () => {
  it('grounds when a citation resolves, and hands back a printable receipt', async () => {
    writeStore('concepts', ['ruvector/CARD/ruvector-card']);
    const v = await verifyGrounding(READER_OUT, kb);
    expect(v.grounded).toBe(true);
    expect(v.receipt).toMatchObject({
      repo: 'concepts',
      path: 'concepts/ruvector/CARD/ruvector-card',
      file: 'concepts.passages.jsonl',
    });
  });
  it('accepts a lower-ranked citation when the top hit does not resolve', async () => {
    writeStore('ruvector', ['crates/rvf/src/lib.rs']); // only hit #2 is real
    const v = await verifyGrounding(READER_OUT, kb);
    expect(v.grounded).toBe(true);
    expect(v.receipt.repo).toBe('ruvector');
  });
  it('REJECTS confident prose with no citations — the keyword check used to pass this', async () => {
    const v = await verifyGrounding('Use RVF: a single-file HNSW vector store, no server needed.', kb);
    expect(v).toMatchObject({ grounded: false, reason: 'no-citations', receipt: null });
  });
  it('REJECTS an answer whose every citation is fabricated', async () => {
    writeStore('concepts', ['some/other/doc']);
    const v = await verifyGrounding(READER_OUT, kb);
    expect(v).toMatchObject({ grounded: false, reason: 'citations-do-not-resolve' });
    expect(v.citations).toHaveLength(2); // it saw the claims; it just did not believe them
  });
});
