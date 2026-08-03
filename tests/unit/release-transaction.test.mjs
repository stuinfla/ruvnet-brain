import { describe, expect, it } from 'vitest';
import {
  abortReleaseTransaction,
  signReceipt,
  validateReceiptChain,
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
