// tests/unit/forge-update-isbehind.test.mjs — kb/forge-update.mjs's isBehind(local, canon)
// (lines 100-112) decides whether a single installed KB store needs re-fetching from its
// canonical source. It is a SIBLING of the exact bug class already fixed once in
// scripts/self-update.mjs (see memory `test-coverage-gaps-2026-07-07` and
// tests/unit/self-update-plan.test.mjs): both functions silently default to "up to date" when
// their freshness signal can't be read, rather than failing open toward "rebuild". Found during
// the 2026-07-08 coverage-gap pass; not in any prior audit — self-update.mjs's copy of this bug
// class was flagged before, forge-update.mjs's was not.
//
// isBehind() has three fallback tiers, checked in order:
//   1. releaseTag equality — authoritative when BOTH sides carry a tag.
//   2. Date.parse(local.builtUtc) vs Date.parse(canon.builtUtc) — only fires when BOTH parse to a
//      valid number AND canon is later; if either is missing/malformed, Date.parse returns NaN and
//      Number.isNaN(lt)/Number.isNaN(ct) short-circuits this branch to false (not "behind").
//   3. sourceCommit string inequality — only fires when BOTH sides have a sourceCommit.
// If NONE of the three signals are present/parseable on either side, isBehind returns false BY
// DEFAULT — a store with no timestamp, no tag, and no commit on record reads as "up to date"
// rather than "unknown, so rebuild to be safe". This is the same silent-staleness shape as the
// ruflo/agentic-flow 'unknown' incident, via a different code path (missing/malformed fields
// instead of the literal string 'unknown').
//
// PREREQUISITE (RESOLVED 2026-09-14, ADR-086 step 16): isBehind was a private top-level function.
// It is now exported — an additive change with no behavior change — so the tiers below are pinned
// for real instead of described in prose.
//
// STILL OPEN, AND DELIBERATELY NOT CHANGED HERE: whether the "no signal at all" case should default
// to "behind" (safer) instead of "up to date" (current). That is a behavior question for Stuart, not
// a test-coverage gap, so the test below pins TODAY'S behavior and names it as the open question
// rather than quietly legislating an answer.
//
// A FOURTH TIER now precedes the three above: corpus transport identity. A corpus release is tagged
// `corpus-sha256-<64 hex>` — a content address, not a version — and comparing it against the semver
// in `releaseTag` could never converge, which is the measured redownload loop recorded in
// kb/corpus-release-identity.mjs's header (4 applies of one release = 4 full downloads).
import { describe, it, expect } from 'vitest';

// Importing is safe: forge-update.mjs runs main() only when import.meta.url matches argv[1] (a guard
// added after the reclaim test's import started racing a real update against the test run).
const { isBehind } = await import('../../kb/forge-update.mjs');

const CORPUS_A = `corpus-sha256-${'a'.repeat(64)}`;
const CORPUS_B = `corpus-sha256-${'b'.repeat(64)}`;

describe('forge-update.mjs — isBehind(local, canon), tier 0: corpus transport identity', () => {
  it('is up to date when both sides carry the SAME corpus tag, whatever the timestamps say', () => {
    // The release publish time is always later than the forge time of the KB inside it, so a
    // timestamp fallback here would report BEHIND forever — the exact shape of the original bug.
    expect(isBehind(
      { corpusReleaseTag: CORPUS_A, releaseTag: 'v4.9.0', builtUtc: '2026-09-01T00:00:00.000Z' },
      { corpusReleaseTag: CORPUS_A, releaseTag: null, builtUtc: '2026-09-10T00:00:00.000Z' },
    )).toBe(false);
  });

  it('is behind when the corpus tag differs', () => {
    expect(isBehind({ corpusReleaseTag: CORPUS_A }, { corpusReleaseTag: CORPUS_B })).toBe(true);
  });

  it('is behind when this brain has never taken a corpus release', () => {
    expect(isBehind({ releaseTag: 'v4.9.0' }, { corpusReleaseTag: CORPUS_A })).toBe(true);
  });

  it('NEVER compares a corpus tag against a runtime version — the two domains do not meet', () => {
    // If the corpus branch were removed and this fell through to the releaseTag tier, a matching
    // corpus tag would be compared against 'v4.9.0' and read BEHIND. That is the loop.
    expect(isBehind(
      { corpusReleaseTag: CORPUS_A, releaseTag: 'v4.9.0' },
      { corpusReleaseTag: CORPUS_A, releaseTag: null },
    )).toBe(false);
  });
});

describe('forge-update.mjs — isBehind(local, canon), tiers 1-3 (pre-existing behavior)', () => {
  it('tier 1: both sides carry a releaseTag and the tags differ', () => {
    expect(isBehind({ releaseTag: 'v4.0.7' }, { releaseTag: 'v4.0.8' })).toBe(true);
  });

  it('tier 1: matching releaseTags win over a later canon builtUtc', () => {
    expect(isBehind(
      { releaseTag: 'v4.0.8', builtUtc: '2026-07-31T04:39:28.414Z' },
      { releaseTag: 'v4.0.8', builtUtc: '2026-08-03T00:00:00.000Z' },
    )).toBe(false);
  });

  it('tier 2: both builtUtc parse and canon is later', () => {
    expect(isBehind({ builtUtc: '2026-07-31T00:00:00.000Z' }, { builtUtc: '2026-08-03T00:00:00.000Z' })).toBe(true);
  });

  it('tier 2: equal builtUtc is not behind', () => {
    expect(isBehind({ builtUtc: '2026-08-03T00:00:00.000Z' }, { builtUtc: '2026-08-03T00:00:00.000Z' })).toBe(false);
  });

  it('tier 2: an OLDER canon is not behind (the comparison is directional, not merely unequal)', () => {
    expect(isBehind({ builtUtc: '2026-08-03T00:00:00.000Z' }, { builtUtc: '2026-07-31T00:00:00.000Z' })).toBe(false);
  });

  it('tier 3: inconclusive timestamps, differing sourceCommit', () => {
    expect(isBehind({ sourceCommit: 'aaa111' }, { sourceCommit: 'bbb222' })).toBe(true);
    expect(isBehind({ sourceCommit: 'aaa111' }, { sourceCommit: 'aaa111' })).toBe(false);
  });

  it('only ONE side\'s builtUtc parsing must not read as behind (both Number.isNaN guards)', () => {
    expect(isBehind({ builtUtc: 'not-a-date' }, { builtUtc: '2026-08-03T00:00:00.000Z' })).toBe(false);
    expect(isBehind({ builtUtc: '2026-07-31T00:00:00.000Z' }, { builtUtc: undefined })).toBe(false);
  });

  it('OPEN QUESTION, pinned as-is: no signal at all currently reads "up to date", not "rebuild"', () => {
    // Documenting the fail-silent default, NOT endorsing it. If Stuart decides "unknown ⇒ behind"
    // is the safer contract, this is the single assertion that must flip, and it should flip
    // deliberately rather than drift.
    expect(isBehind({}, {})).toBe(false);
  });
});
