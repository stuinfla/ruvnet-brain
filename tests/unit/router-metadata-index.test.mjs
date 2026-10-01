// tests/unit/router-metadata-index.test.mjs — the router's metadata fallback (kb/forge-ask-all.mjs
// metadataSourceRoute) reads an in-process inverted index instead of re-parsing every <repo>.meta.json
// (82 MB on the 4.3.37 corpus, ~11-13 s cold) on each query. Pinned here:
//   - the counts are the per-entry definition's (max query-term overlap of one entry, >= 3 terms);
//   - a warm call re-reads no store file;
//   - an UPDATE never serves the old index: not after an in-place rewrite that keeps the file's
//     mtime and size, and not after the whole kb/ directory is swapped under the same path;
//   - the tie-break keeps up to METADATA_ROUTE_TIES stores tied at the best overlap, ordered by how
//     many of their entries reach it, name last.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { METADATA_ROUTE_TIES, kbBuildIdentity, metadataSourceRoute } from '../../kb/forge-ask-all.mjs';

const entry = (title, preview) => ({ title, preview });
const QUERY = 'keep embeddings searchable offline on a laptop without a database server';

function writeStores(dir, stores) {
  for (const [repo, entries] of Object.entries(stores)) {
    fs.writeFileSync(path.join(dir, `${repo}.meta.json`),
      JSON.stringify({ entries: Object.fromEntries(entries.map((e, i) => [`e${i}`, e])) }));
  }
}
function fixture(stores, { manifest = { generated: '2026-10-01T00:00:00.000Z' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-meta-'));
  writeStores(dir, stores);
  if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
// Same byte length, different content: the case (mtime, size) cannot tell apart.
function sameSizeJson(entries, size) {
  const raw = JSON.stringify({ entries: Object.fromEntries(entries.map((e, i) => [`e${i}`, e])) });
  if (raw.length > size) throw new Error('fixture too large');
  return raw.slice(0, -1) + ' '.repeat(size - raw.length) + '}';
}

afterEach(() => { vi.restoreAllMocks(); });

describe('router metadata index', () => {
  it('routes to the store whose single best entry covers the most query terms', () => {
    const dir = fixture({
      alpha: [entry('Offline embeddings', 'searchable laptop'), entry('unrelated', 'nothing here')],
      zeta: [entry('Server setup', 'database server laptop')],
    });
    expect(metadataSourceRoute(QUERY, dir, ['alpha', 'zeta']).repos).toEqual(['alpha']);
  });

  it('does not re-read any store file on a warm call', () => {
    const dir = fixture({ alpha: [entry('Offline embeddings', 'searchable laptop')], zeta: [entry('x', 'y')] });
    metadataSourceRoute(QUERY, dir, ['alpha', 'zeta']);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(metadataSourceRoute(QUERY, dir, ['alpha', 'zeta']).repos).toEqual(['alpha']);
    expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.meta.json'))).toEqual([]);
  });

  it('keeps two KB directories indexed at once, so alternating between them re-reads nothing', () => {
    const a = fixture({ alpha: [entry('Offline embeddings', 'searchable laptop')] });
    const b = fixture({ zeta: [entry('Offline embeddings', 'searchable laptop')] });
    metadataSourceRoute(QUERY, a, ['alpha']);
    metadataSourceRoute(QUERY, b, ['zeta']);
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 3; i++) {
      expect(metadataSourceRoute(QUERY, a, ['alpha']).repos).toEqual(['alpha']);
      expect(metadataSourceRoute(QUERY, b, ['zeta']).repos).toEqual(['zeta']);
    }
    expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.meta.json'))).toEqual([]);
  });

  it('drops the least recently used directory index beyond two directories', () => {
    const dirs = [1, 2, 3].map(() => fixture({ alpha: [entry('Offline embeddings', 'searchable laptop')] }));
    for (const dir of dirs) metadataSourceRoute(QUERY, dir, ['alpha']);
    const reads = vi.spyOn(fs, 'readFileSync');
    metadataSourceRoute(QUERY, dirs[0], ['alpha']);
    expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.meta.json')).length).toBe(1);
  });

  it('re-indexes a store that an update rewrote in place with the SAME mtime and size', () => {
    const dir = fixture({ alpha: [entry('Offline embeddings', 'searchable laptop')], zeta: [entry('x', 'y')] });
    const zeta = path.join(dir, 'zeta.meta.json');
    const size = 400;
    fs.writeFileSync(zeta, sameSizeJson([entry('nothing', 'relevant')], size));
    const pinned = new Date('2026-09-30T00:00:00Z');
    fs.utimesSync(zeta, pinned, pinned);
    expect(metadataSourceRoute(QUERY, dir, ['alpha', 'zeta']).repos).toEqual(['alpha']);
    // The update: new content, identical byte size and mtime, new build manifest.
    fs.writeFileSync(zeta, sameSizeJson([entry('Offline embeddings searchable', 'laptop database server')], size));
    fs.utimesSync(zeta, pinned, pinned);
    expect(fs.statSync(zeta).size).toBe(size);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generated: '2026-10-02T00:00:00.000Z' }));
    expect(metadataSourceRoute(QUERY, dir, ['alpha', 'zeta']).repos[0]).toBe('zeta');
  });

  it('serves the new build after the whole kb directory is swapped under the same path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-swap-'));
    const kb = path.join(root, 'kb');
    const size = 400;
    const pinned = new Date('2026-09-30T00:00:00Z');
    const build = (name, zetaEntries, generated) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      writeStores(dir, { alpha: [entry('Offline embeddings', 'searchable laptop')] });
      fs.writeFileSync(path.join(dir, 'zeta.meta.json'), sameSizeJson(zetaEntries, size));
      fs.utimesSync(path.join(dir, 'zeta.meta.json'), pinned, pinned);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generated }));
      return dir;
    };
    fs.renameSync(build('gen1', [entry('nothing', 'relevant')], 'g1'), kb);
    expect(metadataSourceRoute(QUERY, kb, ['alpha', 'zeta']).repos).toEqual(['alpha']);
    const next = build('gen2', [entry('Offline embeddings searchable', 'laptop database server')], 'g2');
    fs.renameSync(kb, path.join(root, 'kb.old'));
    fs.renameSync(next, kb);
    expect(metadataSourceRoute(QUERY, kb, ['alpha', 'zeta']).repos[0]).toBe('zeta');
  });

  it('derives the build identity from the manifest and changes it when the manifest is rewritten', () => {
    const dir = fixture({ alpha: [entry('a', 'b')] }, { manifest: { generated: 'g1', corpus: { generationTag: 't1' } } });
    const first = kbBuildIdentity(dir);
    expect(kbBuildIdentity(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generated: 'g2', corpus: { generationTag: 't1' } }));
    expect(kbBuildIdentity(dir)).not.toBe(first);
    const bare = fixture({ alpha: [entry('a', 'b')] }, { manifest: null });
    expect(kbBuildIdentity(bare)).toMatch(/no-manifest$/);
  });

  it('keeps up to METADATA_ROUTE_TIES stores tied at the best overlap, most top entries first, name last', () => {
    expect(METADATA_ROUTE_TIES).toBe(3);
    const tied = entry('Offline embeddings', 'searchable laptop');
    const dir = fixture({
      alpha: [tied], beta: [tied, tied], gamma: [tied, tied, tied], delta: [tied, tied],
      weaker: [entry('Offline', 'laptop searchable')],
    });
    // gamma (3 entries at the top overlap), then beta and delta (2 each, by name); alpha (1) is cut.
    expect(metadataSourceRoute(QUERY, dir, ['alpha', 'beta', 'delta', 'gamma', 'weaker']).repos)
      .toEqual(['gamma', 'beta', 'delta']);
  });

  it('never adds a store below the best overlap to fill the tie slots', () => {
    const dir = fixture({
      best: [entry('Offline embeddings searchable', 'laptop')],
      second: [entry('Offline embeddings', 'searchable'), entry('Offline embeddings', 'searchable')],
    });
    expect(metadataSourceRoute(QUERY, dir, ['best', 'second']).repos).toEqual(['best']);
  });

  it('declines when no store shares at least three terms, and skips unreadable stores', () => {
    const dir = fixture({ alpha: [entry('Offline', 'laptop')] });
    fs.writeFileSync(path.join(dir, 'broken.meta.json'), '{not json');
    expect(metadataSourceRoute(QUERY, dir, ['alpha', 'broken', 'missing'])).toBeNull();
  });
});
