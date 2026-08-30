import { describe, expect, it } from 'vitest';
import {
  abortReleaseTransaction,
  canonicalJson,
  CURRENT_RECEIPT_SCHEMA_VERSION,
  digestReceipt,
  receiptDisposition,
  signReceipt,
  transactionIdFor,
  validateReceiptChain,
  verifyReceipt,
} from '../../scripts/release-transaction.mjs';
import {
  execute, FakeReleaseProvider, identity, keys, transactionId,
} from '../helpers/release-transaction-fixture.mjs';

describe('remote durable release transaction', () => {
  it('stages both providers before advancing defaults and finishes with a signed remote receipt', async () => {
    const provider = new FakeReleaseProvider();
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(final.transactionId).toBe(transactionId);
    expect(provider.calls.indexOf('stageNpm')).toBeLessThan(provider.calls.indexOf('publishDraftNonLatest'));
    expect(provider.calls.indexOf('publishDraftNonLatest')).toBeLessThan(provider.calls.indexOf('promoteNpm'));
    expect(provider.calls.indexOf('promoteNpm')).toBeLessThan(provider.calls.indexOf('makeGithubLatest'));
    expect(validateReceiptChain(provider.receipts, identity, keys.publicKey).at(-1).state)
      .toBe('channels-converged');
    expect(final.schemaVersion).toBe(CURRENT_RECEIPT_SCHEMA_VERSION);
    expect(receiptDisposition(final)).toBe('pending-public-verification');
    expect(provider.calls).not.toContain('finalize');
  });

  it('keeps transaction identity stable across the receipt schema cutover', () => {
    expect(transactionIdFor(identity)).toBe(transactionId);
  });

  it('classifies only schema-3 install verification as successful closure', () => {
    expect(receiptDisposition({ schemaVersion: 3, state: 'channels-converged' }))
      .toBe('pending-public-verification');
    expect(receiptDisposition({ schemaVersion: 3, state: 'install-verified' })).toBe('verified');
    expect(receiptDisposition({ schemaVersion: 2, state: 'channels-converged' })).toBe('legacy-closed');
    expect(receiptDisposition({ schemaVersion: 3, state: 'aborted' })).toBe('closed-unsuccessful');
  });

  it('accepts a mixed signed schema-2 to schema-3 chain without rewriting history', () => {
    const first = signReceipt({
      schemaVersion: 2, transactionId, sequence: 0, previousReceiptDigest: null,
      state: 'remote-prepared', identity, observation: {}, createdAt: 'then',
    }, keys.privateKey);
    const second = signReceipt({
      schemaVersion: 3, transactionId, sequence: 1, previousReceiptDigest: first.receiptDigest,
      state: 'asset-upload-intent', identity, observation: {}, createdAt: 'now',
    }, keys.privateKey);
    expect(validateReceiptChain([first, second], identity, keys.publicKey)).toHaveLength(2);
    expect(verifyReceipt(second, keys.publicKey).schemaVersion).toBe(3);
  });

  it('rejects a competing pending candidate before creating a draft', async () => {
    const provider = new FakeReleaseProvider();
    provider.pending = [{ transactionId: 'c'.repeat(64) }];
    await expect(execute(provider)).rejects.toThrow('blocks');
    expect(provider.calls).not.toContain('createDraft');
  });

  it('rejects hostile receipt mutation and sequence replay', () => {
    const receipt = signReceipt({
      schemaVersion: 1, transactionId, sequence: 0, previousReceiptDigest: null,
      state: 'remote-prepared', fence: 'owner', identity, observation: {}, createdAt: 'now',
    }, keys.privateKey);
    expect(() => validateReceiptChain([{ ...receipt, state: 'prepared' }], identity, keys.publicKey))
      .toThrow('digest');
    expect(() => validateReceiptChain([receipt, { ...receipt, sequence: 1 }], identity, keys.publicKey))
      .toThrow();
  });

  it('requires explicit human authorization to burn a poisoned immutable version', async () => {
    const provider = new FakeReleaseProvider({ fault: 'stageNpm' });
    await expect(execute(provider)).rejects.toThrow('injected stageNpm');
    await expect(abortReleaseTransaction({
      identity, receipts: provider.receipts, reason: 'poisoned version', authorized: false,
      adapter: provider, privateKey: keys.privateKey, publicKey: keys.publicKey,
    })).rejects.toThrow('explicit human authorization');
    const aborted = await abortReleaseTransaction({
      identity, receipts: provider.receipts, reason: 'poisoned version', authorized: true,
      adapter: provider, privateKey: keys.privateKey, publicKey: keys.publicKey,
    });
    expect(aborted.state).toBe('aborted');
  });
});

describe('the digest serialiser agrees with the one that writes the file', () => {
  // THIS SILENTLY CORRUPTED THE TERMINAL RECEIPT OF EVERY SUCCESSFUL RELEASE.
  //
  // Measured 2026-08-20 on v4.0.36 and v4.0.90-dev: both `channels-converged` receipts failed their
  // own digest check, with the same key missing. `canonicalJson` KEPT keys whose value was
  // `undefined` (emitting `"error":undefined`, which is not even valid JSON) while `JSON.stringify`
  // DROPS them when the receipt is written. The converge observation carries optional fields and on
  // a clean run `verified.error` is undefined — so the digest was computed over a shape that could
  // never be read back. `runReleaseTransaction` appends, re-reads and verifies, so the publish died
  // with `release receipt digest mismatch` AFTER npm and GitHub were both promoted: the release
  // shipped and the rail reported failure.

  it('TEETH: a receipt holding an undefined field digests the same after a write/read round-trip', () => {
    const receipt = {
      schemaVersion: 2,
      state: 'channels-converged',
      observation: { hosts: { verifier: { artifactSha256: 'abc', error: undefined } } },
    };
    const before = digestReceipt(receipt);
    const afterWriteAndRead = JSON.parse(JSON.stringify(receipt));
    expect(digestReceipt(afterWriteAndRead), 'the digest must survive the trip through disk').toBe(before);
  });

  it('TEETH: canonicalJson omits undefined exactly as JSON.stringify does — objects AND arrays', () => {
    // Without this the fix could regress to "emit something different but still stable".
    expect(canonicalJson({ a: 1, b: undefined })).toBe(JSON.stringify({ a: 1, b: undefined }));
    expect(canonicalJson([1, undefined, 2])).toBe(JSON.stringify([1, undefined, 2]));
  });

  it('does NOT change the digest of a receipt that never held an undefined value', () => {
    // Every receipt that currently verifies must keep verifying; this fix repairs the writer, it
    // does not re-date history.
    const clean = { schemaVersion: 2, state: 'prepared', observation: { verdict: 'PASS' } };
    expect(digestReceipt(clean)).toBe(digestReceipt(JSON.parse(JSON.stringify(clean))));
    expect(canonicalJson(clean)).toBe('{"observation":{"verdict":"PASS"},"schemaVersion":2,"state":"prepared"}');
  });
});
