#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import osModule from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest, validateCoverageLedger } from './coverage-integrity.mjs';
import { validateHostRegistry } from './host-registry.mjs';
import { RECEIPT_MODE_NAMES } from './host-install-matrix.mjs';
import { generatePublicationReceipt, livePublicationAdapter, validateCandidateSource } from './publication-receipt.mjs';
import {
  createPublicVerificationLeaf,
  PUBLIC_VERIFICATION_MODES,
  PUBLIC_VERIFICATION_OS,
} from './public-verification-aggregate.mjs';
import { transactionIdFor } from './release-transaction.mjs';
import {
  runRetrievalCanaries,
  validatePlanAgainstCoverage,
  validateRetrievalCanaryReceipt,
} from './retrieval-canary.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const normalizedDigest = (value) => String(value || '').replace(/^sha256:/, '');

function failedCanaryCases(retrieval) {
  return retrieval.cases.filter(({ cohort, status, retrievalHit, citationResolved }) =>
    status !== 'COMPLETED' || retrievalHit !== true || (cohort === 'delta' && citationResolved !== true));
}

function publicVerificationFailure({ os, identity, verifierSha, failures, completedLeaves }) {
  const payload = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-public-verification-failure',
    os,
    sourceSha: identity.candidateSha,
    ...(verifierSha === undefined ? {} : { verifierSha }),
    artifactSha256: identity.packageSha256,
    bundleSha256: identity.bundleSha256,
    failures: failures.map(({ mode, reason, retrieval }) => ({
      mode,
      reason,
      metrics: retrieval.metrics,
      failedCaseIds: failedCanaryCases(retrieval).map(({ id }) => id),
      failedCases: failedCanaryCases(retrieval),
      retrievalReceiptSha256: retrieval.receiptSha256,
    })),
    completedLeaves: completedLeaves.map(({ mode, leafSha256 }) => ({ mode, leafSha256 })),
  };
  return { ...payload, failureSha256: digest(payload) };
}

function validateReleaseIdentity(identity) {
  if (identity?.repository !== 'stuinfla/ruvnet-brain' || identity?.package !== 'ruvnet-brain'
    || !HEX40.test(String(identity.candidateSha || '')) || !HEX64.test(String(identity.payloadId || ''))
    || !HEX64.test(String(identity.packageSha256 || '')) || !HEX64.test(String(identity.bundleSha256 || ''))
    || typeof identity.version !== 'string' || !identity.version || identity.tag !== `v${identity.version}`) {
    throw new Error('release transaction identity is malformed');
  }
  return identity;
}

function validatePublicEvidence({ candidate, publication, identity }) {
  const candidateArtifact = normalizedDigest(candidate?.artifact?.sha256);
  const surface = publication?.postPublicationChecks?.find(({ name }) => name === 'published-surface-probe');
  if (candidate?.sha !== identity.candidateSha || candidate?.version !== identity.version || candidate?.tag !== identity.tag
    || candidateArtifact !== identity.packageSha256 || publication?.sha !== identity.candidateSha
    || publication?.version !== identity.version || publication?.payloadId !== identity.payloadId
    || publication?.artifactSha256 !== identity.packageSha256
    || publication?.bundleArtifactSha256 !== identity.bundleSha256
    || publication?.npm?.version !== identity.version || publication?.npm?.sha !== identity.candidateSha
    || publication?.npm?.artifactSha256 !== identity.packageSha256
    || publication?.githubRelease?.tag !== identity.tag || publication?.githubRelease?.sha !== identity.candidateSha
    || publication?.githubRelease?.artifactSha256 !== identity.packageSha256
    || publication?.brain?.status !== 'PASS' || publication.brain.selfStore !== true
    || surface?.status !== 'completed' || surface?.conclusion !== 'success' || surface?.sha !== identity.candidateSha) {
    throw new Error('public byte identity or functional surface evidence differs from the release transaction');
  }
  return publication;
}

