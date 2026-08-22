import { describe, expect, it } from 'vitest';
import { digest, releaseCoverageGenerationFor } from '../../scripts/coverage-integrity.mjs';
import { buildHostRegistry } from '../../scripts/host-registry.mjs';
import { transactionIdFor } from '../../scripts/release-transaction.mjs';
import { createPublicVerificationLane } from '../../scripts/public-verification-lane.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const artifactSha256 = 'a'.repeat(64);
const bundleSha256 = 'b'.repeat(64);
const sourceSha = 'c'.repeat(40);
const payloadId = 'd'.repeat(64);

function coverage() {
  const rows = ['new', 'old'].map((store) => ({
    key: `repo:stuinfla/${store}`, kind: 'repository', name: store,
    url: `https://github.com/stuinfla/${store}`, disposition: 'eligible',
    upstream: { sha: 'e'.repeat(40) }, artifact: { store }, status: 'CURRENT', reasons: [],
  }));
  const value = {
    schemaVersion: 1, kind: 'ruvnet-brain-release-coverage',
    generatorSourceSha: '1'.repeat(64), snapshotRoot: '2'.repeat(64), sourceObservationSha256: '3'.repeat(64),
    releaseIdentity: { version: '9.9.9', tag: 'v9.9.9', sourceSnapshot: sourceSha },
    corpusSeed: { tag: 'corpus-seed-fixture', archiveSha256: '4'.repeat(64), archiveBytes: 100,
      receiptSha256: '5'.repeat(64) },
    corpusCoverage: { sha256: '6'.repeat(64), coverageGeneration: '7'.repeat(64) },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: '8'.repeat(64), bytes: 200, storeCount: 2 },
    publicInventoryPartitionSha256: '9'.repeat(64), installedProjectionSchema: 2,
    rows,
    totals: { repositories: 2, gists: 0, rows: 2, byStatus: { CURRENT: 2 } },
    enumerationReceipt: { schemaVersion: 1, terminal: true, duplicateKeys: 0,
      repositories: { expected: 2, pages: [{ page: 1 }] }, gists: { expected: 0, pages: [] } },
    policy: { policyDispositionDigests: [], exemptionDigests: [] },
  };
  value.releaseCoverageGeneration = releaseCoverageGenerationFor(value);
  return value;
}

function plan(releaseCoverage) {
  const value = {
    schemaVersion: 2, kind: 'ruvnet-brain-retrieval-canary-plan',
    coverage: { sha256: digest(releaseCoverage), bytes: 100,
      releaseCoverageGeneration: releaseCoverage.releaseCoverageGeneration },
    baseline: { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline',
      tag: releaseCoverage.corpusSeed.tag, archiveSha256: releaseCoverage.corpusSeed.archiveSha256,
      archiveBytes: releaseCoverage.corpusSeed.archiveBytes, archiveManifestSha256: 'f'.repeat(64),
      verificationReceiptSha256: releaseCoverage.corpusSeed.receiptSha256, stores: ['old'], storeCount: 1,
      storeSetSha256: digest(['old']) },
    candidate: { sourceSha, packageSha256: artifactSha256, archiveSha256: bundleSha256,
      coverageSha256: digest(releaseCoverage), publicLedgerSha256: releaseCoverage.generationLedger.sha256,
      publicLedgerBytes: releaseCoverage.generationLedger.bytes, publicStoreCount: releaseCoverage.generationLedger.storeCount,
      publicInventoryPartitionSha256: releaseCoverage.publicInventoryPartitionSha256 },
    denominator: { eligibleStores: ['new', 'old'], eligibleStoreSetSha256: digest(['new', 'old']),
      deltaStores: ['new'], deltaStoreSetSha256: digest(['new']),
      legacyPopulationStores: ['old'], legacyPopulationStoreSetSha256: digest(['old']),
      legacySelectedStores: ['old'], legacySelectedStoreSetSha256: digest(['old']) },
    oracle: { receiptSha256: '0'.repeat(64), queryStoreSetSha256: digest(['new', 'old']),
      sourceCommit: 'a'.repeat(40), sourceBlobSha256: '0'.repeat(64) },
    cohorts: { delta: 1, legacy: 1 }, k: 10,
    cases: [
      { id: 'delta:new', cohort: 'delta', query: 'new exact source behavior query fixture', oracleRecordSha256: '1'.repeat(64),
        expected: { repo: 'new', path: 'src/new.mjs', passageSha256: '2'.repeat(64) }, source: {} },
      { id: 'legacy:old', cohort: 'legacy', query: 'old exact source behavior query fixture', oracleRecordSha256: '3'.repeat(64),
        expected: { repo: 'old', path: 'src/old.mjs', passageSha256: '4'.repeat(64) }, source: {} },
    ],
  };
  value.planSha256 = digest(value);
  return value;
}

