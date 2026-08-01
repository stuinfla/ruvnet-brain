#!/usr/bin/env node
// Fail-closed release authority. It validates evidence bound to one clean source SHA and one
// packed-artifact digest. It never publishes and never converts UNKNOWN/SKIP/zero work into PASS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const REQUIRED_CHECKS = ['ci', 'integration-linux', 'stranger-matrix', 'ux-qe', 'release-qe'];

const fail = (code, detail) => ({ code, detail });
const cleanHex = (value, length) => new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(String(value || ''));
const digestOf = (receipt) => String(receipt?.artifact?.sha256 || '').replace(/^sha256:/, '');
const versionField = (value) => typeof value === 'string' && value.length > 0 ? value : null;

function versionIdentityFailures(expectedVersion, expectedTag, fields) {
  const mismatches = [];
  if (!versionField(expectedVersion)) mismatches.push('version is missing');
  if (expectedTag !== `v${expectedVersion}`) mismatches.push(`tag=${expectedTag ?? 'missing'}`);
  for (const [name, value, expected = expectedVersion] of fields) {
    if (value !== expected) mismatches.push(`${name}=${value ?? 'missing'}`);
  }
  return mismatches;
}

export function evaluateCandidateReceipt(receipt) {
  const failures = [];
  const sha = String(receipt?.sha || '');
  const digest = digestOf(receipt);

  if (receipt?.schemaVersion !== 1 || receipt?.phase !== 'candidate') failures.push(fail('INVALID_RECEIPT', 'schemaVersion=1 and phase=candidate are required'));
  if (!cleanHex(sha, 40) || !cleanHex(receipt?.tree, 40)) failures.push(fail('INVALID_LINEAGE', 'candidate SHA and tree must be full git object ids'));
  if (receipt?.dirty !== false) failures.push(fail('DIRTY_WORKTREE', 'release candidates must come from a clean worktree'));
  if (!cleanHex(digest, 64)) failures.push(fail('INVALID_ARTIFACT_DIGEST', 'artifact SHA-256 is missing or malformed'));
  if (receipt?.artifact?.sourceSha !== sha) failures.push(fail('ARTIFACT_SOURCE_MISMATCH', 'packed artifact is not bound to the candidate SHA'));

  const version = versionField(receipt?.version);
  const tag = version ? `v${version}` : null;
  const identityMismatches = versionIdentityFailures(version, receipt?.tag, [
    ['source package', receipt?.sourceVersions?.package],
    ['source Claude plugin', receipt?.sourceVersions?.claudePlugin],
    ['source Codex plugin', receipt?.sourceVersions?.codexPlugin],
    ['packed npm artifact', receipt?.artifact?.version],
    ['bundle brainVersion', receipt?.artifact?.bundle?.brainVersion],
    ['bundle releaseTag', receipt?.artifact?.bundle?.releaseTag, tag],
    ['installed Claude host', receipt?.hosts?.claude?.version],
    ['installed Codex host', receipt?.hosts?.codex?.version],
  ]);
  if (identityMismatches.length > 0) {
    failures.push(fail('VERSION_IDENTITY_MISMATCH', `candidate surfaces must identify one generation: ${identityMismatches.join(', ')}`));
  }

  const vector = receipt?.releaseVector || {};
  if (vector.verdict !== 'PASS' || vector.sha !== sha || vector.unknown !== 0 || vector.skipped !== 0) {
    failures.push(fail('RELEASE_VECTOR_NOT_PASS', 'release vector must PASS on the exact SHA with zero UNKNOWN/SKIP'));
  }

  const tests = receipt?.tests || {};
  if (!(tests.total > 0)) failures.push(fail('ZERO_TESTS', 'a zero-test run is never evidence'));
  if (tests.failed !== 0 || tests.skipped !== 0 || tests.todo !== 0 || tests.passed !== tests.total) {
    failures.push(fail('TESTS_NOT_ALL_EXECUTED', 'all discovered tests must execute and pass; skipped/todo are release failures'));
  }
  const coverage = receipt?.coverage || {};
  if (coverage.status !== 'PASS' || !(coverage.lines >= coverage.requiredLines)) failures.push(fail('COVERAGE_NOT_PASS', 'fresh exact-SHA coverage must meet the floor'));
  const security = receipt?.security || {};
  if (security.status !== 'PASS' || security.critical !== 0 || security.high !== 0) failures.push(fail('SECURITY_NOT_PASS', 'security must pass with zero critical/high findings'));

  const openIssues = Array.isArray(receipt?.issues?.open) ? receipt.issues.open : null;
  if (openIssues === null || openIssues.length > 0) failures.push(fail('OPEN_ISSUES', openIssues === null ? 'open-issue evidence missing' : `${openIssues.length} issue(s) remain open`));

  if (receipt?.github?.sha !== sha) failures.push(fail('GITHUB_SHA_MISMATCH', 'GitHub evidence is not bound to candidate SHA'));
  const checks = Array.isArray(receipt?.github?.checks) ? receipt.github.checks : [];
  for (const name of REQUIRED_CHECKS) {
    const matches = checks.filter((check) => check?.name === name);
    if (matches.length === 0) failures.push(fail('REQUIRED_CHECK_MISSING', `${name} has no exact-SHA result`));
    else if (!matches.some((check) => check.status === 'completed' && check.conclusion === 'success')) failures.push(fail('REQUIRED_CHECK_NOT_GREEN', `${name} is not completed/success`));
  }

  for (const hostName of ['claude', 'codex']) {
    const host = receipt?.hosts?.[hostName];
    if (host?.status !== 'PASS') failures.push(fail('HOST_NOT_PASS', `${hostName} clean-install acceptance did not pass`));
    if (host?.artifactSha256 !== digest) failures.push(fail('HOST_ARTIFACT_MISMATCH', `${hostName} did not install the sealed artifact`));
  }

  const brain = receipt?.brain || {};
  if (brain.status !== 'PASS') failures.push(fail('BRAIN_NOT_PASS', 'installed MCP search acceptance did not pass'));
  if (brain.selfStore !== true) failures.push(fail('BRAIN_SELF_STORE_MISSING', 'active RVF registry does not contain ruvnet-brain'));
  if (brain.citedSelfSource !== true) failures.push(fail('BRAIN_SELF_CITATION_MISSING', 'installed Brain did not cite its own source'));
  const deadline = Number(brain.deadlineMs);
  const observed = Math.max(Number(brain.narrowMs), Number(brain.broadMs), Number(brain.concurrentMs));
  if (!(deadline > 0) || !Number.isFinite(observed) || observed > deadline * 0.8) failures.push(fail('BRAIN_DEADLINE_MARGIN', 'searches must finish within 80% of deadline'));

  const qe = receipt?.qe || {};
  if (!(qe.total > 0)) failures.push(fail('QE_ZERO_TESTS', 'Agentic QE executed zero tests'));
  if (qe.status !== 'PASS' || qe.failed !== 0 || qe.skipped !== 0 || qe.passed !== qe.total) failures.push(fail('QE_NOT_PASS', 'Agentic QE must run a nonzero fleet with zero failed/skipped tests'));

  const graders = Array.isArray(receipt?.graders) ? receipt.graders : [];
  const independent = graders.filter((grader) => grader?.independent === true);
  if (independent.length < 2 || new Set(independent.map((grader) => grader.id)).size < 2) failures.push(fail('INDEPENDENT_GRADERS', 'two distinct independent graders are required'));
  for (const grader of independent) {
    if (!(grader.score >= 95)) failures.push(fail('GRADER_BELOW_95', `${grader.id || 'grader'} scored ${grader.score ?? 'UNKNOWN'}`));
    if (grader.sha !== sha || grader.artifactSha256 !== digest) failures.push(fail('GRADER_BINDING_MISMATCH', `${grader.id || 'grader'} is not bound to the seal`));
  }

  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', sha, artifactSha256: digest, failures };
}

