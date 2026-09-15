// tests/unit/updater-manifest.test.mjs
//
// Every shipped repository store must carry a complete updater entry, and a backfill must never let a
// migration masquerade as a build. Measured 2026-09-15: a full local build reached bundle assembly and
// was refused because 100 of 194 repository stores — all inherited unchanged from the pinned bootstrap
// seed, none refreshed that run — had no entry at all.
//
// Conditions from the Dual ruling (decision A, verifier APPROVE_WITH_REQUIRED_IMPLEMENTATION_CONDITIONS)
// are each a case here: original timestamps preserved, no fabricated producer, content and metadata
// origin recorded separately, artifacts verified against the ledger before synthesis, and idempotence.
import { describe, expect, it, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyStore, normalizeUpdaterManifest, UPDATER_MANIFEST_VERSION } from '../../scripts/updater-manifest.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ORIGINAL_BUILT = '2026-08-01T00:00:00.000Z';

function fixture({ withEntries = [], stores = ['alpha', 'beta', 'ruv-gists', 'concepts'], corruptLedgerFor = null, entryOverrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-manifest-'));
  dirs.push(dir);
  const ledger = { stores: {} };
  for (const store of stores) {
    const bytes = Buffer.from(`rvf-bytes-for-${store}`);
    fs.writeFileSync(path.join(dir, `${store}.big.rvf`), bytes);
    ledger.stores[store] = {
      file: `${store}.big.rvf`,
      sha256: store === corruptLedgerFor ? 'f'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      sourceCommit: 'a'.repeat(40),
      builtUtc: ORIGINAL_BUILT,
    };
  }
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify(ledger, null, 2));
  fs.writeFileSync(path.join(dir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [{ store: 'concepts' }] }));
  const entries = {};
  for (const store of withEntries) {
    entries[store] = { kbName: store, sourceRepo: `https://github.com/ruvnet/${store}`, sourceCommit: 'b'.repeat(40), builtUtc: '2026-07-01T00:00:00.000Z', builder: 'rvf-kb-forge', selfUpdate: `node forge-update.mjs ${store}`, ...(entryOverrides[store] || {}) };
  }
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', canonicalManifestUrl: 'https://example.invalid/latest', stores: entries }, null, 2));
  const coverage = { rows: stores.map((s) => ({ url: `https://github.com/ruvnet/${s}`, artifact: { store: s } })) };
  return { dir, coverage };
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8'));

describe('classification decides which stores require an entry', () => {
  it('treats the gist aggregate and registered derived stores as not requiring one', () => {
    const derived = new Set(['concepts']);
    expect(classifyStore('ruv-gists', derived)).toBe('gist-aggregate');
    expect(classifyStore('concepts', derived)).toBe('derived');
    expect(classifyStore('2bottalk', derived)).toBe('repository');
  });
});

