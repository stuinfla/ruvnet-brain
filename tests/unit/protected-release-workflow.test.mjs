import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workflow = () => fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');
const ci = () => fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const gitignore = () => fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

describe('protected release rail', () => {
  it('has one CI producer for the exact candidate consumed by the publisher', () => {
    expect(ci()).toContain('node scripts/stabilization-receipt.mjs');
    expect(ci()).toContain('name: release-evidence-${{ github.sha }}');
    expect(workflow()).toContain('name: release-evidence-${{ inputs.candidate_sha }}');
    expect(workflow()).toContain('run-id: ${{ inputs.release_qe_run_id }}');
  });

  it('derives the digest from CI-produced bytes instead of accepting a human digest', () => {
    const source = workflow();
    const inputs = source.match(/inputs:\n([\s\S]*?)\n\npermissions:/)?.[1] || '';
    expect(inputs).not.toContain('artifact_sha256:');
    expect(source).toContain("crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')");
    expect(source).toContain('artifact_sha256=${digest}');
  });

  it('requires the exact candidate to be current main with completed green CI and release QE', () => {
    const source = workflow();
    expect(source).toContain('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    expect(source).toContain("run.workflowName === 'ci'");
    expect(source).toContain('run.headSha === process.env.EXPECTED_SHA');
    expect(source).toContain("name === 'release-qe'");
    expect(source).toContain("status === 'completed' && conclusion === 'success'");
  });

  it('fails closed on maintainer-governed release blockers without letting unrelated issues wedge releases', () => {
    const source = workflow();
    expect(source).toContain('issues: read');
    expect(source).toContain('Require zero maintainer-governed release blockers');
    expect(source).toContain('--state open --label release-blocker');
    expect(source).toContain('test "$blockers" -eq 0');
  });

  it('serializes all versions through one publisher fence and preserves failure evidence', () => {
    const source = workflow();
    expect(source).toContain('group: ruvnet-brain-release');
    expect(source).toContain('cancel-in-progress: false');
    expect(source).toContain('if: always()');
  });

  it('keeps generated evidence outside the checkout until source cleanliness is proven', () => {
    expect(ci()).toContain('$RUNNER_TEMP/release-evidence');
    const source = workflow();
    expect(source.indexOf('candidate checkout is dirty')).toBeLessThan(source.indexOf('Download CI-produced candidate receipt'));
    expect(gitignore()).toMatch(/^\/release-evidence\/$/m);
  });

  it('puts the sole publisher behind Production and requires both exact-SHA reviews before mutation', () => {
    const source = workflow();
    expect(source).toContain('environment: Production – ruvnet-brain');
    expect(source.match(/node scripts\/release\.mjs --publish/g)).toHaveLength(1);
    expect(source).toContain('RUVNET_RELEASE_MODE: stabilization');
    expect(source).toContain("run.workflowName !== 'product-integrity-review'");
    expect(source).toContain('product-integrity-reviews-${{ inputs.candidate_sha }}');
    expect(source.indexOf('independent review artifact must contain exactly two JSON receipts'))
      .toBeLessThan(source.indexOf('node scripts/release.mjs --publish'));
    expect(source).not.toContain('continue-on-error: true');
  });

  it('validates both reviews against the exact retrieval plan before provider mutation', () => {
    const source = workflow();
    const reviewVerification = source.indexOf('node scripts/independent-review-receipt.mjs verify-pair');
    const retrievalPlan = source.indexOf('--retrieval-plan release-evidence/retrieval-canary-plan.json', reviewVerification);
    const publish = source.indexOf('node scripts/release.mjs --publish');
    expect(reviewVerification).toBeGreaterThan(-1);
    expect(retrievalPlan).toBeGreaterThan(reviewVerification);
    expect(publish).toBeGreaterThan(retrievalPlan);
    expect(source.match(/--retrieval-plan release-evidence\/retrieval-canary-plan\.json/g)).toHaveLength(1);
  });

  it('stops channel publication at signed PUBLISHED_NOT_VERIFIED before public install proof', () => {
    const source = workflow();
    expect(source).toContain('RUVNET_RELEASE_IDENTITY: release-evidence/release-identity.json');
    expect(source).toContain('RUVNET_CHANNEL_RECEIPT: release-evidence/channels-converged-receipt.json');
    expect(source).toContain("receipt.state !== 'channels-converged'");
    expect(source).toContain("receipt.observation?.verdict !== 'PUBLISHED_NOT_VERIFIED'");
  });

  it('runs the exact public 3x3 matrix and only then persists install-verified', () => {
    const source = workflow();
    expect(source.match(/release-evidence\/COVERAGE\.json/g).length).toBeGreaterThanOrEqual(3);
    expect(source.match(/release-evidence\/retrieval-canary-plan\.json/g).length).toBeGreaterThanOrEqual(3);
    for (const lane of ['ubuntu-latest, os_name: linux', 'macos-latest, os_name: macos',
      'windows-latest, os_name: windows']) expect(source).toContain(lane);
    expect(source).toContain('node scripts/public-verification-lane.mjs');
    expect(source).toContain('pattern: public-verification-*-${{ needs.release-qe-proof.outputs.candidate_sha }}');
    expect(source).toContain('node scripts/public-verification-aggregate.mjs');
    expect(source).toContain('node scripts/public-verification-finalizer.mjs');
    expect(source).toContain('--out release-evidence/install-verified-receipt.json');
  });

  it('derives baseline and candidate inputs from exact bytes before sealing the payload', () => {
    const source = ci();
    expect(source.match(/node scripts\/public-verification-inputs\.mjs/g)).toHaveLength(1);
    expect(source.indexOf('Build the immutable knowledge bundle exactly once'))
      .toBeLessThan(source.indexOf('node scripts/public-verification-inputs.mjs'));
    expect(source.indexOf('node scripts/public-verification-inputs.mjs'))
      .toBeLessThan(source.indexOf('Persist the canonical candidate payload manifest'));
    for (const argument of [
      '--baseline-bundle "$RUVNET_SEED_BUNDLE"',
      '--candidate-bundle "$RUNNER_TEMP/release-evidence/ruvnet-brain.zip"',
      '--candidate-package "$RUVNET_SEALED_PACKAGE"',
      '--oracle data/retrieval-query-evidence.json',
      '--repo "$GITHUB_WORKSPACE"',
      '--out-dir "$RUNNER_TEMP/release-evidence"',
      '--observed-baseline',
    ]) expect(source).toContain(argument);
    expect(source).toContain('test -s data/retrieval-query-evidence.json');
  });

  it('selects and opens a real RVF instead of macOS ZIP metadata', () => {
    const source = ci();
    expect(source).toContain("-type f -name '*.big.rvf'");
    expect(source).toContain("! -path '*/__MACOSX/*' ! -name '._*'");
    expect(source).toContain("LC_ALL=C sort -u");
    expect(source).toContain('node scripts/rvf-index-audit.mjs --dir "${asset_dirs[0]}"');
  });

  it.each([
    ['candidate producer', /stabilization-receipt\.mjs/],
    ['main identity', /git rev-parse origin\/main/],
    ['production boundary', /environment: Production – ruvnet-brain/],
    ['candidate seal', /release-proof\.mjs --candidate/],
    ['nonterminal channel seal', /channels-converged-receipt\.json/],
    ['terminal public seal', /install-verified-receipt\.json/],
  ])('retains load-bearing %s', (_name, required) => {
    expect(`${ci()}\n${workflow()}`).toMatch(required);
  });
});
