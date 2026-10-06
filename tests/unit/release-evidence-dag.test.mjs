import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createCandidateCiReceipt, REQUIRED_CI_JOBS } from '../../scripts/candidate-ci-receipt.mjs';
import { qualificationPlan } from '../../scripts/release-qualification.mjs';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { getVersion } from '../../scripts/version.mjs';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('same-run release evidence DAG', () => {
  it('builds one npm candidate and never rebuilds it in downstream lanes', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci.match(/npm pack --json/g)).toHaveLength(1);
    expect(ci).toContain('RUVNET_SEALED_PACKAGE=$artifact');
    expect(ci.indexOf('Build the immutable npm candidate exactly once'))
      .toBeLessThan(ci.indexOf('Exact-artifact release QE'));
    for (const workflow of ['integration-linux.yml', 'ux-qe.yml', 'stranger-matrix.yml', 'protected-release.yml']) {
      expect(read(`.github/workflows/${workflow}`), `${workflow} must consume the sealed candidate`).not.toMatch(/^\s*run:\s*npm pack/m);
    }
  });

  it('persists a source-bound artifact receipt from every reusable lane', () => {
    const producers = [
      ['ci.yml', 'release-evidence-${{ inputs.candidate_sha || github.sha }}'],
      ['integration-linux.yml', 'integration-evidence-${{ inputs.candidate_sha || github.event.pull_request.head.sha || github.sha }}'],
      ['ux-qe.yml', 'ux-evidence-${{ inputs.candidate_sha || github.sha }}-${{ runner.os }}'],
      ['stranger-matrix.yml', 'stranger-evidence-${{ inputs.candidate_sha || github.sha }}'],
    ];
    for (const [file, artifact] of producers) {
      const source = read(`.github/workflows/${file}`);
      expect(source, `${file} must upload its receipt`).toContain('actions/upload-artifact@v4');
      expect(source, `${file} receipt must be candidate-bound`).toContain(`name: ${artifact}`);
    }
  });

  it('downloads and validates every same-run lane receipt before aggregation', () => {
    const source = read('.github/workflows/release-candidate-preflight.yml');
    const aggregate = source.indexOf('node scripts/prepublication-evidence.mjs');
    expect(aggregate).toBeGreaterThan(-1);
    for (const artifact of ['release-evidence-', 'release-acceptance-', 'integration-evidence-', 'ux-evidence-', 'stranger-evidence-']) {
      const download = Math.max(source.indexOf(`name: ${artifact}`), source.indexOf(`pattern: ${artifact}`));
      expect(download, `${artifact} receipt must be restored`).toBeGreaterThan(-1);
      expect(download, `${artifact} receipt must be restored before aggregation`).toBeLessThan(aggregate);
    }
    expect(source.slice(0, aggregate)).toContain('node scripts/release-proof.mjs --candidate');
    expect(source).not.toContain('NEEDS_JSON: ${{ toJson(needs) }}');
    expect(source).toContain('CI_RESULTS_JSON: ${{ toJson(needs.ci.outputs) }}');
    expect(source.indexOf('node scripts/candidate-ci-receipt.mjs')).toBeLessThan(aggregate);
    expect(read('.github/workflows/ci.yml')).not.toContain('  candidate-ci-evidence:');
    expect(read('.github/workflows/ci.yml')).not.toContain('  candidate-preflight:');
    expect(source).toContain('PREFLIGHT_RESULT: ${{ needs.candidate-preflight.result }}');
    expect(source).toContain('CI_RESULT: ${{ needs.ci.result }}');
    expect(source).toContain('node scripts/architecture-review-lock.mjs');
    for (const lane of ['ci', 'integration', 'ux']) expect(source).toContain('  ' + lane + ':\n    needs: candidate-preflight');
    for (const name of ['release-acceptance-linux', 'release-acceptance-windows', 'release-acceptance-macos', 'release-qe']) {
      expect(read('.github/workflows/ci.yml')).toContain('value: ${{ jobs.' + name + '.outputs.conclusion }}');
      const job = read('.github/workflows/ci.yml').split('\njobs:\n')[1].split('  ' + name + ':\n')[1].split(/\n  [a-z][a-z-]*:/)[0].trim();
      expect(job.endsWith('run: echo \"conclusion=${{ job.status }}\" >> \"$GITHUB_OUTPUT\"')).toBe(true);
      expect(job).toContain('id: capture-ci-result\n        if: always()');
    }
  });

  it('imports the exact-SHA preflight artifact without rerunning expensive lanes', () => {
    const source = read('.github/workflows/protected-release.yml');
    expect(source).toContain('const artifactName = `release-candidate-${sha}`;');
    expect(source).toContain('node scripts/release-proof.mjs --candidate release-evidence/candidate-receipt.json');
    expect(source).toContain("aggregate.sha !== process.env.CANDIDATE_SHA");
    for (const file of ['ci.yml', 'integration-linux.yml', 'ux-qe.yml', 'stranger-matrix.yml']) {
      expect(source).not.toContain(`uses: ./.github/workflows/${file}`);
    }
  });

  it('keeps source gates out of the protected provider-mutation branch', () => {
    const release = read('scripts/release.mjs');
    const checkOnly = release.indexOf('if (!PUBLISH) {');
    const transaction = release.indexOf('if (PUBLISH) {', checkOnly + 1);
    expect(checkOnly).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(checkOnly);
    const sourceGates = release.slice(checkOnly, transaction);
    // scripts/release-qualification.mjs is the SAME gate CI enforces (canonical-qa.yml/ci.yml
    // invoke it the same way); check-only mode is a local preview of that one contract, not a
    // second, independently-maintained test list.
    expect(sourceGates).toContain("['scripts/release-qualification.mjs', '--suite', 'source'");
    expect(sourceGates).toContain("runOrDie('version sync'");
    expect(sourceGates).toContain("runOrDie('one protected publisher'");
    expect(release).not.toContain("runOrDie('git push'");
    expect(release).not.toContain('fetchLatestCiVerdict');
  });

  it('keeps public-byte verification out of publication and in the protected matrix', () => {
    const release = read('scripts/release.mjs');
    const provider = read('scripts/release-transaction-provider.mjs');
    const workflow = read('.github/workflows/protected-release.yml');
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(provider).not.toContain('publication.postPublicationChecks');
    expect(workflow).toContain('node scripts/public-verification-lane.mjs');
    expect(workflow).toContain('node scripts/public-verification-finalizer.mjs');
    // Live public-byte verification never lived in check-only mode's own source gates either — the
    // local verify-channels.mjs walk that used to run here was removed 2026-09-26 as part of
    // collapsing check-only onto the one CI-enforced qualification contract (see the test above).
    expect(release).not.toContain("'scripts/verify-channels.mjs'");
  });
});


