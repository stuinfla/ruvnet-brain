import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  REQUIRED_CHECKS,
  evaluateCandidateReceipt,
  evaluateStabilizationCandidateReceipt,
  evaluateLivePreflight,
  evaluatePublicationReceipt,
  latestRunsByWorkflow,
} from '../../scripts/release-proof.mjs';

const require = createRequire(import.meta.url);
const VERSION = require('../../package.json').version;
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function stabilizationCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: 'stabilization-candidate',
    mode: 'stabilization',
    targetScore: 95,
    scoreClaimed: false,
    sha: SHA,
    tree: 'c'.repeat(40),
    dirty: false,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceVersions: { package: VERSION, claudePlugin: VERSION, codexPlugin: VERSION },
    artifact: { path: 'release-evidence/ruvnet-brain.tgz', sha256: DIGEST.slice(7), sourceSha: SHA, version: VERSION },
    security: { status: 'PASS', critical: 0, high: 0 },
    qe: { status: 'PASS', total: 34, passed: 34, failed: 0, skipped: 0 },
    ...overrides,
  };
}

function greenCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: 'candidate',
    sha: SHA,
    tree: 'c'.repeat(40),
    dirty: false,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceVersions: {
      package: VERSION,
      claudePlugin: VERSION,
      codexPlugin: VERSION,
    },
    artifact: {
      path: '/tmp/ruvnet-brain.tgz',
      sha256: DIGEST.slice(7),
      sourceSha: SHA,
      version: VERSION,
      bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
    },
    releaseVector: { verdict: 'PASS', sha: SHA, unknown: 0, skipped: 0 },
    tests: { total: 2800, passed: 2800, failed: 0, skipped: 0, todo: 0 },
    coverage: { status: 'PASS', lines: 85, requiredLines: 80 },
    security: { status: 'PASS', critical: 0, high: 0 },
    issues: { open: [] },
    github: {
      sha: SHA,
      checks: REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    },
    hosts: {
      claude: { status: 'PASS', version: VERSION, artifactSha256: DIGEST.slice(7) },
      codex: { status: 'PASS', version: VERSION, artifactSha256: DIGEST.slice(7) },
    },
    brain: {
      status: 'PASS',
      selfStore: true,
      narrowMs: 1000,
      broadMs: 5000,
      concurrentMs: 1400,
      deadlineMs: 30_000,
      citedSelfSource: true,
    },
    qe: { status: 'PASS', total: 100, passed: 100, failed: 0, skipped: 0 },
    graders: [
      { id: 'grader-a', independent: true, score: 98, sha: SHA, artifactSha256: DIGEST.slice(7) },
      { id: 'grader-b', independent: true, score: 96, sha: SHA, artifactSha256: DIGEST.slice(7) },
    ],
    ...overrides,
  };
}

