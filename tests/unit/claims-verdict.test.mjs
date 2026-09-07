import { describe, it, expect } from 'vitest';
import { claimsVerdict, claimsScope, ledger } from '../../scripts/claims-verify.mjs';

describe('claims evidence verdict', () => {
  it('source qualification identifies every omitted runtime obligation', () => {
    const source = claimsScope('source');
    const runtime = claimsScope('runtime');
    expect(source.complete).toBe(false);
    expect(source.entries.map(({ id }) => id)).toEqual(['baseline', 'held-out', 'coverage', 'version']);
    expect(source.omitted).toEqual(runtime.entries.map(({ id }) => id));
    expect([...source.entries, ...runtime.entries]).toHaveLength(ledger.length);
    expect(claimsScope('all').complete).toBe(true);
    expect(() => claimsScope('typo')).toThrow();
  });
  it('does not turn missing measurements into a successful release claim', () => {
    expect(claimsVerdict([{ status: 'PASS' }, { status: 'SKIP' }])).toBe('UNKNOWN');
    expect(claimsVerdict([])).toBe('UNKNOWN');
    expect(claimsVerdict([{ status: 'FAIL' }, { status: 'SKIP' }])).toBe('FAIL');
    expect(claimsVerdict([{ status: 'PASS' }])).toBe('PASS');
  });
});
