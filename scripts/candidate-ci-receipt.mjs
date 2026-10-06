#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyPayloadMembers } from './release-payload.mjs';
import { validateQualificationReceipt } from './release-qualification.mjs';

export const REQUIRED_CI_JOBS = ['candidate-preflight', 'release-acceptance-linux',
  'release-acceptance-windows', 'release-acceptance-macos', 'release-qe'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function createCandidateCiReceipt({ sha, runId, runAttempt, results, ciResult, manifestFile,
  candidateFile, acceptanceDir }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !Number.isSafeInteger(runId) || runId <= 0
    || !Number.isSafeInteger(runAttempt) || runAttempt <= 0) throw new Error('candidate CI run identity is invalid');
  if (ciResult !== 'success') throw new Error('candidate CI reusable workflow did not succeed');
  if (!results || Object.keys(results).sort().join(',') !== [...REQUIRED_CI_JOBS].sort().join(',')
    || REQUIRED_CI_JOBS.some(name => results[name] !== 'success')) {
    throw new Error('candidate CI contains a missing or non-success dependency');
  }
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  const candidate = JSON.parse(fs.readFileSync(candidateFile));
  if (manifest.candidateSha !== sha || candidate.sha !== sha || manifest.version !== candidate.version
    || !/^\d+\.\d+\.\d+$/.test(manifest.version || '') || manifest.tag !== `v${manifest.version}`) {
    throw new Error('candidate CI receipt identity differs from checked-out source');
  }
  const members = manifest.members;
  if (!Array.isArray(members) || !members.length
    || new Set(members.map(row => row.name)).size !== members.length
    || members.filter(row => row.role === 'npm').length !== 1) throw new Error('candidate CI payload members are invalid');
  const payload = verifyPayloadMembers({ manifest, root: path.dirname(manifestFile) });
  const npm = members.find(row => row.role === 'npm');
  if (String(candidate.artifact?.sha256 || '').replace(/^sha256:/, '') !== npm.sha256) {
    throw new Error('candidate package digest differs from payload');
  }
  const acceptanceReceipts = ['linux', 'macos', 'windows'].map(platform => {
    const bytes = fs.readFileSync(path.join(acceptanceDir, `release-acceptance-${platform}.json`));
    const report = JSON.parse(bytes);
    const tests = validateQualificationReceipt(report, { suite: 'source', platform, sourceSha: sha });
    return { platform, sourceSha: report.source.sha, passed: tests.passed, receiptSha256: sha256(bytes) };
  });
  return { acceptanceReceipts, schemaVersion: 1, kind: 'ruvnet-brain-candidate-ci-evidence',
    sourceSha: sha, version: manifest.version, payloadId: payload.payloadId,
    payloadManifestSha256: sha256(manifestBytes), producerWorkflow: 'release-candidate-preflight',
    producerJob: 'aggregate', summarizedWorkflow: 'ci', runId, runAttempt,
    jobs: REQUIRED_CI_JOBS.map(name => ({ name, conclusion: results[name],
      workflow: name === 'candidate-preflight' ? 'release-candidate-preflight' : 'ci' })),
    verdict: 'PASS', skipped: 0, unknown: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = createCandidateCiReceipt({ sha: process.env.CANDIDATE_SHA,
    runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    ciResult: process.env.CI_RESULT,
    results: { ...JSON.parse(process.env.CI_RESULTS_JSON), 'candidate-preflight': process.env.PREFLIGHT_RESULT }, manifestFile: 'release-evidence/payload-manifest.json',
    candidateFile: 'release-evidence/candidate-receipt.json', acceptanceDir: 'acceptance-reports' });
  fs.writeFileSync('lane-evidence/ci/candidate-ci-evidence.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
}
