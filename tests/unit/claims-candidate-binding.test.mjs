import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyRuntimeCensus, CHUNK_SURFACES } from '../../scripts/claims-verify.mjs';
import { createPayloadManifest, payloadIdFor, signPayloadManifest } from '../../scripts/release-payload.mjs';
import { digest, coverageGenerationFor, releaseCoverageGenerationFor, validatePublicInventory } from '../../scripts/coverage-integrity.mjs';
import { writeStoredZip } from '../helpers/zip-fixture.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const write = (root, name, value) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(claimText = '2 chunks, 1 public stores, 1 built stores') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claims-bound-'))); roots.push(root);
  const source = path.join(root, 'source'), kb = path.join(root, 'kb'); fs.mkdirSync(source); fs.mkdirSync(kb);
  write(source, 'package.json', { version: '9.9.9' });
  for (const surface of CHUNK_SURFACES) write(source, surface, claimText);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'candidate');
  const sha = git('rev-parse', 'HEAD');
  write(kb, 'alpha.big.rvf', 'rvf'); write(kb, 'alpha.big.rvf.idmap.json', { idToLabel: { 0: 'a', 1: 'b' } });
  write(kb, 'PRIVATE-STORES.json', { privateStores: [] }); write(kb, 'public-store-classes.json', { schemaVersion: 1, derived: [] });
  const ledger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger', brainVersion: '9.9.9', releaseTag: 'v9.9.9',
    sourceSnapshot: sha, stores: { alpha: { file: 'alpha.big.rvf', sha256: digest('rvf'), bytes: 3, model: 'fixture',
      dimensions: 384, sourceCommit: sha, builtUtc: '2026-09-01T12:00:00Z' } } };
  write(kb, 'PUBLIC-RVF-GENERATIONS.json', ledger); write(kb, 'RVF-GENERATIONS.json', { ...ledger, kind: 'ruvnet-brain-runtime-generation-ledger' });
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', sourceObservationSha256: '1'.repeat(64),
    generatorSourceSha: '2'.repeat(64), snapshotRoot: '3'.repeat(64), rows: [{ key: 'repo:fixture/alpha', kind: 'repository',
      name: 'alpha', url: 'https://example.invalid/alpha', disposition: 'eligible', status: 'CURRENT', upstream: { commit: sha },
      artifact: { store: 'alpha' }, reasons: [] }], totals: { repositories: 1, gists: 0, rows: 1, byStatus: { CURRENT: 1 } },
    enumerationReceipt: { schemaVersion: 1, terminal: true, duplicateKeys: 0, repositories: { expected: 1, pages: [] }, gists: { expected: 0, pages: [] } },
    policy: { policyDispositionDigests: [], exemptionDigests: [] } };
  corpus.coverageGeneration = coverageGenerationFor({ ...corpus, ...corpus.policy }); write(kb, 'CORPUS-COVERAGE.json', corpus);
  const coverage = { ...corpus, kind: 'ruvnet-brain-release-coverage', releaseIdentity: { version: '9.9.9', tag: 'v9.9.9', sourceSnapshot: sha },
    corpusSeed: { tag: 'v9.9.8', archiveSha256: '4'.repeat(64), archiveBytes: 10, receiptSha256: '5'.repeat(64) },
    corpusCoverage: { sha256: digest(JSON.stringify(corpus)), coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: digest(JSON.stringify(ledger)), bytes: Buffer.byteLength(JSON.stringify(ledger)), storeCount: 1 }, installedProjectionSchema: 2 };
  coverage.publicInventoryPartitionSha256 = validatePublicInventory({ assetsDir: kb, coverage, ledger }).partitionSha256;
  coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(coverage); write(kb, 'COVERAGE.json', coverage);
  const bundle = path.join(root, 'bundle.zip');
  writeStoredZip({ archiveFile: bundle, entries: fs.readdirSync(kb).map((name) => ({ name: `ruvnet-brain/${name}`, data: fs.readFileSync(path.join(kb, name)) })) });
  const npm = path.join(root, 'candidate.tgz'); fs.writeFileSync(npm, 'exact opaque package member');
  const manifest = createPayloadManifest({ version: '9.9.9', tag: 'v9.9.9', candidateSha: sha, producer: { runId: 'fixture' },
    members: [{ name: 'bundle.zip', role: 'bundle', file: bundle }, { name: 'candidate.tgz', role: 'npm', file: npm }] });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  write(root, 'payload.json', manifest); write(root, 'payload.sig', signPayloadManifest(manifest, privateKey));
  return { candidateKb: kb, candidateSha: sha, candidateVersion: '9.9.9', candidateRoot: source,
    diagnosticKb: kb, privateStoresFile: path.join(kb, 'PRIVATE-STORES.json'), payloadManifest: path.join(root, 'payload.json'),
    payloadSignature: path.join(root, 'payload.sig'), payloadId: payloadIdFor(manifest), publicKey, root, git };
}

