import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, digest } from '../../scripts/coverage-integrity.mjs';
import { transactionIdFor } from '../../scripts/release-transaction.mjs';
import { validateIndependentReviewReceipt as validateAggregateReviewReceipt } from '../../scripts/public-verification-aggregate.mjs';
import {
  ALLOWED_INDEPENDENT_REVIEWERS,
  createIndependentReviewReceipt,
  main,
  validateIndependentReviewPair,
  verifyIndependentReviewReceipt,
} from '../../scripts/independent-review-receipt.mjs';

const fableKeys = crypto.generateKeyPairSync('ed25519');
const solKeys = crypto.generateKeyPairSync('ed25519');
const strangerKeys = crypto.generateKeyPairSync('ed25519');

const release = {
  repository: 'stuinfla/ruvnet-brain',
  package: 'ruvnet-brain',
  version: '4.2.2-dev',
  tag: 'v4.2.2-dev',
  candidateSha: 'a'.repeat(40),
  payloadId: 'b'.repeat(64),
  evidenceDigest: 'c'.repeat(64),
  packageIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  packageSha256: 'd'.repeat(64),
  packageAssetName: 'ruvnet-brain-4.2.2-dev.tgz',
  bundleSha256: 'e'.repeat(64),
  bundleSignatureSha256: 'f'.repeat(64),
  bundleDigestSha256: '1'.repeat(64),
};
release.transactionId = transactionIdFor(release);

const common = {
  subjectProducerIdentity: 'ruvnet-brain-release-builder',
  sourceSha: release.candidateSha,
  sourceTree: '2'.repeat(40),
  artifactSha256: release.packageSha256,
  payloadId: release.payloadId,
  payloadSha256: '3'.repeat(64),
  releaseIdentity: release,
  productContractSha256: '4'.repeat(64),
  rubricSha256: '5'.repeat(64),
  independent: true,
  verdict: 'PASS',
  score: 97,
  findings: [
    { code: 'F-002', severity: 'minor', summary: 'One documentation caveat', evidence: ['docs/adr/0072-whole-product-integrity-conformance.md:149'] },
    { code: 'F-001', severity: 'info', summary: 'Mechanical evidence is bound', evidence: ['scripts/product-integrity-contract.mjs'] },
  ],
  deductions: [
    { code: 'D-002', points: 1, reason: 'Public receipt wiring is not part of this review', evidence: ['scripts/public-verification-aggregate.mjs'] },
    { code: 'D-001', points: 2, reason: 'One public host remains outside this review', evidence: ['docs/adr/0072-whole-product-integrity-conformance.md'] },
  ],
  untested: [],
  reviewedAt: '2026-08-22T16:00:00.000Z',
};

function fableInput(overrides = {}) {
  return {
    ...common,
    id: 'claude-fable-5',
    model: 'claude-fable-5',
    provider: 'firstParty',
    execution: { subscriptionAuthenticated: true, invocationDigest: '6'.repeat(64) },
    ...overrides,
  };
}

function fable(overrides = {}) {
  return createIndependentReviewReceipt(fableInput(overrides), fableKeys.privateKey);
}

function sol(overrides = {}) {
  return createIndependentReviewReceipt({
    ...common,
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    provider: 'openai',
    execution: {
      subscriptionAuthenticated: true,
      invocationDigest: '7'.repeat(64),
      threadId: 'thread-adr072-review',
      catalogRowSha256: '8'.repeat(64),
    },
    ...overrides,
  }, solKeys.privateKey);
}

const publicKeys = () => ({
  'claude-fable-5': fableKeys.publicKey,
  'gpt-5.6-sol': solKeys.publicKey,
});

function sink() {
  let value = '';
  return { write: (chunk) => { value += chunk; }, read: () => value };
}

