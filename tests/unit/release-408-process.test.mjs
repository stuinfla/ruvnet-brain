import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS, pollObservation, reduceReleaseState,
} from '../../scripts/release-transaction.mjs';
import {
  createPayloadManifest, payloadIdFor, signPayloadManifest, verifyPayload,
} from '../../scripts/release-payload.mjs';
import {
  aggregateEvidence, REQUIRED_RELEASE_LEAVES,
} from '../../scripts/release-evidence-aggregate.mjs';
import { ASSET_DOWNLOAD_TIMEOUT_MS, selectCurrentReleaseBytes } from '../../scripts/release-transaction-provider.mjs';
import { identity } from '../helpers/release-transaction-fixture.mjs';
import { getVersion } from '../../scripts/version.mjs';

const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('durable public receipt recovery', () => {
  it('reuses remote bytes across fresh-runner diagnostic drift', () => {
    const receiptIdentity = { transactionId: 'a'.repeat(64), version: getVersion(), candidateSha: 'b'.repeat(40) };
    const remote = Buffer.from(JSON.stringify({ ...receiptIdentity, verdict: 'PASS', hosts: { verdict: 'PASS', timing: 10 } }));
    const regenerated = Buffer.from(JSON.stringify({ ...receiptIdentity, verdict: 'PASS', hosts: { verdict: 'PASS', timing: 99 } }));
    expect(selectCurrentReleaseBytes({ remoteBytes: remote, generatedBytes: regenerated, identity: receiptIdentity })).toEqual(remote);
    expect(ASSET_DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

const snapshot = (overrides = {}) => ({
  npm: { candidateVersion: null, candidateIntegrity: null, latestVersion: '9.9.8' },
  github: {
    tag: identity.tag, sha: identity.candidateSha, draft: true, published: false,
    latest: false, assetsExact: false,
  },
  ...overrides,
});
const context = (value, state = 'remote-prepared') => ({
  lastReceipt: { state }, snapshot: value, identity,
  prior: { npmLatest: '9.9.8', githubLatest: 'v9.9.8' },
});

describe('4.0.8 release reducer', () => {
  it.each([
    [snapshot(), 'upload-assets'],
    [snapshot({ github: { ...snapshot().github, assetsExact: true } }), 'stage-npm'],
    [snapshot({
      npm: { candidateVersion: identity.version, candidateIntegrity: identity.packageIntegrity, candidateTagVersion: identity.version, latestVersion: '9.9.8' },
      github: { ...snapshot().github, assetsExact: true },
    }), 'publish-github-nonlatest'],
    [snapshot({
      npm: { candidateVersion: identity.version, candidateIntegrity: identity.packageIntegrity, candidateTagVersion: identity.version, latestVersion: '9.9.8' },
      github: { ...snapshot().github, assetsExact: true, draft: false, published: true },
    }), 'promote-npm'],
    [snapshot({
      npm: { candidateVersion: identity.version, candidateIntegrity: identity.packageIntegrity, candidateTagVersion: identity.version, latestVersion: identity.version },
      github: { ...snapshot().github, assetsExact: true, draft: false, published: true },
    }), 'make-github-latest'],
  ])('maps fresh provider state to %s', (value, action) => {
    expect(reduceReleaseState(context(value)).action).toBe(action);
  });

  it('fails closed on unreadable, competing, and third-default observations', () => {
    expect(reduceReleaseState(context({ readError: 'offline' })).action).toBe('manual');
    const wrongSha = snapshot({ github: { ...snapshot().github, sha: 'f'.repeat(40) } });
    expect(reduceReleaseState(context(wrongSha)).action).toBe('manual');
    const third = snapshot({
      npm: { candidateVersion: identity.version, candidateIntegrity: identity.packageIntegrity, candidateTagVersion: identity.version, latestVersion: '10.0.0' },
      github: { ...snapshot().github, assetsExact: true, draft: false, published: true },
    });
    expect(reduceReleaseState(context(third)).action).toBe('manual');
  });

  it('defines every emitted nonterminal state in the transition graph', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS)).toEqual(expect.arrayContaining([
      'remote-prepared', 'compensated', 'finalize-intent', 'channels-converged',
    ]));
  });
});

describe('bounded observation', () => {
  it('succeeds after delayed visibility with an injected clock', async () => {
    let reads = 0;
    let clock = 0;
    const result = await pollObservation(
      async () => ({ visible: ++reads === 4 }),
      (value) => value.visible,
      { now: () => clock, sleep: async (ms) => { clock += ms; }, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 5, maxElapsedMs: 100, jitter: () => 0 },
    );
    expect(result.attempt).toBe(4);
  });

  it('times out within the declared attempt bound', async () => {
    let reads = 0;
    let clock = 0;
    await expect(pollObservation(
      async () => { reads += 1; return null; },
      () => false,
      { now: () => clock, sleep: async (ms) => { clock += ms; }, initialDelayMs: 10, maxAttempts: 3, maxElapsedMs: 100, jitter: () => 0 },
    )).rejects.toThrow('visibility deadline exceeded');
    expect(reads).toBe(3);
  });
});

describe('immutable payload and aggregate evidence', () => {
  it('signs one canonical manifest and rejects changed member bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-payload-'));
    temps.push(root);
    const file = path.join(root, 'candidate.tgz');
    fs.writeFileSync(file, 'candidate-A');
    const manifest = createPayloadManifest({
      version: '9.9.9', tag: 'v9.9.9', candidateSha: 'a'.repeat(40), producer: { runId: '1' },
      members: [{ role: 'npm', name: 'candidate.tgz', file }],
    });
    const keys = crypto.generateKeyPairSync('ed25519');
    const signature = signPayloadManifest(manifest, keys.privateKey);
    expect(verifyPayload({ manifest, signature, publicKey: keys.publicKey, root }).payloadId).toBe(payloadIdFor(manifest));
    fs.writeFileSync(file, 'candidate-B');
    expect(() => verifyPayload({ manifest, signature, publicKey: keys.publicKey, root })).toThrow('payload member mismatch');
  });

  it('requires one exact-SHA PASS for every aggregate leaf', () => {
    const sha = 'a'.repeat(40);
    const payloadId = 'b'.repeat(64);
    const leaves = REQUIRED_RELEASE_LEAVES.map((name) => ({
      name, sha, payloadId, status: 'completed', conclusion: 'success', verdict: 'PASS',
    }));
    expect(aggregateEvidence({ sha, payloadId, leaves }).verdict).toBe('PASS');
    expect(() => aggregateEvidence({ sha, payloadId, leaves: leaves.slice(1) })).toThrow('missing');
    expect(() => aggregateEvidence({ sha, payloadId, leaves: leaves.map((leaf, i) => i ? leaf : { ...leaf, conclusion: 'skipped' }) })).toThrow('not fail-closed PASS');
  });
});
