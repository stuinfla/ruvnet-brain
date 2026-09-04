#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvidence } from './release-evidence-aggregate.mjs';
import { canonicalJson } from './release-transaction.mjs';
import { EXCLUSION_POLICY } from './integration-evidence.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(file) {
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes), digest: sha256(bytes) };
}

function requireExactSet(actual, expected, label) {
  const got = [...actual].sort();
  const want = [...expected].sort();
  if (canonicalJson(got) !== canonicalJson(want)) {
    throw new Error(`${label} differs: expected ${want.join(', ')}, got ${got.join(', ')}`);
  }
}

function passLeaf({ name, sha, payloadId, source, receiptSha256, ...details }) {
  const validated = /^[a-f0-9]{64}$/.test(receiptSha256 || '');
  return {
    name,
    sha,
    payloadId,
    status: validated ? 'completed' : 'failed',
    conclusion: validated ? 'success' : 'failure',
    verdict: validated ? 'PASS' : 'FAIL',
    source,
    receiptSha256,
    ...details,
  };
}

export function buildPrepublicationEvidence({
  sha,
  version,
  runId,
  manifestFile,
  payloadProofFile,
  hostFile,
  ciFile,
  integrationFile,
  uxFiles,
  strangerFile,
}) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !/^\d+\.\d+\.\d+$/.test(version || '') || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('prepublication identity is malformed');
  }

  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  const payload = JSON.parse(fs.readFileSync(payloadProofFile));
  if (manifest.candidateSha !== sha || manifest.version !== version || manifest.tag !== `v${version}`) {
    throw new Error('candidate manifest identity mismatch');
  }
  if (!/^[a-f0-9]{64}$/.test(payload.payloadId || '')) throw new Error('payload identity is malformed');

  const host = readJson(hostFile);
  if (host.value.schemaVersion !== 1 || host.value.sha !== sha || host.value.payloadId !== payload.payloadId
    || !/^[a-f0-9]{64}$/.test(host.value.artifactSha256 || '') || host.value.leaves?.length !== 3) {
    throw new Error('candidate host evidence identity or shape mismatch');
  }
  requireExactSet(host.value.leaves.map(({ name }) => name), ['claude-only', 'codex-only', 'dual-host'], 'candidate host leaves');
  for (const leaf of host.value.leaves) {
    const grounding = leaf.grounding;
    const grounded = grounding && ['repo', 'path', 'file', 'storedPath']
      .every((field) => typeof grounding[field] === 'string' && grounding[field].trim());
    if (leaf.sha !== sha || leaf.payloadId !== payload.payloadId || leaf.status !== 'completed'
      || leaf.conclusion !== 'success' || leaf.verdict !== 'PASS'
      || leaf.functionalSearch !== true || leaf.searchExit !== 0 || !grounded
      || leaf.artifactSha256 !== host.value.artifactSha256) {
      throw new Error(`candidate host leaf is not an exact PASS: ${leaf.name || '(missing)'}`);
    }
  }

  const ci = readJson(ciFile);
  const requiredCiJobs = ['candidate-preflight', 'check', 'windows-unit', 'warm-brain', 'release-qe'];
  if (ci.value.schemaVersion !== 1 || ci.value.kind !== 'ruvnet-brain-candidate-ci-evidence'
    || ci.value.sourceSha !== sha || ci.value.version !== version || ci.value.payloadId !== payload.payloadId
    || ci.value.payloadManifestSha256 !== sha256(manifestBytes) || ci.value.workflow !== 'ci'
    || ci.value.runId !== runId || ci.value.verdict !== 'PASS' || ci.value.skipped !== 0 || ci.value.unknown !== 0) {
    throw new Error('candidate CI receipt identity or verdict mismatch');
  }
  requireExactSet(ci.value.jobs?.map(({ name }) => name) || [], requiredCiJobs, 'candidate CI jobs');
  if (ci.value.jobs.some(({ conclusion }) => conclusion !== 'success')) throw new Error('candidate CI receipt contains a non-success job');

  const integration = readJson(integrationFile);
  if (integration.value.schemaVersion !== 1 || integration.value.kind !== 'ruvnet-brain-integration-evidence'
    || integration.value.sourceSha !== sha || integration.value.workflow !== 'integration-linux'
    || integration.value.runId !== runId || integration.value.verdict !== 'PASS'
    || integration.value.total <= 0
    || integration.value.passed + Number(integration.value.todo || 0) + Number(integration.value.skipped || 0) !== integration.value.total
    || integration.value.failed !== 0
    || !Array.isArray(integration.value.skippedTests)
    || integration.value.skippedTests.length !== integration.value.skipped
    || integration.value.skippedTests.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error('integration receipt is not an exact, fully accounted PASS');
  }
  if (integration.value.exclusionPolicy !== EXCLUSION_POLICY
    || !Array.isArray(integration.value.todoTests)
    || integration.value.todoTests.length !== Number(integration.value.todo || 0)
    || !/^[a-f0-9]{64}$/.test(integration.value.exclusionsSha256 || '')) {
    throw new Error('integration receipt exclusions are not governed and fully enumerated');
  }

  if (!Array.isArray(uxFiles) || uxFiles.length !== 3) throw new Error('exactly three UX receipts are required');
  const ux = uxFiles.map(readJson);
  requireExactSet(ux.map(({ value }) => value.platform), ['darwin', 'linux', 'win32'], 'UX platforms');
  for (const receipt of ux) {
    const value = receipt.value;
    if (value.schemaVersion !== 1 || value.suite !== 'ruvnet-brain-ux-qe' || value.gitSha !== sha
      || value.pass !== true || !Array.isArray(value.hardFailures) || value.hardFailures.length !== 0) {
      throw new Error(`UX receipt is not an exact PASS: ${value.platform || '(missing)'}`);
    }
  }
  const uxDigest = sha256(Buffer.from(canonicalJson(ux.map(({ value, digest }) => ({ platform: value.platform, digest }))
    .sort((a, b) => a.platform.localeCompare(b.platform)))));

  const stranger = readJson(strangerFile);
  const strangerJobs = ['ubuntu', 'macos', 'windows-gitbash', 'windows-powershell', 'hostile'];
  if (stranger.value.schemaVersion !== 1 || stranger.value.sha !== sha || stranger.value.payloadId !== payload.payloadId
    || Number(stranger.value.sourceCiRunId) !== runId || Number(stranger.value.strangerRunId) !== runId
    || stranger.value.verdict !== 'PASS') {
    throw new Error('stranger receipt identity or verdict mismatch');
  }
  requireExactSet(stranger.value.jobs || [], strangerJobs, 'stranger jobs');

  const common = { sha, payloadId: payload.payloadId, runId };
  const leaves = [
    passLeaf({ ...common, name: 'source-quality', source: 'candidate-ci-receipt:check', receiptSha256: ci.digest }),
    passLeaf({ ...common, name: 'ux-qe', source: 'ux-qe-receipts:darwin,linux,win32', receiptSha256: uxDigest }),
    passLeaf({ ...common, name: 'release-qe', source: 'candidate-ci-receipt:release-qe', receiptSha256: ci.digest }),
    passLeaf({ ...common, name: 'integration-linux', source: 'integration-receipt', receiptSha256: integration.digest,
      skipped: integration.value.skipped, todo: integration.value.todo }),
    passLeaf({ ...common, name: 'stranger-linux', source: 'stranger-receipt:ubuntu', receiptSha256: stranger.digest }),
    passLeaf({ ...common, name: 'stranger-macos', source: 'stranger-receipt:macos', receiptSha256: stranger.digest }),
    passLeaf({ ...common, name: 'stranger-windows', source: 'stranger-receipt:windows', receiptSha256: stranger.digest }),
    ...host.value.leaves.map((leaf) => ({ ...leaf, runId, receiptSha256: host.digest })),
  ];
  return { leaves, envelope: aggregateEvidence({ sha, payloadId: payload.payloadId, leaves }) };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
  };
  const uxDir = path.resolve(arg('--ux-dir'));
  const uxFiles = fs.readdirSync(uxDir).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(uxDir, name));
  const result = buildPrepublicationEvidence({
    sha: arg('--sha'),
    version: arg('--version'),
    runId: Number(arg('--run-id')),
    manifestFile: path.resolve(arg('--manifest')),
    payloadProofFile: path.resolve(arg('--payload-proof')),
    hostFile: path.resolve(arg('--hosts')),
    ciFile: path.resolve(arg('--ci')),
    integrationFile: path.resolve(arg('--integration')),
    uxFiles,
    strangerFile: path.resolve(arg('--stranger')),
  });
  const leavesOut = path.resolve(arg('--leaves-out'));
  const envelopeOut = path.resolve(arg('--envelope-out'));
  fs.writeFileSync(leavesOut, `${JSON.stringify(result.leaves, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(envelopeOut, `${canonicalJson(result.envelope)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ verdict: result.envelope.verdict, evidenceDigest: result.envelope.evidenceDigest })}\n`);
}
