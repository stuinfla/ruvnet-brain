// tests/unit/project-store-views.test.mjs — Step 5 (2026-09-13): projectStoreViews is the pure
// function that generates SOURCE.json, the runtime/public generation ledger, and the manifest's
// per-repo rows ONCE from one explicit list of selected records and the explicit release identity
// (algorithm step 6). These tests isolate the three properties DELETE named specifically:
//   - step 5: `updaterConfig` is read as an explicit adapter (specific non-identity fields borrowed
//     per store), never a checkout `SOURCE.stores` copy trusted wholesale for identity.
//   - step 7: `builtFromSha` is derived directly from the selected generation, never from an
//     external "prior manifest" lookup.
//   - concepts/ruv-gists are ledger-only (never SOURCE.json rows or manifest entries), replacing the
//     old ad hoc hasConcepts/hasGists special-casing with one KIND-driven rule.
import { describe, expect, it } from 'vitest';
import { projectStoreViews } from '../../scripts/build-bundle.mjs';

const generation = (overrides = {}) => ({
  file: 'alpha.big.rvf', sha256: 'a'.repeat(64), bytes: 100, model: 'fixture-model', dimensions: 3,
  sourceCommit: 'b'.repeat(40), builtUtc: '2026-09-13T00:00:00.000Z', ...overrides,
});
const IDENTITY = { version: '1.2.3-fixture', sourceSnapshot: 'c'.repeat(40) };

describe('projectStoreViews', () => {
  it('rejects a missing or non-string version, and a malformed source snapshot', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: generation() }];
    expect(() => projectStoreViews({ selectedResults, identity: {}, updaterConfig: {} }))
      .toThrow('explicit release version');
    expect(() => projectStoreViews({ selectedResults, identity: { version: '1.0.0', sourceSnapshot: 'not-hex' }, updaterConfig: {} }))
      .toThrow('40-hex');
  });

  it('tolerates a null source snapshot (optional enrichment, not required for the base ledger)', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: generation() }];
    const { ledger } = projectStoreViews({ selectedResults, identity: { version: '1.0.0' }, updaterConfig: {} });
    expect(ledger.sourceSnapshot).toBeNull();
  });

  it('step 7: builtFromSha is derived from the selected generation, never a second, external lookup', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: generation({ sourceCommit: 'd'.repeat(40) }) }];
    // No priorSha-shaped input exists in this function's signature at all — the only source of
    // truth it can possibly draw builtFromSha from is the generation record itself.
    const { manifestEntries } = projectStoreViews({ selectedResults, identity: IDENTITY, updaterConfig: { stores: { alpha: { sourceCommit: 'e'.repeat(40) } } } });
    expect(manifestEntries[0].builtFromSha).toBe('d'.repeat(40));
    expect(manifestEntries[0].builtFromSha).not.toBe('e'.repeat(40));
  });

  it('falls back to the literal "unknown" only when the generation itself carries no sourceCommit', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: generation({ sourceCommit: null }) }];
    const { manifestEntries } = projectStoreViews({ selectedResults, identity: IDENTITY, updaterConfig: {} });
    expect(manifestEntries[0].builtFromSha).toBe('unknown');
  });

  it('step 5: updaterConfig is an explicit adapter — non-identity fields are borrowed, but sourceCommit/builtUtc always come from the generation', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: generation({ sourceCommit: 'd'.repeat(40), builtUtc: '2026-09-13T01:00:00.000Z' }) }];
    const updaterConfig = { builder: 'rvf-kb-forge', stores: { alpha: {
      kbName: 'alpha', sourceRepo: 'https://github.com/ruvnet/alpha', sourceDescribe: 'v1.0-2-gdeadbee',
      builder: 'rvf-kb-forge', canonicalManifestUrl: 'https://example.invalid/manifest.json',
      canonicalBundleUrl: 'https://example.invalid/bundle.zip', selfUpdate: 'node forge-update.mjs alpha',
      // Deliberately WRONG identity fields an updaterConfig might carry from a stale round --
      // must never leak into the projected SOURCE.json.
      sourceCommit: 'f'.repeat(40), builtUtc: '2020-01-01T00:00:00.000Z',
    } } };
    const { source } = projectStoreViews({ selectedResults, identity: IDENTITY, updaterConfig });
    expect(source.stores.alpha).toMatchObject({
      kbName: 'alpha', sourceRepo: 'https://github.com/ruvnet/alpha', sourceDescribe: 'v1.0-2-gdeadbee',
      canonicalManifestUrl: 'https://example.invalid/manifest.json',
      canonicalBundleUrl: 'https://example.invalid/bundle.zip',
    });
    expect(source.stores.alpha.sourceCommit).toBe('d'.repeat(40));
    expect(source.stores.alpha.builtUtc).toBe('2026-09-13T01:00:00.000Z');
  });

  it('never copies updaterConfig.stores wholesale — a store absent from selectedResults never appears in SOURCE.json', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: generation() }];
    const updaterConfig = { stores: { alpha: {}, ghost: { kbName: 'ghost', sourceCommit: 'a'.repeat(40) } } };
    const { source } = projectStoreViews({ selectedResults, identity: IDENTITY, updaterConfig });
    expect(Object.keys(source.stores)).toEqual(['alpha']);
  });

  it('concepts/ruv-gists (non-repository kinds) are ledger-only: never a SOURCE.json row, never a manifest entry', () => {
    const selectedResults = [
      { name: 'alpha', kind: 'repository', tier: 'core', stars: 1, chunks: 1, baseModel: 'm', baseDims: 3,
        hasSymbols: false, hasPrimer: false, gradeRealUse: null, generation: generation() },
      { name: 'ruv-gists', kind: 'gist-aggregate', tier: '?', stars: null, chunks: 5, baseModel: 'm', baseDims: 3,
        hasSymbols: false, hasPrimer: false, gradeRealUse: null, generation: generation({ file: 'ruv-gists.big.rvf', sourceCommit: null }) },
      { name: 'concepts', kind: 'derived', tier: '?', stars: null, chunks: 9, baseModel: 'm', baseDims: 3,
        hasSymbols: false, hasPrimer: false, gradeRealUse: null, generation: generation({ file: 'concepts.big.rvf' }) },
    ];
    const { source, ledger, manifestEntries } = projectStoreViews({ selectedResults, identity: IDENTITY, updaterConfig: {} });
    expect(Object.keys(source.stores)).toEqual(['alpha']);
    expect(manifestEntries.map((e) => e.name)).toEqual(['alpha']);
    expect(Object.keys(ledger.stores).sort()).toEqual(['alpha', 'concepts', 'ruv-gists']);
  });

  it('rejects a selected record with no generation to project, rather than silently omitting it', () => {
    const selectedResults = [{ name: 'alpha', kind: 'repository', tier: 'core', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 3, hasSymbols: false, hasPrimer: false, gradeRealUse: null,
      generation: null }];
    expect(() => projectStoreViews({ selectedResults, identity: IDENTITY, updaterConfig: {} }))
      .toThrow('no generation to project');
  });
});
