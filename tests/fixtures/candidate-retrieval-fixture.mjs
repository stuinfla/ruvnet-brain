import { canonicalJson, digest, releaseCoverageGenerationFor } from '../../scripts/coverage-integrity.mjs';
import { buildRetrievalCanaryPlan, sealRetrievalQueryEvidence } from '../../scripts/retrieval-canary.mjs';

export function candidateRetrievalFixture({ sourceSha = 'a'.repeat(40), packageSha256 = 'b'.repeat(64),
  archiveSha256 = 'c'.repeat(64), legacyCount = 1, version = '9.9.9' } = {}) {
  const old = Array.from({ length: legacyCount }, (_, i) => `old-${String(i).padStart(2, '0')}`);
  const stores = ['new', ...old];
  const rows = stores.map((store) => ({ key: `repo:ruvnet/${store}`, kind: 'repository', name: store,
    url: `https://example.invalid/${store}`, disposition: 'eligible', upstream: { sha: 'e'.repeat(40) },
    artifact: { store }, status: 'CURRENT', reasons: [] }));
  const coverage = { schemaVersion: 1, kind: 'ruvnet-brain-release-coverage',
    generatorSourceSha: '1'.repeat(64), snapshotRoot: '2'.repeat(64), sourceObservationSha256: '3'.repeat(64),
    releaseIdentity: { version, tag: `v${version}`, sourceSnapshot: sourceSha },
    corpusSeed: { tag: 'fixture-seed', archiveSha256: '4'.repeat(64), archiveBytes: 100, receiptSha256: '5'.repeat(64) },
    corpusCoverage: { sha256: '6'.repeat(64), coverageGeneration: '7'.repeat(64) },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: '8'.repeat(64), bytes: 200, storeCount: stores.length },
    publicInventoryPartitionSha256: '9'.repeat(64), installedProjectionSchema: 2, rows,
    totals: { repositories: stores.length, gists: 0, rows: stores.length, byStatus: { CURRENT: stores.length } },
    enumerationReceipt: { schemaVersion: 1, terminal: true, duplicateKeys: 0,
      repositories: { expected: stores.length, pages: [{ page: 1 }] }, gists: { expected: 0, pages: [] } },
    policy: { policyDispositionDigests: [], exemptionDigests: [] } };
  coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(coverage);
  const coverageBytes = canonicalJson(coverage);
  const coverageIdentity = { sha256: digest(coverage), bytes: Buffer.byteLength(coverageBytes) };
  const passages = Object.fromEntries(stores.map((store) => [store, { path: `src/${store}.mjs`,
    text: `The ${store} source implements its unique runtime boundary with source evidence that can be checked precisely.` }]));
  const queries = Object.fromEntries(stores.map((store) => {
    const query = `Explain the exact implementation boundary owned by ${store}`;
    const expected = { path: passages[store].path, passageSha256: digest(passages[store]) };
    return [store, { query, expected, recordSha256: digest({ store, query, expected }) }];
  }));
  const queryEvidence = sealRetrievalQueryEvidence({ schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence',
    sourceCommit: 'd'.repeat(40), sourcePath: 'data/retrieval-query-evidence.json', queryStoreSetSha256: digest([...stores].sort()), queries });
  const candidate = { sourceSha, packageSha256, archiveSha256, coverageSha256: coverageIdentity.sha256,
    publicLedgerSha256: coverage.generationLedger.sha256, publicLedgerBytes: 200, publicStoreCount: stores.length,
    publicInventoryPartitionSha256: coverage.publicInventoryPartitionSha256 };
  const baseline = { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline', tag: coverage.corpusSeed.tag,
    archiveSha256: coverage.corpusSeed.archiveSha256, archiveBytes: 100, archiveManifestSha256: 'f'.repeat(64),
    verificationReceiptSha256: coverage.corpusSeed.receiptSha256, stores: old, storeCount: old.length };
  const plan = buildRetrievalCanaryPlan({ coverage, coverageIdentity, candidate, baseline, queryEvidence,
    readPassages: (_dir, store) => [passages[store]], legacySampleSize: legacyCount });
  return { plan, coverage, coverageBytes, coverageIdentity, passages, sourceSha,
    artifactSha256: packageSha256, candidateArchiveSha256: archiveSha256 };
}
