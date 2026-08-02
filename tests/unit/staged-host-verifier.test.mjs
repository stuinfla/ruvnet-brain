import { describe, expect, it } from 'vitest';
import { classifyDoctorResult } from '../../scripts/staged-host-verifier.mjs';

describe('staged host doctor classification', () => {
  it('accepts a clean doctor verdict', () => {
    expect(classifyDoctorResult({ status: 0, stdout: 'Healthy' })).toMatchObject({
      accepted: true, status: 'PASS',
    });
  });

  it('preserves explicit Codex hook trust as pending review', () => {
    const stdout = 'Grounding PROVEN\nCodex installed the Brain, but 17 lifecycle hooks await review.';
    expect(classifyDoctorResult({ status: 1, stdout })).toMatchObject({
      accepted: true, status: 'PENDING_REVIEW',
    });
  });

  it.each([
    ['generic failure', 'Grounding PROVEN\nother failure'],
    ['missing reader', 'Grounding PROVEN\nCodex installed the Brain, but 17 lifecycle hooks await review.\nreader MISSING'],
    ['unproven grounding', 'Codex installed the Brain, but 17 lifecycle hooks await review.'],
  ])('rejects %s instead of hiding it behind pending trust', (_name, stdout) => {
    expect(classifyDoctorResult({ status: 1, stdout })).toMatchObject({
      accepted: false, status: 'FAIL',
    });
  });
});