export function evaluatePublicationReceipt(candidate, publication) {
  const candidateResult = evaluateCandidateReceipt(candidate);
  const failures = [...candidateResult.failures];
  const sha = candidateResult.sha;
  const digest = candidateResult.artifactSha256;
  if (publication?.schemaVersion !== 1 || publication?.phase !== 'publication') failures.push(fail('INVALID_PUBLICATION_RECEIPT', 'schemaVersion=1 and phase=publication are required'));
  if (publication?.sha !== sha || publication?.artifactSha256 !== digest) failures.push(fail('PUBLICATION_SEAL_MISMATCH', 'publication does not reference candidate seal'));
  const version = versionField(candidate?.version);
  const tag = version ? `v${version}` : null;
  const identityMismatches = versionIdentityFailures(version, candidate?.tag, [
    ['publication version', publication?.version],
    ['npm version', publication?.npm?.version],
    ['GitHub release tag', publication?.githubRelease?.tag, tag],
    ['bundle brainVersion', publication?.bundle?.brainVersion],
    ['bundle releaseTag', publication?.bundle?.releaseTag, tag],
    ['installed Claude host', publication?.installed?.claude?.version],
    ['installed Codex host', publication?.installed?.codex?.version],
  ]);
  if (identityMismatches.length > 0) {
    failures.push(fail('PUBLIC_VERSION_IDENTITY_MISMATCH', `public surfaces must identify candidate ${version ?? 'UNKNOWN'}: ${identityMismatches.join(', ')}`));
  }
  for (const surface of ['npm', 'githubRelease']) {
    const item = publication?.[surface];
    if (item?.sha !== sha || item?.artifactSha256 !== digest) failures.push(fail('PUBLIC_ARTIFACT_MISMATCH', `${surface} differs from candidate seal`));
  }
  for (const hostName of ['claude', 'codex']) {
    const host = publication?.installed?.[hostName];
    if (host?.status !== 'PASS' || host?.artifactSha256 !== digest) failures.push(fail('PUBLIC_HOST_NOT_PASS', `${hostName} is not running sealed public artifact`));
  }
  const brain = publication?.brain || {};
  if (brain.status !== 'PASS' || brain.selfStore !== true || !(brain.broadMs <= Number(brain.deadlineMs) * 0.8)) failures.push(fail('PUBLIC_BRAIN_NOT_PASS', 'public installed Brain acceptance failed'));
  const probes = Array.isArray(publication?.postPublicationChecks) ? publication.postPublicationChecks : [];
  const probe = probes.find((check) => check?.name === 'published-surface-probe' && check?.sha === sha);
  if (probe?.status !== 'completed' || probe?.conclusion !== 'success') failures.push(fail('POST_PUBLICATION_CHECK_NOT_GREEN', 'published-surface-probe is not green'));
  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', sha, artifactSha256: digest, failures };
}

