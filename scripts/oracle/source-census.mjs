import fs from 'node:fs';
import path from 'node:path';
import {
  digest,
  isIngestibleDisposition,
  validateCoverageDirectory,
  validateGistAggregateReceipt,
} from '../../plugin/scripts/coverage-integrity.mjs';

const HEX40 = /^[a-f0-9]{40}$/i;
const HEX64 = /^[a-f0-9]{64}$/i;

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is unreadable: ${error.message}`); }
}

function withoutSeal(census) {
  const { censusSha256: _seal, ...payload } = census;
  return payload;
}

function assertShape(census) {
  if (census?.schemaVersion !== 2 || census.kind !== 'ruvnet-brain-oracle-archive-source-census'
    || !HEX64.test(String(census.coverageSha256 || ''))
    || !HEX64.test(String(census.corpusCoverageSha256 || ''))
    || !Array.isArray(census.partitions) || !census.partitions.length
    || !HEX64.test(String(census.censusSha256 || ''))
    || census.censusSha256 !== digest(withoutSeal(census))) {
    throw new Error('archive source census schema or digest is invalid');
  }
  const seen = new Set();
  let previous = '';
  for (const row of census.partitions) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)
      || !['repository', 'gist'].includes(row.kind)
      || typeof row.store !== 'string' || !row.store
      || !HEX40.test(String(row.sourceCommit || ''))) {
      throw new Error('archive source census partition is malformed or duplicated');
    }
    if (previous && row.id.localeCompare(previous) < 0) throw new Error('archive source census partitions are not sorted');
    previous = row.id;
    seen.add(row.id);
  }
  if (!Array.isArray(census.archiveStores) || !Array.isArray(census.excludedDerived)) throw new Error('archive source census store accounting is missing');
  const sourceStores = new Set(census.partitions.map(row => row.store.toLowerCase()));
  const derivedStores = new Set();
  for (const row of census.excludedDerived) {
    if (!row || Object.keys(row).sort().join(',') !== 'ledgerDigest,reason,store'
      || typeof row.store !== 'string' || !row.store || row.reason !== 'derived-view'
      || !HEX64.test(String(row.ledgerDigest || '')) || sourceStores.has(row.store.toLowerCase()) || derivedStores.has(row.store.toLowerCase())) {
      throw new Error('archive source census derived exclusion is invalid or overlaps a source');
    }
    derivedStores.add(row.store.toLowerCase());
  }
  const accounted = [...sourceStores, ...derivedStores].sort();
  if (JSON.stringify(accounted) !== JSON.stringify(census.archiveStores)
    || new Set(census.archiveStores).size !== census.archiveStores.length) throw new Error('archive source census does not account for every physical store');
}

function eligibleRows(coverage) {
  return (coverage?.rows || []).filter((row) => isIngestibleDisposition(row?.disposition));
}

function physicalStoreNames(root) {
  const names = fs.readdirSync(root).filter((name) => name.endsWith('.big.rvf'))
    .map((name) => name.slice(0, -'.big.rvf'.length));
  const folded = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (folded.has(key)) throw new Error('canonical RVF store names have case-fold aliases');
    folded.set(key, name);
  }
  return folded;
}

/**
 * Build the exact source partition denominator from an authenticated archive projection.
 * Incomplete projections are available only through the explicit historical diagnostic mode.
 */
export function archiveSourceCensus(root, { requireCoverage = true } = {}) {
  const checked = validateCoverageDirectory(root, { requireCompleteProfile: true });
  if (!checked.valid) {
    if (!requireCoverage) return null;
    throw new Error(`complete coverage is required for source census: ${checked.failures.join('; ')}`);
  }
  const coverage = checked.corpusCoverage;
  const rows = eligibleRows(coverage);
  if (!rows.length) throw new Error('source census has no eligible coverage rows');
  const ledger = checked.generationLedger;
  const physicalNames = physicalStoreNames(root);
  const gistRows = rows.filter((row) => row.kind === 'gist');
  const gistIds = gistRows.map((row) => String(row.key || '').replace(/^gist:/, ''));
  if (new Set(gistIds).size !== gistIds.length || gistIds.some((id) => !id)) {
    throw new Error('source census gist coverage identities are missing or duplicated');
  }
  if (gistRows.length) {
    const gistStoreName = physicalNames.get('ruv-gists') || 'ruv-gists';
    const receiptFile = path.join(root, `${gistStoreName}.sources.json`);
    const passagesFile = path.join(root, `${gistStoreName}.passages.jsonl`);
    const receipt = readJson(receiptFile, 'gist aggregate receipt');
    validateGistAggregateReceipt({ receipt, passagesFile, expectedIds: gistIds,
      sourceObservationSha256: coverage.sourceObservationSha256 });
    for (const row of gistRows) {
      const id = String(row.key).slice('gist:'.length);
      const sourceCommit = row.artifact?.sourceCommit;
      if (String(sourceCommit).toLowerCase() !== String(receipt.gists[id]?.versionSha).toLowerCase()) {
        throw new Error(`gist ${id} coverage sourceCommit differs from authenticated receipt`);
      }
    }
  }
  const partitions = rows.map((row) => {
    const store = String(row.artifact?.store || '').toLowerCase();
    if (!store) throw new Error(`coverage row ${row.key} has no artifact store`);
    if (row.kind === 'gist') return { id: row.key, kind: 'gist', store, sourceCommit: row.artifact.sourceCommit.toLowerCase() };
    if (row.kind === 'repository') return { id: store, kind: 'repository', store, sourceCommit: row.artifact.sourceCommit.toLowerCase() };
    throw new Error(`unsupported source coverage kind: ${row.kind}`);
  });
  // Derived views carry authenticated build provenance, never a fabricated Git commit.
  const excludedDerived = (checked.publicInventory?.derived || []).map(store => {
    const ledgerRow = Object.entries(ledger?.stores || {}).find(([name]) => name.toLowerCase() === store)?.[1];
    if (!ledgerRow) throw new Error(`derived store ${store} is absent from the generation ledger`);
    return { store, reason: 'derived-view', ledgerDigest: digest(ledgerRow) };
  }).sort((a,b) => a.store.localeCompare(b.store));
  const archiveStores = [...physicalNames.keys()].sort();
  partitions.sort((a, b) => a.id.localeCompare(b.id));
  const census = { schemaVersion: 2, kind: 'ruvnet-brain-oracle-archive-source-census',
    coverageSha256: checked.coverageSha256, corpusCoverageSha256: checked.corpusCoverageSha256, partitions, archiveStores, excludedDerived };
  const sealed = { ...census, censusSha256: digest(census) };
  assertShape(sealed);
  return sealed;
}

/** Match a measured/qualified partition set to the exact archive census. */
export function assertSourceCensusPartitions(census, partitions, { allowMissing = false } = {}) {
  assertShape(census);
  if (!Array.isArray(partitions)) throw new Error('source census partitions must be an array');
  const expected = new Map(census.partitions.map((row) => [row.id, row]));
  const actual = new Map();
  for (const row of partitions) {
    if (!row || typeof row.id !== 'string' || actual.has(row.id)) {
      throw new Error('source census measured partitions are missing or duplicated');
    }
    actual.set(row.id, row);
    const source = expected.get(row.id);
    if (!source || row.kind !== source.kind || row.store.toLowerCase() !== source.store.toLowerCase() || String(row.sourceCommit).toLowerCase() !== source.sourceCommit.toLowerCase()) {
      throw new Error(`source census partition ${row.id} differs from the authenticated archive census`);
    }
  }
  const missing = census.partitions.filter((row) => !actual.has(row.id)).map((row) => row.id);
  if (missing.length && !allowMissing) throw new Error(`source census partitions are missing: ${missing.join(', ')}`);
  return { missing };
}
