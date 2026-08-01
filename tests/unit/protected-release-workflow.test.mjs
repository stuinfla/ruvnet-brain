import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workflowPath = path.join(ROOT, '.github/workflows/protected-release.yml');
const readWorkflow = () => fs.readFileSync(workflowPath, 'utf8');

describe('protected release workflow', () => {
  it('accepts only explicit 4.0.4 candidate identity inputs', () => {
    const workflow = readWorkflow();
    expect(workflow).toContain('candidate_sha:');
    expect(workflow).toContain('artifact_sha256:');
    expect(workflow).toContain('version:');
    expect(workflow).toContain('EXPECTED_VERSION: 4.0.4');
    expect(workflow).toContain('EXPECTED_SHA: ${{ inputs.candidate_sha }}');
    expect(workflow).toContain('EXPECTED_DIGEST: ${{ inputs.artifact_sha256 }}');
  });

  it('requires exact-SHA release-qe proof before the publisher can start', () => {
    const workflow = readWorkflow();
    expect(workflow).toContain('name: release-qe-proof');
    expect(workflow).toContain('release_qe_run_id:');
    expect(workflow).toContain('workflowName == "ci"');
    expect(workflow).toContain('headSha == env.EXPECTED_SHA');
    expect(workflow).toContain('name == "release-qe"');
    expect(workflow).toContain('status == "completed"');
    expect(workflow).toContain('conclusion == "success"');
    expect(workflow).toMatch(/publish:\s*\n\s+name: protected-publisher\s*\n\s+needs: release-qe-proof/);
  });

  it('puts the sole publisher behind the reviewer-protected production environment', () => {
    const workflow = readWorkflow();
    expect(workflow).toContain('environment: Production – ruvnet-brain');
    expect(workflow).toContain('node scripts/release-authority.mjs');
    expect(workflow).toContain('node scripts/release.mjs --publish');
    expect(workflow.match(/node scripts\/release\.mjs --publish/g)).toHaveLength(1);
  });

  it('validates candidate proof before mutation and publication proof afterwards', () => {
    const workflow = readWorkflow();
    const candidateSeal = workflow.indexOf('node scripts/release-proof.mjs --candidate release-evidence/candidate-receipt.json');
    const publisher = workflow.indexOf('node scripts/release.mjs --publish');
    const publicationSeal = workflow.indexOf('--publication release-evidence/publication-receipt.json');
    expect(candidateSeal).toBeGreaterThan(-1);
    expect(publisher).toBeGreaterThan(candidateSeal);
    expect(publicationSeal).toBeGreaterThan(publisher);
    expect(workflow).toContain('candidate-receipt.json');
    expect(workflow).toContain('publication-receipt.json');
  });

  it('fails closed when the receipt, SHA, digest, version, or proof artifact is absent or split', () => {
    const workflow = readWorkflow();
    expect(workflow).toContain('set -euo pipefail');
    expect(workflow).toContain('test -s release-evidence/candidate-receipt.json');
    expect(workflow).toContain('test -s release-evidence/publication-receipt.json');
    expect(workflow).toContain('candidate receipt SHA mismatch');
    expect(workflow).toContain('candidate artifact digest mismatch');
    expect(workflow).toContain('candidate version mismatch');
    expect(workflow).not.toContain('continue-on-error: true');
  });

  it.each([
    ['MUTANT: removing production environment removes the approval boundary', /environment: Production – ruvnet-brain/],
    ['MUTANT: removing release-qe dependency permits unqualified publication', /needs: release-qe-proof/],
    ['MUTANT: removing candidate seal permits unverified bytes', /release-proof\.mjs --candidate/],
    ['MUTANT: removing publication seal permits an unverified shipped claim', /--publication release-evidence\/publication-receipt\.json/],
  ])('%s', (_name, required) => {
    const workflow = readWorkflow();
    expect(workflow.replace(new RegExp(required.source, 'g'), '')).not.toMatch(required);
    expect(workflow).toMatch(required);
  });
});
