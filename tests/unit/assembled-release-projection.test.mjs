// tests/unit/assembled-release-projection.test.mjs — Step 5 (2026-09-13): createReleaseProjection is
// now a PURE function of an already-sealed corpus coverage, an already-derived selected public
// generation ledger, and an already-computed public inventory (all three produced ONCE by
// scripts/build-bundle.mjs's assembleBundle -> projectStoreViews, in the SAME pass that assembles the
// archive). It never touches disk, never re-derives the ledger or the public store set from an assets
// directory, and never rewrites a row/status/reason/enumeration count from the sealed measurement it
// is handed — the opposite of what this file used to prove (a "scopes gist rows to the sealed seed
// receipt" test existed only because the OLD architecture let a live re-observation drift from the
// seed the corpus was actually sealed against; Step 4's real pruning makes that race structurally
// impossible now, so there is nothing left to scope or rewrite). bindAssembledReleaseProjection is
// now validation-only: it proves an already-fully-written assembled directory is internally
// consistent, and never repairs or rewrites anything itself.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindAssembledReleaseProjection, createReleaseProjection } from '../../scripts/release-projection.mjs';
import { validatePublicInventory } from '../../scripts/public-inventory.mjs';
import { getVersion } from '../../scripts/version.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
let assetsDir;
const version = getVersion();
const sourceSnapshot = 'd'.repeat(40);
const seedIdentity = { tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1,
  baselineReceiptSha256: 'f'.repeat(64) };

beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembled-projection-'));
  execFileSync(process.execPath, ['scripts/ci/build-fixture-kb.mjs', '--out', assetsDir],
    { cwd: ROOT, stdio: 'pipe' });
});
afterEach(() => fs.rmSync(assetsDir, { recursive: true, force: true }));

// The fixture's own COVERAGE.json/CORPUS-COVERAGE.json/PUBLIC-RVF-GENERATIONS.json/RVF-GENERATIONS.json
// were built by build-fixture-kb.mjs to satisfy the OLD validateCoverageDirectory contract directly.
// Deriving `selectedLedger`/`inventory` fresh from the fixture's own RVF-GENERATIONS.json +
// CORPUS-COVERAGE.json (rather than trusting its pre-baked COVERAGE.json/PUBLIC-RVF-GENERATIONS.json)
// exercises the REAL path assembleBundle takes: projectStoreViews derives the ledger once, and that
// SAME ledger (re-tagged as the public view) is what createReleaseProjection is handed.
function deriveInputsFromFixture() {
  const corpusCoverage = JSON.parse(fs.readFileSync(path.join(assetsDir, 'CORPUS-COVERAGE.json'), 'utf8'));
  const runtimeLedger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
  const selectedLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: version, releaseTag: `v${version}`, sourceSnapshot, stores: runtimeLedger.stores };
  const inventory = validatePublicInventory({ assetsDir, coverage: corpusCoverage, ledger: selectedLedger });
  return { corpusCoverage, selectedLedger, inventory };
}

function writeProjection(result) {
  fs.writeFileSync(path.join(assetsDir, 'COVERAGE.json'), `${JSON.stringify(result.releaseCoverage, null, 2)}\n`);
  fs.writeFileSync(path.join(assetsDir, 'CORPUS-COVERAGE.json'), result.corpusCoverageBytes);
  fs.writeFileSync(path.join(assetsDir, 'PUBLIC-RVF-GENERATIONS.json'), result.publicGenerationLedgerBytes);
}

it('produces a release coverage projection that validates end to end via bindAssembledReleaseProjection', () => {
  const { corpusCoverage, selectedLedger, inventory } = deriveInputsFromFixture();
  const result = createReleaseProjection({ corpusCoverage, selectedLedger,
    identity: { version, sourceSnapshot }, seedIdentity, inventory });
  writeProjection(result);
  const bound = bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot });
  expect(bound.valid).toBe(true);
});

it('rejects a projection whose selected ledger does not bind the exact release identity, and touches no disk', () => {
  const { corpusCoverage, selectedLedger, inventory } = deriveInputsFromFixture();
  const before = fs.readdirSync(assetsDir).sort();
  expect(() => createReleaseProjection({ corpusCoverage, selectedLedger,
    identity: { version, sourceSnapshot: 'e'.repeat(40) }, seedIdentity, inventory }))
    .toThrow('does not bind this release identity');
  // createReleaseProjection is pure -- a rejected call writes nothing, ever.
  expect(fs.readdirSync(assetsDir).sort()).toEqual(before);
});