const temporary = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function candidateFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-ci-')); temporary.push(dir);
  const sha = 'a'.repeat(40), version = getVersion();
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const packageBytes = Buffer.from('immutable candidate');
  fs.writeFileSync(path.join(dir, 'candidate.tgz'), packageBytes);
  const packageDigest = crypto.createHash('sha256').update(packageBytes).digest('hex');
  const manifestFile = write('manifest.json', { schemaVersion: 1, candidateSha: sha, version, tag: `v${version}`,
    members: [{ role: 'npm', name: 'candidate.tgz', size: packageBytes.length, sha256: packageDigest }] });
  const candidateFile = write('candidate.json', { sha, version, artifact: { sha256: packageDigest } });
  for (const platform of ['linux', 'macos', 'windows']) {
    const plan = qualificationPlan('source', platform), paths = platform === 'windows' ? path.win32 : path.posix;
    const checkoutRoot = platform === 'windows' ? 'D:\\work\\repo' : '/work/repo';
    const source = { sha, dirty: false, digest: 'b'.repeat(64) };
    const body = { schemaVersion: 1, kind: 'ruvnet-brain-release-qualification', suite: 'source', platform,
      checkoutRoot, status: 'PASS', source, sourceAfter: source, sourceStable: true, files: plan.files,
      requirements: plan.requirements.map(r => r.id), contractSha256: plan.contractSha256,
      results: [{ status: 'PASS', exitCode: 0 }], tests: { total: plan.files.length, passed: plan.files.length, failed: 0, skipped: 0 },
      testReport: { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0,
        numTotalTests: plan.files.length, numPassedTests: plan.files.length, testResults: plan.files.map(file => ({
          name: paths.join(checkoutRoot, file), status: 'passed', assertionResults: [{ status: 'passed' }] })) } };
    write(`release-acceptance-${platform}.json`, { ...body, receiptSha256: digest(body) });
  }
  return { sha, runId: 1, runAttempt: 1, ciResult: 'success', results: Object.fromEntries(REQUIRED_CI_JOBS.map(n => [n, 'success'])),
    manifestFile, candidateFile, acceptanceDir: dir };
}
function mutateJson(file, mutate, reseal = false) {
  const value = JSON.parse(fs.readFileSync(file)); mutate(value);
  if (reseal) { delete value.receiptSha256; value.receiptSha256 = digest(value); }
  fs.writeFileSync(file, JSON.stringify(value));
}
describe('aggregate-produced candidate CI evidence', () => {
  it('retains individual CI outcomes and all raw platform qualification checks', () => {
    const receipt = createCandidateCiReceipt(candidateFixture());
    expect(receipt.acceptanceReceipts.map(r => r.platform)).toEqual(['linux', 'macos', 'windows']);
    expect(receipt.producerJob).toBe('aggregate'); expect(receipt.summarizedWorkflow).toBe('ci');
    expect(receipt.jobs.map(r => r.name)).toEqual(REQUIRED_CI_JOBS);
  });
  it.each(['failure', 'skipped', 'cancelled', 'unknown', undefined])('rejects %s individual outcome', result => {
    const args = candidateFixture(); args.results['release-qe'] = result;
    expect(() => createCandidateCiReceipt(args)).toThrow('dependency');
  });
  it.each(['failure', 'skipped', 'cancelled', undefined])('rejects overall reusable CI %s', ciResult => {
    const args = candidateFixture(); args.ciResult = ciResult;
    expect(() => createCandidateCiReceipt(args)).toThrow('workflow did not succeed');
  });

  it('rejects missing/extra individual outputs and malformed run identity', () => {
    const args = candidateFixture(); delete args.results['release-qe'];
    expect(() => createCandidateCiReceipt(args)).toThrow();
    args.results['release-qe'] = 'success'; args.results.extra = 'success'; expect(() => createCandidateCiReceipt(args)).toThrow();
    delete args.results.extra; args.runId = 0; expect(() => createCandidateCiReceipt(args)).toThrow();
    args.runId = 1; args.runAttempt = 0; expect(() => createCandidateCiReceipt(args)).toThrow();
  });
  it.each(['sha', 'version', 'package', 'candidate-package', 'duplicate'])('rejects changed %s candidate identity', field => {
    const args = candidateFixture();
    if (field === 'sha') args.sha = 'c'.repeat(40);
    if (field === 'version') mutateJson(args.candidateFile, r => r.version = getVersion() + '-mismatch');
    if (field === 'package') fs.writeFileSync(path.join(args.acceptanceDir, 'candidate.tgz'), 'different');
    if (field === 'candidate-package') mutateJson(args.candidateFile, r => r.artifact.sha256 = 'c'.repeat(64));
    if (field === 'duplicate') mutateJson(args.manifestFile, r => r.members.push(r.members[0]));
    expect(() => createCandidateCiReceipt(args)).toThrow();
  });
  it.each(['missing', 'wrong-sha', 'wrong-platform', 'skipped', 'empty', 'failed'])('rejects %s raw qualification', fault => {
    const args = candidateFixture(), file = path.join(args.acceptanceDir, 'release-acceptance-linux.json');
    if (fault === 'missing') fs.rmSync(file);
    else mutateJson(file, r => {
      if (fault === 'wrong-sha') r.source.sha = 'c'.repeat(40);
      if (fault === 'wrong-platform') r.platform = 'macos';
      if (fault === 'skipped') r.testReport.testResults[0].assertionResults[0].status = 'skipped';
      if (fault === 'empty') r.testReport.testResults[0].assertionResults = [];
      if (fault === 'failed') r.testReport.testResults[0].assertionResults[0].status = 'failed';
    }, true);
    expect(() => createCandidateCiReceipt(args)).toThrow();
  });
});
