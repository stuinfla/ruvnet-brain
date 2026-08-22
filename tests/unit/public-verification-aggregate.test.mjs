import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, digest } from '../../scripts/coverage-integrity.mjs';
import { runRetrievalCanaries } from '../../scripts/retrieval-canary.mjs';
import {
  createPublicVerificationLeaf,
  createIndependentReviewReceipt,
  PUBLIC_VERIFICATION_MODES,
  PUBLIC_VERIFICATION_OS,
  signPublicVerificationAggregate,
  verifyPublicVerificationAggregate,
} from '../../scripts/public-verification-aggregate.mjs';
import { getVersion, getVersionTag } from '../../scripts/version.mjs';

const identity = {
  sourceSha: 'a'.repeat(40), version: getVersion(), tag: getVersionTag(), artifactSha256: 'b'.repeat(64),
  bundleSha256: 'c'.repeat(64), payloadId: 'd'.repeat(64), hostRegistryDigest: 'e'.repeat(64),
  coverageGeneration: 'f'.repeat(64), canaryPlanSha256: '1'.repeat(64), releaseTransactionId: '2'.repeat(64),
};
const plan = { schemaVersion: 2, kind: 'ruvnet-brain-retrieval-canary-plan',
  coverage: { sha256: '6'.repeat(64), bytes: 100, releaseCoverageGeneration: identity.coverageGeneration },
  baseline: { tag: getVersionTag(), archiveSha256: '3'.repeat(64), archiveBytes: 100,
    archiveManifestSha256: '4'.repeat(64), verificationReceiptSha256: '5'.repeat(64), stores: ['old'],
    storeCount: 1, storeSetSha256: digest(['old']) },
  candidate: { sourceSha: identity.sourceSha, packageSha256: identity.artifactSha256,
    archiveSha256: identity.bundleSha256, coverageSha256: '6'.repeat(64),
    publicLedgerSha256: '7'.repeat(64), publicLedgerBytes: 200, publicStoreCount: 2,
    publicInventoryPartitionSha256: '8'.repeat(64) },
  denominator: { eligibleStores: ['new', 'old'], eligibleStoreSetSha256: digest(['new', 'old']),
    deltaStores: ['new'], deltaStoreSetSha256: digest(['new']),
    legacyPopulationStores: ['old'], legacyPopulationStoreSetSha256: digest(['old']),
    legacySelectedStores: ['old'], legacySelectedStoreSetSha256: digest(['old']) },
  oracle: { receiptSha256: '9'.repeat(64), queryStoreSetSha256: digest(['new', 'old']),
    sourceCommit: 'b'.repeat(40), sourceBlobSha256: '9'.repeat(64) },
  cohorts: { delta: 1, legacy: 1 }, k: 10,
  cases: [
    { id: 'delta:new', cohort: 'delta', query: 'new repository exact source behavior query', oracleRecordSha256: 'a'.repeat(64), expected: { repo: 'new', path: 'src/new.mjs', passageSha256: 'a'.repeat(64) }, source: {} },
    { id: 'legacy:old', cohort: 'legacy', query: 'legacy repository exact behavior query', oracleRecordSha256: 'a'.repeat(64), expected: { repo: 'old', path: 'src/old.mjs', passageSha256: 'a'.repeat(64) }, source: {} },
  ] };