function fixture() {
  const releaseCoverage = coverage();
  const retrievalPlan = plan(releaseCoverage);
  const identity = {
    repository: 'stuinfla/ruvnet-brain', package: 'ruvnet-brain', version: '9.9.9', tag: 'v9.9.9',
    candidateSha: sourceSha, payloadId, evidenceDigest: '5'.repeat(64),
    packageIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    packageSha256: artifactSha256, bundleSha256,
  };
  const candidate = { sha: sourceSha, version: identity.version, tag: identity.tag,
    artifact: { sha256: artifactSha256 } };
  const installed = Object.fromEntries(['claudeOnly', 'codexOnly', 'dual'].map((mode) => [mode,
    { status: 'PASS', doctorExit: 0, version: identity.version, artifactSha256, functionalSearch: true }]));
  const publication = { sha: sourceSha, version: identity.version, artifactSha256, payloadId,
    bundleArtifactSha256: bundleSha256,
    npm: { version: identity.version, sha: sourceSha, artifactSha256 },
    githubRelease: { tag: identity.tag, sha: sourceSha, artifactSha256 },
    installed, brain: { status: 'PASS', selfStore: true },
    postPublicationChecks: [{ name: 'published-surface-probe', status: 'completed', conclusion: 'success', sha: sourceSha }] };
  const adapter = {
    async searchInstalled({ query }) {
      const expected = retrievalPlan.cases.find((row) => row.query === query).expected;
      return [{ repo: expected.repo, path: expected.path }];
    },
    async resolveInstalledCitation({ expected }) {
      return { resolved: true, evidence: { passageSha256: expected.passageSha256, passageFileSha256: '6'.repeat(64) } };
    },
  };
  return { releaseCoverage, retrievalPlan, identity, candidate, publication, adapter,
    hostRegistry: buildHostRegistry({ root: ROOT }) };
}

describe('public verification OS lane', () => {
  it('produces exactly three source-bound host leaves from public bytes and canaries', async () => {
    const f = fixture();
    const leaves = await createPublicVerificationLane({ os: 'linux', ...f,
      coverageIdentity: { sha256: digest(f.releaseCoverage), bytes: 100 } });
    expect(leaves.map(({ os, mode }) => `${os}/${mode}`)).toEqual(['linux/claude', 'linux/codex', 'linux/dual']);
    expect(leaves.every(({ releaseTransactionId }) => releaseTransactionId === transactionIdFor(f.identity))).toBe(true);
    expect(leaves.every(({ retrieval }) => retrieval.metrics.recallAt10 === 1
      && retrieval.metrics.deltaCitationRate === 1)).toBe(true);
  });

  it('measures against an observed failed-public baseline without accepting it as candidate identity', async () => {
    const f = fixture();
    f.retrievalPlan.baseline = {
      ...f.retrievalPlan.baseline,
      kind: 'ruvnet-brain-observed-failed-public-baseline',
      integrity: 'DEGRADED',
      historicalCorpusReceipt: false,
      candidateVerificationEligible: false,
      observationReceiptSha256: f.releaseCoverage.corpusSeed.receiptSha256,
      discrepancyDigest: '7'.repeat(64),
    };
    delete f.retrievalPlan.baseline.verificationReceiptSha256;
    f.retrievalPlan.planSha256 = digest(Object.fromEntries(
      Object.entries(f.retrievalPlan).filter(([key]) => key !== 'planSha256'),
    ));
    const leaves = await createPublicVerificationLane({ os: 'linux', ...f,
      coverageIdentity: { sha256: digest(f.releaseCoverage), bytes: 100 } });
    expect(leaves).toHaveLength(3);

    f.retrievalPlan.candidate.sourceSha = '9'.repeat(40);
    f.retrievalPlan.planSha256 = digest(Object.fromEntries(
      Object.entries(f.retrievalPlan).filter(([key]) => key !== 'planSha256'),
    ));
    await expect(createPublicVerificationLane({ os: 'linux', ...f,
      coverageIdentity: { sha256: digest(f.releaseCoverage), bytes: 100 } }))
      .rejects.toThrow(/candidate identity differs from the release transaction/i);
  });

  it.each([
    ['public package drift', (f) => { f.publication.npm.artifactSha256 = '0'.repeat(64); }, /public byte identity/],
    ['incomplete coverage', (f) => { f.releaseCoverage.rows[0].status = 'STALE'; }, /coverage/],
    ['wrong registry', (f) => { f.hostRegistry.registrySha256 = '0'.repeat(64); }, /registry digest/],
    ['unknown canary', (f) => { f.adapter.searchInstalled = async () => { throw new Error('offline'); }; }, /acceptance failed/],
  ])('fails closed on %s', async (_label, mutate, expected) => {
    const f = fixture(); mutate(f);
    await expect(createPublicVerificationLane({ os: 'linux', ...f,
      coverageIdentity: { sha256: digest(f.releaseCoverage), bytes: 100 } })).rejects.toThrow(expected);
  });
});
