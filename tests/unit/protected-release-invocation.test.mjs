import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { REQUIRED_CHECKS } from '../../scripts/release-proof.mjs';
import { validateProtectedPublishInvocation } from '../../scripts/protected-release-invocation.mjs';
import { getVersion } from '../../scripts/version.mjs';

const SHA = 'a'.repeat(40);
const VERSION = getVersion();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-release-'));
  const evidence = path.join(root, 'release-evidence');
  fs.mkdirSync(evidence);
  const artifactPath = path.join(evidence, `ruvnet-brain-${VERSION}.tgz`);
  fs.writeFileSync(artifactPath, 'sealed candidate bytes');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
  const receipt = {
    schemaVersion: 1,
    phase: 'candidate',
    sha: SHA,
    tree: 'b'.repeat(40),
    dirty: false,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceVersions: { package: VERSION, claudePlugin: VERSION, codexPlugin: VERSION },
    artifact: {
      path: `release-evidence/ruvnet-brain-${VERSION}.tgz`,
      sha256: digest,
      sourceSha: SHA,
      version: VERSION,
      bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
    },
    releaseVector: { verdict: 'PASS', sha: SHA, unknown: 0, skipped: 0 },
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    coverage: { status: 'PASS', lines: 95, requiredLines: 80 },
    security: { status: 'PASS', critical: 0, high: 0 },
    issues: { open: [] },
    github: {
      sha: SHA,
      checks: REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    },
    hosts: {
      claude: { status: 'PASS', version: VERSION, artifactSha256: digest },
      codex: { status: 'PASS', version: VERSION, artifactSha256: digest },
    },
    brain: {
      status: 'PASS', selfStore: true, citedSelfSource: true,
      narrowMs: 100, broadMs: 200, concurrentMs: 150, deadlineMs: 1000,
    },
    qe: { status: 'PASS', total: 1, passed: 1, failed: 0, skipped: 0 },
    graders: [
      { id: 'grader-a', independent: true, score: 95, sha: SHA, artifactSha256: digest },
      { id: 'grader-b', independent: true, score: 96, sha: SHA, artifactSha256: digest },
    ],
  };
  const receiptPath = path.join(evidence, 'candidate-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'protected-release',
    RUVNET_CANDIDATE_RECEIPT: 'release-evidence/candidate-receipt.json',
    RUVNET_EXPECTED_SHA: SHA,
    RUVNET_EXPECTED_ARTIFACT_SHA256: digest,
    RUVNET_EXPECTED_VERSION: VERSION,
  };
  return { root, env, receipt, digest };
}

describe('protected publish invocation guard', () => {
  it('accepts only the protected workflow carrying a valid exact artifact seal', () => {
    const f = fixture();
    expect(validateProtectedPublishInvocation({ root: f.root, env: f.env })).toMatchObject({
      verdict: 'PASS', sha: SHA, artifactSha256: f.digest, version: VERSION,
    });
  });

  it.each([
    ['local invocation', (f) => { delete f.env.GITHUB_ACTIONS; }],
    ['wrong workflow', (f) => { f.env.GITHUB_WORKFLOW = 'ci'; }],
    ['missing receipt', (f) => { f.env.RUVNET_CANDIDATE_RECEIPT = ''; }],
    ['split SHA', (f) => { f.env.RUVNET_EXPECTED_SHA = 'c'.repeat(40); }],
    ['split digest', (f) => { f.env.RUVNET_EXPECTED_ARTIFACT_SHA256 = 'd'.repeat(64); }],
    ['wrong generation', (f) => { f.env.RUVNET_EXPECTED_VERSION = '4.0.3'; }],
    ['tampered artifact', (f) => { fs.appendFileSync(path.join(f.root, f.receipt.artifact.path), '!'); }],
  ])('fails closed on %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(validateProtectedPublishInvocation({ root: f.root, env: f.env }).verdict).toBe('FAIL');
  });

  it('is load-bearing before any remote mutation in the canonical publisher', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/release.mjs'), 'utf8');
    const guard = source.indexOf('validateProtectedPublishInvocation');
    const push = source.indexOf("runOrDie('git push'");
    const publish = source.indexOf("runOrDie('npm publish'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(push);
    expect(guard).toBeLessThan(publish);
    expect(source).toContain('PROTECTED RELEASE GATE FAILED');
  });
});
