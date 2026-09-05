import { describe, it, expect } from 'vitest';
import { claimsVerdict } from '../../scripts/claims-verify.mjs';

describe('claims evidence verdict', () => {
  it('does not turn missing measurements into a successful release claim', () => {
    expect(claimsVerdict([{ status: 'PASS' }, { status: 'SKIP' }])).toBe('UNKNOWN');
    expect(claimsVerdict([])).toBe('UNKNOWN');
    expect(claimsVerdict([{ status: 'FAIL' }, { status: 'SKIP' }])).toBe('FAIL');
    expect(claimsVerdict([{ status: 'PASS' }])).toBe('PASS');
  });
});
