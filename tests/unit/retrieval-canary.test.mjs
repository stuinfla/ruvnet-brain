import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { coverageGenerationFor, digest } from '../../scripts/coverage-integrity.mjs';
import { getVersionTag } from '../../scripts/version.mjs';
import {
  buildRetrievalCanaryPlan,
  runRetrievalCanaries,
  sealRetrievalQueryEvidence,
  validateRetrievalCanaryPlan,
  validateRetrievalCanaryReceipt,
  validatePlanAgainstCoverage,
  verifyQueryOracleSource,
} from '../../scripts/retrieval-canary.mjs';

const sourceSha = 'a'.repeat(40);
const artifactSha256 = 'b'.repeat(64);
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function fixture() {
  const stores = ['old-a', 'old-b', 'old-c', 'old-d', 'new-e', 'new-f'];
  const rows = stores.map((store) => ({
    key: `repo:ruvnet/${store}`, kind: 'repository', name: store, url: `https://example/${store}`,
    disposition: 'eligible', status: 'CURRENT', reasons: [], upstream: { sha: 'c'.repeat(40) },
    artifact: { store, rvfSha256: digest(store) },
  }));
  const enumerationReceipt = { schemaVersion: 1, owner: 'ruvnet', observedAt: '2026-08-22T00:00:00Z',
    requestParameters: {}, repositories: { expected: 6, pages: [] }, gists: { expected: 0, pages: [] },
    duplicateKeys: 0, terminal: true };
  const base = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet',
    observedAt: '2026-08-22T00:00:00Z', generatorSourceSha: digest('generator'),
    sourceObservationSha256: digest('observation'), snapshotRoot: digest('snapshot'),
    policy: { policyDispositionDigests: [], exemptionDigests: [] }, enumerationReceipt, rows,
    totals: { repositories: 6, gists: 0, rows: 6, byStatus: { CURRENT: 6 } } };
  const coverageGeneration = coverageGenerationFor({ generatorSourceSha: base.generatorSourceSha,
    snapshotRoot: base.snapshotRoot, sourceObservationSha256: base.sourceObservationSha256, rows,
    enumerationReceipt, policyDispositionDigests: [], exemptionDigests: [] });
  const coverage = { ...base, coverageGeneration };
  const baseline = { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline', tag: getVersionTag(),
    archiveSha256: '1'.repeat(64), archiveBytes: 1234, archiveManifestSha256: '2'.repeat(64),
    verificationReceiptSha256: '3'.repeat(64), stores: ['old-a', 'old-b', 'old-c', 'old-d'], storeCount: 4 };
  const coverageIdentity = { sha256: digest(coverage), bytes: Buffer.byteLength(JSON.stringify(coverage)) };
  const candidate = { sourceSha, packageSha256: artifactSha256, archiveSha256: '4'.repeat(64),
    coverageSha256: coverageIdentity.sha256,
    publicLedgerSha256: '5'.repeat(64), publicLedgerBytes: 4321, publicStoreCount: 6,
    publicInventoryPartitionSha256: '6'.repeat(64) };
  const passagesFor = (store) => Array.from({ length: stores.indexOf(store) + 1 }, (_, index) => ({
    id: `${store}-${index}`, path: `src/${store}-${index}.mjs`, title: `${store} architecture`,
    text: `The ${store} implementation owns a unique deterministic boundary and verifies its exact runtime behavior with source evidence number ${index}.` }));
  const queries = Object.fromEntries(stores.map((store) => {
    const passage = passagesFor(store)[0];
    const value = { query: `independently authored behavior question for ${store} runtime boundary`,
      expected: { path: passage.path, passageSha256: digest(passage) } };
    return [store, { ...value, recordSha256: digest({ store, ...value }) }];
  }));
  const queryEvidence = sealRetrievalQueryEvidence({
    schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence',
    sourceCommit: 'd'.repeat(40), sourcePath: 'data/retrieval-query-evidence.json',
    queryStoreSetSha256: digest([...stores].sort()), queries });
  const readPassages = (_dir, store) => passagesFor(store);
  return { coverage, coverageIdentity, baseline, candidate, queryEvidence, readPassages };
}

