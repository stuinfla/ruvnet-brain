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

function seedCompatibleGistReceipt() {
  const source = readJson(path.join(ROOT, 'kb', 'ruv-gists.sources.json'));
  const gists = {};
  for (const [id, row] of Object.entries(source.gists || {})) {
    const files = row.files;
    gists[id] = { versionSha: row.versionSha, files,
      contentDigest: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  }
  // The v4.2.1 seed predates the schema-3 source-byte binding. Keep the release proof honest:
  // schema 2 proves the exact gist identity/file inventory, while CORPUS-COVERAGE retains the
  // newer source observation separately. Do not relabel the old seed as current-source evidence.
  return { schemaVersion: 2, owner: source.owner, generated: source.generated, gists };
}

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
  const publicStores = [...new Set(rows.map((row) => String(row.artifact.store).toLowerCase()))];
  const classesFile = path.join(assets, 'public-store-classes.json');
  const derivedStores = fs.existsSync(classesFile)
    ? readJson(classesFile).derived.map((entry) => String(entry.store).toLowerCase()) : [];
  const ledgerStores = [...new Set([...publicStores, ...derivedStores])];
  const projectedCoverage = { ...corpusCoverage, rows,
    totals: { ...corpusCoverage.totals, rows: rows.length,
      repositories: rows.filter((row) => row.kind === 'repository').length,
      gists: rows.filter((row) => row.kind === 'gist').length,
      byStatus: Object.fromEntries([...new Set(rows.map((row) => row.status))].sort()
        .map((status) => [status, rows.filter((row) => row.status === status).length])) } };
  const projectedEnumerationReceipt = { ...corpusCoverage.enumerationReceipt,
    repositories: { ...corpusCoverage.enumerationReceipt.repositories,
      expected: projectedCoverage.totals.repositories },
    gists: { ...corpusCoverage.enumerationReceipt.gists,
      expected: projectedCoverage.totals.gists } };
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
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: sha256(ledgerBytes),
      bytes: ledgerBytes.length, storeCount: Object.keys(ledger.stores).length },
    installedProjectionSchema: 2, policy: corpusCoverage.policy, enumerationReceipt: projectedEnumerationReceipt,
    rows: projectedCoverage.rows, totals: projectedCoverage.totals,
  };
  const gistReceipt = seedCompatibleGistReceipt();
  // Keep the projected receipt in the same asset root that the final archive
  // validator reads, so both partition hashes include identical evidence.
  fs.writeFileSync(path.join(assets, 'ruv-gists.sources.json'), `${JSON.stringify(gistReceipt, null, 2)}\n`);
  const inventory = validatePublicInventory({ assetsDir: assets, coverage: releaseBase, ledger });
  releaseBase.publicInventoryPartitionSha256 = inventory.partitionSha256;
  releaseBase.releaseCoverageGeneration = releaseCoverageGenerationFor(releaseBase);
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'CORPUS-COVERAGE.json'), corpusBytes);
  fs.writeFileSync(path.join(out, 'COVERAGE.json'), `${JSON.stringify(releaseBase, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'PUBLIC-RVF-GENERATIONS.json'), ledgerBytes);
  fs.writeFileSync(path.join(out, 'ruv-gists.sources.json'), `${JSON.stringify(gistReceipt, null, 2)}\n`);
  for (const file of ['public-store-classes.json', 'concepts.sources.json']) {
    const source = path.join(assets, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(out, file));
  }
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