function coverageProjection(coverage) {
  const checked = validateCoverageLedger(coverage);
  if (!checked.valid || coverage.kind !== 'ruvnet-brain-release-coverage') {
    throw new Error(`release coverage is invalid: ${checked.failures.join('; ')}`);
  }
  const repositories = coverage.rows.filter((row) => row.kind === 'repository' && row.disposition === 'eligible');
  const gists = coverage.rows.filter((row) => row.kind === 'gist' && row.disposition === 'eligible');
  const currentRepositories = repositories.filter(({ status }) => status === 'CURRENT').length;
  const currentGists = gists.filter(({ status }) => status === 'CURRENT').length;
  if (currentRepositories !== repositories.length || currentGists !== gists.length) {
    throw new Error('release coverage contains a non-current eligible source');
  }
  return {
    verified: true,
    eligibleCurrent: currentRepositories,
    eligibleTotal: repositories.length,
    gistCurrent: currentGists,
    gistTotal: gists.length,
  };
}

export async function createPublicVerificationLane({
  os,
  verifierSha,
  workflowRunId,
  publicKey,
  candidate,
  publication,
  identity,
  releaseCoverage,
  coverageIdentity,
  retrievalPlan,
  hostRegistry,
  adapter,
} = {}) {
  if (!PUBLIC_VERIFICATION_OS.includes(os)) throw new Error(`unsupported public verification OS: ${os || '(missing)'}`);
  if (verifierSha !== undefined && !HEX40.test(String(verifierSha))) throw new Error('verifier SHA must be a full commit identity');
  if (!/^[1-9][0-9]*$/.test(String(workflowRunId || ''))) throw new Error('workflow run ID is required');
  validateReleaseIdentity(identity);
  validatePublicEvidence({ candidate, publication, identity });
  const registry = validateHostRegistry(hostRegistry);
  const coverage = coverageProjection(releaseCoverage);
  if (!coverageIdentity || retrievalPlan?.coverage?.sha256 !== coverageIdentity.sha256
    || retrievalPlan.coverage.bytes !== coverageIdentity.bytes
    || releaseCoverage.releaseCoverageGeneration !== retrievalPlan.coverage.releaseCoverageGeneration) {
    throw new Error('retrieval plan coverage byte identity differs');
  }
  validatePlanAgainstCoverage(retrievalPlan, releaseCoverage, { allowObservedBaseline: true });
  if (retrievalPlan.candidate.sourceSha !== identity.candidateSha
    || retrievalPlan.candidate.packageSha256 !== identity.packageSha256
    || retrievalPlan.candidate.archiveSha256 !== identity.bundleSha256) {
    throw new Error('retrieval plan candidate identity differs from the release transaction');
  }
  if (!adapter || typeof adapter.searchInstalled !== 'function'
    || typeof adapter.resolveInstalledCitation !== 'function') {
    throw new Error('public verification lane adapter is incomplete');
  }
  const common = {
    workflowRunId: String(workflowRunId),
    sourceSha: identity.candidateSha,
    ...(verifierSha === undefined ? {} : { verifierSha }),
    version: identity.version,
    tag: identity.tag,
    artifactSha256: identity.packageSha256,
    bundleSha256: identity.bundleSha256,
    payloadId: identity.payloadId,
    hostRegistryDigest: registry.registrySha256,
    coverageGeneration: releaseCoverage.releaseCoverageGeneration,
    canaryPlanSha256: retrievalPlan.planSha256,
    releaseTransactionId: transactionIdFor(identity),
  };
  const leaves = [];
  const failures = [];
  for (const mode of PUBLIC_VERIFICATION_MODES) {
    const installed = publication.installed?.[RECEIPT_MODE_NAMES[mode]];
    if (installed?.status !== 'PASS' || installed.doctorExit !== 0 || installed.version !== identity.version
      || installed.artifactSha256 !== identity.packageSha256 || installed.functionalSearch !== true) {
      throw new Error(`${os}/${mode} installed public loader evidence is incomplete`);
    }
    const retrieval = await runRetrievalCanaries({
      plan: retrievalPlan,
      sourceSha: identity.candidateSha,
      artifactSha256: identity.packageSha256,
      candidateArchiveSha256: identity.bundleSha256,
      search: ({ query, k }) => adapter.searchInstalled({ mode, query, k }),
      citationResolver: (matched, expected) => adapter.resolveInstalledCitation({ mode, matched, expected }),
    });
    let verifiedRetrieval;
    try {
      verifiedRetrieval = validateRetrievalCanaryReceipt(
        retrieval,
        { plan: retrievalPlan, requireAcceptance: true },
      );
    } catch (error) {
      failures.push({ mode, reason: error.message, retrieval });
      continue;
    }
    // Native scheduler lifecycle is part of the accepted release contract. Keep
    // the public lane bound to the same proof required by the leaf/aggregate
    // validators; an adapter cannot silently downgrade a dual-host leaf.
    let nativeNightly;
    let nativeSchedulerSmoke;
    if (mode === 'dual') {
      const schedulerMode = process.env.RUVNET_PUBLIC_SCHEDULER_MODE || 'full';
      if (schedulerMode === 'smoke') {
        if (typeof adapter.runNativeNightlySmoke !== 'function') throw new Error('native scheduler smoke adapter is required');
        nativeSchedulerSmoke = await adapter.runNativeNightlySmoke({ identity, workflowRunId: String(workflowRunId) });
      } else {
        if (typeof adapter.runNativeNightly !== 'function') throw new Error('native nightly proof adapter is required');
        nativeNightly = await adapter.runNativeNightly({ identity, workflowRunId: String(workflowRunId) });
      }
    }
    leaves.push(createPublicVerificationLeaf({
      ...common,
      ...(publication.acceptancePolicy ? { acceptancePolicy: publication.acceptancePolicy, searchTiming: { firstSearchMs: installed.searchMs, broadMs: publication.brain.broadMs, deadlineMs: publication.brain.deadlineMs } } : {}),
      ...(nativeNightly === undefined ? {} : { nativeNightly }),
      ...(nativeSchedulerSmoke === undefined ? {} : { nativeSchedulerSmoke }),
      os,
      mode,
      status: verifiedRetrieval.receiptSha256 === retrieval.receiptSha256 ? 'completed' : 'failed',
      verdict: 'PASS',
      publicBytes: { npmExact: true, githubExact: true, bundleExact: true },
      installed: { version: installed.version, loaderVerified: true },
      coverage,
      retrievalPlan,
      retrieval,
      untested: [],
      skipped: 0,
      unknown: 0,
    }, { publicKey }));
  }
  if (failures.length) {
    const error = new Error(`retrieval canary acceptance failed for ${failures.map(({ mode }) => mode).join(', ')}`);
    error.publicVerificationFailure = publicVerificationFailure({ os, identity, verifierSha, failures, completedLeaves: leaves });
    throw error;
  }
  if (canonicalJson(leaves.map(({ mode }) => mode)) !== canonicalJson(PUBLIC_VERIFICATION_MODES)) {
    throw new Error('public verification lane modes are incomplete');
  }
  return leaves;
}