it('bindAssembledReleaseProjection rejects a mismatched runtime ledger WITHOUT repairing it (validation-only)', () => {
  const { corpusCoverage, selectedLedger, inventory } = deriveInputsFromFixture();
  const result = createReleaseProjection({ corpusCoverage, selectedLedger,
    identity: { version, sourceSnapshot }, seedIdentity, inventory });
  writeProjection(result);
  // Simulate the base (non-projection) assembly's own ledger shape -- schema 1, no sourceSnapshot,
  // no `kind` -- the exact omission the OLD bindAssembledReleaseProjection used to silently repair by
  // overwriting RVF-GENERATIONS.json itself. The new one only proves it is wrong.
  const runtimeStores = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8')).stores;
  fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'),
    JSON.stringify({ schemaVersion: 1, brainVersion: version, releaseTag: `v${version}`, stores: runtimeStores }));
  const before = fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'));
  expect(() => bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot }))
    .toThrow(/runtime generation ledger release identity differs/);
  expect(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'))).toEqual(before);
});

it('rejects changed public bytes even when their release identity matches', () => {
  const { corpusCoverage, selectedLedger, inventory } = deriveInputsFromFixture();
  const result = createReleaseProjection({ corpusCoverage, selectedLedger,
    identity: { version, sourceSnapshot }, seedIdentity, inventory });
  writeProjection(result);
  fs.appendFileSync(path.join(assetsDir, 'fixture.big.rvf'), 'tampered');
  expect(() => bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot }))
    .toThrow('assembled release projection rejected');
});

// The direct, disk-free proof of algorithm step 9: release coverage is generated from the sealed
// corpus coverage WITHOUT changing a row, a status, a reason, the enumeration, or a per-gist version
// -- including a row that is NOT eligible/CURRENT, and a gist row, both of which the OLD
// createReleaseProjection would have filtered or rewritten depending on what happened to be present
// on disk at projection time.
it('carries rows, statuses, reasons, and enumeration through UNCHANGED from the sealed corpus coverage', () => {
  const rows = [
    { key: 'repo:alpha', kind: 'repository', name: 'alpha', url: 'https://github.com/ruvnet/alpha',
      status: 'CURRENT', disposition: 'eligible', upstream: {}, artifact: { store: 'alpha' }, reasons: [] },
    { key: 'repo:beta', kind: 'repository', name: 'beta', url: 'https://github.com/ruvnet/beta',
      status: 'INELIGIBLE', disposition: 'archived', upstream: {}, artifact: { store: 'beta' }, reasons: ['archived'] },
    { key: 'gist:abc', kind: 'gist', name: 'abc', url: 'https://gist.github.com/ruvnet/abc',
      status: 'CURRENT', disposition: 'eligible', upstream: { sha: 'x' }, artifact: { store: 'ruv-gists' }, reasons: [] },
  ];
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0,
    repositories: { expected: 2, pages: [] }, gists: { expected: 1, pages: [] } };
  const corpusCoverage = {
    schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet',
    observedAt: '2026-09-13T00:00:00.000Z', generatorSourceSha: 'a'.repeat(64), snapshotRoot: 'b'.repeat(64),
    sourceObservationSha256: 'c'.repeat(64), policy: { policyDispositionDigests: [], exemptionDigests: [] },
    coverageGeneration: 'fixed-generation-id-for-this-test',
    enumerationReceipt, rows,
    totals: { rows: 3, repositories: 2, gists: 1, byStatus: { CURRENT: 2, INELIGIBLE: 1 } },
  };
  const selectedLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: version, releaseTag: `v${version}`, sourceSnapshot,
    stores: { alpha: { file: 'alpha.big.rvf', sha256: 'd'.repeat(64), bytes: 10, model: 'fixture-model',
      dimensions: 8, sourceCommit: 'a'.repeat(40), builtUtc: '2026-09-13T00:00:00.000Z' } } };
  const inventory = { partitionSha256: 'e'.repeat(64) };

  const result = createReleaseProjection({ corpusCoverage, selectedLedger,
    identity: { version, sourceSnapshot }, seedIdentity, inventory });

  expect(result.releaseCoverage.rows).toBe(corpusCoverage.rows); // same reference: never re-derived
  expect(result.releaseCoverage.totals).toEqual(corpusCoverage.totals);
  expect(result.releaseCoverage.enumerationReceipt).toEqual(enumerationReceipt);
  expect(result.releaseCoverage.rows.find((r) => r.key === 'repo:beta').status).toBe('INELIGIBLE');
  expect(result.releaseCoverage.rows.find((r) => r.key === 'gist:abc').status).toBe('CURRENT');
  expect(JSON.parse(result.corpusCoverageBytes.toString())).toEqual(corpusCoverage);
});

