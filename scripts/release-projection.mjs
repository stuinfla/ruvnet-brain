#!/usr/bin/env node
// Build the release-bound coverage projection from an observed corpus ledger and exact bundle bytes.
// This is intentionally a producer, not a validator: public-verification-inputs.mjs remains the
// independent consumer that proves the emitted files agree with the archive.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, generationLedgerBytes, projectPublicGenerationLedger,
  releaseCoverageGenerationFor } from '../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from './public-inventory.mjs';
import { readRvfGenerations } from './rvf-generation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const storeName = (value) => String(value || '').toLowerCase().replace(/\.big\.rvf$|\.rvf$/i, '');

export function createReleaseProjection({ corpusCoverage, assetsDir, version, sourceSnapshot,
  corpusSeed, baselineReceiptSha256, outDir }) {
  if (!corpusCoverage || corpusCoverage.kind !== 'ruvnet-brain-corpus-coverage') {
    throw new Error('corpus coverage must be an observed ruvnet-brain-corpus-coverage ledger');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('release version is invalid');
  if (!/^[a-f0-9]{40}$/.test(sourceSnapshot || '')) throw new Error('release source snapshot is invalid');
  if (!corpusSeed?.tag || !/^[a-f0-9]{64}$/.test(corpusSeed.archiveSha256 || '')
    || !Number.isSafeInteger(corpusSeed.archiveBytes) || !/^[a-f0-9]{64}$/.test(baselineReceiptSha256 || '')) {
    throw new Error('corpus seed identity is incomplete');
  }
  const assets = path.resolve(assetsDir);
  const sourceLedger = readRvfGenerations(assets);
  // The coverage ledger describes the full upstream universe. A release candidate contains
  // only the immutable seed's asset set, so absent-but-eligible upstream rows are not release
  // blockers; shipped stores must still all be CURRENT.
  const assetStores = fs.readdirSync(assets)
    .filter((name) => /\.rvf$/i.test(name)).map(storeName);
  const availableStores = new Set([
    ...Object.keys(sourceLedger.stores || {}).map(storeName),
    ...assetStores,
  ]);
  const eligible = corpusCoverage.rows.filter((row) => row.disposition === 'eligible'
    && availableStores.has(storeName(row.artifact?.store)));
  if (!eligible.length || eligible.some((row) => row.status !== 'CURRENT')) throw new Error('eligible corpus rows are not all CURRENT');
  const publicStores = [...new Set(eligible.map((row) => String(row.artifact.store).toLowerCase()))];
  // Derived public stores are not corpus rows, but they are still part of the
  // exact shipped generation ledger when the candidate asset set contains them.
  if (sourceLedger.stores?.concepts && !publicStores.includes('concepts')) publicStores.push('concepts');
  const ledger = projectPublicGenerationLedger({ ledger: sourceLedger, publicStores, version, sourceSnapshot });
  const releaseBase = {
    schemaVersion: 1, kind: 'ruvnet-brain-release-coverage', owner: corpusCoverage.owner,
    observedAt: corpusCoverage.observedAt, generatorSourceSha: corpusCoverage.generatorSourceSha,
    sourceObservationSha256: corpusCoverage.sourceObservationSha256, snapshotRoot: corpusCoverage.snapshotRoot,
    releaseIdentity: { version, tag: `v${version}`, sourceSnapshot },
    corpusSeed: { tag: corpusSeed.tag, archiveSha256: corpusSeed.archiveSha256,
      archiveBytes: corpusSeed.archiveBytes, receiptSha256: baselineReceiptSha256 },
    corpusCoverage: { sha256: sha256(Buffer.from(`${JSON.stringify(corpusCoverage, null, 2)}\n`)), coverageGeneration: corpusCoverage.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: sha256(generationLedgerBytes(ledger)),
      bytes: generationLedgerBytes(ledger).length, storeCount: Object.keys(ledger.stores).length },
    installedProjectionSchema: 2, policy: corpusCoverage.policy, enumerationReceipt: corpusCoverage.enumerationReceipt,
    rows: corpusCoverage.rows, totals: corpusCoverage.totals,
  };
  const inventory = validatePublicInventory({ assetsDir: assets, coverage: releaseBase, ledger });
  releaseBase.publicInventoryPartitionSha256 = inventory.partitionSha256;
  releaseBase.releaseCoverageGeneration = releaseCoverageGenerationFor(releaseBase);
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const corpusBytes = Buffer.from(`${JSON.stringify(corpusCoverage, null, 2)}\n`);
  const coverageBytes = Buffer.from(`${JSON.stringify(releaseBase, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'CORPUS-COVERAGE.json'), corpusBytes);
  fs.writeFileSync(path.join(out, 'COVERAGE.json'), coverageBytes);
  fs.writeFileSync(path.join(out, 'PUBLIC-RVF-GENERATIONS.json'), generationLedgerBytes(ledger));
  return releaseBase;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const corpusFile = path.resolve(arg('--corpus', path.join(ROOT, 'data', 'source-coverage.json')));
    const corpus = readJson(corpusFile);
    const projection = createReleaseProjection({ corpusCoverage: corpus,
      assetsDir: arg('--assets'), outDir: arg('--out', 'release-evidence'), version: arg('--version'),
      sourceSnapshot: arg('--source-snapshot'), baselineReceiptSha256: arg('--baseline-receipt-sha256'),
      corpusSeed: { tag: arg('--seed-tag'), archiveSha256: arg('--seed-sha256'), archiveBytes: Number(arg('--seed-bytes')) } });
    console.log(JSON.stringify({ ok: true, releaseCoverageGeneration: projection.releaseCoverageGeneration }));
  } catch (error) { console.error(`[release-projection] ${error.message}`); process.exitCode = 1; }
}
