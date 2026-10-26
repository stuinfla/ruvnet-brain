// #401 — doctor kept a stale corpus check and called installed v4.5.9 "older than published v4.5.7"
// (and installed v4.6.2 older than v4.6.0 / v4.5.12). A DIFFERENT retained tag is not a NEWER one.
import { describe, it, expect } from 'vitest';
import { newerCorpusPending, compareReleaseTags } from '../../plugin/scripts/session-start-health.mjs';

const check = (candidateTag, checkedAt = '2026-10-01T13:56:00Z') => ({
  candidateTag, verdict: 'UPDATE_AVAILABLE', checkedAt, outcome: 'updating',
});
const OPAQUE_A = `corpus-sha256-${'a'.repeat(64)}`;
const OPAQUE_B = `corpus-sha256-${'b'.repeat(64)}`;

describe('#401 newerCorpusPending orders semver tags and drops superseded evidence', () => {
  it('compareReleaseTags is numeric semver, prerelease below release, null for opaque tags', () => {
    expect(compareReleaseTags('v4.5.9', 'v4.5.7')).toBe(1);
    expect(compareReleaseTags('v4.5.12', 'v4.6.2')).toBe(-1);
    expect(compareReleaseTags('v4.5.10', 'v4.5.9')).toBe(1);
    expect(compareReleaseTags('v4.5.9', 'v4.5.9-rc.1')).toBe(1);
    expect(compareReleaseTags('v4.5.9', 'v4.5.9')).toBe(0);
    expect(compareReleaseTags(OPAQUE_A, 'v4.5.9')).toBeNull();
  });

  it('prerelease identifiers compare per semver §11: numeric parts numerically, numeric below alphanumeric, longer set wins', () => {
    expect(compareReleaseTags('v4.7.21-alpha.10', 'v4.7.21-alpha.9')).toBe(1);
    expect(compareReleaseTags('v4.7.21-alpha.9', 'v4.7.21-alpha.10')).toBe(-1);
    expect(compareReleaseTags('v4.7.21-rc.2', 'v4.7.21-rc.11')).toBe(-1);
    expect(compareReleaseTags('v4.7.21-alpha.1', 'v4.7.21-alpha')).toBe(1);
    expect(compareReleaseTags('v4.7.21-alpha.beta', 'v4.7.21-alpha.1')).toBe(1);
    expect(compareReleaseTags('v4.7.21-beta', 'v4.7.21-alpha.10')).toBe(1);
    expect(compareReleaseTags('v4.7.21-alpha.01', 'v4.7.21-alpha.1')).toBe(0);
    expect(newerCorpusPending({ source: { releaseTag: 'v4.7.21-alpha.10' }, corpusCheck: check('v4.7.21-alpha.9') })).toBeNull();
  });

  it.each([
    ['v4.5.9', 'v4.5.7'],
    ['v4.6.2', 'v4.6.0'],
    ['v4.6.2', 'v4.5.12'],
  ])('installed %s is never told an older retained candidate %s is newer', (installed, candidate) => {
    expect(newerCorpusPending({ source: { releaseTag: installed }, corpusCheck: check(candidate) })).toBeNull();
  });

  it('a genuinely newer semver candidate still reads as pending, even right after an install', () => {
    const pending = newerCorpusPending({ source: { releaseTag: 'v4.5.9' }, corpusCheck: check('v4.5.10'),
      installedAtMs: Date.parse('2026-10-02T00:00:00Z') });
    expect(pending).toMatchObject({ tag: 'v4.5.10', installed: 'v4.5.9' });
  });

  it('opaque identities: a check that predates the verified install is stale; a later one is still pending', () => {
    const installedAtMs = Date.parse('2026-10-01T14:00:00Z');
    const source = { corpusReleaseTag: OPAQUE_A, releaseTag: OPAQUE_A };
    expect(newerCorpusPending({ source, corpusCheck: check(OPAQUE_B, '2026-10-01T13:56:00Z'), installedAtMs })).toBeNull();
    expect(newerCorpusPending({ source, corpusCheck: check(OPAQUE_B, '2026-10-01T15:00:00Z'), installedAtMs }))
      .toMatchObject({ tag: OPAQUE_B });
    // No install record: inequality alone keeps the advisory (unchanged behaviour).
    expect(newerCorpusPending({ source, corpusCheck: check(OPAQUE_B) })).toMatchObject({ tag: OPAQUE_B });
  });
});
