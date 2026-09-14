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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_GENERATIONS_FILE, generationLedgerBytes, releaseCoverageGenerationFor,
  validateCoverageDirectory } from '../plugin/scripts/coverage-integrity.mjs';

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

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    console.error('[release-projection] this CLI is retired -- createReleaseProjection is now called '
      + 'in-process, exactly once, from scripts/build-bundle.mjs (assembleBundle) as part of a single '
      + 'assembly pass. See ' + path.relative(ROOT, fileURLToPath(import.meta.url)) + ' header.');
    process.exitCode = 1;
  } catch (error) { console.error(`[release-projection] ${error.message}`); process.exitCode = 1; }
}
