import { describe, expect, it } from 'vitest';
import {
  execute, FakeReleaseProvider, identity,
} from '../../helpers/release-transaction-fixture.mjs';

const PREPARE_FAULTS = [
  'createDraft', 'append:remote-prepared', 'readReceipt', 'append:asset-upload-intent',
  'uploadAssets', 'append:host-verification-intent', 'append:local-hosts-verified',
  'append:npm-stage-intent', 'stageNpm', 'observeNpmCandidate', 'append:npm-candidate-staged',
  'append:remote-host-verification-intent', 'materializeStagedAssets', 'cleanupStagedAssets',
  'append:prepared', 'append:github-promote-intent', 'publishDraftNonLatest', 'observeGithub',
  'append:github-promoted-nonlatest', 'append:npm-promote-intent', 'promoteNpm',
];

const RESUMABLE_PROMOTION_FAULTS = [
  'observeNpmLatest', 'append:npm-promoted', 'append:github-latest-intent',
  'observeGithubLatest', 'append:defaults-promoted', 'append:finalize-intent',
  'finalize', 'append:channels-converged',
];

describe('issue #77 failure-first release QE', () => {
  it.each(PREPARE_FAULTS)('fault at %s never advances a default channel', async (fault) => {
    const provider = new FakeReleaseProvider({ fault });
    await expect(execute(provider)).rejects.toThrow();
    expect(provider.npmLatest).toBe('9.9.8');
    expect(provider.githubLatest).toBe('v9.9.8');
    expect(provider.receipts.some(({ state }) => state === 'channels-converged')).toBe(false);
  });

  it.each(RESUMABLE_PROMOTION_FAULTS)('fault at %s converges the same B on retry', async (fault) => {
    const provider = new FakeReleaseProvider({ fault });
    await expect(execute(provider)).rejects.toThrow();
    provider.fault = null;
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(provider.npmLatest).toBe(identity.version);
    expect(provider.githubLatest).toBe(identity.tag);
  });

  it.each(['local', 'staged', 'final'])('host fixture failure at %s never records convergence', async (source) => {
    const provider = new FakeReleaseProvider();
    const hosts = {
      async verify(input) {
        return input.source === source ? { verdict: 'FAIL' } : { verdict: 'PASS' };
      },
    };
    await expect(execute(provider, hosts)).rejects.toThrow();
    expect(provider.receipts.some(({ state }) => state === 'channels-converged')).toBe(false);
  });

  it('recovers the same B on a clean runner using remote receipts only', async () => {
    const provider = new FakeReleaseProvider({ fault: 'promoteNpm' });
    await expect(execute(provider)).rejects.toThrow('npm promotion pending');
    const stagedCalls = provider.calls.filter((call) => call === 'stageNpm').length;
    provider.fault = null;
    provider.calls = [];
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(provider.calls.filter((call) => call === 'stageNpm')).toHaveLength(0);
    expect(stagedCalls).toBe(1);
  });

  it('compensates npm only when GitHub latest promotion fails after npm B', async () => {
    const provider = new FakeReleaseProvider({ fault: 'makeGithubLatest' });
    await expect(execute(provider)).rejects.toThrow('npm compensated');
    expect(provider.npmLatest).toBe('9.9.8');
    expect(provider.githubLatest).toBe('v9.9.8');
    expect(provider.receipts.at(-1).state).toBe('compensated');
  });

  it('re-promotes B before retrying GitHub after a compensated clean-runner recovery', async () => {
    const provider = new FakeReleaseProvider({ fault: 'makeGithubLatest' });
    await expect(execute(provider)).rejects.toThrow('npm compensated');
    provider.fault = null;
    provider.calls = [];
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(provider.calls.indexOf('promoteNpm')).toBeLessThan(provider.calls.indexOf('makeGithubLatest'));
    expect(provider.npmLatest).toBe(identity.version);
    expect(provider.githubLatest).toBe(identity.tag);
  });

  it('does not overwrite a third-party npm latest during compensation', async () => {
    const provider = new FakeReleaseProvider({ fault: 'makeGithubLatest' });
    const original = provider.makeGithubLatest.bind(provider);
    provider.makeGithubLatest = async (...args) => {
      provider.npmLatest = '10.0.0';
      return original(...args);
    };
    await expect(execute(provider)).rejects.toThrow('changed during compensation');
    expect(provider.npmLatest).toBe('10.0.0');
    expect(provider.calls).not.toContain('restoreNpmLatest');
  });

  it('fails closed on duplicate orphan drafts instead of guessing ownership', async () => {
    const provider = new FakeReleaseProvider();
    provider.discover = async () => ({
      pending: [], receipts: [], prior: { npmLatest: '9.9.8' },
      matchingDrafts: [{ id: 1, tag: identity.tag }, { id: 2, tag: identity.tag }],
    });
    await expect(execute(provider)).rejects.toThrow('duplicate matching drafts');
  });

  it('a concurrent same-sequence writer loses the create-only receipt race', async () => {
    const provider = new FakeReleaseProvider();
    const original = provider.appendReceipt.bind(provider);
    let raced = false;
    provider.appendReceipt = async (draft, receipt, name) => {
      if (!raced) {
        raced = true;
        provider.receipts.push(structuredClone(receipt));
      }
      return original(draft, receipt, name);
    };
    await expect(execute(provider)).rejects.toThrow('duplicate receipt sequence');
    expect(provider.calls).not.toContain('stageNpm');
  });
});