export function evaluateLivePreflight(observed) {
  const failures = [];
  if (observed?.dirty !== false) failures.push(fail('DIRTY_WORKTREE', 'local worktree is dirty'));
  if (observed?.localSha !== observed?.remoteSha) failures.push(fail('REMOTE_SHA_MISMATCH', 'local HEAD is not origin/main'));
  if (!Array.isArray(observed?.openIssues) || observed.openIssues.length > 0) failures.push(fail('OPEN_ISSUES', `${observed?.openIssues?.length ?? 'unknown'} issue(s) open`));
  if (!Array.isArray(observed?.failedRuns) || observed.failedRuns.length > 0) failures.push(fail('GITHUB_FAILURES', `${observed?.failedRuns?.length ?? 'unknown'} recent failed run(s)`));
  if (observed?.activeSelfStore !== true) failures.push(fail('BRAIN_SELF_STORE_MISSING', 'installed active registry lacks ruvnet-brain'));
  if (observed?.branchEnforceAdmins !== true) failures.push(fail('ADMIN_BYPASS_ENABLED', 'main protection does not enforce required checks for admins'));
  if (observed?.productionProtected !== true) failures.push(fail('PRODUCTION_ENV_UNPROTECTED', 'production environment has no required reviewer protection'));
  if (observed?.releaseVector !== 'PASS') failures.push(fail('RELEASE_VECTOR_NOT_PASS', `release vector is ${observed?.releaseVector ?? 'UNKNOWN'}`));
  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', observed, failures };
}

