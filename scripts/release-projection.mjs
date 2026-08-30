#!/usr/bin/env node
// Build the release-bound coverage projection from an observed corpus ledger and exact bundle bytes.
// This is a producer; public-verification-inputs.mjs independently proves the emitted files.
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
  // Source observation and release assets are different evidence planes. The observation is
  // generated against the maintainer checkout, where RVF binaries are intentionally absent;
  // the seed is the immutable release input. Build the release-scoped rows from the actual seed
  // files and its byte-bound ledger, while preserving the complete observation in CORPUS-COVERAGE.
  const availableStores = new Set(fs.readdirSync(assets)
    .filter((name) => /^.+\.big\.rvf$/.test(name)).map((name) => name.slice(0, -'.big.rvf'.length).toLowerCase()));
  const seededRows = corpusCoverage.rows.filter((row) => row.disposition === 'eligible'
    && availableStores.has(String(row.artifact?.store || '').toLowerCase()));
  if (!seededRows.length) throw new Error('immutable seed contains no eligible corpus stores');
  const rows = seededRows.map((row) => {
    const store = String(row.artifact.store);
    const generation = sourceLedger.stores[store];
    if (!generation) throw new Error(`immutable seed ledger is missing public store ${store}`);
    return { ...row, status: 'CURRENT', artifact: { ...row.artifact,
      sourceCommit: generation.sourceCommit, rvfSha256: generation.sha256 } };
  });
  const publicStores = [...new Set(rows.map((row) => String(row.artifact.store).toLowerCase()))];
  const projectedCoverage = { ...corpusCoverage, rows,
    totals: { ...corpusCoverage.totals, rows: rows.length,
      repositories: rows.filter((row) => row.kind === 'repository').length,
      gists: rows.filter((row) => row.kind === 'gist').length } };
  const ledger = projectPublicGenerationLedger({ ledger: sourceLedger, publicStores, version, sourceSnapshot });
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
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: sha256(ledgerBytes),
      bytes: ledgerBytes.length, storeCount: Object.keys(ledger.stores).length },
    installedProjectionSchema: 2, policy: corpusCoverage.policy, enumerationReceipt: corpusCoverage.enumerationReceipt,
    rows: projectedCoverage.rows, totals: projectedCoverage.totals,
  };
  const inventory = validatePublicInventory({ assetsDir: assets, coverage: releaseBase, ledger });
  releaseBase.publicInventoryPartitionSha256 = inventory.partitionSha256;
  releaseBase.releaseCoverageGeneration = releaseCoverageGenerationFor(releaseBase);
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'CORPUS-COVERAGE.json'), corpusBytes);
  fs.writeFileSync(path.join(out, 'COVERAGE.json'), `${JSON.stringify(releaseBase, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'PUBLIC-RVF-GENERATIONS.json'), ledgerBytes);
  return releaseBase;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const corpusFile = path.resolve(arg('--corpus', path.join(ROOT, 'data', 'source-coverage.json')));
    const corpus = readJson(corpusFile);
    const projection = createReleaseProjection({ corpusCoverage: corpus, assetsDir: arg('--assets'),
      outDir: arg('--out', 'release-evidence'), version: arg('--version'), sourceSnapshot: arg('--source-snapshot'),
      baselineReceiptSha256: arg('--baseline-receipt-sha256'),
      corpusSeed: { tag: arg('--seed-tag'), archiveSha256: arg('--seed-sha256'), archiveBytes: Number(arg('--seed-bytes')) } });
    console.log(JSON.stringify({ ok: true, releaseCoverageGeneration: projection.releaseCoverageGeneration }));
  } catch (error) { console.error(`[release-projection] ${error.message}`); process.exitCode = 1; }
}
