#!/usr/bin/env node
// 2026-09-18-grounding-quality-repro.mjs — reproduces, on unmodified `main`, the exact gap PR #239
// (2026-09-03, closed unmerged 2026-09-07) found and never got integrated: eval-brain.mjs's
// `gradeQuestion()` grades the `provenance` stratum's "did a winning gist chunk carry its banner"
// rule off `citations[0].repo` (the raw top-ranked citation) instead of `receipt.repo` (the
// citation verify-citation.mjs's `citationResolves()` actually verified on disk, which can be a
// LOWER rank when the top citation is unverified/fabricated — the sibling gap PR #187/#188 already
// closed for the `routed` metric, in the same function, never migrated to this stratum's check).
//
// Scenario reproduced: the top-ranked citation names a non-gist repo but never resolves (fabricated
// or stale); the citation verify-citation.mjs actually verified is a ruv-gists chunk with NO
// provenance banner. The stratum exists to catch exactly this — a gist chunk winning without its
// banner — but grading off citations[0] instead of the receipt lets it through as a pass.
//
// Run against unmodified main: exits 1, prints VULNERABLE.
// Run against the candidate (routedRepo threaded into the provenance branch): exits 0, prints FIXED.

import { gradeQuestion } from '../../../scripts/eval-brain.mjs';

const q = { stratum: 'provenance', expectRepo: ['ruv-gists', 'ruflo'] };

// Top citation coincidentally names ruflo (non-gist) but was never verified as resolving on disk;
// the citation that ACTUALLY grounded the answer (per verify-citation.mjs's own receipt) is a
// ruv-gists chunk carrying no banner.
const citations = [
  { repo: 'ruflo', fullPath: 'ruflo/fake/path', ce: 5 },
  { repo: 'ruv-gists', fullPath: 'ruv-gists/real/path', ce: 3 },
];
const receipt = { repo: 'ruv-gists', path: 'ruv-gists/real/path' };

const graded = gradeQuestion(q, { grounded: true, citations, receipt, bannerPresent: false });

if (graded.pass) {
  console.log('VULNERABLE: provenance stratum passed a bannerless gist-chunk win because it graded');
  console.log('off citations[0] (ruflo, never verified) instead of the receipt (ruv-gists, the hit');
  console.log('verify-citation.mjs actually resolved on disk).');
  process.exit(1);
} else {
  console.log('FIXED: provenance stratum correctly failed the bannerless gist win, graded off the');
  console.log('receipt verify-citation.mjs actually verified.');
  process.exit(0);
}