describe('release-proof candidate authority', () => {
  it('passes only a fully bound, measured candidate', () => {
    const result = evaluateCandidateReceipt(greenCandidate());
    expect(result.verdict).toBe('PASS');
    expect(result.failures).toEqual([]);
  });

  it.each([
    ['dirty worktree', { dirty: true }, 'DIRTY_WORKTREE'],
    ['zero tests', { tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 } }, 'ZERO_TESTS'],
    ['skipped tests', { tests: { total: 10, passed: 9, failed: 0, skipped: 1, todo: 0 } }, 'TESTS_NOT_ALL_EXECUTED'],
    ['todo tests', { tests: { total: 10, passed: 9, failed: 0, skipped: 0, todo: 1 } }, 'TESTS_NOT_ALL_EXECUTED'],
    ['open issue', { issues: { open: [{ number: 54, title: 'timeout' }] } }, 'OPEN_ISSUES'],
    ['unknown release vector', { releaseVector: { verdict: 'UNKNOWN', sha: SHA, unknown: 1, skipped: 0 } }, 'RELEASE_VECTOR_NOT_PASS'],
    ['vacuous QE', { qe: { status: 'PASS', total: 0, passed: 0, failed: 0, skipped: 0 } }, 'QE_ZERO_TESTS'],
    ['missing self RVF', { brain: { ...greenCandidate().brain, selfStore: false } }, 'BRAIN_SELF_STORE_MISSING'],
    ['slow broad query', { brain: { ...greenCandidate().brain, broadMs: 25_000, deadlineMs: 30_000 } }, 'BRAIN_DEADLINE_MARGIN'],
    ['one grader', { graders: [greenCandidate().graders[0]] }, 'INDEPENDENT_GRADERS'],
    ['low grader', { graders: [{ ...greenCandidate().graders[0], score: 94 }, greenCandidate().graders[1]] }, 'GRADER_BELOW_95'],
  ])('fails closed on %s', (_name, override, code) => {
    expect(evaluateCandidateReceipt(greenCandidate(override)).failures.map((f) => f.code)).toContain(code);
  });

  it('requires every named GitHub check to succeed on the exact SHA', () => {
    const receipt = greenCandidate();
    receipt.github.checks = receipt.github.checks.filter((check) => check.name !== REQUIRED_CHECKS[0]);
    expect(evaluateCandidateReceipt(receipt).failures.map((f) => f.code)).toContain('REQUIRED_CHECK_MISSING');

    const pending = greenCandidate();
    pending.github.checks[0] = { ...pending.github.checks[0], status: 'in_progress', conclusion: null };
    expect(evaluateCandidateReceipt(pending).failures.map((f) => f.code)).toContain('REQUIRED_CHECK_NOT_GREEN');
  });

  it('rejects any SHA or artifact-digest split', () => {
    const receipt = greenCandidate();
    receipt.graders[1].sha = 'd'.repeat(40);
    receipt.hosts.codex.artifactSha256 = 'e'.repeat(64);
    const codes = evaluateCandidateReceipt(receipt).failures.map((f) => f.code);
    expect(codes).toContain('GRADER_BINDING_MISMATCH');
    expect(codes).toContain('HOST_ARTIFACT_MISMATCH');
  });

  it.each([
    ['candidate tag', (receipt) => { receipt.tag = `v${VERSION}-split`; }],
    ['npm package source', (receipt) => { receipt.sourceVersions.package = `${VERSION}-split`; }],
    ['Claude plugin source', (receipt) => { receipt.sourceVersions.claudePlugin = `${VERSION}-split`; }],
    ['Codex plugin source', (receipt) => { receipt.sourceVersions.codexPlugin = `${VERSION}-split`; }],
    ['packed npm artifact', (receipt) => { receipt.artifact.version = `${VERSION}-split`; }],
    ['bundle brainVersion', (receipt) => { receipt.artifact.bundle.brainVersion = `${VERSION}-split`; }],
    ['bundle releaseTag', (receipt) => { receipt.artifact.bundle.releaseTag = `v${VERSION}-split`; }],
    ['installed Claude host', (receipt) => { receipt.hosts.claude.version = `${VERSION}-split`; }],
    ['installed Codex host', (receipt) => { receipt.hosts.codex.version = `${VERSION}-split`; }],
  ])('rejects a split version identity at %s', (_name, mutate) => {
    const receipt = greenCandidate();
    mutate(receipt);
    expect(evaluateCandidateReceipt(receipt).failures.map((failure) => failure.code))
      .toContain('VERSION_IDENTITY_MISMATCH');
  });
});

describe('release-proof stabilization authority', () => {
  it('accepts a transparent stabilization receipt without claiming 95', () => {
    expect(evaluateStabilizationCandidateReceipt(stabilizationCandidate())).toMatchObject({ verdict: 'PASS', failures: [] });
    expect(evaluateCandidateReceipt(stabilizationCandidate()).verdict).toBe('PASS');
  });

  it.each([
    ['fake 95 claim', { scoreClaimed: true }, 'STABILIZATION_SCORE_MISREPRESENTED'],
    ['missing score declaration', { scoreClaimed: undefined }, 'STABILIZATION_SCORE_MISREPRESENTED'],
    ['red QE', { qe: { status: 'FAIL', total: 34, passed: 33, failed: 1, skipped: 0 } }, 'QE_NOT_PASS'],
    ['inconsistent QE total', { qe: { status: 'PASS', total: 34, passed: 33, failed: 0, skipped: 0 } }, 'QE_NOT_PASS'],
    ['red security', { security: { status: 'FAIL', critical: 0, high: 1 } }, 'SECURITY_NOT_PASS'],
  ])('fails closed on %s', (_name, override, code) => {
    expect(evaluateStabilizationCandidateReceipt(stabilizationCandidate(override)).failures.map((item) => item.code)).toContain(code);
  });

});