describe('independent review receipt', () => {
  it('deterministically signs the exact source, payload, release, rubric, findings, and timestamp', () => {
    const first = fable();
    const reordered = fable({
      findings: [...common.findings].reverse(),
      deductions: [...common.deductions].reverse(),
    });

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      schemaVersion: 1,
      kind: 'ruvnet-brain-independent-review',
      id: 'claude-fable-5',
      model: 'claude-fable-5',
      sourceSha: release.candidateSha,
      sourceTree: '2'.repeat(40),
      payloadId: release.payloadId,
      payloadSha256: '3'.repeat(64),
      artifactSha256: release.packageSha256,
      releaseIdentity: { transactionId: release.transactionId },
      reviewedAt: '2026-08-22T16:00:00.000Z',
      signatureAlgorithm: 'Ed25519',
    });
    expect(first.findings.map(({ code }) => code)).toEqual(['F-001', 'F-002']);
    expect(first.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(first.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyIndependentReviewReceipt(first, fableKeys.publicKey)).toBe(first);
    expect(verifyIndependentReviewReceipt(first,
      fableKeys.publicKey.export({ type: 'spki', format: 'pem' }))).toBe(first);
    expect(validateAggregateReviewReceipt(first)).toBe(first);
    const releaseWithoutOptionalAsset = { ...release };
    delete releaseWithoutOptionalAsset.packageAssetName;
    releaseWithoutOptionalAsset.transactionId = transactionIdFor(releaseWithoutOptionalAsset);
    expect(fable({ releaseIdentity: releaseWithoutOptionalAsset }).releaseIdentity.packageAssetName).toBeUndefined();
  });

  it.each([
    ['source tree', (row) => { row.sourceTree = '9'.repeat(40); }, /receipt digest mismatch|signature mismatch/],
    ['payload bytes', (row) => { row.payloadSha256 = '9'.repeat(64); }, /receipt digest mismatch|signature mismatch/],
    ['release version', (row) => { row.releaseIdentity.version = '9.9.9'; }, /release tag|receipt digest mismatch|release transaction identity/],
    ['finding', (row) => { row.findings[0].summary = 'rewritten'; }, /receipt digest mismatch/],
    ['timestamp', (row) => { row.reviewedAt = '2026-08-23T16:00:00.000Z'; }, /receipt digest mismatch/],
  ])('rejects tampered %s', (_label, mutate, expected) => {
    const receipt = structuredClone(fable());
    mutate(receipt);
    expect(() => verifyIndependentReviewReceipt(receipt, fableKeys.publicKey)).toThrow(expected);
  });

  it('rejects the wrong key, unknown fields, non-Ed25519 keys, and malformed timestamps', () => {
    expect(() => verifyIndependentReviewReceipt(fable(), strangerKeys.publicKey)).toThrow(/signing key identity|signature mismatch/);
    expect(() => createIndependentReviewReceipt({ ...common, id: 'claude-fable-5', model: 'claude-fable-5', provider: 'firstParty',
      execution: { subscriptionAuthenticated: true, invocationDigest: '6'.repeat(64) }, unsignedEscape: true }, fableKeys.privateKey))
      .toThrow(/unknown field/);
    expect(() => fable({ reviewedAt: '2026-08-22' })).toThrow(/timestamp/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => createIndependentReviewReceipt({ ...common, id: 'claude-fable-5', model: 'claude-fable-5', provider: 'firstParty',
      execution: { subscriptionAuthenticated: true, invocationDigest: '6'.repeat(64) } }, rsa.privateKey)).toThrow(/Ed25519/);
  });

  it('fails closed across malformed schema, nested evidence, key, signature, and canonicalization boundaries', () => {
    const missing = fableInput();
    delete missing.reviewedAt;
    expect(() => createIndependentReviewReceipt(null, fableKeys.privateKey)).toThrow(/plain object/);
    expect(() => createIndependentReviewReceipt(missing, fableKeys.privateKey)).toThrow(/missing field/);
    expect(() => fable({ subjectProducerIdentity: '' })).toThrow(/producer identity/);
    expect(() => fable({ sourceTree: 'not-a-tree' })).toThrow(/source tree/);
    expect(() => fable({ untested: null })).toThrow(/untested scope.*array/);
    expect(() => fable({ untested: ['same', 'same'], verdict: 'FAIL' })).toThrow(/duplicates/);
    expect(() => fable({ findings: null })).toThrow(/findings.*array/);
    expect(() => fable({ findings: [{ ...common.findings[0], severity: 'unknown' }] })).toThrow(/severity/);
    expect(() => fable({ findings: [common.findings[0], { ...common.findings[0] }] })).toThrow(/duplicate codes/);
    expect(() => fable({ findings: [{ ...common.findings[0], evidence: [] }] })).toThrow(/evidence.*array/);
    expect(() => fable({ deductions: null })).toThrow(/deductions.*array/);
    expect(() => fable({ deductions: [{ ...common.deductions[0], points: 0 }] })).toThrow(/points/);
    expect(() => fable({ deductions: [common.deductions[0], { ...common.deductions[0] }] })).toThrow(/duplicate codes/);
    expect(() => fable({ execution: { subscriptionAuthenticated: false, invocationDigest: '6'.repeat(64) } }))
      .toThrow(/not subscription authenticated/);
    expect(() => fable({ independent: false })).toThrow(/independent execution/);
    expect(() => fable({ verdict: 'UNKNOWN' })).toThrow(/verdict/);
    expect(() => fable({ verdict: 'FAIL' })).toThrow(/no acceptance blocker/);
    expect(() => createIndependentReviewReceipt(fableInput(), 'not-a-private-key')).toThrow(/private key is invalid/);

    const schemaDrift = structuredClone(fable());
    schemaDrift.schemaVersion = 2;
    expect(() => verifyIndependentReviewReceipt(schemaDrift, fableKeys.publicKey)).toThrow(/schema/);
    const noncanonical = structuredClone(fable());
    noncanonical.findings.reverse();
    expect(() => verifyIndependentReviewReceipt(noncanonical, fableKeys.publicKey)).toThrow(/not canonical/);
    const releaseDigestDrift = structuredClone(fable());
    releaseDigestDrift.releaseIdentitySha256 = '9'.repeat(64);
    expect(() => verifyIndependentReviewReceipt(releaseDigestDrift, fableKeys.publicKey)).toThrow(/release identity digest/);
    const malformedSignature = structuredClone(fable());
    malformedSignature.signature = '';
    expect(() => verifyIndependentReviewReceipt(malformedSignature, fableKeys.publicKey)).toThrow(/signature is malformed/);

    const forged = structuredClone(fable());
    const { receiptSha256: _receiptSha256, signature: _signature, ...payload } = forged;
    forged.signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), strangerKeys.privateKey).toString('base64');
    forged.receiptSha256 = digest({ ...payload, signature: forged.signature });
    expect(() => verifyIndependentReviewReceipt(forged, fableKeys.publicKey)).toThrow(/signature mismatch/);
  });

  it('derives score from deductions and keeps a failing review as signed evidence', () => {
    expect(() => fable({ score: 98 })).toThrow(/score.*deductions/);
    expect(() => fable({ verdict: 'PASS', untested: ['real Windows host'] })).toThrow(/PASS.*untested/);
    const failed = fable({ verdict: 'FAIL', score: 95, deductions: [{ ...common.deductions[0], points: 5 }],
      untested: ['real Windows host'] });
    expect(verifyIndependentReviewReceipt(failed, fableKeys.publicKey).verdict).toBe('FAIL');
  });

  it('enforces the live allowed reviewer/provider/execution contracts', () => {
    expect(ALLOWED_INDEPENDENT_REVIEWERS).toEqual([
      { identity: 'claude-fable-5', model: 'claude-fable-5', provider: 'firstParty' },
      { identity: 'gpt-5.6-sol', model: 'gpt-5.6-sol', provider: 'openai' },
    ]);
    expect(() => fable({ provider: 'openai' })).toThrow(/reviewer identity.*model.*provider/);
    expect(() => sol({ execution: { subscriptionAuthenticated: true, invocationDigest: '7'.repeat(64) } }))
      .toThrow(/thread.*catalog/);
    expect(() => fable({ id: 'unknown-reviewer', model: 'unknown-reviewer' })).toThrow(/reviewer identity/);
  });

  it('rejects release drift and self-review before signing', () => {
    expect(() => fable({ subjectProducerIdentity: 'claude-fable-5' })).toThrow(/self-review/);
    expect(() => fable({ artifactSha256: '9'.repeat(64) })).toThrow(/release identity/);
    expect(() => fable({ releaseIdentity: { ...release, transactionId: '9'.repeat(64) } })).toThrow(/release transaction identity/);
    expect(() => fable({ releaseIdentity: { ...release, tag: 'v9.9.9' } })).toThrow(/release tag|release transaction identity/);
  });
});

