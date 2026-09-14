#!/usr/bin/env node
// scripts/release-channel-kind.mjs — "what KIND of release is this?", stated once.
//
// THE CONFLICT THIS RESOLVES. ADR-086's C4 resolution (S1) requires customer corpus releases to be
// promoted to `releases/latest`, because kb/forge-update.mjs discovers updates by polling exactly
// that pointer. But six author-side tools were written when `releases/latest` could only ever be a
// code release, and each of them independently assumes its tag is a semver `vX.Y.Z`:
//
//   scripts/verify-channels.mjs            compares latest's tag to the shipping version — and
//                                          release.mjs:547-548 runs it as `runOrDie` in step E, so a
//                                          corpus release on latest BRICKS the owner's own preflight
//   scripts/published-surface-probe.mjs    asserts npm version == GitHub tag
//   scripts/github-health-watch.mjs        same equality, nightly — a corpus tag fires a false
//                                          "issue #77 recurring" alert
//   scripts/release-transaction-provider.mjs  reads latest mid-transaction, and refuses promotion
//                                          when latest is not the tag it expected
//   scripts/release-convergence-watchdog.mjs  would read "not converged" forever and keep dispatching
//   scripts/release-abort-stale.mjs        would call a genuinely-shipped release abandoned
//
// Patching six call sites six ways would leave six subtly different answers to one question. The
// question is shared, so the answer is shared: `releases/latest` means "what a customer downloads"
// and may legitimately be EITHER kind; every check about the CODE generation must ask for the latest
// CODE release instead of assuming latest is one.
//
// This module is deliberately PURE — no network, no `gh`, no fetch. Each consumer already has its own
// transport; handing them a predicate keeps this testable and keeps the transports theirs.

/** Content-addressed corpus generation: the tag IS the archive's sha256. */
export const CORPUS_TAG_PATTERN = /^corpus-sha256-[0-9a-f]{64}$/;
/** Owner-approved product release: a plain semver tag. */
export const CODE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export function releaseKind(tag) {
  const value = String(tag ?? '');
  if (CORPUS_TAG_PATTERN.test(value)) return 'corpus';
  if (CODE_TAG_PATTERN.test(value)) return 'code';
  return 'other';
}

export const isCorpusReleaseTag = (tag) => releaseKind(tag) === 'corpus';
export const isCodeReleaseTag = (tag) => releaseKind(tag) === 'code';

const timeOf = (release) => {
  const parsed = Date.parse(release?.published_at || release?.created_at || release?.publishedAt || release?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : null;
};
const tagOf = (release) => String(release?.tag_name ?? release?.tagName ?? '');
const isDraft = (release) => release?.draft === true || release?.isDraft === true;

/**
 * The newest published CODE release from a `GET /repos/{owner}/{repo}/releases` page (or a
 * `gh release list --json` page — both spellings are accepted).
 *
 * Drafts are excluded: a draft has no tag a customer or a channel check can resolve. Prereleases are
 * NOT excluded — the repo genuinely ships stabilization generations, and treating one as invisible
 * would reintroduce the "latest is stale" blindness from the other direction.
 *
 * Ordering is by publication time when the API supplies it, falling back to list order, which the
 * GitHub releases API already returns newest-first.
 */
export function pickLatestCodeRelease(releases) {
  const rows = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !isDraft(release) && isCodeReleaseTag(tagOf(release)));
  if (rows.length === 0) return null;
  const dated = rows.filter((release) => timeOf(release) !== null);
  if (dated.length === rows.length) {
    return [...rows].sort((left, right) => timeOf(right) - timeOf(left))[0];
  }
  return rows[0];
}

export function latestCodeReleaseTag(releases) {
  const release = pickLatestCodeRelease(releases);
  return release ? tagOf(release) : null;
}

/**
 * One sentence a consumer can print when `releases/latest` is NOT a code release, so the situation
 * reads as designed rather than as a defect someone must chase.
 */
export function describeLatestPointer(latestTag) {
  const kind = releaseKind(latestTag);
  if (kind === 'corpus') return `releases/latest is corpus generation ${latestTag} (by design — that is the customer download)`;
  if (kind === 'code') return `releases/latest is code release ${latestTag}`;
  return `releases/latest is ${latestTag || '(none)'} — neither a code release nor a corpus generation`;
}