plan.planSha256 = digest(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planSha256')));
identity.canaryPlanSha256 = plan.planSha256;

async function leaves() {
  const result = [];
  for (const os of PUBLIC_VERIFICATION_OS) for (const mode of PUBLIC_VERIFICATION_MODES) {
    const retrieval = await runRetrievalCanaries({ plan, sourceSha: identity.sourceSha, artifactSha256: identity.artifactSha256,
      candidateArchiveSha256: identity.bundleSha256,
      search: async ({ query }) => {
        const expected = plan.cases.find((row) => row.query === query).expected;
        return [{ repo: expected.repo, path: expected.path }];
      }, citationResolver: async (_matched, expected) => ({ resolved: true, evidence: {
        passageSha256: expected.passageSha256, passageFileSha256: 'b'.repeat(64) } }) });
    result.push(createPublicVerificationLeaf({ ...identity, os, mode, status: 'completed', verdict: 'PASS',
      publicBytes: { npmExact: true, githubExact: true, bundleExact: true },
      installed: { version: identity.version, loaderVerified: true },
      coverage: { verified: true, eligibleCurrent: 182, eligibleTotal: 182, gistCurrent: 479, gistTotal: 479 },
      retrievalPlan: plan, retrieval, untested: [], skipped: 0, unknown: 0 }));
  }
  return result;
}

function reviews() {
  const shared = { sourceSha: identity.sourceSha, artifactSha256: identity.artifactSha256, payloadId: identity.payloadId,
    productContractSha256: '4'.repeat(64), rubricSha256: '5'.repeat(64), independent: true, verdict: 'PASS',
    score: 96, deductions: [], untested: [] };
  return [
    createIndependentReviewReceipt({ ...shared, id: 'claude-fable-5', model: 'claude-fable-5', provider: 'firstParty',
      execution: { subscriptionAuthenticated: true, invocationDigest: '6'.repeat(64) } }),
    createIndependentReviewReceipt({ ...shared, id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', provider: 'openai',
      execution: { subscriptionAuthenticated: true, invocationDigest: '7'.repeat(64), threadId: 'thread-1', catalogRowSha256: '8'.repeat(64) } }),
  ];
}

describe('signed public 3x3 verification aggregate', () => {
  it('accepts exactly nine bound leaves and verifies the signature and identity', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signPublicVerificationAggregate({ leaves: await leaves(), reviews: reviews() }, keys.privateKey);
    expect(aggregate.metrics).toMatchObject({ leaves: 9, recallAt10: 1, deltaCitationRate: 1 });
    expect(verifyPublicVerificationAggregate(aggregate, keys.publicKey, identity)).toBe(aggregate);
  });

  it.each([
    ['missing lane', (rows) => rows.pop(), /exactly nine leaves/],
    ['duplicate lane', (rows) => { rows[8] = rows[0]; }, /missing or duplicated/],
    ['identity split', (rows) => { rows[1].sourceSha = '9'.repeat(40); rows[1].leafSha256 = digest(Object.fromEntries(Object.entries(rows[1]).filter(([key]) => key !== 'leafSha256'))); }, /identity differs/],
    ['coverage split', (rows) => { rows[1].coverage.eligibleCurrent -= 1; rows[1].leafSha256 = digest(Object.fromEntries(Object.entries(rows[1]).filter(([key]) => key !== 'leafSha256'))); }, /coverage is incomplete/],
  ])('rejects %s', async (_label, mutate, expected) => {
    const rows = await leaves();
    mutate(rows);
    expect(() => signPublicVerificationAggregate({ leaves: rows, reviews: reviews() }, crypto.generateKeyPairSync('ed25519').privateKey)).toThrow(expected);
  });

  it('rejects aggregate tampering, signature substitution, and expected-identity drift', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signPublicVerificationAggregate({ leaves: await leaves(), reviews: reviews() }, keys.privateKey);
    aggregate.metrics.recallAt10 = 0.5;
    expect(() => verifyPublicVerificationAggregate(aggregate, keys.publicKey)).toThrow(/digest mismatch/);
    const fresh = signPublicVerificationAggregate({ leaves: await leaves(), reviews: reviews() }, keys.privateKey);
    expect(() => verifyPublicVerificationAggregate(fresh, crypto.generateKeyPairSync('ed25519').publicKey)).toThrow(/signature mismatch/);
    expect(() => verifyPublicVerificationAggregate(fresh, keys.publicKey, { ...identity, version: 'other' })).toThrow(/identity differs/);
  });

  it('rejects a resigned summary that omits every raw leaf and review receipt', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signPublicVerificationAggregate({ leaves: await leaves(), reviews: reviews() }, keys.privateKey);
    delete aggregate.evidence;
    const payload = Object.fromEntries(Object.entries(aggregate)
      .filter(([key]) => !['aggregateSha256', 'signature'].includes(key)));
    aggregate.aggregateSha256 = digest(payload);
    const signed = { ...payload, aggregateSha256: aggregate.aggregateSha256 };
    aggregate.signature = crypto.sign(null, Buffer.from(canonicalJson(signed)), keys.privateKey).toString('base64');
    expect(() => verifyPublicVerificationAggregate(aggregate, keys.publicKey)).toThrow(/lacks raw/);
  });

  it('rejects missing, stale, low, forged, or non-subscription review evidence', async () => {
    const rows = await leaves();
    expect(() => signPublicVerificationAggregate({ leaves: rows, reviews: reviews().slice(0, 1) }, crypto.generateKeyPairSync('ed25519').privateKey))
      .toThrow(/exactly two/);
    const stale = reviews();
    stale[1].sourceSha = '9'.repeat(40);
    stale[1].receiptSha256 = digest(Object.fromEntries(Object.entries(stale[1]).filter(([key]) => key !== 'receiptSha256')));
    expect(() => signPublicVerificationAggregate({ leaves: rows, reviews: stale }, crypto.generateKeyPairSync('ed25519').privateKey))
      .toThrow(/identity or rubric differs/);
    expect(() => createIndependentReviewReceipt({ ...reviews()[0], receiptSha256: undefined, score: 94 })).toThrow(/below 95/);
  });
});