describe('independent review pair', () => {
  it('requires and deterministically orders both distinct signed allowed reviewers', () => {
    const result = validateIndependentReviewPair([sol(), fable()], { publicKeysByReviewer: publicKeys() });
    expect(result.map(({ id }) => id)).toEqual(['claude-fable-5', 'gpt-5.6-sol']);
    expect(validateIndependentReviewPair([sol(), fable()], {
      publicKeysByReviewer: new Map(Object.entries(publicKeys())),
    }).map(({ id }) => id)).toEqual(['claude-fable-5', 'gpt-5.6-sol']);
  });

  it('rejects duplicate, missing, mismatched, self, failing, and wrong-key review evidence', () => {
    const otherRelease = { ...release, packageAssetName: 'different-package.tgz' };
    otherRelease.transactionId = transactionIdFor(otherRelease);
    expect(() => validateIndependentReviewPair([fable(), fable()], { publicKeysByReviewer: publicKeys() })).toThrow(/distinct allowed reviewers/);
    expect(() => validateIndependentReviewPair([fable()], { publicKeysByReviewer: publicKeys() })).toThrow(/exactly two/);
    expect(() => validateIndependentReviewPair([fable(), sol({ sourceTree: '9'.repeat(40) })], { publicKeysByReviewer: publicKeys() }))
      .toThrow(/reviewed identity differs/);
    expect(() => validateIndependentReviewPair([fable(), sol({ releaseIdentity: otherRelease })], { publicKeysByReviewer: publicKeys() }))
      .toThrow(/reviewed identity differs/);
    expect(() => validateIndependentReviewPair([fable(), sol({ verdict: 'FAIL', score: 95,
      deductions: [{ ...common.deductions[0], points: 5 }], untested: ['real Windows host'] })],
    { publicKeysByReviewer: publicKeys() })).toThrow(/passing reviews/);
    expect(() => validateIndependentReviewPair([fable(), sol()], { publicKeysByReviewer: {
      ...publicKeys(), 'gpt-5.6-sol': strangerKeys.publicKey } })).toThrow(/signing key identity|signature mismatch/);
    expect(() => validateIndependentReviewPair([fable(), sol()], {
      publicKeysByReviewer: { 'claude-fable-5': fableKeys.publicKey },
    })).toThrow(/public key is missing/);
    expect(() => validateIndependentReviewPair([fable(), sol()], { publicKeysByReviewer: null }))
      .toThrow(/public key is missing/);
    expect(() => validateIndependentReviewPair([fable(), sol()], {
      publicKeysByReviewer: publicKeys(), expectedIdentity: {},
    })).toThrow(/expected reviewed identity/);
  });
});

