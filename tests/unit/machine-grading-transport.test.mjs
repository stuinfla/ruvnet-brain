import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { transactionIdFor } from '../../scripts/release-transaction.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { createIndependentReviewReceipt, validateIndependentReviewPair } from '../../scripts/independent-review-receipt.mjs';
import { encodeGradingInputs, decodeGradingInputs, MAX_DISPATCH_BYTES, MAX_REVIEW_BYTES } from '../../scripts/machine-grading-transport.mjs';

// Synthetic judgments and ephemeral keys are test fixtures, never product grading evidence.
const oracle = JSON.parse(fs.readFileSync('data/retrieval-query-evidence.json', 'utf8'));
const records = Object.entries(oracle.queries).sort(([a], [b]) => a.localeCompare(b)).map(([store, row]) => ({
  store, oracleRecordSha256: row.recordSha256, relevant: true, verdict: 'PASS',
  evidence: [`fixture:data/retrieval-query-evidence.json#${store}`], untested: [],
}));
const version = getVersion();
const identity = { repository: 'stuinfla/ruvnet-brain', package: 'ruvnet-brain', version, tag: `v${version}`,
  candidateSha: 'a'.repeat(40), payloadId: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64),
  packageIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`, packageSha256: 'd'.repeat(64), bundleSha256: 'e'.repeat(64) };
identity.transactionId = transactionIdFor(identity);
const keys = ['claude-fable-5-1', 'gpt-6-astra'].map((id) => ({ id, ...crypto.generateKeyPairSync('ed25519') }));
const receipts = keys.map(({ id, privateKey }, index) => createIndependentReviewReceipt({
  id, model: id, provider: index ? 'openai' : 'firstParty', subjectProducerIdentity: 'fixture-release-builder',
  sourceSha: identity.candidateSha, sourceTree: 'f'.repeat(40), artifactSha256: identity.packageSha256,
  payloadId: identity.payloadId, payloadSha256: '1'.repeat(64), releaseIdentity: identity,
  productContractSha256: '2'.repeat(64), rubricSha256: '3'.repeat(64), independent: true,
  verdict: 'PASS', score: 100, findings: [], deductions: [], untested: [], reviewedAt: '2026-09-18T00:00:00.000Z',
  execution: { nativeHost: index ? 'codex' : 'claude-code', subscriptionAuthenticated: true,
    invocationDigest: '4'.repeat(64), requestedModel: id, modelIdentityClass: 'requested-only',
    threadId: index ? 'fixture-thread' : null, sessionId: index ? null : 'fixture-session' },
  retrievalOracleReview: { schemaVersion: 1, kind: 'ruvnet-brain-retrieval-oracle-semantic-review',
    oracleReceiptSha256: oracle.receiptSha256, queryStoreSetSha256: digest(records.map(({ store }) => store)),
    recordCount: records.length, recordSetSha256: digest(records.map(({ store, oracleRecordSha256 }) => ({ store, oracleRecordSha256 }))),
    records, verdict: 'PASS', untested: [] },
}, privateKey));
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const documents = { fable_receipt_b64: json(receipts[0]), astra_receipt_b64: json(receipts[1]), release_identity_b64: json(identity) };
const envelope = () => encodeGradingInputs(identity.candidateSha, documents);
const trust = Object.fromEntries(keys.map(({ id, publicKey }) => [id, publicKey]));
const verify = (decoded, publicKeysByReviewer = trust, expectedIdentity = identity) => validateIndependentReviewPair([
  JSON.parse(decoded.fable_receipt_b64), JSON.parse(decoded.astra_receipt_b64),
], { publicKeysByReviewer, expectedIdentity });
const mutate = (bytes) => ({ ...envelope(), fable_receipt_b64: bytes.toString('base64') });
const temp = [];
afterEach(() => { for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('bounded machine grading transport', () => {
  it('fits the complete current store set and preserves both signatures and every input byte', () => {
    expect(records.length).toBeGreaterThanOrEqual(200);
    const oldSize = Object.values(documents).reduce((n, bytes) => n + bytes.toString('base64').length, 40);
    expect(oldSize).toBeGreaterThan(MAX_DISPATCH_BYTES);
    const packed = envelope();
    expect(Object.values(packed).reduce((n, value) => n + Buffer.byteLength(value), 0)).toBeLessThanOrEqual(MAX_DISPATCH_BYTES);
    const decoded = decodeGradingInputs(packed);
    expect(decoded).toEqual(documents);
    expect(() => verify(decoded)).not.toThrow();
  });
  it.each(['', 'main', 'A'.repeat(40), 'a'.repeat(39)])('rejects invalid candidate SHA %s', (sha) => {
    expect(() => encodeGradingInputs(sha, documents)).toThrow(/candidate SHA/);
    expect(() => decodeGradingInputs({ ...envelope(), candidate_sha: sha })).toThrow(/candidate SHA/);
  });
  it('rejects oversized encoded input before decoding and oversized plain input before encoding', () => {
    expect(() => decodeGradingInputs({ ...envelope(), fable_receipt_b64: 'x'.repeat(MAX_DISPATCH_BYTES) })).toThrow(/input budget/);
    expect(() => encodeGradingInputs(identity.candidateSha, { ...documents, fable_receipt_b64: Buffer.alloc(MAX_REVIEW_BYTES + 1) })).toThrow(/byte limit/);
  });
  it('bounds decompression even when the encoded expansion bomb is small', () => {
    const packed = gzipSync(Buffer.alloc(MAX_REVIEW_BYTES + 1, 32));
    expect(packed.length).toBeLessThan(60000);
    expect(() => decodeGradingInputs(mutate(packed))).toThrow();
  });
  it.each(['!', 'e30=\n', 'e30', 'e31='])('rejects noncanonical base64 %s', (value) => {
    expect(() => decodeGradingInputs({ ...envelope(), fable_receipt_b64: value })).toThrow(/canonical base64/);
  });
  it('rejects plain legacy inputs, truncated gzip, corrupt CRC, concatenated members and trailing data', () => {
    const valid = gzipSync(Buffer.from('{}'));
    const crc = Buffer.from(valid); crc[crc.length - 8] ^= 1;
    for (const invalid of [Buffer.from('{}'), valid.subarray(0, -1), crc,
      Buffer.concat([valid, gzipSync(Buffer.from(' '))]), Buffer.concat([valid, Buffer.from([0])])]) {
      expect(() => decodeGradingInputs(mutate(invalid))).toThrow();
    }
  });
  it('rejects invalid JSON, non-object JSON, and invalid UTF-8', () => {
    for (const bytes of [Buffer.from('{'), Buffer.from('[]'), Buffer.from('null'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
      expect(() => decodeGradingInputs(mutate(gzipSync(bytes)))).toThrow();
    }
  });
  it('keeps tampered signatures, changed identities, wrong keys and absent keys rejected', () => {
    const decoded = decodeGradingInputs(envelope());
    const tampered = JSON.parse(decoded.fable_receipt_b64); tampered.reviewedAt = '2026-09-17T00:00:00.000Z';
    expect(() => verify({ ...decoded, fable_receipt_b64: json(tampered) })).toThrow(/digest|signature/);
    expect(() => verify(decoded, trust, { ...identity, evidenceDigest: '9'.repeat(64) })).toThrow(/identity/);
    expect(() => verify(decoded, { ...trust, [keys[0].id]: keys[1].publicKey })).toThrow(/key identity/);
    for (const { id } of keys) for (const absent of ['', undefined]) {
      expect(() => verify(decoded, { ...trust, [id]: absent })).toThrow(/public key is missing/);
    }
  });
  it('runs the actual workflow decoder and pair validator with exact fixture bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-intake-')); temp.push(dir);
    const workflow = YAML.parse(fs.readFileSync('.github/workflows/machine-grading-intake.yml', 'utf8'));
    const step = workflow.jobs.intake.steps.find((s) => s.name === 'Validate local signed pair against exact candidate');
    expect(step.run).not.toContain('base64 --decode');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync('scripts/machine-grading-transport.mjs', path.join(dir, 'scripts/machine-grading-transport.mjs'));
    fs.symlinkSync(path.resolve('scripts/independent-review-receipt.mjs'), path.join(dir, 'scripts/independent-review-receipt.mjs'));
    const packed = envelope();
    const result = spawnSync('bash', ['-c', step.run], { cwd: dir, encoding: 'utf8', env: { ...process.env,
      CANDIDATE_SHA: packed.candidate_sha, FABLE_B64: packed.fable_receipt_b64, ASTRA_B64: packed.astra_receipt_b64,
      IDENTITY_B64: packed.release_identity_b64, FABLE_PUBLIC_KEY: keys[0].publicKey.export({ type: 'spki', format: 'pem' }),
      ASTRA_PUBLIC_KEY: keys[1].publicKey.export({ type: 'spki', format: 'pem' }) } });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'reviews/claude-fable-5-1.json'))).toEqual(documents.fable_receipt_b64);
    expect(fs.readFileSync(path.join(dir, 'reviews/gpt-6-astra.json'))).toEqual(documents.astra_receipt_b64);
    expect(fs.readFileSync(path.join(dir, 'release-identity.json'))).toEqual(documents.release_identity_b64);
  });
});
