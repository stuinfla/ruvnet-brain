#!/usr/bin/env node
// Build the release-bound coverage projection from an ALREADY-SEALED corpus coverage ledger and the
// exact selected generation ledger/inventory an assembly pass just computed.
//
// Step 5 of the corpus-seed/release pipeline consolidation (2026-09-13). Before this, the projection
// re-read `RVF-GENERATIONS.json` from an assets directory on its own, re-derived the public store set
// from disk, and — because the corpus coverage handed to it could have been observed at a DIFFERENT
// moment than the one the seed was actually sealed against — filtered rows to "seeded" ones and
// rewrote every surviving eligible row to `status: 'CURRENT'`. That entire class of drift is now
// impossible: `corpusCoverage` reaching this function is Step 4's own sealed measurement of the
// EXACT corpus directory being assembled (reconciliation only terminates once every eligible row is
// already CURRENT and artifact-bound against that same directory), so there is nothing left to
// reconcile here. `createReleaseProjection` is now a pure function: it never touches disk, never
// re-derives the ledger or the public store set, and never changes a row, a status, a reason, the
// enumeration, or a per-gist version — it only wraps the sealed measurement in a release identity.
// The caller (scripts/build-bundle.mjs's assembleBundle) is the ONE place that reads inputs from
// disk and the ONE place that writes the resulting files, exactly once, alongside everything else it
// assembles in the same pass.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_GENERATIONS_FILE, generationLedgerBytes, projectPublicGenerationLedger,
  releaseCoverageGenerationFor, validateCoverageDirectory } from '../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from './public-inventory.mjs';
import { readRvfGenerations } from './rvf-generation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

// Validation-only (Step 5 compatibility note): the assembled directory's RVF-GENERATIONS.json is now
// written exactly once, by assembleBundle -> projectStoreViews, already in its final, correctly-bound
// shape. There is nothing left for this function to derive or write — it only proves the finished
// assembly is internally consistent and bound to the exact release identity being published. Kept
// (rather than deleted and its callers repointed) because it is the one place every consumer already
// calls for this proof: scripts/build-bundle.mjs's assembleBundle, and the release-qualification test
// suite (tests/unit/assembled-release-projection.test.mjs).
export function bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot }) {
  const result = validateCoverageDirectory(assetsDir, {
    expectedVersion: version, expectedSourceSnapshot: sourceSnapshot, requireCompleteProfile: true,
  });
  if (!result.valid) throw new Error(`assembled release projection rejected: ${result.failures.join('; ')}`);
  return result;
}

/**
 * createReleaseProjection({ corpusCoverage, selectedLedger, identity, seedIdentity, inventory })
 *   -> ReleaseProjection
 *
 * `corpusCoverage`   — the exact ruvnet-brain-corpus-coverage object Step 4 sealed for the directory
 *                       being assembled. Every row, status, reason, and the enumeration receipt are
 *                       carried through UNCHANGED (algorithm step 9) — this function reads them, it
 *                       never rewrites them.
 * `selectedLedger`   — the PUBLIC generation ledger view assembleBundle's projectStoreViews already
 *                       derived once from the selected records (schemaVersion 2, kind
 *                       'ruvnet-brain-public-generation-ledger', carrying `identity`'s version/
 *                       sourceSnapshot). Never independently re-read from disk here.
 * `identity`         — { version, sourceSnapshot }: the exact release this projection is bound to.
 * `seedIdentity`     — { tag, archiveSha256, archiveBytes, baselineReceiptSha256 }: the immutable
 *                       corpus seed this assembly started from, and the sha256 of the baseline
 *                       observation receipt proving that seed was not silently substituted.
 * `inventory`         — the ValidatePublicInventory() result assembleBundle already computed once
 *                       while validating the finalized corpus (its `partitionSha256` is the evidence
 *                       digest bound into the release ledger).
 *
 * Returns `{ releaseCoverage, corpusCoverageBytes, publicGenerationLedgerBytes }` — plain data; this
 * function performs no I/O of its own.
 */