describe('backfilling inherited stores', () => {
  it('gives every repository store an entry, and leaves aggregates and derived stores alone', () => {
    const { dir, coverage } = fixture({ withEntries: ['alpha'] });
    const summary = normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: ['alpha'] });
    expect(summary.classification).toEqual({ repository: 2, 'gist-aggregate': 1, derived: 1 });
    expect(summary.requiredRepositoryStores).toBe(2);
    expect(summary.backfilled).toEqual(['beta']);
    expect(summary.missing).toEqual([]);
    const out = read(dir);
    expect(Object.keys(out.stores).sort()).toEqual(['alpha', 'beta']);
  });

  it('preserves the ORIGINAL build time and never invents a producer or describe string', () => {
    const { dir, coverage } = fixture();
    normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: [] });
    const beta = read(dir).stores.beta;
    expect(beta.builtUtc).toBe(ORIGINAL_BUILT); // never the migration time
    expect(beta.builder).toBeNull(); // the ledger evidenced none: explicit unknown, not "rvf-kb-forge"
    expect(beta.sourceDescribe).toBeNull(); // never reconstructed
    expect(beta.selfUpdate).toBe('node forge-update.mjs beta');
    expect(beta.canonicalManifestUrl).toBeNull(); // top-level discovery supplies the endpoint
  });

  it('records content origin and metadata origin SEPARATELY, for existing entries too', () => {
    const { dir, coverage } = fixture({ withEntries: ['alpha'] });
    normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: ['alpha'] });
    const out = read(dir);
    expect(out.stores.alpha).toMatchObject({ contentOrigin: 'built-this-generation', metadataOrigin: 'worker-produced' });
    expect(out.stores.beta).toMatchObject({ contentOrigin: 'inherited', metadataOrigin: 'backfilled-from-seed-ledger' });
    expect(out.stores.beta.migrationIdentity).toBe(UPDATER_MANIFEST_VERSION);
  });

  it('an inherited store that already had an entry is never relabelled as built this generation', () => {
    const { dir, coverage } = fixture({ withEntries: ['alpha'] });
    normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: [] }); // zero refreshes
    expect(read(dir).stores.alpha).toMatchObject({ contentOrigin: 'inherited', metadataOrigin: 'inherited-existing' });
  });

  it('binds inheritance evidence to the seed and the verified artifact', () => {
    const { dir, coverage } = fixture();
    normalizeUpdaterManifest({ assetsDir: dir, coverage, seedIdentity: { tag: 'v4.2.1-dev', sha256: 'c'.repeat(64) } });
    const e = read(dir).stores.beta.inheritanceEvidence;
    expect(e).toMatchObject({ seedTag: 'v4.2.1-dev', seedSha256: 'c'.repeat(64), builtUtc: ORIGINAL_BUILT, artifactBytes: Buffer.from('rvf-bytes-for-beta').length });
    expect(e.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(e.ledgerSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('MUST BLOCK: an artifact that does not match its ledger digest is reported, never backfilled', () => {
    // "Pinned does not automatically mean authenticated, and unrefreshed does not automatically mean
    // byte-identical." Such a store needs a real rebuild, not a synthesized row.
    const { dir, coverage } = fixture({ corruptLedgerFor: 'beta' });
    const summary = normalizeUpdaterManifest({ assetsDir: dir, coverage });
    expect(summary.backfilled).toEqual(['alpha']); // alpha verifies and is backfilled; beta must not be
    expect(summary.unverified).toEqual([{ store: 'beta', reason: expect.stringMatching(/ledger digest or size/) }]);
    expect(summary.missing).toEqual(['beta']);
    expect(read(dir).stores.beta).toBeUndefined();
  });

  it('MUST BLOCK: a store with no coverage row supplying an upstream URL is reported, never guessed', () => {
    const { dir } = fixture();
    const summary = normalizeUpdaterManifest({ assetsDir: dir, coverage: { rows: [] } });
    expect(summary.backfilled).toEqual([]);
    expect(summary.unverified.map((u) => u.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/upstream repository URL/)]));
  });

  it('preserves an explicit updateManaged:false policy', () => {
    const { dir, coverage } = fixture({ withEntries: ['alpha'], entryOverrides: { alpha: { updateManaged: false } } });
    normalizeUpdaterManifest({ assetsDir: dir, coverage });
    expect(read(dir).stores.alpha.updateManaged).toBe(false);
  });

  it('is idempotent: a second run over its own output changes nothing', () => {
    const { dir, coverage } = fixture({ withEntries: ['alpha'] });
    normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: ['alpha'] });
    const first = fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8');
    normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: ['alpha'] });
    expect(fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8')).toBe(first);
  });

  it('runs even when nothing was refreshed at all', () => {
    const { dir, coverage } = fixture();
    const summary = normalizeUpdaterManifest({ assetsDir: dir, coverage, refreshedStores: [] });
    expect(summary.backfilled.sort()).toEqual(['alpha', 'beta']);
    expect(summary.missing).toEqual([]);
  });
});
