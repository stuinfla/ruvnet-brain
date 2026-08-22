import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, digest } from '../../scripts/coverage-integrity.mjs';
import { runRetrievalCanaries } from '../../scripts/retrieval-canary.mjs';
import {
  createIndependentReviewReceipt,
  createPublicVerificationLeaf,
  PUBLIC_VERIFICATION_MODES,
  PUBLIC_VERIFICATION_OS,
  signPublicVerificationAggregate,
} from '../../scripts/public-verification-aggregate.mjs';
import { finalizeReleaseTransaction, transactionIdFor } from '../../scripts/release-transaction.mjs';
import { execute, FakeReleaseProvider, identity, keys } from '../helpers/release-transaction-fixture.mjs';
import { getVersionTag } from '../../scripts/version.mjs';

const plan = { schemaVersion: 2, kind: 'ruvnet-brain-retrieval-canary-plan',
  coverage: { sha256: '4'.repeat(64), bytes: 100, releaseCoverageGeneration: 'f'.repeat(64) },
  baseline: { tag: getVersionTag(), archiveSha256: '1'.repeat(64), archiveBytes: 100,
    archiveManifestSha256: '2'.repeat(64), verificationReceiptSha256: '3'.repeat(64), stores: ['old'],
    storeCount: 1, storeSetSha256: digest(['old']) },
  candidate: { sourceSha: identity.candidateSha, packageSha256: identity.packageSha256,
    archiveSha256: identity.bundleSha256, coverageSha256: '4'.repeat(64),
    publicLedgerSha256: '5'.repeat(64), publicLedgerBytes: 200, publicStoreCount: 2,
    publicInventoryPartitionSha256: '6'.repeat(64) },
  denominator: { eligibleStores: ['new', 'old'], eligibleStoreSetSha256: digest(['new', 'old']),
    deltaStores: ['new'], deltaStoreSetSha256: digest(['new']),
    legacyPopulationStores: ['old'], legacyPopulationStoreSetSha256: digest(['old']),
    legacySelectedStores: ['old'], legacySelectedStoreSetSha256: digest(['old']) },
  oracle: { receiptSha256: '7'.repeat(64), queryStoreSetSha256: digest(['new', 'old']),
    sourceCommit: 'b'.repeat(40), sourceBlobSha256: '7'.repeat(64) },
  cohorts: { delta: 1, legacy: 1 }, k: 10,
  cases: [
    { id: 'delta:new', cohort: 'delta', query: 'new exact public source behavior query', oracleRecordSha256: '8'.repeat(64), expected: { repo: 'new', path: 'src/new.mjs', passageSha256: '8'.repeat(64) }, source: {} },
    { id: 'legacy:old', cohort: 'legacy', query: 'old exact public source behavior query', oracleRecordSha256: '8'.repeat(64), expected: { repo: 'old', path: 'src/old.mjs', passageSha256: '8'.repeat(64) }, source: {} },
  ] };