const hostOperatingSystem = () => ({ linux: 'linux', darwin: 'macos', win32: 'windows' })[process.platform] || null;

function regularJson(file, label) {
  const absolute = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted regular file`);
  return { absolute, bytes: fs.readFileSync(absolute), value: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
}

export function resolveVerifierSha(root, expected) {
  const options = { cwd: root, encoding: 'utf8' };
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  if (!HEX40.test(actual) || (expected !== undefined && expected !== actual)) {
    throw new Error('verifier SHA differs from the executing checkout');
  }
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], options).trim()) {
    throw new Error('verifier checkout has tracked changes');
  }
  return actual;
}

export async function generatePublicVerificationLane({
  os,
  verifierSha: expectedVerifierSha,
  workflowRunId,
  candidatePath,
  identityPath,
  coveragePath,
  planPath,
  registryPath,
  outPath,
  root = process.cwd(),
  candidateRoot = root,
  adapter = livePublicationAdapter({ root, candidateRoot }),
} = {}) {
  if (os !== hostOperatingSystem()) throw new Error(`runner OS ${hostOperatingSystem() || process.platform} cannot produce ${os || '(missing)'}`);
  const rootDirectory = fs.statSync(root, { bigint: true });
  const scriptDirectory = fs.statSync(fileURLToPath(new URL('..', import.meta.url)), { bigint: true });
  if (!rootDirectory.isDirectory() || rootDirectory.ino <= 0n
    || rootDirectory.dev !== scriptDirectory.dev || rootDirectory.ino !== scriptDirectory.ino) {
    throw new Error('verifier root differs from the executing script checkout');
  }
  const verifierSha = resolveVerifierSha(root, expectedVerifierSha);
  const candidate = regularJson(candidatePath, 'candidate receipt');
  validateCandidateSource(candidateRoot, candidate.value);
  const identity = regularJson(identityPath, 'release identity');
  const releaseCoverage = regularJson(coveragePath, 'release coverage');
  const retrievalPlan = regularJson(planPath, 'retrieval plan');
  const hostRegistry = regularJson(registryPath, 'host registry');
  const output = path.resolve(outPath || '');
  if (!outPath) throw new Error('--out is required');
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite public verification lane: ${output}`);
  const temp = fs.mkdtempSync(path.join(osModule.tmpdir(), `ruvnet-public-${os}-`));
  const publicationPath = path.join(temp, 'publication-receipt.json');
  try {
    await generatePublicationReceipt({ root, candidatePath: candidate.absolute, outPath: publicationPath,
      adapter, disposeAdapter: false });
    const publication = JSON.parse(fs.readFileSync(publicationPath, 'utf8'));
    const leaves = await createPublicVerificationLane({
      os,
      verifierSha,
      workflowRunId,
      candidate: candidate.value,
      publication,
      identity: identity.value,
      releaseCoverage: releaseCoverage.value,
      coverageIdentity: { sha256: crypto.createHash('sha256').update(releaseCoverage.bytes).digest('hex'),
        bytes: releaseCoverage.bytes.length },
      retrievalPlan: retrievalPlan.value,
      hostRegistry: hostRegistry.value,
      adapter,
    });
    resolveVerifierSha(root, verifierSha);
    validateCandidateSource(candidateRoot, candidate.value);
    const payload = { schemaVersion: 1, kind: 'ruvnet-brain-public-verification-os-lane', os,
      verifierSha, sourceSha: identity.value.candidateSha, leaves };
    const receipt = { ...payload, laneSha256: digest(payload) };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return receipt;
  } catch (error) {
    if (!fs.existsSync(output)) {
      const failure = error.publicVerificationFailure || (() => {
        const payload = { schemaVersion: 1, kind: 'ruvnet-brain-public-verification-failure',
          os, verifierSha, sourceSha: identity.value.candidateSha,
          artifactSha256: identity.value.packageSha256, bundleSha256: identity.value.bundleSha256,
          workflowRunId: String(workflowRunId || ''),
          failures: [{ stage: 'public-install-and-native-update', reason: String(error.message).slice(0, 2000) }],
          completedLeaves: [] };
        return { ...payload, failureSha256: digest(payload) };
      })();
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(failure, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
    }
    throw error;
  } finally {
    await adapter.dispose?.();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const receipt = await generatePublicVerificationLane({
      os: argument(args, '--os'),
      verifierSha: argument(args, '--verifier-sha') ?? undefined,
      workflowRunId: argument(args, '--workflow-run-id'),
      candidateRoot: argument(args, '--candidate-root') ?? undefined,
      candidatePath: argument(args, '--candidate'),
      identityPath: argument(args, '--identity'),
      coveragePath: argument(args, '--coverage'),
      planPath: argument(args, '--plan'),
      registryPath: argument(args, '--registry'),
      outPath: argument(args, '--out'),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, os: receipt.os, laneSha256: receipt.laneSha256 })}\n`);
    return 0;
  } catch (error) {
    console.error(`public-verification-lane: ${error.message}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) process.exitCode = await main();
