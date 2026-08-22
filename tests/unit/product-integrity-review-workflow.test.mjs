import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname,
  '../../.github/workflows/product-integrity-review.yml'), 'utf8');

describe('product integrity review ingress', () => {
  it('accepts only owner-dispatched public signed evidence bound to an exact candidate', () => {
    expect(source).toContain('if: github.actor == github.repository_owner');
    expect(source).toContain('ref: ${{ inputs.candidate_sha }}');
    expect(source).toContain('test "$(git rev-parse HEAD)" = "${{ inputs.candidate_sha }}"');
    expect(source).toContain('name: release-evidence-${{ inputs.candidate_sha }}');
    expect(source).toContain('name: release-aggregate-${{ inputs.candidate_sha }}');
  });

  it('never extracts an uploaded archive and verifies both signatures through fixed paths', () => {
    expect(source).not.toMatch(/\btar\b|\bunzip\b/);
    expect(source).toContain('node scripts/independent-review-receipt.mjs verify-pair');
    expect(source).toContain('--fable review-evidence/receipts/claude-fable-5.json');
    expect(source).toContain('--sol review-evidence/receipts/gpt-5.6-sol.json');
    expect(source).toContain('signed review bundle must contain exactly fable and sol');
  });

  it('binds source tree, payload bytes, contract, rubric, and release identity before upload', () => {
    expect(source).toContain("execFileSync('git', ['rev-parse', 'HEAD^{tree}']");
    expect(source).toContain("sha256(fs.readFileSync('release-evidence/payload-manifest.json'))");
    expect(source).toContain("sha256(fs.readFileSync('scripts/product-integrity-contract.mjs'))");
    expect(source).toContain("sha256(fs.readFileSync('docs/qe/GRADING-RUBRIC.md'))");
    expect(source.indexOf('validateIndependentReviewPair'))
      .toBeLessThan(source.indexOf('name: product-integrity-reviews-${{ inputs.candidate_sha }}'));
  });
});
