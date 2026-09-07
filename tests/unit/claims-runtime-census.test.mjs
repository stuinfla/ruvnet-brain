import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as claims from '../../scripts/claims-verify.mjs';
import { digest, coverageGenerationFor, releaseCoverageGenerationFor, validatePublicInventory,
  validateCoverageDirectory } from '../../scripts/coverage-integrity.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const SHA = 'a'.repeat(40);
const VERSION = '9.9.9';
const write = (root, name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-candidate-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'alpha.big.rvf'), 'rvf');
  write(root, 'alpha.big.rvf.idmap.json', { idToLabel: { 0: 'a', 1: 'b' } });
  write(root, 'extra.big.rvf.idmap.json', { idToLabel: { 0: 'unqualified' } });
  write(root, 'PRIVATE-STORES.json', { privateStores: [] });
  write(root, 'public-store-classes.json', { schemaVersion: 1, derived: [] });
  const ledger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: VERSION, releaseTag: `v${VERSION}`, sourceSnapshot: SHA,
    stores: { alpha: { file: 'alpha.big.rvf', sha256: digest('rvf'), bytes: 3, model: 'fixture',
      dimensions: 384, sourceCommit: SHA, builtUtc: '2026-09-01T12:00:00Z' } } };
  write(root, 'PUBLIC-RVF-GENERATIONS.json', ledger);
  write(root, 'RVF-GENERATIONS.json', { ...ledger, kind: 'ruvnet-brain-runtime-generation-ledger' });
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage',
    sourceObservationSha256: '1'.repeat(64), generatorSourceSha: '2'.repeat(64), snapshotRoot: '3'.repeat(64),
    rows: [{ key: 'repo:fixture/alpha', kind: 'repository', name: 'alpha', url: 'https://example.invalid/alpha', disposition: 'eligible',
      status: 'CURRENT', upstream: { commit: SHA }, artifact: { store: 'alpha' }, reasons: [] }],
    totals: { repositories: 1, gists: 0, rows: 1, byStatus: { CURRENT: 1 } },
    enumerationReceipt: { schemaVersion: 1, terminal: true, duplicateKeys: 0,
      repositories: { expected: 1, pages: [] }, gists: { expected: 0, pages: [] } },
    policy: { policyDispositionDigests: [], exemptionDigests: [] } };
  corpus.coverageGeneration = coverageGenerationFor({ ...corpus, ...corpus.policy });
  write(root, 'CORPUS-COVERAGE.json', corpus);
  const coverage = { ...corpus, kind: 'ruvnet-brain-release-coverage',
    releaseIdentity: { version: VERSION, tag: `v${VERSION}`, sourceSnapshot: SHA },
    corpusSeed: { tag: 'v9.9.8', archiveSha256: '4'.repeat(64), archiveBytes: 10, receiptSha256: '5'.repeat(64) },
    corpusCoverage: { sha256: digest(JSON.stringify(corpus)), coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: digest(JSON.stringify(ledger)),
      bytes: Buffer.byteLength(JSON.stringify(ledger)), storeCount: 1 }, installedProjectionSchema: 2 };
  coverage.publicInventoryPartitionSha256 = validatePublicInventory({ assetsDir: root, coverage, ledger }).partitionSha256;
  coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(coverage);
  write(root, 'COVERAGE.json', coverage);
  const checked = validateCoverageDirectory(root, { expectedVersion: VERSION, expectedSourceSnapshot: SHA,
    requireCompleteProfile: true });
  expect(checked.failures).toEqual([]);
  return { candidateKb: root, candidateSha: SHA, candidateVersion: VERSION, diagnosticKb: root,
    privateStoresFile: path.join(root, 'PRIVATE-STORES.json') };
}

