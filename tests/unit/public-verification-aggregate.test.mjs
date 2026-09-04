import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canonicalJson, digest } from '../../scripts/coverage-integrity.mjs';
import { runRetrievalCanaries, sealRetrievalQueryEvidence } from '../../scripts/retrieval-canary.mjs';
import {
  createPublicVerificationLeaf,
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
  baseline: { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline',
    tag: getVersionTag(), archiveSha256: '3'.repeat(64), archiveBytes: 100,
    archiveManifestSha256: '4'.repeat(64), verificationReceiptSha256: '5'.repeat(64), stores: ['old', 'old-unselected'],
    storeCount: 2, storeSetSha256: digest(['old', 'old-unselected']) },
  candidate: { sourceSha: identity.sourceSha, packageSha256: identity.artifactSha256,
    archiveSha256: identity.bundleSha256, coverageSha256: '6'.repeat(64),
    publicLedgerSha256: '7'.repeat(64), publicLedgerBytes: 200, publicStoreCount: 3,
    publicInventoryPartitionSha256: '8'.repeat(64) },
  denominator: { eligibleStores: ['new', 'old', 'old-unselected'], eligibleStoreSetSha256: digest(['new', 'old', 'old-unselected']),
    deltaStores: ['new'], deltaStoreSetSha256: digest(['new']),
    legacyPopulationStores: ['old', 'old-unselected'], legacyPopulationStoreSetSha256: digest(['old', 'old-unselected']),
    legacySelectedStores: ['old'], legacySelectedStoreSetSha256: digest(['old']) },
  oracle: {},
  cohorts: { delta: 1, legacy: 1 }, k: 10,
  cases: [
    { id: 'delta:new', cohort: 'delta', query: 'new repository exact source behavior query', oracleRecordSha256: 'a'.repeat(64), expected: { repo: 'new', path: 'src/new.mjs', passageSha256: 'a'.repeat(64) }, source: {} },
    { id: 'legacy:old', cohort: 'legacy', query: 'legacy repository exact behavior query', oracleRecordSha256: 'a'.repeat(64), expected: { repo: 'old', path: 'src/old.mjs', passageSha256: 'a'.repeat(64) }, source: {} },
  ] };
const planQueries = Object.fromEntries(plan.cases.map(({ query, expected }) => {
  const bound = { path: expected.path, passageSha256: expected.passageSha256 };
  return [expected.repo, { query, expected: bound, recordSha256: digest({ store: expected.repo, query, expected: bound }) }];
}));
const unselectedExpected = { path: 'src/old-unselected.mjs', passageSha256: 'c'.repeat(64) };
const unselectedQuery = 'unselected legacy repository exact behavior query';
planQueries['old-unselected'] = { query: unselectedQuery, expected: unselectedExpected,
  recordSha256: digest({ store: 'old-unselected', query: unselectedQuery, expected: unselectedExpected }) };
const planEvidence = sealRetrievalQueryEvidence({ schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence',
  sourceCommit: 'b'.repeat(40), sourcePath: 'data/retrieval-query-evidence.json',
  queryStoreSetSha256: digest(['new', 'old', 'old-unselected']), queries: planQueries });
plan.cases.forEach((row) => { row.oracleRecordSha256 = planQueries[row.expected.repo].recordSha256; });
plan.oracle = { receiptSha256: planEvidence.receiptSha256, queryStoreSetSha256: planEvidence.queryStoreSetSha256,
  sourceCommit: planEvidence.sourceCommit, sourceBlobSha256: planEvidence.sourceBlobSha256, evidence: planEvidence };
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

describe('signed public 3x3 verification aggregate', () => {
  it('accepts exactly nine bound leaves and verifies the signature and identity', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signPublicVerificationAggregate({ leaves: await leaves() }, keys.privateKey);
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
    expect(() => signPublicVerificationAggregate({ leaves: rows }, crypto.generateKeyPairSync('ed25519').privateKey)).toThrow(expected);
  });

  it('rejects aggregate tampering, signature substitution, and expected-identity drift', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signPublicVerificationAggregate({ leaves: await leaves() }, keys.privateKey);
    aggregate.metrics.recallAt10 = 0.5;
    expect(() => verifyPublicVerificationAggregate(aggregate, keys.publicKey)).toThrow(/digest mismatch/);
    const fresh = signPublicVerificationAggregate({ leaves: await leaves() }, keys.privateKey);
    expect(() => verifyPublicVerificationAggregate(fresh, crypto.generateKeyPairSync('ed25519').publicKey)).toThrow(/signature mismatch/);
    expect(() => verifyPublicVerificationAggregate(fresh, keys.publicKey, { ...identity, version: 'other' })).toThrow(/identity differs/);
  });

  it('rejects a resigned summary that omits every raw public leaf', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signPublicVerificationAggregate({ leaves: await leaves() }, keys.privateKey);
    delete aggregate.evidence;
    const payload = Object.fromEntries(Object.entries(aggregate)
      .filter(([key]) => !['aggregateSha256', 'signature'].includes(key)));
    aggregate.aggregateSha256 = digest(payload);
    const signed = { ...payload, aggregateSha256: aggregate.aggregateSha256 };
    aggregate.signature = crypto.sign(null, Buffer.from(canonicalJson(signed)), keys.privateKey).toString('base64');
    expect(() => verifyPublicVerificationAggregate(aggregate, keys.publicKey)).toThrow(/lacks raw/);
  });

  it('signs exactly three immutable OS lane receipts through the CLI', async () => {
    const signingKeys = crypto.generateKeyPairSync('ed25519');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-aggregate-'));
    const lanesDir = path.join(temp, 'lanes');
    fs.mkdirSync(lanesDir);
    const allLeaves = await leaves();
    for (const osName of PUBLIC_VERIFICATION_OS) {
      const payload = { schemaVersion: 1, kind: 'ruvnet-brain-public-verification-os-lane', os: osName,
        leaves: allLeaves.filter(({ os: leafOs }) => leafOs === osName) };
      fs.writeFileSync(path.join(lanesDir, `${osName}.json`), JSON.stringify({ ...payload, laneSha256: digest(payload) }));
    }
    const out = path.join(temp, 'aggregate.json');
    const env = { ...process.env, RUVNET_SIGNING_KEY: signingKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const args = ['scripts/public-verification-aggregate.mjs', '--lanes', lanesDir, '--out', out];
    const first = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, '../..'), env, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(verifyPublicVerificationAggregate(JSON.parse(fs.readFileSync(out, 'utf8')), signingKeys.publicKey, identity)).toBeTruthy();
    const second = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, '../..'), env, encoding: 'utf8' });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/refusing to overwrite/);
  });
});