plan.planSha256 = digest(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planSha256')));

async function aggregate(reviewKeys = keys) {
  const common = { sourceSha: identity.candidateSha, version: identity.version, tag: identity.tag,
    artifactSha256: identity.packageSha256, bundleSha256: identity.bundleSha256, payloadId: identity.payloadId,
    hostRegistryDigest: '2'.repeat(64), coverageGeneration: plan.coverage.releaseCoverageGeneration,
    canaryPlanSha256: plan.planSha256, releaseTransactionId: transactionIdFor(identity) };
  const leaves = [];
  for (const os of PUBLIC_VERIFICATION_OS) for (const mode of PUBLIC_VERIFICATION_MODES) {
    const retrieval = await runRetrievalCanaries({ plan, sourceSha: identity.candidateSha, artifactSha256: identity.packageSha256,
      candidateArchiveSha256: identity.bundleSha256,
      search: async ({ query }) => {
        const expected = plan.cases.find((row) => row.query === query).expected;
        return [{ repo: expected.repo, path: expected.path }];
      }, citationResolver: async (_matched, expected) => ({ resolved: true, evidence: {
        passageSha256: expected.passageSha256, passageFileSha256: '9'.repeat(64) } }) });
    leaves.push(createPublicVerificationLeaf({ ...common, os, mode, status: 'completed', verdict: 'PASS',
      publicBytes: { npmExact: true, githubExact: true, bundleExact: true },
      installed: { version: identity.version, loaderVerified: true },
      coverage: { verified: true, eligibleCurrent: 2, eligibleTotal: 2, gistCurrent: 1, gistTotal: 1 },
      retrievalPlan: plan, retrieval, untested: [], skipped: 0, unknown: 0 }));
  }
  const reviewCommon = { sourceSha: identity.candidateSha, artifactSha256: identity.packageSha256,
    payloadId: identity.payloadId, productContractSha256: '3'.repeat(64), rubricSha256: '4'.repeat(64),
    independent: true, verdict: 'PASS', score: 96, deductions: [], untested: [] };
  const reviews = [
    createIndependentReviewReceipt({ ...reviewCommon, id: 'claude-fable-5', model: 'claude-fable-5', provider: 'firstParty',
      execution: { subscriptionAuthenticated: true, invocationDigest: '5'.repeat(64) } }),
    createIndependentReviewReceipt({ ...reviewCommon, id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', provider: 'openai',
      execution: { subscriptionAuthenticated: true, invocationDigest: '6'.repeat(64), threadId: 'thread', catalogRowSha256: '7'.repeat(64) } }),
  ];
  return signPublicVerificationAggregate({ leaves, reviews }, reviewKeys.privateKey);
}

async function convergedProvider() {
  const provider = new FakeReleaseProvider();
  await execute(provider);
  provider.materializePublicVerificationAggregate = async ({ aggregate: evidence }) => ({
    aggregateSha256: evidence.aggregateSha256,
    aggregateAssetSha256: crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex'),
    signatureAssetSha256: crypto.createHash('sha256').update(Buffer.from(evidence.signature, 'base64')).digest('hex'),
  });
  return provider;
}

describe('schema-3 install-verified finalizer', () => {
  it('materializes, reobserves, appends, reads back, and validates install-verified', async () => {
    const provider = await convergedProvider();
    const evidence = await aggregate();
    const final = await finalizeReleaseTransaction({ identity, aggregate: evidence, adapter: provider,
      privateKey: keys.privateKey, publicKey: keys.publicKey, aggregatePublicKey: keys.publicKey });
    expect(final.state).toBe('install-verified');
    expect(final.observation.publicVerification.aggregateSha256).toBe(evidence.aggregateSha256);
    expect((await finalizeReleaseTransaction({ identity, aggregate: evidence, adapter: provider,
      privateKey: keys.privateKey, publicKey: keys.publicKey, aggregatePublicKey: keys.publicKey })).receiptDigest)
      .toBe(final.receiptDigest);
  });

  it('rejects pre-convergence, channel drift, wrong aggregate key, and materialization drift', async () => {
    const evidence = await aggregate();
    const fresh = new FakeReleaseProvider();
    fresh.materializePublicVerificationAggregate = async () => ({});
    await expect(finalizeReleaseTransaction({ identity, aggregate: evidence, adapter: fresh,
      privateKey: keys.privateKey, publicKey: keys.publicKey, aggregatePublicKey: keys.publicKey })).rejects.toThrow(/no receipt chain/);
    const drifted = await convergedProvider();
    drifted.npmLatest = drifted.prior;
    await expect(finalizeReleaseTransaction({ identity, aggregate: evidence, adapter: drifted,
      privateKey: keys.privateKey, publicKey: keys.publicKey, aggregatePublicKey: keys.publicKey })).rejects.toThrow(/channels drifted/);
    await expect(finalizeReleaseTransaction({ identity, aggregate: evidence, adapter: await convergedProvider(),
      privateKey: keys.privateKey, publicKey: keys.publicKey,
      aggregatePublicKey: crypto.generateKeyPairSync('ed25519').publicKey })).rejects.toThrow(/signature mismatch/);
    const badMaterialization = await convergedProvider();
    badMaterialization.materializePublicVerificationAggregate = async () => ({ aggregateSha256: '0'.repeat(64), signatureSha256: '0'.repeat(64) });
    await expect(finalizeReleaseTransaction({ identity, aggregate: evidence, adapter: badMaterialization,
      privateKey: keys.privateKey, publicKey: keys.publicKey, aggregatePublicKey: keys.publicKey })).rejects.toThrow(/differs/);
  });
});
