import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { abandonPublicVerificationTransaction, canonicalJson, receiptDisposition, validateReceiptChain } from '../../scripts/release-transaction.mjs';
import { abandonPublicVerification, closureProvenance } from '../../scripts/public-verification-abandon.mjs';
import { execute, FakeReleaseProvider, identity, keys } from '../helpers/release-transaction-fixture.mjs';

async function fixture() {
  const adapter = new FakeReleaseProvider();
  await execute(adapter);
  const current = adapter.receipts.at(-1);
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-public-verification-failure', os: 'linux',
    sourceSha: identity.candidateSha, artifactSha256: identity.packageSha256, bundleSha256: identity.bundleSha256,
    failures: [{ mode: 'claude', reason: 'retrieval canary acceptance failed',
      metrics: { total: 1, unknown: 1 }, failedCases: [{ status: 'UNKNOWN', error: 'source citation absent' }] }], completedLeaves: [] };
  const failure = { ...payload, failureSha256: crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex') };
  const request = { identity, adapter, ...keys, failure,
    expected: { transactionId: current.transactionId, sequence: current.sequence, receiptDigest: current.receiptDigest },
    reason: 'Preserve published bytes and close the failed verification attempt without a success claim.',
    authorization: { actor: 'maintainer', reference: 'explicit-session-approval-closure',
      event: 'repository_dispatch', action: 'abandon-public-verification', dispatchRunId: 123, verifierSha: '1'.repeat(40) },
    recovery: { repository: identity.repository, workflow: '.github/workflows/recover-public-verification.yml',
      workflowId: 999, repositoryId: 7, event: 'repository_dispatch', runId: 456, verifierSha: '2'.repeat(40), conclusion: 'failure', artifactId: 789,
      artifactName: `recovered-public-verification-linux-${identity.candidateSha}-456` } };
  adapter.calls.length = 0;
  return request;
}

describe('protected unsuccessful public verification closure', () => {
  it('appends one signed abandoned receipt preserving the original failure and published state', async () => {
    const f = await fixture(); const before = f.adapter.receipts.length;
    const receipt = await abandonPublicVerificationTransaction(f);
    expect(receipt.state).toBe('abandoned');
    expect(receipt.observation.verdict).toBe('PUBLISHED_NOT_VERIFIED');
    expect(receipt.observation.abandonment.failure).toEqual(f.failure);
    expect(receiptDisposition(receipt)).toBe('closed-unsuccessful');
    expect(f.adapter.receipts).toHaveLength(before + 1);
    expect(validateReceiptChain(f.adapter.receipts, identity, keys.publicKey).at(-1)).toEqual(receipt);
    expect(f.adapter.calls.every((name) => ['discover', 'observeSnapshot', 'append:abandoned', 'readReceipt'].includes(name))).toBe(true);
  });

  it('reuses the same intent across dispatch retries and rejects changed intent', async () => {
    const f = await fixture(); const first = await abandonPublicVerificationTransaction(f);
    const count = f.adapter.receipts.length;
    f.authorization.dispatchRunId += 1;
    expect(await abandonPublicVerificationTransaction(f)).toEqual(first);
    expect(f.adapter.receipts).toHaveLength(count);
    f.reason = 'A different reason';
    await expect(abandonPublicVerificationTransaction(f)).rejects.toThrow(/conflicting/);
  });

  it.each([
    ['sequence', (f) => { f.expected.sequence += 1; }],
    ['digest', (f) => { f.expected.receiptDigest = '0'.repeat(64); }],
    ['transaction', (f) => { f.expected.transactionId = '0'.repeat(64); }],
    ['authorization', (f) => { delete f.authorization.reference; }],
    ['dispatch', (f) => { f.authorization.action = 'release'; }],
    ['run success', (f) => { f.recovery.conclusion = 'success'; }],
    ['foreign run', (f) => { f.recovery.repository = 'other/repository'; }],
    ['foreign artifact', (f) => { f.recovery.artifactName = 'other'; }],
    ['foreign package', (f) => { f.failure.artifactSha256 = '0'.repeat(64); }],
    ['tampered failure', (f) => { f.failure.failures[0].reason = 'changed'; }],
    ['oversized failure', (f) => { f.failure.extra = 'x'.repeat(131073); }],
    ['wrong signing key', (f) => { f.privateKey = crypto.generateKeyPairSync('ed25519').privateKey; }],
    ['chain signature', (f) => { f.adapter.receipts[0].signature = ''; }],
    ['chain gap', (f) => { f.adapter.receipts.splice(1, 1); }],
    ['changed npm channel', (f) => { f.adapter.npmLatest = 'different'; }],
    ['changed github channel', (f) => { f.adapter.githubLatest = 'different'; }],
    ['changed assets', (f) => { f.adapter.assetsExact = false; }],
  ])('rejects %s before appending', async (_name, mutate) => {
    const f = await fixture(); mutate(f); const count = f.adapter.receipts.length;
    await expect(abandonPublicVerificationTransaction(f)).rejects.toThrow();
    expect(f.adapter.receipts).toHaveLength(count);
    expect(f.adapter.calls).not.toContain('append:abandoned');
  });

  it('rejects nonexact persisted readback', async () => {
    const f = await fixture(); f.adapter.readReceipt = async () => ({ invalid: true });
    await expect(abandonPublicVerificationTransaction(f)).rejects.toThrow(/invalid release transaction receipt/);
  });
});

