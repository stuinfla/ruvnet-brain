import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, cardsAt, darkStores, explain, storeRoot, storesAt } from '../../kb/store-root.mjs';

/**
 * ONE STORE ROOT, AND "DONE" MEANS REACHABLE.
 *
 * Measured 2026-08-13: seven expressions resolved the store root across 29 call sites, so the answer
 * to "where does the knowledge live?" depended on which file you asked. That produced the failure of
 * 2026-08-12 — three repos ingested, each printing `roundtrip 3/3 PASS` and "searchable now", none
 * findable by search. Ingest wrote one root; retrieval read another.
 *
 * The second half matters as much: the build proves a store is VALID and never proves it is
 * REACHABLE. 30 of 65 built stores have no capability card, so a by-description query cannot route
 * to them. Byte-verification is not delivery.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-root-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the store root has exactly one answer', () => {
  it('defaults to the retrieval path, because retrieval is the only consumer a user sees', () => {
    expect(storeRoot({}, '/home/x')).toBe(path.join('/home/x', '.cache', 'ruvnet-brain', 'kb'));
    expect(DEFAULT_ROOT('/home/x')).toBe(path.join('/home/x', '.cache', 'ruvnet-brain', 'kb'));
  });

  it('honours the overrides a fixture and a dev checkout need, in a stated precedence', () => {
    expect(storeRoot({ RUVNET_BRAIN_KB: '/a' })).toBe('/a');
    expect(storeRoot({ KB_DIR: '/b' })).toBe('/b');
    expect(storeRoot({ RUVNET_BRAIN_KB: '/a', KB_DIR: '/b' }), 'the more specific name wins').toBe('/a');
  });

  it('TEETH: NEVER falls back to process.cwd()', () => {
    // `KB_DIR || process.cwd()` is the sharpest form of the original defect: the same command
    // answered differently from two shells, so a write could land where nothing reads.
    const fromA = storeRoot({}, '/home/x');
    const fromB = storeRoot({}, '/home/x');
    expect(fromA).toBe(fromB);
    expect(fromA, 'the root must not contain the caller\'s working directory').not.toContain(process.cwd());
  });

  it('an empty or whitespace override is not an override', () => {
    // Otherwise `KB_DIR=""` silently redirects the whole brain to the filesystem root.
    expect(storeRoot({ RUVNET_BRAIN_KB: '   ' }, '/home/x')).toBe(DEFAULT_ROOT('/home/x'));
    expect(storeRoot({ KB_DIR: '' }, '/home/x')).toBe(DEFAULT_ROOT('/home/x'));
  });

  it('says WHY it chose a root, so two components can be compared instead of guessed about', () => {
    expect(explain({ KB_DIR: '/b' })).toMatchObject({ root: '/b', source: 'KB_DIR' });
    expect(explain({}, '/home/x')).toMatchObject({ source: 'default' });
  });
});

describe('a store is not done until it is REACHABLE', () => {
  const seed = (stores, cards) => {
    for (const s of stores) fs.writeFileSync(path.join(dir, `${s}.big.rvf`), 'x');
    if (cards) fs.writeFileSync(path.join(dir, 'capability-cards.md'), cards.map((c) => `## ${c}\nbody\n`).join('\n'));
  };

  it('counts stores regardless of the .rvf/.big.rvf suffix, without double-counting', () => {
    fs.writeFileSync(path.join(dir, 'alpha.big.rvf'), 'x');
    fs.writeFileSync(path.join(dir, 'alpha.rvf'), 'x');
    fs.writeFileSync(path.join(dir, 'beta.rvf'), 'x');
    expect(storesAt(dir)).toEqual(['alpha', 'beta']);
  });

  it('TEETH: a built store with no card is DARK, and named', () => {
    // The acceptance question the build never asked. All three of 2026-08-12's ingests passed their
    // own corpus QA and were invisible to search, because nothing checked routability.
    seed(['alpha', 'beta', 'gamma'], ['alpha']);
    expect(darkStores(dir)).toEqual(['beta', 'gamma']);
    expect(cardsAt(dir)).toEqual(['alpha']);
  });

  it('a fully carded root has no dark stores', () => {
    seed(['alpha', 'beta'], ['alpha', 'beta']);
    expect(darkStores(dir)).toEqual([]);
  });

  it('a missing cards file makes EVERY store dark — never zero', () => {
    // Silence here would read as "all reachable", which is the empty-corpus lie on another surface.
    seed(['alpha', 'beta'], null);
    expect(darkStores(dir)).toEqual(['alpha', 'beta']);
  });

  it('an absent root is empty, not a crash', () => {
    expect(storesAt(path.join(dir, 'nope'))).toEqual([]);
    expect(darkStores(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('the resolver is actually adopted, not merely available', () => {
  it('TEETH: no shipped retrieval path still resolves the root from process.cwd()', () => {
    // This is the one that made an ingest write where nothing reads. A module that offers the right
    // answer while callers keep their own is the disease, not the cure.
    const forge = fs.readFileSync(path.join(ROOT, 'kb', 'forge-mcp-all.mjs'), 'utf8');
    const code = forge.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code, 'the retriever must not fall back to the caller\'s working directory')
      .not.toMatch(/KB_DIR\s*\|\|\s*process\.cwd\(\)/);
  });
});