export function createReleaseProjection({ corpusCoverage, selectedLedger, identity, seedIdentity, inventory }) {
  if (!corpusCoverage || corpusCoverage.kind !== 'ruvnet-brain-corpus-coverage' || !Array.isArray(corpusCoverage.rows)) {
    throw new Error('corpus coverage must be an observed ruvnet-brain-corpus-coverage ledger');
  }
  const version = identity?.version;
  const sourceSnapshot = identity?.sourceSnapshot;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('release version is invalid');
  if (!HEX40.test(sourceSnapshot || '')) throw new Error('release source snapshot is invalid');
  if (!seedIdentity?.tag || !HEX64.test(seedIdentity.archiveSha256 || '')
    || !Number.isSafeInteger(seedIdentity.archiveBytes) || !HEX64.test(seedIdentity.baselineReceiptSha256 || '')) {
    throw new Error('corpus seed identity is incomplete');
  }
  if (!selectedLedger || selectedLedger.kind !== 'ruvnet-brain-public-generation-ledger'
    || !selectedLedger.stores || typeof selectedLedger.stores !== 'object' || Array.isArray(selectedLedger.stores)
    || Object.keys(selectedLedger.stores).length === 0) {
    throw new Error('selected public generation ledger is malformed or empty');
  }
  if (selectedLedger.brainVersion !== version || selectedLedger.sourceSnapshot !== sourceSnapshot) {
    throw new Error('selected public generation ledger does not bind this release identity');
  }
  if (!inventory || typeof inventory.partitionSha256 !== 'string' || !HEX64.test(inventory.partitionSha256)) {
    throw new Error('public inventory evidence is required');
  }

  const ledgerBytes = generationLedgerBytes(selectedLedger);
  const corpusBytes = Buffer.from(`${JSON.stringify(corpusCoverage, null, 2)}\n`);
  const releaseCoverage = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-release-coverage',
    owner: corpusCoverage.owner,
    observedAt: corpusCoverage.observedAt,
    generatorSourceSha: corpusCoverage.generatorSourceSha,
    sourceObservationSha256: corpusCoverage.sourceObservationSha256,
    snapshotRoot: corpusCoverage.snapshotRoot,
    releaseIdentity: { version, tag: `v${version}`, sourceSnapshot },
    corpusSeed: { tag: seedIdentity.tag, archiveSha256: seedIdentity.archiveSha256,
      archiveBytes: seedIdentity.archiveBytes, receiptSha256: seedIdentity.baselineReceiptSha256 },
    corpusCoverage: { sha256: sha256(corpusBytes), coverageGeneration: corpusCoverage.coverageGeneration },
    generationLedger: { file: PUBLIC_GENERATIONS_FILE, sha256: sha256(ledgerBytes),
      bytes: ledgerBytes.length, storeCount: Object.keys(selectedLedger.stores).length },
    installedProjectionSchema: 2,
    policy: corpusCoverage.policy,
    // UNCHANGED from the sealed measurement (algorithm step 9): no row, status, reason, or
    // enumeration count is ever rewritten here.
    enumerationReceipt: corpusCoverage.enumerationReceipt,
    rows: corpusCoverage.rows,
    totals: corpusCoverage.totals,
    publicInventoryPartitionSha256: inventory.partitionSha256,
  };
  releaseCoverage.releaseCoverageGeneration = releaseCoverageGenerationFor(releaseCoverage);
  return { releaseCoverage, corpusCoverageBytes: corpusBytes, publicGenerationLedgerBytes: ledgerBytes };
}

/**
 * projectReleaseFromAssets(...) — TEMPORARY COMPATIBILITY PATH. RETIRES AT PLAN STEP 11.
 *
 * P1-c (Dual, 2026-09-14): the step-5 consolidation replaced this file's CLI with an unconditional
 * `process.exitCode = 1`, while .github/workflows/ci.yml's release-qe job still invoked it and then
 * passed `--coverage`/`--projection` to a build-bundle CLI that rejected both. A release gate that
 * can only exit 1 is not a gate, and documenting that it is expected to fail does not repair it.
 * The consumer sequence and the scripts now AGREE again: ci.yml declares the legacy rail explicitly
 * with `--legacy-seed-projection`, this CLI produces the projection it did before the consolidation,
 * and build-bundle.mjs's legacySeedProjection branch consumes it.
 *
 * This is NOT a return to the pre-consolidation semantics for new work: `createReleaseProjection`
 * above remains the single-pass, pure, in-process producer every step-11 consumer will call. This
 * function exists ONLY because `data/corpus-seed.json` still pins v4.2.1-dev, a PRE-Step-3/4 seed
 * whose contents (measured 2026-09-14: 186 stores, no sealed public-input selection, no
 * public-store-classes.json, no ruv-gists.sources.json) cannot satisfy the sealed-corpus contract.
 * Steps 8-11 publish and re-pin a Step-4-produced seed; this function is deleted with that switch.
 *
 * Unchanged from the pre-consolidation producer in the one respect that matters: rows are SCOPED to
 * what the immutable seed actually carries (a repository whose store is absent, or a gist the sealed
 * receipt does not carry, is dropped — never rewritten CURRENT), and the complete observation is
 * preserved untouched in CORPUS-COVERAGE.json.
 */