describe('independent review receipt CLI', () => {
  it('produces create-only reviewer receipts and verifies individual and paired artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-review-cli-'));
    const fableInputFile = path.join(root, 'fable-input.json');
    const solInputFile = path.join(root, 'sol-input.json');
    const fableReceipt = path.join(root, 'fable-receipt.json');
    const solReceipt = path.join(root, 'sol-receipt.json');
    const fablePublic = path.join(root, 'fable-public.pem');
    const solPublic = path.join(root, 'sol-public.pem');
    fs.writeFileSync(fableInputFile, JSON.stringify(fableInput()));
    fs.writeFileSync(solInputFile, JSON.stringify({
      ...common,
      id: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      execution: { subscriptionAuthenticated: true, invocationDigest: '7'.repeat(64),
        threadId: 'thread-adr072-review', catalogRowSha256: '8'.repeat(64) },
    }));
    fs.writeFileSync(fablePublic, fableKeys.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(solPublic, solKeys.publicKey.export({ type: 'spki', format: 'pem' }));
    const stdout = sink();
    const stderr = sink();

    expect(main(['produce', '--input', fableInputFile, '--out', fableReceipt], {
      env: { RUVNET_REVIEW_SIGNING_KEY: fableKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, stdout, stderr,
    })).toBe(0);
    expect(main(['produce', '--input', solInputFile, '--out', solReceipt], {
      env: { RUVNET_REVIEW_SIGNING_KEY: solKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, stdout, stderr,
    })).toBe(0);
    expect(fs.statSync(fableReceipt).mode & 0o777).toBe(0o600);
    expect(main(['verify', '--receipt', fableReceipt, '--public-key', fablePublic], { stdout, stderr })).toBe(0);
    const expectedIdentity = path.join(root, 'expected-identity.json');
    const fableRow = JSON.parse(fs.readFileSync(fableReceipt, 'utf8'));
    fs.writeFileSync(expectedIdentity, JSON.stringify({
      subjectProducerIdentity: fableRow.subjectProducerIdentity,
      sourceSha: fableRow.sourceSha,
      sourceTree: fableRow.sourceTree,
      artifactSha256: fableRow.artifactSha256,
      payloadId: fableRow.payloadId,
      payloadSha256: fableRow.payloadSha256,
      releaseIdentitySha256: fableRow.releaseIdentitySha256,
      productContractSha256: fableRow.productContractSha256,
      rubricSha256: fableRow.rubricSha256,
    }));
    const pairOut = sink();
    expect(main(['verify-pair', '--fable', fableReceipt, '--sol', solReceipt,
      '--fable-public-key', fablePublic, '--sol-public-key', solPublic,
      '--expected-identity', expectedIdentity], { stdout: pairOut, stderr })).toBe(0);
    expect(JSON.parse(pairOut.read())).toMatchObject({ verdict: 'PASS', reviews: [
      { id: 'claude-fable-5' }, { id: 'gpt-5.6-sol' },
    ] });
    expect(main(['verify-pair', '--fable', fableReceipt, '--sol', solReceipt,
      '--fable-public-key', fablePublic, '--sol-public-key', solPublic], { stdout: sink(), stderr })).toBe(0);
    expect(main(['produce', '--input', fableInputFile, '--out', fableReceipt], {
      env: { RUVNET_REVIEW_SIGNING_KEY: fableKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, stdout, stderr,
    })).toBe(1);
    expect(stderr.read()).toMatch(/EEXIST/);
  });

  it('rejects missing secrets, malformed arguments and JSON, and symlinked evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-review-cli-bad-'));
    const input = path.join(root, 'input.json');
    const badJson = path.join(root, 'bad.json');
    const linked = path.join(root, 'linked.json');
    const out = path.join(root, 'out.json');
    fs.writeFileSync(input, JSON.stringify(fableInput()));
    fs.writeFileSync(badJson, '{');
    fs.symlinkSync(input, linked);
    const stdout = sink();
    const stderr = sink();

    expect(main(['produce', '--input', input, '--out', out], { env: {}, stdout, stderr })).toBe(1);
    expect(main(['unknown'], { stdout, stderr })).toBe(1);
    expect(main(['produce', '--unknown', 'value'], { stdout, stderr })).toBe(1);
    expect(main(['produce', '--input'], { stdout, stderr })).toBe(1);
    expect(main(['produce', '--input', input], { stdout, stderr })).toBe(1);
    expect(main(['produce', '--input', input, '--input', input, '--out', out], { stdout, stderr })).toBe(1);
    expect(main(['produce', '--input', badJson, '--out', out], {
      env: { RUVNET_REVIEW_SIGNING_KEY: 'key' }, stdout, stderr,
    })).toBe(1);
    expect(main(['produce', '--input', linked, '--out', out], {
      env: { RUVNET_REVIEW_SIGNING_KEY: 'key' }, stdout, stderr,
    })).toBe(1);
    expect(main(['verify', '--receipt', path.join(root, 'missing.json'), '--public-key', input], { stdout, stderr })).toBe(1);
    expect(stderr.read()).toMatch(/required|command|requires a value|only once|valid JSON|non-symlink/);
  });

  it('uses process streams and executes its direct CLI guard', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const priorArgv = process.argv;
    const priorExitCode = process.exitCode;
    const modulePath = path.resolve('scripts/independent-review-receipt.mjs');
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-review-cli-streams-'));
      const receipt = path.join(root, 'receipt.json');
      const publicKey = path.join(root, 'public.pem');
      fs.writeFileSync(receipt, JSON.stringify(fable()));
      fs.writeFileSync(publicKey, fableKeys.publicKey.export({ type: 'spki', format: 'pem' }));
      expect(main(['verify', '--receipt', receipt, '--public-key', publicKey], { stderr: sink() })).toBe(0);
      expect(main(['unknown'], { env: {} })).toBe(1);
      process.argv = [process.execPath, modulePath, 'unknown'];
      await import(/* @vite-ignore */ `${pathToFileURL(modulePath).href}?direct=${Date.now()}`);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalled();
    } finally {
      process.argv = priorArgv;
      process.exitCode = priorExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