// Restored (Step 5 remediation): a projection whose COVERAGE.json is edited after it was written is
// rejected by the activation-boundary reader — ledger rebinding is never a substitute for
// qualification. This case had been dropped from the first Step 5 commit.
it('rejects modified coverage instead of treating ledger rebinding as qualification', () => {
  const { corpusCoverage, selectedLedger, inventory } = deriveInputsFromFixture();
  const result = createReleaseProjection({ corpusCoverage, selectedLedger,
    identity: { version, sourceSnapshot }, seedIdentity, inventory });
  writeProjection(result);
  const file = path.join(assetsDir, 'COVERAGE.json');
  const coverage = JSON.parse(fs.readFileSync(file));
  coverage.releaseIdentity.version = '0.0.0-invalid';
  fs.writeFileSync(file, JSON.stringify(coverage));
  expect(() => bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot }))
    .toThrow('assembled release projection rejected');
});

// THE LIVE PRODUCTION CONDITION, kept as an explicit REJECTION (Step 5 remediation, 2026-09-13).
// Measured 2026-09-12: the observation moved 479 -> 492 gists while the sealed v4.2.1 seed still
// carried 479. The retired createReleaseProjection SCOPED that away (dropped the unseeded gists,
// stamped survivors CURRENT). Under the consolidated design there is nothing to scope: coverage is
// sealed against the exact corpus being assembled, so an observation that names gists the corpus's
// receipt does not carry is a DEFECT — assembleBundle refuses, the corpus returns to preparation.
// The positive control (same fixture, zero unseeded gists) proves the rejection is about the drift,
// not about the fixture. Uses the checkout's REAL, current schema-3 gist receipt (492 gists today),
// resealed around a fixture passages file with the same production sealing function.
describe('sealed gist receipt vs observed gists — rejection, never scoping', () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
  const realReceipt = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'kb', 'ruv-gists.sources.json'), 'utf8'));

  it('positive control: coverage naming exactly the sealed gist set assembles', async () => {
    const { assembleBundle } = await import('../../scripts/build-bundle.mjs');
    const fx = await import('../helpers/assemble-bundle-fixture.mjs');
    const runtimeRoot = fx.buildRuntimeRoot(dirs);
    const corpusDir = await fx.buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'ruv-gists'], gistReceipt: realReceipt() });
    const coverage = fx.writeCoverage(runtimeRoot, corpusDir);
    const sealedCount = Object.keys(JSON.parse(fs.readFileSync(path.join(corpusDir, 'ruv-gists.sources.json'), 'utf8')).gists).length;
    expect(coverage.totals.gists).toBe(sealedCount);
    const outDir = path.join(fx.tempDir(dirs, 'out'), 'ruvnet-brain');
    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: { version, sourceSnapshot } });
    expect(result.selectedStores.sort()).toEqual(['alpha', 'ruv-gists']);
  });

  it('REJECTS coverage that names gists the sealed receipt does not carry (the 492-observed vs 479-sealed shape)', async () => {
    const { assembleBundle } = await import('../../scripts/build-bundle.mjs');
    const fx = await import('../helpers/assemble-bundle-fixture.mjs');
    const runtimeRoot = fx.buildRuntimeRoot(dirs);
    const corpusDir = await fx.buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'ruv-gists'], gistReceipt: realReceipt() });
    const unseeded = Array.from({ length: 13 }, (_, i) => `${'f'.repeat(24)}${String(i).padStart(8, '0')}`);
    const coverage = fx.writeCoverage(runtimeRoot, corpusDir, { unseededGistIds: unseeded });
    const sealedCount = Object.keys(JSON.parse(fs.readFileSync(path.join(corpusDir, 'ruv-gists.sources.json'), 'utf8')).gists).length;
    expect(coverage.totals.gists).toBe(sealedCount + 13);
    const outDir = path.join(fx.tempDir(dirs, 'out'), 'ruvnet-brain');
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir, identity: { version, sourceSnapshot } }))
      .rejects.toThrow(/does not match its sealed coverage/);
    // Nothing was scoped, rewritten, or shipped.
    expect(fs.existsSync(`${outDir}.zip`)).toBe(false);
  });
});