it('qualifies signed exact public sidecars and candidate-bound advertising without ambient extras', async () => {
  const f = fixture(); write(f.candidateKb, 'ambient.big.rvf.idmap.json', { idToLabel: { 0: 'not-public' } });
  const result = await verifyRuntimeCensus(f);
  expect(result).toMatchObject({ status: 'PASS', qualification: 'signed-candidate', diagnostic: false });
  expect(result.provenance.artifacts).toMatchObject({ payloadId: f.payloadId, signatureVerified: true, sidecarsVerified: 1 });
  expect(result.diagnostics.candidate).toEqual({ chunks: 2, publicStores: 1, extraSidecars: 1 });
});
it('permits explicit staged exact-byte qualification without claiming signed public proof', async () => {
  const f = fixture(); const result = await verifyRuntimeCensus({ ...f, payloadSignature: null, qualificationMode: 'staged' });
  expect(result).toMatchObject({ status: 'PASS', qualification: 'staged-candidate' });
  expect(result.provenance.artifacts.signatureVerified).toBe(false);
  expect(result.untested).toContain('signed public publication proof');
});
it('fails stale advertising in a clean exact candidate without rewriting it', async () => {
  const f = fixture('99 chunks, 1 public stores, 1 built stores');
  const result = await verifyRuntimeCensus(f);
  expect(result.status).toBe('FAIL');
  expect(result.evidence).toContain('candidate chunk count absent');
  expect(fs.readFileSync(path.join(f.candidateRoot, 'README.md'), 'utf8')).toContain('99 chunks');
  expect(f.git('status', '--porcelain')).toBe('');
});
it('plumbs staged identities through the real strict CLI while keeping scope completeness honest', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../scripts/claims-verify.mjs'),
    '--strict', '--scope', 'runtime', '--qualification-mode', 'staged', '--candidate-kb', f.candidateKb,
    '--candidate-root', f.candidateRoot, '--candidate-sha', f.candidateSha, '--candidate-version', f.candidateVersion,
    '--payload-manifest', f.payloadManifest, '--payload-id', f.payloadId],
  { encoding: 'utf8', env: { ...process.env, RUVNET_BRAIN_KB: f.candidateKb }, timeout: 10_000 });
  expect(result.status, result.stderr || result.stdout).toBe(4); // Other runtime claims remain unmeasured in this fixture.
  const receipt = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{')));
  expect(receipt).toMatchObject({ scope: 'runtime', complete: false, verdict: 'UNKNOWN', scopeVerdict: 'UNKNOWN' });
  expect(receipt.rows.find((row) => row.id === 'chunk-count')).toMatchObject({ qualification: 'staged-candidate', status: 'PASS' });
});
it.each(['payloadManifest', 'payloadSignature', 'payloadId', 'candidateRoot'])('keeps missing %s UNKNOWN', async (key) => {
  const result = await verifyRuntimeCensus({ ...fixture(), [key]: null });
  expect(result).toMatchObject({ status: 'SKIP', qualification: 'UNKNOWN' });
});
it.each(['sidecar', 'bundle', 'package', 'signature', 'payload-id', 'wrong-key', 'dirty-source'])('rejects %s mismatch', async (kind) => {
  const f = fixture();
  if (kind === 'sidecar') write(f.candidateKb, 'alpha.big.rvf.idmap.json', { idToLabel: { 0: 'changed' } });
  if (kind === 'bundle') fs.appendFileSync(path.join(f.root, 'bundle.zip'), 'mutation');
  if (kind === 'package') fs.appendFileSync(path.join(f.root, 'candidate.tgz'), 'mutation');
  if (kind === 'signature') write(f.root, 'payload.sig', 'not-a-signature');
  if (kind === 'payload-id') f.payloadId = '0'.repeat(64);
  if (kind === 'wrong-key') f.publicKey = crypto.generateKeyPairSync('ed25519').publicKey;
  if (kind === 'dirty-source') write(f.candidateRoot, 'README.md', 'wrong 99 chunks');
  expect((await verifyRuntimeCensus(f)).status).toBe('FAIL');
});
