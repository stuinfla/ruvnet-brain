#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { abandonPublicVerificationTransaction } from './release-transaction.mjs';
import { liveReleaseProvider } from './release-transaction-provider.mjs';

function regularJson(file, max = 131072) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('untrusted or oversized closure input');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const api = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30000 }));

export function closureProvenance({ event, env, identity, failure, run, artifact, workflow }) {
  const input = event.client_payload;
  if (env.GITHUB_EVENT_NAME !== 'repository_dispatch' || event.action !== 'abandon-public-verification'
    || event.sender?.login !== env.GITHUB_ACTOR || event.repository?.full_name !== identity.repository
    || env.GITHUB_REPOSITORY !== identity.repository || input?.authorization !== 'abandon-published-not-verified') {
    throw new Error('closure requires the explicitly authorized abandonment dispatch');
  }
  if (run.event !== 'repository_dispatch' || !Number.isSafeInteger(run.repository?.id)
    || run.repository.id !== event.repository.id || run.head_repository?.id !== run.repository.id
    || run.head_repository?.full_name !== identity.repository
    || !Number.isSafeInteger(workflow?.id) || run.workflow_id !== workflow.id || workflow.path !== run.path
    || run.id !== input.recovery_run_id || run.status !== 'completed' || run.conclusion !== 'failure'
    || run.path !== '.github/workflows/recover-public-verification.yml'
    || run.repository?.full_name !== identity.repository || !/^[a-f0-9]{40}$/.test(run.head_sha || '')
    || artifact.id !== input.failure_artifact_id || artifact.expired !== false
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || artifact.name !== `recovered-public-verification-${failure.os}-${identity.candidateSha}-${run.id}`) {
    throw new Error('GitHub failed-run artifact provenance mismatch');
  }
  return {
    expected: input.expected,
    reason: input.reason,
    authorization: { actor: env.GITHUB_ACTOR, reference: input.authorization_reference,
      event: env.GITHUB_EVENT_NAME, action: event.action,
      dispatchRunId: Number(env.GITHUB_RUN_ID), verifierSha: env.GITHUB_SHA },
    recovery: { repository: identity.repository, workflow: run.path, workflowId: workflow.id, repositoryId: run.repository.id, event: run.event, runId: run.id,
      verifierSha: run.head_sha, conclusion: run.conclusion, artifactId: artifact.id, artifactName: artifact.name },
  };
}

// Download the named GitHub artifact independently; a local JSON lookalike is not provenance.
async function failureFromArtifact(repository, artifactId) {
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error('invalid failed artifact ID');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-failed-artifact-'));
  try {
    const zip = path.join(temp, 'failure.zip');
    fs.writeFileSync(zip, execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
      { encoding: null, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }), { flag: 'wx' });
    const output = path.join(temp, 'contents');
    const extracted = await extractZip(zip, output);
    if (extracted.entryNames.length !== 1 || !/^(linux|macos|windows)\.json$/.test(extracted.entryNames[0])) {
      throw new Error('failure artifact must contain exactly one OS failure receipt');
    }
    return regularJson(path.join(output, extracted.entryNames[0]));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function abandonPublicVerification({ identityFile, outputFile, env = process.env,
  readApi = api, readFailure = failureFromArtifact, adapter = liveReleaseProvider({ root: process.cwd() }),
  publicKeyFile = 'keys/ruvnet-brain-signing.pub.pem' } = {}) {
  if (!identityFile || !outputFile || !env.GITHUB_EVENT_PATH || !env.RUVNET_SIGNING_KEY) {
    throw new Error('identity, output, dispatch event, and signing key are required');
  }
  if (fs.existsSync(outputFile)) throw new Error('refusing to overwrite closure output');
  const identity = regularJson(identityFile);
  if (identity.repository !== 'stuinfla/ruvnet-brain' || identity.package !== 'ruvnet-brain') throw new Error('unexpected release repository');
  const event = regularJson(env.GITHUB_EVENT_PATH);
  const input = event.client_payload;
  if (![input?.recovery_run_id, input?.failure_artifact_id].every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('explicit recovery run and failed artifact IDs are required');
  }
  const run = await readApi(`repos/${identity.repository}/actions/runs/${input.recovery_run_id}`);
  const artifact = await readApi(`repos/${identity.repository}/actions/artifacts/${input.failure_artifact_id}`);
  const workflow = await readApi(`repos/${identity.repository}/actions/workflows/recover-public-verification.yml`);
  const failure = await readFailure(identity.repository, input.failure_artifact_id);
  const provenance = closureProvenance({ event, env, identity, failure, run, artifact, workflow });
  const receipt = await abandonPublicVerificationTransaction({ identity, failure, ...provenance, adapter,
    privateKey: crypto.createPrivateKey(env.RUVNET_SIGNING_KEY),
    publicKey: crypto.createPublicKey(fs.readFileSync(publicKeyFile, 'utf8')) });
  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return receipt;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
  try {
    const receipt = await abandonPublicVerification({ identityFile: arg('--identity'), outputFile: arg('--out') });
    console.log(JSON.stringify({ state: receipt.state, verdict: receipt.observation.verdict,
      transactionId: receipt.transactionId, sequence: receipt.sequence, receiptDigest: receipt.receiptDigest }));
  } catch (error) { console.error(`public-verification-abandon: ${error.message}`); process.exitCode = 1; }
}
