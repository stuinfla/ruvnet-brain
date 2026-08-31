import { describe, expect, it } from 'vitest';
import {
  execute, FakeReleaseProvider, identity,
} from '../../helpers/release-transaction-fixture.mjs';

const BEFORE_BOUNDARIES = [
  'createDraft', 'append:remote-prepared', 'readReceipt', 'append:asset-upload-intent',
  'uploadAssets', 'append:npm-stage-intent', 'stageNpm', 'observeSnapshot',
  'append:npm-candidate-staged', 'append:remote-materialization-intent',
  'materializeStagedAssets', 'verifyMaterializedPayload', 'cleanupStagedAssets', 'append:prepared',
  'append:github-promote-intent', 'publishDraftNonLatest', 'append:github-promoted-nonlatest',
  'append:npm-promote-intent', 'promoteNpm', 'append:npm-promoted',
  'append:github-latest-intent', 'makeGithubLatest', 'append:defaults-promoted',
  'append:finalize-intent', 'append:channels-converged',
];

const AFTER_SIDE_EFFECTS = [
  ['uploadAssets', 'assetsExact'],
  ['stageNpm', 'candidatePublished'],
  ['publishDraftNonLatest', 'githubPublished'],
  ['promoteNpm', 'npmLatest'],
  ['makeGithubLatest', 'githubLatest'],
];

describe('ADR-062 recovery transaction', () => {
  it('converges channels without claiming or running public-host verification', async () => {
    const provider = new FakeReleaseProvider();
    const hosts = { calls: [], async verify({ source }) { this.calls.push(source); return { verdict: 'PASS' }; } };
    const final = await execute(provider, hosts);
    expect(final.state).toBe('channels-converged');
    expect(hosts.calls).toEqual([]);
    expect(provider.calls.filter((call) => call === 'stageNpm')).toHaveLength(1);
  });

  it.each(BEFORE_BOUNDARIES)('fails closed when interrupted at %s', async (fault) => {
    const provider = new FakeReleaseProvider({ fault });
    await expect(execute(provider)).rejects.toThrow();
    expect(provider.receipts.some(({ state }) => state === 'channels-converged')).toBe(false);
  });

  it.each(AFTER_SIDE_EFFECTS)('recovers after interruption immediately after %s', async (method) => {
    const provider = new FakeReleaseProvider();
    const original = provider[method].bind(provider);
    let crashed = false;
    provider[method] = async (...args) => {
      const result = await original(...args);
      if (!crashed) { crashed = true; throw new Error(`crash after ${method}`); }
      return result;
    };
    await expect(execute(provider)).rejects.toThrow(`crash after ${method}`);
    provider[method] = original;
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(provider.npmLatest).toBe(identity.version);
    expect(provider.githubLatest).toBe(identity.tag);
  });

  it('polls boundedly through delayed npm candidate and latest visibility', async () => {
    const provider = new FakeReleaseProvider({ visibilityDelay: { candidate: 3, npmLatest: 3 } });
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(provider.observations).toBeGreaterThan(8);
  });

  it('times out without republishing and later resumes the same bytes', async () => {
    const provider = new FakeReleaseProvider({ visibilityDelay: { candidate: 99 } });
    await expect(execute(provider)).rejects.toThrow('visibility deadline exceeded');
    expect(provider.calls.filter((call) => call === 'stageNpm')).toHaveLength(1);
    provider.visibilityDelay.candidate = 0;
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
    expect(provider.calls.filter((call) => call === 'stageNpm')).toHaveLength(1);
  });

  it('compensates an npm-first partial publication and resumes through normal states', async () => {
    const provider = new FakeReleaseProvider({ fault: 'publishDraftNonLatest' });
    await expect(execute(provider)).rejects.toThrow();
    provider.fault = null;
    provider.npmLatest = identity.version;
    await expect(execute(provider)).rejects.toThrow('npm compensated');
    expect(provider.npmLatest).toBe(provider.prior);
    const final = await execute(provider);
    expect(final.state).toBe('channels-converged');
  });

  it('fails closed on immutable npm byte mismatch', async () => {
    const provider = new FakeReleaseProvider();
    provider.candidatePublished = true;
    provider.candidateIntegrity = 'sha512-wrong';
    await expect(execute(provider)).rejects.toThrow('immutable npm candidate bytes mismatch');
    expect(provider.calls).not.toContain('promoteNpm');
  });

  it('fails closed on competing release identity and duplicate anchors', async () => {
    const competing = new FakeReleaseProvider();
    competing.pending = [{ transactionId: 'e'.repeat(64) }];
    await expect(execute(competing)).rejects.toThrow('blocks');
    const duplicate = new FakeReleaseProvider();
    duplicate.discover = async () => ({
      pending: [], receipts: [], prior: { npmLatest: '9.9.8', githubLatest: 'v9.9.8' },
      matchingDrafts: [{ id: 1 }, { id: 2 }],
    });
    await expect(execute(duplicate)).rejects.toThrow('duplicate matching drafts');
  });

  it('does not overwrite a third-party npm default during recovery', async () => {
    const provider = new FakeReleaseProvider({ fault: 'promoteNpm' });
    await expect(execute(provider)).rejects.toThrow();
    provider.fault = null;
    provider.npmLatest = '10.0.0';
    await expect(execute(provider)).rejects.toThrow('neither captured A nor candidate B');
    expect(provider.npmLatest).toBe('10.0.0');
  });

  it('revalidates channel receipts and rejects provider drift', async () => {
    const provider = new FakeReleaseProvider();
    await execute(provider);
    provider.githubLatest = provider.prior;
    await expect(execute(provider)).rejects.toThrow('release state drift');
  });

  it.each([
    ['candidate integrity', (provider) => { provider.candidateIntegrity = 'sha512-wrong'; }],
    ['GitHub assets', (provider) => { provider.assetsExact = false; }],
  ])('revalidates %s when recovering finalize-intent', async (_name, drift) => {
    const provider = new FakeReleaseProvider({ fault: 'append:channels-converged' });
    await expect(execute(provider)).rejects.toThrow();
    provider.fault = null;
    drift(provider);
    await expect(execute(provider)).rejects.toThrow();
    expect(provider.receipts.at(-1).state).not.toBe('channels-converged');
  });

  it('a concurrent same-sequence writer loses before any subsequent provider mutation', async () => {
    const provider = new FakeReleaseProvider();
    const original = provider.appendReceipt.bind(provider);
    let raced = false;
    provider.appendReceipt = async (draft, receipt, name) => {
      if (!raced) { raced = true; provider.receipts.push(structuredClone(receipt)); }
      return original(draft, receipt, name);
    };
    await expect(execute(provider)).rejects.toThrow('duplicate receipt sequence');
    expect(provider.calls).not.toContain('uploadAssets');
  });
});