describe('release-proof publication authority', () => {
  it('requires public bytes, installed hosts, active self-RVF, and post-publication checks to match the seal', () => {
    const candidate = greenCandidate();
    const publication = {
      schemaVersion: 1,
      phase: 'publication',
      sha: SHA,
      artifactSha256: DIGEST.slice(7),
      version: VERSION,
      npm: { version: VERSION, sha: SHA, artifactSha256: DIGEST.slice(7) },
      githubRelease: { tag: `v${VERSION}`, sha: SHA, artifactSha256: DIGEST.slice(7) },
      bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
      installed: {
        claude: { version: VERSION, artifactSha256: DIGEST.slice(7), status: 'PASS' },
        codex: { version: VERSION, artifactSha256: DIGEST.slice(7), status: 'PASS' },
      },
      brain: { status: 'PASS', selfStore: true, broadMs: 4000, deadlineMs: 30_000 },
      postPublicationChecks: [
        { name: 'published-surface-probe', status: 'completed', conclusion: 'success', sha: SHA },
      ],
    };
    expect(evaluatePublicationReceipt(candidate, publication).verdict).toBe('PASS');

    publication.npm.artifactSha256 = 'f'.repeat(64);
    expect(evaluatePublicationReceipt(candidate, publication).failures.map((f) => f.code))
      .toContain('PUBLIC_ARTIFACT_MISMATCH');
  });

  it.each([
    ['publication version', (receipt) => { receipt.version = `${VERSION}-split`; }],
    ['npm version', (receipt) => { receipt.npm.version = `${VERSION}-split`; }],
    ['GitHub tag', (receipt) => { receipt.githubRelease.tag = `v${VERSION}-split`; }],
    ['bundle brainVersion', (receipt) => { receipt.bundle.brainVersion = `${VERSION}-split`; }],
    ['bundle releaseTag', (receipt) => { receipt.bundle.releaseTag = `v${VERSION}-split`; }],
    ['Claude installed version', (receipt) => { receipt.installed.claude.version = `${VERSION}-split`; }],
    ['Codex installed version', (receipt) => { receipt.installed.codex.version = `${VERSION}-split`; }],
  ])('rejects public split identity at %s', (_name, mutate) => {
    const candidate = greenCandidate();
    const publication = {
      schemaVersion: 1,
      phase: 'publication',
      sha: SHA,
      artifactSha256: DIGEST.slice(7),
      version: VERSION,
      npm: { version: VERSION, sha: SHA, artifactSha256: DIGEST.slice(7) },
      githubRelease: { tag: `v${VERSION}`, sha: SHA, artifactSha256: DIGEST.slice(7) },
      bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
      installed: {
        claude: { version: VERSION, artifactSha256: DIGEST.slice(7), status: 'PASS' },
        codex: { version: VERSION, artifactSha256: DIGEST.slice(7), status: 'PASS' },
      },
      brain: { status: 'PASS', selfStore: true, broadMs: 4000, deadlineMs: 30_000 },
      postPublicationChecks: [
        { name: 'published-surface-probe', status: 'completed', conclusion: 'success', sha: SHA },
      ],
    };
    mutate(publication);
    expect(evaluatePublicationReceipt(candidate, publication).failures.map((failure) => failure.code))
      .toContain('PUBLIC_VERSION_IDENTITY_MISMATCH');
  });
});

describe('release-proof live preflight', () => {
  it('uses only the newest exact-SHA result per workflow', () => {
    expect(latestRunsByWorkflow([
      { workflowName: 'ci', databaseId: 2, conclusion: 'success' },
      { workflowName: 'ci', databaseId: 1, conclusion: 'failure' },
      { workflowName: 'ux-qe', databaseId: 3, conclusion: 'failure' },
    ])).toEqual([
      { workflowName: 'ci', databaseId: 2, conclusion: 'success' },
      { workflowName: 'ux-qe', databaseId: 3, conclusion: 'failure' },
    ]);
  });

  it('shows the current class of bypass and delivery blockers instead of claiming readiness', () => {
    const result = evaluateLivePreflight({
      localSha: SHA,
      remoteSha: 'd'.repeat(40),
      dirty: true,
      openIssues: [{ number: 54 }],
      failedRuns: [{ workflowName: 'ci', conclusion: 'failure' }],
      activeSelfStore: false,
      branchEnforceAdmins: false,
      productionProtected: false,
      releaseVector: 'FAIL',
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
      'DIRTY_WORKTREE',
      'REMOTE_SHA_MISMATCH',
      'OPEN_ISSUES',
      'GITHUB_FAILURES',
      'BRAIN_SELF_STORE_MISSING',
      'ADMIN_BYPASS_ENABLED',
      'PRODUCTION_ENV_UNPROTECTED',
      'RELEASE_VECTOR_NOT_PASS',
    ]));
  });
});
