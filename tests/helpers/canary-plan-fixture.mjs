// Shared plan-building fixtures for the retrieval-canary tests: a tiny frozen fixture over four stores,
// rows as the ordinal-id builder wrote them (what the fixture pins) and as the content-addressed builder
// writes them, and a plan builder wired with an injected passage reader.
import { coverageGenerationFor, digest } from '../../scripts/coverage-integrity.mjs';
import { getVersionTag } from '../../scripts/version.mjs';
import { buildRetrievalCanaryPlan, sealRetrievalQueryEvidence } from '../../scripts/retrieval-canary.mjs';
import { passageContentDigest } from '../../scripts/retrieval-passage-identity.mjs';

export const STORES = ['old-a', 'old-b', 'old-c', 'old-d'];
// A row as the ORDINAL-id builder wrote it (what the fixture pinned) and as the content-addressed builder writes it.
export const ordinalRow = (store, id = '1') => ({ id, path: `src/${store}.mjs`, title: `${store} architecture`,
  text: `The ${store} implementation owns a unique deterministic boundary and verifies its runtime behavior.` });
export const chunkRow = (store) => ({ ...ordinalRow(store), id: `chunk:${digest(`content-${store}`)}` });
export const contentMapFor = (stores) => new Map(stores.map((store) => [digest(ordinalRow(store)), passageContentDigest(ordinalRow(store))]));

function row(store) {
  return { key: `repo:ruvnet/${store}`, kind: 'repository', name: store, url: `https://example/${store}`,
    disposition: 'eligible', status: 'CURRENT', reasons: [], upstream: { sha: 'c'.repeat(40) },
    artifact: { store, rvfSha256: digest(store) } };
}
function coverageOf(rows) {
  const enumerationReceipt = { schemaVersion: 1, owner: 'ruvnet', observedAt: '2026-08-22T00:00:00Z', requestParameters: {},
    repositories: { expected: rows.length, pages: [] }, gists: { expected: 0, pages: [] }, duplicateKeys: 0, terminal: true };
  const byStatus = {};
  for (const entry of rows) byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
  const base = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet', observedAt: '2026-08-22T00:00:00Z',
    generatorSourceSha: digest('generator'), sourceObservationSha256: digest('observation'), snapshotRoot: digest('snapshot'),
    policy: { policyDispositionDigests: [], exemptionDigests: [] }, enumerationReceipt, rows,
    totals: { repositories: rows.length, gists: 0, rows: rows.length, byStatus } };
  return { ...base, coverageGeneration: coverageGenerationFor({ generatorSourceSha: base.generatorSourceSha,
    snapshotRoot: base.snapshotRoot, sourceObservationSha256: base.sourceObservationSha256, rows, enumerationReceipt,
    policyDispositionDigests: [], exemptionDigests: [] }) };
}
const queryEvidence = sealRetrievalQueryEvidence({
  schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence', sourceCommit: 'd'.repeat(40),
  sourcePath: 'data/retrieval-query-evidence.json', queryStoreSetSha256: digest([...STORES].sort()),
  queries: Object.fromEntries(STORES.map((store) => {
    const value = { query: `independently authored behavior question for ${store} runtime boundary`,
      expected: { path: ordinalRow(store).path, passageSha256: digest(ordinalRow(store)) } };
    return [store, { ...value, recordSha256: digest({ store, ...value }) }];
  })),
});
export function plan(readPassages, extra = {}) {
  const coverage = coverageOf(STORES.map(row));
  const coverageIdentity = { sha256: digest(coverage), bytes: Buffer.byteLength(JSON.stringify(coverage)) };
  const notices = [];
  const built = buildRetrievalCanaryPlan({
    coverage, coverageIdentity, queryEvidence, readPassages, allowNoDelta: true, legacySampleSize: 10,
    notice: (message) => notices.push(message), ...extra,
    baseline: { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline', tag: getVersionTag(),
      archiveSha256: '1'.repeat(64), archiveBytes: 1234, archiveManifestSha256: '2'.repeat(64),
      verificationReceiptSha256: '3'.repeat(64), stores: STORES, storeCount: STORES.length },
    candidate: { sourceSha: 'a'.repeat(40), packageSha256: 'b'.repeat(64), archiveSha256: '4'.repeat(64),
      coverageSha256: coverageIdentity.sha256, publicLedgerSha256: '5'.repeat(64), publicLedgerBytes: 4321,
      publicStoreCount: STORES.length, publicInventoryPartitionSha256: '6'.repeat(64) },
  });
  return { built, notices };
}