describe('runtime census requires explicit artifact qualification', () => {
  it('cannot qualify an ambient census even when its counts match advertising', async () => {
    const f = fixture();
    const rows = await claims.runLedger([{ id: 'chunk-count', verify: () => ({ status: 'PASS', evidence: 'ambient' }) }],
      { strict: true, runtimeCensus: { diagnosticKb: f.diagnosticKb, privateStoresFile: f.privateStoresFile } });
    expect(rows[0].status).toBe('SKIP');
    expect(rows[0].qualification).toBe('UNKNOWN');
    expect(rows[0].diagnostics.ambient.census).toMatchObject({ chunks: 3, publicStores: 2 });
    expect(claims.claimsVerdict(rows)).toBe('UNKNOWN');
  });

  it('counts validated membership, discloses extras, and keeps missing package/sidecar proof UNKNOWN', async () => {
    const f = fixture();
    const result = await claims.verifyRuntimeCensus(f);
    expect(result.status).toBe('SKIP');
    expect(result.provenance.projectionVerified).toBe(true);
    expect(result.provenance.candidate).toMatchObject({ sourceSha: SHA, version: VERSION });
    expect(result.provenance.candidate.coverageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.diagnostics.candidate).toEqual({ chunks: 2, publicStores: 1, extraSidecars: 1 });
    expect(result.untested).toContain('signed package/bundle-to-sidecar binding');
    expect(result.evidence).not.toContain('claims:fix');
  });

  it.each(['candidateSha', 'candidateVersion'])('rejects mismatched %s rather than blessing another release', async (key) => {
    const f = fixture();
    const result = await claims.verifyRuntimeCensus({ ...f, [key]: key === 'candidateSha' ? 'b'.repeat(40) : '9.9.8' });
    expect(result.status).toBe('FAIL');
    expect(result.provenance.projectionVerified).toBe(false);
  });

  it.each(['PUBLIC-RVF-GENERATIONS.json', 'alpha.big.rvf'])('rejects tampered %s through the existing validator', async (file) => {
    const f = fixture();
    fs.appendFileSync(path.join(f.candidateKb, file), ' ');
    expect((await claims.verifyRuntimeCensus(f)).status).toBe('FAIL');
  });

  it('does not claim sidecar integrity merely because public RVF membership validates', async () => {
    const f = fixture();
    write(f.candidateKb, 'alpha.big.rvf.idmap.json', { idToLabel: { 0: 'changed' } });
    const result = await claims.verifyRuntimeCensus(f);
    expect(result.status).toBe('SKIP');
    expect(result.diagnostics.candidate.chunks).toBe(1);
    expect(result.untested).toContain('signed package/bundle-to-sidecar binding');
  });

  it('retains ambient comparisons as diagnostics and preserves scope completeness semantics', async () => {
    const rows = await claims.runLedger([{ id: 'chunk-count', verify: () => ({ status: 'PASS', evidence: 'ambient' }) }]);
    expect(rows[0]).toMatchObject({ status: 'PASS', diagnostic: true, qualification: 'UNKNOWN' });
    expect(claims.claimsScope('runtime').complete).toBe(false);
    expect(claims.claimsScope('source').complete).toBe(false);
    expect(claims.claimsScope('all').complete).toBe(true);
  });

  it('passes candidate inputs through the real strict CLI without claiming completion', () => {
    const f = fixture();
    const script = fileURLToPath(new URL('../../scripts/claims-verify.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--strict', '--scope', 'runtime',
      '--candidate-kb', f.candidateKb, '--candidate-sha', f.candidateSha,
      '--candidate-version', f.candidateVersion], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, RUVNET_BRAIN_KB: f.candidateKb } });
    expect(result.status).toBe(4);
    const receipt = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{')));
    expect(receipt).toMatchObject({ scope: 'runtime', complete: false, verdict: 'UNKNOWN', scopeVerdict: 'UNKNOWN' });
    expect(receipt.rows.find((row) => row.id === 'chunk-count').provenance.projectionVerified).toBe(true);
  });

  it('rejects strict fix before any advertising mutation', () => {
    const script = fileURLToPath(new URL('../../scripts/claims-verify.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--strict', '--fix'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot rewrite advertising');
  });
});