describe('coverage-derived retrieval canaries', () => {
  it('binds the canonical query payload to a strict Git ancestor without a self-hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-query-source-'));
    roots.push(root);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'retrieval-test@example.invalid');
    git(root, 'config', 'user.name', 'Retrieval Test');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, 'add', 'README.md'); git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');

    const sourcePath = 'data/retrieval-query-evidence.json';
    const expected = { path: 'src/alpha.mjs', passageSha256: digest('alpha passage') };
    const queries = { alpha: { query: 'independent alpha behavior question with source evidence', expected,
      recordSha256: digest({ store: 'alpha', query: 'independent alpha behavior question with source evidence', expected }) } };
    const sourcePayload = { schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence',
      queryStoreSetSha256: digest(['alpha']), queries };
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, sourcePath), `${JSON.stringify(sourcePayload)}\n`);
    fs.writeFileSync(path.join(root, 'data/external-query-evidence.json'), `${JSON.stringify(sourcePayload)}\n`);
    git(root, 'add', 'data'); git(root, 'commit', '-qm', 'freeze query source');
    const sourceCommit = git(root, 'rev-parse', 'HEAD');
    const evidence = sealRetrievalQueryEvidence({ ...sourcePayload, sourceCommit, sourcePath });
    expect(evidence.sourceBlobSha256).toBe(digest(sourcePayload));
    fs.writeFileSync(path.join(root, sourcePath), `${JSON.stringify(evidence)}\n`);
    git(root, 'add', sourcePath); git(root, 'commit', '-qm', 'bind frozen query source');
    const candidate = git(root, 'rev-parse', 'HEAD');

    expect(verifyQueryOracleSource(evidence, candidate, { cwd: root })).toBe(evidence);
    expect(() => verifyQueryOracleSource(evidence, sourceCommit, { cwd: root })).toThrow(/identity is invalid/);

    const moved = structuredClone(evidence);
    moved.queries.alpha.query += ' moved';
    moved.queries.alpha.recordSha256 = digest({ store: 'alpha', query: moved.queries.alpha.query,
      expected: moved.queries.alpha.expected });
    const resealedMoved = sealRetrievalQueryEvidence(moved);
    expect(() => verifyQueryOracleSource(resealedMoved, candidate, { cwd: root })).toThrow(/source payload differs/);

    const external = sealRetrievalQueryEvidence({ ...sourcePayload, sourceCommit,
      sourcePath: 'data/external-query-evidence.json' });
    expect(() => verifyQueryOracleSource(external, candidate, { cwd: root }))
      .toThrow(/differs from candidate tracked bytes/);

    git(root, 'checkout', '-qb', 'divergent', base);
    fs.writeFileSync(path.join(root, 'divergent.txt'), 'not descended from the source\n');
    git(root, 'add', 'divergent.txt'); git(root, 'commit', '-qm', 'divergent candidate');
    const divergent = git(root, 'rev-parse', 'HEAD');
    expect(() => verifyQueryOracleSource(evidence, divergent, { cwd: root })).toThrow(/strict candidate ancestor/);
  });

  it('includes every delta store and a deterministic legacy sample', () => {
    const input = fixture();
    const a = buildRetrievalCanaryPlan({ ...input, legacySampleSize: 4 });
    const b = buildRetrievalCanaryPlan({ ...input, legacySampleSize: 4 });
    expect(a).toEqual(b);
    expect(a.cases.filter(({ cohort }) => cohort === 'delta').map(({ expected }) => expected.repo)).toEqual(['new-e', 'new-f']);
    expect(a.cases.filter(({ cohort }) => cohort === 'legacy')).toHaveLength(4);
    expect(new Set(a.cases.filter(({ cohort }) => cohort === 'legacy').map(({ stratum }) => stratum)).size).toBe(4);
    expect(validateRetrievalCanaryPlan(a)).toBe(a);
  });

  it('binds a degraded observation denominator without making it candidate-verification eligible', () => {
    const input = fixture();
    input.baseline = { schemaVersion: 1, kind: 'ruvnet-brain-observed-failed-public-baseline',
      integrity: 'DEGRADED', historicalCorpusReceipt: false, candidateVerificationEligible: false,
      tag: input.baseline.tag, archiveSha256: input.baseline.archiveSha256,
      archiveBytes: input.baseline.archiveBytes, archiveManifestSha256: input.baseline.archiveManifestSha256,
      observationReceiptSha256: '7'.repeat(64), discrepancyDigest: '8'.repeat(64),
      ledgerDiscrepancies: [{ store: 'old-a', type: 'byte-identity-mismatch' }], provenanceGaps: ['old-a'],
      stores: input.baseline.stores, storeCount: input.baseline.storeCount };
    const plan = buildRetrievalCanaryPlan(input);
    expect(plan.baseline).toMatchObject({ integrity: 'DEGRADED', candidateVerificationEligible: false,
      observationReceiptSha256: '7'.repeat(64), discrepancyDigest: '8'.repeat(64) });
    expect(() => validatePlanAgainstCoverage(plan, input.coverage)).toThrow(/not candidate-verification eligible/i);
    expect(validatePlanAgainstCoverage(plan, input.coverage, { allowObservedBaseline: true })).toBe(plan);
    const tampered = structuredClone(plan);
    tampered.baseline.discrepancyDigest = '9'.repeat(64);
    expect(() => validateRetrievalCanaryPlan(tampered)).toThrow(/digest mismatch/);
  });

  it('fails closed when eligible coverage is stale or the failed-seed delta is absent', () => {
    const stale = fixture();
    stale.coverage.rows[0].status = 'STALE';
    expect(() => buildRetrievalCanaryPlan(stale)).toThrow(/coverage ledger is invalid|coverage is incomplete/);
    const noDelta = fixture();
    noDelta.baseline.stores.push('new-e', 'new-f');
    noDelta.baseline.storeCount = 6;
    expect(() => buildRetrievalCanaryPlan(noDelta)).toThrow(/both failed-seed delta and legacy cohorts/);
  });

  it('detects plan tampering and malformed source passages', () => {
    const input = fixture();
    const plan = buildRetrievalCanaryPlan({ ...input, legacySampleSize: 4 });
    plan.cases[0].query += ' tampered';
    expect(() => validateRetrievalCanaryPlan(plan)).toThrow(/malformed/);
    expect(() => buildRetrievalCanaryPlan({ ...input, readPassages: () => [] }))
      .toThrow(/no sealed independent query evidence/);
    expect(() => buildRetrievalCanaryPlan({ ...input, readPassages: (dir, store) => {
      const rows = input.readPassages(dir, store);
      return [structuredClone(rows[0]), ...rows];
    } })).toThrow(/no sealed independent query evidence/);
  });

  it('rejects duplicate queries and every broken expected-passage binding', () => {
    const duplicate = fixture();
    const first = duplicate.queryEvidence.queries['old-a'];
    duplicate.queryEvidence.queries['old-b'].query = first.query;
    duplicate.queryEvidence.queries['old-b'].recordSha256 = digest({ store: 'old-b', query: first.query,
      expected: duplicate.queryEvidence.queries['old-b'].expected });
    duplicate.queryEvidence = sealRetrievalQueryEvidence(duplicate.queryEvidence);
    expect(() => buildRetrievalCanaryPlan(duplicate)).toThrow(/malformed/);

    for (const mutate of [
      (row) => { delete row.expected; },
      (row) => { row.expected.path = 'src/missing.mjs'; },
      (row) => { row.expected.passageSha256 = '0'.repeat(64); },
    ]) {
      const input = fixture();
      const row = input.queryEvidence.queries['new-e'];
      mutate(row);
      if (row.expected) row.recordSha256 = digest({ store: 'new-e', query: row.query, expected: row.expected });
      input.queryEvidence = sealRetrievalQueryEvidence(input.queryEvidence);
      expect(() => buildRetrievalCanaryPlan(input)).toThrow(/malformed|no sealed independent query evidence/);
    }
  });

  it('rejects stale oracle receipts and downstream plan rehashes not backed by the sealed evidence', () => {
    const input = fixture();
    input.queryEvidence.queries['new-e'].query += ' stale';
    expect(() => buildRetrievalCanaryPlan(input)).toThrow(/malformed|digest mismatch/);

    const plan = buildRetrievalCanaryPlan({ ...fixture(), legacySampleSize: 4 });
    const row = plan.cases.find(({ expected }) => expected.repo === 'new-e');
    row.query = 'attacker authored unrelated banana query for the public runtime';
    row.oracleRecordSha256 = digest({ store: 'new-e', query: row.query,
      expected: { path: row.expected.path, passageSha256: row.expected.passageSha256 } });
    plan.planSha256 = digest(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planSha256')));
    expect(() => validateRetrievalCanaryPlan(plan)).toThrow(/malformed/);
  });

  it('rejects a non-canonical baseline kind even with a verification-shaped receipt', () => {
    const input = fixture();
    const plan = buildRetrievalCanaryPlan({ ...input, legacySampleSize: 4 });
    plan.baseline.kind = 'foreign-verification-shaped-baseline';
    plan.planSha256 = digest(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planSha256')));
    expect(() => validateRetrievalCanaryPlan(plan)).toThrow(/malformed/);
  });

  it('derives Recall@10 and delta citation rate from exact repo/path hits', async () => {
    const plan = buildRetrievalCanaryPlan({ ...fixture(), legacySampleSize: 4 });
    const receipt = await runRetrievalCanaries({ plan, sourceSha, artifactSha256,
      candidateArchiveSha256: plan.candidate.archiveSha256,
      search: async ({ query }) => {
        const expected = plan.cases.find((row) => row.query === query).expected;
        return { results: [{ repo: expected.repo, path: expected.path }] };
      }, citationResolver: async (_matched, expected) => ({ resolved: true,
        evidence: { passageSha256: expected.passageSha256, passageFileSha256: 'e'.repeat(64) } }) });
    expect(receipt.metrics).toMatchObject({ recallAt10: 1, deltaCitationRate: 1, unknown: 0, skipped: 0 });
    expect(validateRetrievalCanaryReceipt(receipt, { plan })).toBe(receipt);
  });

  it('keeps misses and search errors red and refuses forged metrics', async () => {
    const plan = buildRetrievalCanaryPlan({ ...fixture(), legacySampleSize: 4 });
    let call = 0;
    const receipt = await runRetrievalCanaries({ plan, sourceSha, artifactSha256,
      candidateArchiveSha256: plan.candidate.archiveSha256,
      search: async () => (++call === 1 ? { results: [] } : Promise.reject(new Error('worker unavailable'))),
      citationResolver: async () => ({ resolved: false }) });
    expect(receipt.metrics.recallAt10).toBe(0);
    expect(receipt.metrics.unknown).toBeGreaterThan(0);
    expect(() => validateRetrievalCanaryReceipt(receipt, { plan })).toThrow(/acceptance failed/);
    receipt.metrics.recallAt10 = 1;
    receipt.receiptSha256 = digest(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receiptSha256')));
    expect(() => validateRetrievalCanaryReceipt(receipt, { plan, requireAcceptance: false })).toThrow(/not derived/);
  });

  it('rejects denominator shrinkage and distinguishes rank ten from rank eleven', async () => {
    const plan = buildRetrievalCanaryPlan({ ...fixture(), legacySampleSize: 4 });
    const executeAtRank = (rank) => runRetrievalCanaries({ plan, sourceSha, artifactSha256,
      candidateArchiveSha256: plan.candidate.archiveSha256,
      search: async ({ query }) => {
        const expected = plan.cases.find((row) => row.query === query).expected;
        return Array.from({ length: 11 }, (_, index) => index === rank - 1 ? expected : { repo: `noise-${index}`, path: `n/${index}` });
      }, citationResolver: async (_matched, expected) => ({ resolved: true,
        evidence: { passageSha256: expected.passageSha256, passageFileSha256: 'e'.repeat(64) } }) });
    expect((await executeAtRank(10)).metrics.recallAt10).toBe(1);
    expect((await executeAtRank(11)).metrics.recallAt10).toBe(0);
    const shrunk = await executeAtRank(11);
    shrunk.cases.pop();
    shrunk.receiptSha256 = digest(Object.fromEntries(Object.entries(shrunk).filter(([key]) => key !== 'receiptSha256')));
    expect(() => validateRetrievalCanaryReceipt(shrunk, { plan, requireAcceptance: false })).toThrow(/denominator/);
  });
});
