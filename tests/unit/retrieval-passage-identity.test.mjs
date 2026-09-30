// 4.3.37 preflight failed with "daa has no sealed independent query evidence" when the release first
// consumed a generation built by the CI corpus builder. That builder writes content-addressed passage
// ids ("chunk:<hash>"); the frozen fixture pinned passages by digest(row) over rows carrying ordinal ids
// ("2824"). Same path, title and text — different digest. These tests pin the fix: an id-independent
// identity through a committed, mechanically derived map, and a release sample drawn only from stores
// whose sealed passage still exists.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { resolveInstalledCanaryCitation } from '../../scripts/retrieval-canary.mjs';
import { CONTENT_MAP_FILE, loadContentMap, passageContentDigest, passageMatches } from '../../scripts/retrieval-passage-identity.mjs';
import { deriveContentMap, fixturePins } from '../../scripts/derive-passage-content-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
import { STORES, ordinalRow, chunkRow, contentMapFor, plan } from '../helpers/canary-plan-fixture.mjs';

describe('passageMatches: an id-independent identity that can only add acceptance for equal content', () => {
  const pinned = digest(ordinalRow('old-a'));
  const map = contentMapFor(['old-a']);
  it('accepts the exact digest, with or without a map', () => {
    expect(passageMatches(ordinalRow('old-a'), pinned, new Map())).toBe(true);
  });
  it('accepts the same passage under a content-addressed id ONLY when the map knows the pin', () => {
    expect(passageMatches(chunkRow('old-a'), pinned, map)).toBe(true);
    expect(passageMatches(chunkRow('old-a'), pinned, new Map())).toBe(false);
  });
  it('rejects changed text, changed title, and a different path, even with the map', () => {
    expect(passageMatches({ ...chunkRow('old-a'), text: `${chunkRow('old-a').text} edited` }, pinned, map)).toBe(false);
    expect(passageMatches({ ...chunkRow('old-a'), title: 'renamed' }, pinned, map)).toBe(false);
    expect(passageMatches({ ...chunkRow('old-a'), path: 'src/elsewhere.mjs' }, pinned, map)).toBe(false);
  });
  it('does not let one pin vouch for another store’s passage', () => {
    expect(passageMatches(chunkRow('old-b'), pinned, map)).toBe(false);
  });
});

describe('the release canary plan against a generation built with content-addressed ids', () => {
  const chunked = (_dir, store) => [chunkRow(store)];
  it('builds and validates when the content map covers the fixture (fails on the pre-fix code)', () => {
    const { built, notices } = plan(chunked, { contentMap: contentMapFor(STORES) });
    expect(built.denominator.legacySelectedStores).toEqual([...STORES].sort());
    expect(notices).toEqual([]);
  });
  it('cannot be sealed without the map: nothing resolves, so nothing is sampled', () => {
    expect(() => plan(chunked, { contentMap: new Map() })).toThrow();
  });
  it('samples only stores whose sealed passage still exists, names the rest, and stays valid', () => {
    const readPassages = (_dir, store) => (store === 'old-c'
      ? [{ ...chunkRow('old-c'), text: 'upstream rewrote this file after the fixture was sealed' }]
      : [chunkRow(store)]);
    const { built, notices } = plan(readPassages, { contentMap: contentMapFor(STORES) });
    expect(built.denominator.legacySelectedStores).toEqual(['old-a', 'old-b', 'old-d']);
    expect(built.denominator.legacyPopulationStores).toEqual([...STORES].sort()); // population is still coverage-derived
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/1 of 4 fixture store\(s\) excluded.*old-c/);
  });
});

describe('resolveInstalledCanaryCitation on an installed content-addressed store', () => {
  const install = (store) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-id-')));
    fs.writeFileSync(path.join(dir, `${store}.passages.jsonl`), `${JSON.stringify(chunkRow(store))}\n`);
    return dir;
  };
  const call = (dir, store, contentMap) => resolveInstalledCanaryCitation({ kbDir: dir, contentMap,
    matched: { repo: store, path: ordinalRow(store).path, text: chunkRow(store).text },
    expected: { repo: store, path: ordinalRow(store).path, passageSha256: digest(ordinalRow(store)) } });
  it('resolves with the map and reports the FIXTURE’s pin as the evidence', async () => {
    const result = await call(install('old-a'), 'old-a', contentMapFor(['old-a']));
    expect(result.resolved).toBe(true);
    expect(result.evidence.passageSha256).toBe(digest(ordinalRow('old-a')));
  });
  it('does not resolve without the map', async () => {
    expect((await call(install('old-b'), 'old-b', new Map())).resolved).toBe(false);
  });
});

describe('the committed content map is derived from, and bound to, the frozen fixture', () => {
  const fixtureFile = path.join(ROOT, 'data', 'retrieval-query-evidence.json');
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const committed = JSON.parse(fs.readFileSync(CONTENT_MAP_FILE, 'utf8'));
  it('names the exact fixture bytes it was derived for — editing the fixture forces re-deriving', () => {
    expect(committed.fixtureSha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(fixtureFile)).digest('hex'));
  });
  it('accounts for every pin the fixture holds: mapped, or listed unresolved with a reason', () => {
    const pins = new Set(fixturePins(fixture).map(({ pinned }) => pinned));
    const accounted = new Set([...Object.keys(committed.entries), ...committed.unresolved.map(({ pinned }) => pinned)]);
    expect([...pins].filter((pin) => !accounted.has(pin))).toEqual([]);
    expect(committed.unresolved.every(({ reason }) => typeof reason === 'string' && reason)).toBe(true);
    expect(loadContentMap().size).toBe(Object.keys(committed.entries).length);
  });
  it('derivation is deterministic and lists what it could not resolve instead of guessing', () => {
    const tiny = { queries: { 'old-a': { expected: { path: ordinalRow('old-a').path, passageSha256: digest(ordinalRow('old-a')) } },
      'old-b': { expected: { path: 'src/old-b.mjs', passageSha256: '0'.repeat(64) } } } };
    const derive = () => deriveContentMap({ fixture: tiny, fixtureSha256: 'f'.repeat(64), sourceTag: 'v0',
      archiveSha256: 'a'.repeat(64), readRows: (store) => [ordinalRow(store)] });
    const first = derive();
    expect(first).toEqual(derive());
    expect(first.entries).toEqual({ [digest(ordinalRow('old-a'))]: passageContentDigest(ordinalRow('old-a')) });
    expect(first.unresolved).toEqual([expect.objectContaining({ store: 'old-b', reason: '0 matching rows' })]);
  });
});
