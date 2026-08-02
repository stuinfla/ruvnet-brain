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

  it('keeps generated evidence outside the checkout until source cleanliness is proven', () => {
    expect(ci()).toContain('$RUNNER_TEMP/release-evidence');
    const source = workflow();
    expect(source.indexOf('candidate checkout is dirty')).toBeLessThan(source.indexOf('Download CI-produced candidate receipt'));
    expect(gitignore()).toMatch(/^\/release-evidence\/$/m);
  });

  it('puts the sole publisher behind Production approval and preserves post-publication proof', () => {
    const source = workflow();
    expect(source).toContain('environment: Production – ruvnet-brain');
    expect(source.match(/node scripts\/release\.mjs --publish/g)).toHaveLength(1);
    expect(source).toContain('RUVNET_RELEASE_MODE: stabilization');
    expect(source).toContain('--publication release-evidence/publication-receipt.json');
    expect(source).not.toContain('continue-on-error: true');
  });

  it('selects and opens a real RVF instead of macOS ZIP metadata', () => {
    const source = workflow();
    expect(source).toContain("-type f -name '*.big.rvf'");
    expect(source).toContain("! -path '*/__MACOSX/*' ! -name '._*'");
    expect(source).toContain("LC_ALL=C sort -u");
    expect(source).toContain('ambiguous canonical RVF asset directories');
    expect(source).toContain('node scripts/rvf-index-audit.mjs --dir "${asset_dirs[0]}"');
  });

  it.each([
    ['candidate producer', /stabilization-receipt\.mjs/],
    ['main identity', /git rev-parse origin\/main/],
    ['production boundary', /environment: Production – ruvnet-brain/],
    ['candidate seal', /release-proof\.mjs --candidate/],
    ['publication seal', /--publication release-evidence\/publication-receipt\.json/],
  ])('retains load-bearing %s', (_name, required) => {
    expect(`${ci()}\n${workflow()}`).toMatch(required);
  });
});