export function latestRunsByWorkflow(runs) {
  const latest = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const prior = latest.get(run.workflowName);
    if (!prior || Number(run.databaseId || 0) > Number(prior.databaseId || 0)) latest.set(run.workflowName, run);
  }
  return [...latest.values()];
}

function command(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function jsonCommand(cmd, args, options = {}) {
  const result = command(cmd, args, options);
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export function collectLivePreflight({ root = process.cwd(), repo = 'stuinfla/ruvnet-brain', includeVector = true } = {}) {
  const git = (args) => command('git', args, { cwd: root });
  const localSha = git(['rev-parse', 'HEAD']).stdout.trim();
  const dirty = Boolean(git(['status', '--porcelain']).stdout.trim());
  git(['fetch', '--quiet', 'origin', 'main']);
  const remoteSha = git(['rev-parse', 'origin/main']).stdout.trim();
  const openIssues = jsonCommand('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url']) ?? null;
  const runs = jsonCommand('gh', ['run', 'list', '--repo', repo, '--limit', '50', '--json', 'databaseId,workflowName,headSha,status,conclusion,url']) ?? null;
  const failedRuns = Array.isArray(runs)
    ? latestRunsByWorkflow(runs.filter((run) => run.headSha === remoteSha))
      .filter((run) => run.status !== 'completed' || run.conclusion !== 'success')
    : null;
  const protection = jsonCommand('gh', ['api', `repos/${repo}/branches/main/protection`]);
  const environments = jsonCommand('gh', ['api', `repos/${repo}/environments`]);
  const production = environments?.environments?.find((environment) => environment.name === 'Production – ruvnet-brain');
  let activeSelfStore = false;
  try {
    const source = JSON.parse(fs.readFileSync(path.join(process.env.HOME || '', '.cache/ruvnet-brain/kb/SOURCE.json'), 'utf8'));
    const stores = source.sources || source.repos || {};
    activeSelfStore = Boolean(stores['ruvnet-brain']);
  } catch {}
  let releaseVector = 'UNKNOWN';
  if (includeVector) {
    const vector = jsonCommand(process.execPath, [path.join(root, 'scripts/release-vector.mjs'), '--json'], { cwd: root });
    releaseVector = vector?.verdict || 'UNKNOWN';
  }
  return {
    localSha,
    remoteSha,
    dirty,
    openIssues,
    failedRuns,
    activeSelfStore,
    branchEnforceAdmins: protection?.enforce_admins?.enabled === true,
    productionProtected: Array.isArray(production?.protection_rules) && production.protection_rules.length > 0 && production.can_admins_bypass === false,
    releaseVector,
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const argument = (args, flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};

export function main(args = process.argv.slice(2)) {
  if (args.includes('--status')) {
    const result = evaluateLivePreflight(collectLivePreflight({ includeVector: !args.includes('--quick') }));
    console.log(JSON.stringify(result, null, 2));
    return result.verdict === 'PASS' ? 0 : 1;
  }
  const candidatePath = argument(args, '--candidate');
  const publicationPath = argument(args, '--publication');
  if (!candidatePath) {
    console.error('Usage: release-proof.mjs --candidate <candidate-receipt.json> [--publication <publication-receipt.json>]');
    return 2;
  }
  try {
    const candidate = readJson(candidatePath);
    const result = publicationPath ? evaluatePublicationReceipt(candidate, readJson(publicationPath)) : evaluateCandidateReceipt(candidate);
    console.log(JSON.stringify(result, null, 2));
    return result.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(`release-proof: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