export function projectReleaseFromAssets({ corpusCoverage, assetsDir, version, sourceSnapshot,
  corpusSeed, baselineReceiptSha256, outDir }) {
  if (!corpusCoverage || corpusCoverage.kind !== 'ruvnet-brain-corpus-coverage') {
    throw new Error('corpus coverage must be an observed ruvnet-brain-corpus-coverage ledger');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('release version is invalid');
  if (!HEX40.test(sourceSnapshot || '')) throw new Error('release source snapshot is invalid');
  if (!corpusSeed?.tag || !HEX64.test(corpusSeed.archiveSha256 || '')
    || !Number.isSafeInteger(corpusSeed.archiveBytes) || !HEX64.test(baselineReceiptSha256 || '')) {
    throw new Error('corpus seed identity is incomplete');
  }
  const assets = path.resolve(assetsDir || '');
  const sourceLedger = readRvfGenerations(assets);
  const availableStores = new Set(fs.readdirSync(assets)
    .filter((name) => /^.+\.big\.rvf$/.test(name)).map((name) => name.slice(0, -'.big.rvf'.length).toLowerCase()));
  // The seed is the truth for gists too, at GIST granularity: `ruv-gists.big.rvf` being present says
  // the aggregate shipped, not that every gist rUv has published since the seal is inside it. A gist
  // the sealed receipt does not carry is unseeded exactly like a repository whose store is absent.
  // NO FALLBACK to the maintainer's checkout copy of the receipt (the 2026-09-13 divergence bug): a
  // receipt that is not in the assembled candidate simply does not exist for this projection.
  const receiptFile = path.join(assets, 'ruv-gists.sources.json');
  let gistReceipt = null;
  if (fs.existsSync(receiptFile)) {
    gistReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (gistReceipt.schemaVersion !== 3 || gistReceipt.kind !== 'ruvnet-brain-gist-source-receipts') {
      throw new Error('the assembled candidate carries a downgraded gist receipt (ruv-gists.sources.json) '
        + '-- refusing to project a release from an unreconciled or schema-downgraded receipt');
    }
  }
  const seededGistIds = new Set(gistReceipt ? Object.keys(gistReceipt.gists) : []);
  const seeded = (row) => availableStores.has(String(row.artifact?.store || '').toLowerCase())
    && (row.kind !== 'gist' || seededGistIds.has(String(row.key || '').replace(/^gist:/, '')));
  const seededRows = corpusCoverage.rows.filter((row) => row.disposition === 'eligible' && seeded(row));
  if (!seededRows.length) throw new Error('immutable seed contains no eligible corpus stores');
  const seededExcludedRows = corpusCoverage.rows.filter((row) => row.disposition !== 'eligible'
    && availableStores.has(String(row.artifact?.store || '').toLowerCase()));
  const rows = [...seededRows, ...seededExcludedRows].map((row) => {
    if (row.disposition !== 'eligible') return { ...row };
    const store = String(row.artifact.store);
    const generation = sourceLedger.stores[store];
    if (!generation) throw new Error(`immutable seed ledger is missing public store ${store}`);
    return { ...row, status: 'CURRENT', artifact: { ...row.artifact,
      sourceCommit: generation.sourceCommit, rvfSha256: generation.sha256 } };
  });
  const publicStores = [...new Set(rows.filter((row) => row.disposition === 'eligible')
    .map((row) => String(row.artifact.store).toLowerCase()))];
  const classesFile = path.join(assets, 'public-store-classes.json');
  const derivedStores = fs.existsSync(classesFile)
    ? (JSON.parse(fs.readFileSync(classesFile, 'utf8')).derived || []).map((entry) => String(entry.store).toLowerCase())
    : [];
  const ledgerStores = [...new Set([...publicStores, ...derivedStores])];
  const totals = { ...corpusCoverage.totals, rows: rows.length,
    repositories: rows.filter((row) => row.kind === 'repository').length,
    gists: rows.filter((row) => row.kind === 'gist').length,
    byStatus: Object.fromEntries([...new Set(rows.map((row) => row.status))].sort()
      .map((status) => [status, rows.filter((row) => row.status === status).length])) };
  const enumerationReceipt = { ...corpusCoverage.enumerationReceipt,
    repositories: { ...corpusCoverage.enumerationReceipt.repositories, expected: totals.repositories },
    gists: { ...corpusCoverage.enumerationReceipt.gists, expected: totals.gists } };
  const ledger = projectPublicGenerationLedger({ ledger: sourceLedger, publicStores: ledgerStores, version, sourceSnapshot });
  const ledgerBytes = generationLedgerBytes(ledger);
  const corpusBytes = Buffer.from(`${JSON.stringify(corpusCoverage, null, 2)}\n`);
  const releaseBase = {
    schemaVersion: 1, kind: 'ruvnet-brain-release-coverage', owner: corpusCoverage.owner,
    observedAt: corpusCoverage.observedAt, generatorSourceSha: corpusCoverage.generatorSourceSha,
    sourceObservationSha256: corpusCoverage.sourceObservationSha256, snapshotRoot: corpusCoverage.snapshotRoot,
    releaseIdentity: { version, tag: `v${version}`, sourceSnapshot },
    corpusSeed: { tag: corpusSeed.tag, archiveSha256: corpusSeed.archiveSha256,
      archiveBytes: corpusSeed.archiveBytes, receiptSha256: baselineReceiptSha256 },
    corpusCoverage: { sha256: sha256(corpusBytes), coverageGeneration: corpusCoverage.coverageGeneration },
    generationLedger: { file: PUBLIC_GENERATIONS_FILE, sha256: sha256(ledgerBytes),
      bytes: ledgerBytes.length, storeCount: Object.keys(ledger.stores).length },
    installedProjectionSchema: 2, policy: corpusCoverage.policy, enumerationReceipt, rows, totals,
  };
  // Re-read from disk (never the object handed in): validatePublicInventory's partition digest omits
  // a directly-supplied receipt's own evidence identity, which would then permanently disagree with
  // the independent digest bindAssembledReleaseProjection computes from the same file moments later.
  const inventory = validatePublicInventory({ assetsDir: assets, coverage: releaseBase, ledger });
  releaseBase.publicInventoryPartitionSha256 = inventory.partitionSha256;
  releaseBase.releaseCoverageGeneration = releaseCoverageGenerationFor(releaseBase);
  const out = path.resolve(outDir || '');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'CORPUS-COVERAGE.json'), corpusBytes);
  fs.writeFileSync(path.join(out, 'COVERAGE.json'), `${JSON.stringify(releaseBase, null, 2)}\n`);
  fs.writeFileSync(path.join(out, PUBLIC_GENERATIONS_FILE), ledgerBytes);
  // Any derived/aggregate evidence the candidate carried travels WITH the projection; nothing is
  // synthesized for a file the candidate did not have.
  for (const file of ['ruv-gists.sources.json', 'public-store-classes.json', 'concepts.sources.json']) {
    const source = path.join(assets, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(out, file));
  }
  return releaseBase;
}

if (((() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })())) {
  const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
  try {
    const corpusFile = path.resolve(arg('--corpus', path.join(ROOT, 'data', 'source-coverage.json')));
    const projection = projectReleaseFromAssets({
      corpusCoverage: JSON.parse(fs.readFileSync(corpusFile, 'utf8')),
      assetsDir: arg('--assets'), outDir: arg('--out', 'release-evidence'),
      version: arg('--version'), sourceSnapshot: arg('--source-snapshot'),
      baselineReceiptSha256: arg('--baseline-receipt-sha256'),
      corpusSeed: { tag: arg('--seed-tag'), archiveSha256: arg('--seed-sha256'), archiveBytes: Number(arg('--seed-bytes')) },
    });
    console.log(JSON.stringify({ ok: true, releaseCoverageGeneration: projection.releaseCoverageGeneration }));
  } catch (error) { console.error(`[release-projection] ${error.message}`); process.exitCode = 1; }
}