function provenanceFixture() {
  const run = { id: 456, workflow_id: 999, event: 'repository_dispatch', head_repository: { id: 7, full_name: identity.repository }, status: 'completed', conclusion: 'failure', head_sha: '2'.repeat(40),
    path: '.github/workflows/recover-public-verification.yml', repository: { id: 7, full_name: identity.repository } };
  return { identity, failure: { os: 'linux' }, run, workflow: { id: 999, path: run.path },
    event: { action: 'abandon-public-verification', sender: { login: 'maintainer' }, repository: { id: 7, full_name: identity.repository },
      client_payload: { authorization: 'abandon-published-not-verified', authorization_reference: 'approval', recovery_run_id: 456, failure_artifact_id: 789 } },
    env: { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_ACTOR: 'maintainer', GITHUB_REPOSITORY: identity.repository,
      GITHUB_RUN_ID: '123', GITHUB_SHA: '1'.repeat(40) },
    artifact: { id: 789, expired: false, name: `recovered-public-verification-linux-${identity.candidateSha}-456`,
      workflow_run: { id: 456, head_sha: run.head_sha } } };
}
describe('GitHub-owned failure and authorization provenance', () => {
  it('binds exact dispatch actor and original failed run artifact', () => {
    const result = closureProvenance(provenanceFixture());
    expect(result.recovery.runId).toBe(456);
    expect(result.authorization.actor).toBe('maintainer');
  });
  it.each([
    ['actor', (f) => { f.event.sender.login = 'someone-else'; }],
    ['authorization', (f) => { delete f.event.client_payload.authorization; }],
    ['PR-origin run', (f) => { f.run.event = 'pull_request'; }],
    ['foreign head repository', (f) => { f.run.head_repository.id += 1; }],
    ['workflow identity', (f) => { f.run.workflow_id += 1; }],
    ['workflow', (f) => { f.run.path = '.github/workflows/ci.yml'; }],
    ['run state', (f) => { f.run.status = 'in_progress'; }],
    ['artifact run', (f) => { f.artifact.workflow_run.id += 1; }],
    ['artifact SHA', (f) => { f.artifact.workflow_run.head_sha = '3'.repeat(40); }],
    ['expired artifact', (f) => { f.artifact.expired = true; }],
  ])('rejects mismatched %s', (_name, mutate) => {
    const f = provenanceFixture(); mutate(f); expect(() => closureProvenance(f)).toThrow();
  });
});

it('executes the file entrypoint with verified provenance and writes exact signed readback', async () => {
  const f = await fixture(); const p = provenanceFixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-entrypoint-test-'));
  try {
    const identityFile = path.join(temp, 'identity.json'); const eventFile = path.join(temp, 'event.json');
    const keyFile = path.join(temp, 'public.pem'); const outputFile = path.join(temp, 'closed.json');
    p.event.client_payload.expected = f.expected; p.event.client_payload.reason = f.reason;
    fs.writeFileSync(identityFile, JSON.stringify(identity)); fs.writeFileSync(eventFile, JSON.stringify(p.event));
    fs.writeFileSync(keyFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const receipt = await abandonPublicVerification({ identityFile, outputFile, publicKeyFile: keyFile, adapter: f.adapter,
      env: { ...p.env, GITHUB_EVENT_PATH: eventFile,
        RUVNET_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
      readApi: async (endpoint) => endpoint.includes('/runs/') ? p.run : endpoint.includes('/workflows/') ? p.workflow : p.artifact,
      readFailure: async () => f.failure });
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8'))).toEqual(receipt);
    expect(receipt.state).toBe('abandoned');
    expect(receipt.observation.verdict).toBe('PUBLISHED_NOT_VERIFIED');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
