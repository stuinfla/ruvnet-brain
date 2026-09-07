import { describe, expect, it } from 'vitest';
import { summarizeAudit } from '../../scripts/stack-sync.mjs';

describe('stack audit completeness', () => {
  it('equal-version cached copies still prevent a no-shadows verdict', () => {
    const summary = summarizeAudit({ rows: [{ state: 'CURRENT' }], shadows: [{ version: '1.0.0', global: '1.0.0' }] });
    expect(summary).toMatchObject({ shadows: 1, stale: 0, verdict: 'DRIFT', exitCode: 1 });
  });
  it('ahead and cache-only copies are shadows but not stale', () => {
    expect(summarizeAudit({ rows: [], shadows: [
      { version: '2.0.0', global: '1.0.0' }, { version: '1.0.0', global: null },
    ] })).toMatchObject({ shadows: 2, stale: 0, verdict: 'DRIFT' });
  });
  it('does not declare plugins current merely because the install record exists', () => {
    expect(summarizeAudit({ rows: [{ state: 'INSTALLED_UNVERIFIED' }], shadows: [] }))
      .toMatchObject({ unverified: 1, verdict: 'UNKNOWN', exitCode: 4 });
    expect(summarizeAudit({ rows: [], shadows: [] }).verdict).toBe('UNKNOWN');
  });
});
