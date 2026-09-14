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
import { afterEach, beforeEach, expect, it } from 'vitest';
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
