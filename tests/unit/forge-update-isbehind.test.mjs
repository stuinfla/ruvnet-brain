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
// PREREQUISITE: isBehind is a private top-level function (kb/forge-update.mjs:100), not exported.
// The fix is additive — no behavior change, just:
//
//   export function isBehind(local, canon) { ... }
//
// Flag to Stuart before applying, and confirm with him whether the "no signal at all" case should
// actually default to "behind" (safer) instead of "up to date" (current) — that's a real behavior
// question, not just a test-coverage gap.
import { describe, it, expect } from 'vitest';

describe.todo('forge-update.mjs — isBehind(local, canon) (requires export, see file header)', () => {
  it.todo('returns true when both sides carry a releaseTag and the tags differ');
  it.todo('returns false when both sides carry a releaseTag and the tags match, even if builtUtc timestamps would otherwise suggest "behind"');
  it.todo('returns true when both builtUtc values parse and canon.builtUtc is later than local.builtUtc');
  it.todo('returns false when both builtUtc values parse and are equal');
  it.todo('returns true when builtUtc comparison is inconclusive but sourceCommit differs between local and canon');
  it.todo('returns false (the fail-silent default) when local.builtUtc is missing/unparseable, canon.builtUtc is missing/unparseable, and neither side has a sourceCommit — the untested "no signal at all" branch that mirrors the fixed self-update.mjs \'unknown\' incident');
  it.todo('returns false (not true) when only ONE side\'s builtUtc parses — Number.isNaN guards on both lt and ct, so a malformed local OR canon timestamp alone must not be treated as "behind"');
});
