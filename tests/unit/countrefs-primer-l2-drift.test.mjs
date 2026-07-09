// tests/unit/countrefs-primer-l2-drift.test.mjs — scripts/build-l2.mjs and scripts/build-primer.mjs
// each hand-roll their own copy of the citation-grounding gate (countRefs) and neither has ever been
// tested. Not found in any of the six prior 2026-07-07/08 coverage-gap passes (those covered
// build-concepts.mjs's PRIVATE_SLUGS duplication and build-symbols.mjs, but not this pair).
//
// WHY THIS IS THE HIGHEST-SEVERITY NEW GAP: build-primer.mjs's own header comment (line 3) claims
// "Same proven shape as build-l2" — but the two copies have silently DIVERGED on the one thing that
// actually matters, whether ungrounded output gets rejected:
//   - build-l2.mjs:48-54   countRefs(txt) checks against the PER-TOPIC `paths` (only that topic's k=8
//                            retrieved sources); if realCited.length < 2 it RETRIES generation once
//                            (line 53), and accepted=false routes the article to kb/l2/rejected/
//                            instead of kb/l2/ (line 55) — a real fail-closed gate.
//   - build-primer.mjs:60-70 countRefs(txt) checks against `allPaths` ACCUMULATED across ALL 6
//                            archetypes (looser scope — a section can "count" a path that was only
//                            ever retrieved for a DIFFERENT section's sources). Worse: refs.length is
//                            compared to a threshold of 6 (line 70) purely for a console.log label
//                            ("GROUNDED" vs "THIN") — fs.writeFileSync (line 63) already ran
//                            UNCONDITIONALLY before that check. A primer that fails the exact same
//                            grounding bar build-l2 enforces still ships to kb/<name>-primer.md with
//                            zero rejection path and no retry.
// The underlying string-matching predicate itself (`txt.includes(p) || txt.includes(p.split('/').pop())`)
// is byte-for-byte identical in both files — it has not drifted. What drifted is what each caller DOES
// with the result. That is exactly the class of bug this repo has shipped before (QE-0011 security#1,
// see build-concepts-fence.test.mjs) — two copies of a safety check, only one of which still gates.
//
// PREREQUISITE (why this is a skeleton, not a finished test): both files are unguarded top-level
// scripts — build-l2.mjs's for-loop (line 41) and build-primer.mjs's for-loop (line 47) call `or()`,
// which does a real `fetch()` to openrouter.ai, unconditionally on import; build-primer.mjs additionally
// calls `process.exit(2)` at line 21 if OPENROUTER_API_KEY is missing. Same additive, no-behavior-change
// fix as every other export-ask in this suite — extract the pure predicate and the per-file gate logic,
// keep the top-level script body under an `if (import.meta.url === \`file://${process.argv[1]}\`)` guard:
//
//   // shared, e.g. scripts/lib/citation-gate.mjs
//   export function countRefs(txt, candidatePaths) {
//     const set = candidatePaths instanceof Set ? candidatePaths : new Set(candidatePaths);
//     return [...set].filter((p) => txt.includes(p) || txt.includes(p.split('/').pop()));
//   }
//   export function isGrounded(refs, minRefs) { return refs.length >= minRefs; }
//
// Then build-l2.mjs's per-topic accept/reject and build-primer.mjs's write-gate both call the SAME
// isGrounded(), at the SAME threshold, with the SAME reject-before-write behavior — closing the drift
// this file exists to catch. Flag to Stuart before applying (standing rule for every export-ask here).
import { describe, it, expect } from 'vitest';

describe.todo('countRefs(txt, candidatePaths) — shared predicate once extracted (requires export, see file header)', () => {
  it.todo('counts a path that appears verbatim in the text');
  it.todo('counts a path whose bare basename appears in the text even when the full path does not (LLM cited "forge-ask.mjs" without the "kb/" prefix)');
  it.todo('does not count a path that appears nowhere in the text, verbatim or by basename');
  it.todo('dedups when the same path is passed twice (Set semantics) — result has no duplicate entries');
  it.todo('BASENAME COLLISION — counts BOTH "kb/forge-ask.mjs" and "scripts/forge-ask.mjs" as cited when the text contains only the bare string "forge-ask.mjs" once — documents that basename-only matching can over-credit citations when two candidate paths share a basename across directories');
  it.todo('is case-sensitive — a path cited with different casing than the candidate path is NOT counted (String.includes has no case-insensitive mode here)');
  it.todo('returns an empty array, not a throw, when text is an empty string');
});

describe.todo('build-l2.mjs grounding gate — per-topic scope + retry-then-reject (requires export, see file header)', () => {
  it.todo('accepted=true when the article cites >= 2 of the CURRENT topic\'s retrieved paths (line 54 threshold)');
  it.todo('triggers exactly one retry generation when the first attempt cites < 2 real paths (line 53), then re-evaluates the retried article\'s citations');
  it.todo('accepted=false when even the retried article still cites < 2 real paths, and the article is written under kb/l2/rejected/ instead of kb/l2/ (line 55-57)');
  it.todo('does NOT count a real, valid repo path as cited if that path was not among the CURRENT topic\'s k=8 retrieved sources — proves the grounding is scoped to retrieved evidence, not "any real path anywhere"');
});

describe.todo('build-primer.mjs grounding gate — accumulated scope + THE DRIFT (requires export, see file header)', () => {
  it.todo('counts a path as cited if it was retrieved for ANY of the 6 archetypes, not just the one whose section text is being checked — documents the looser accumulated-scope behavior vs build-l2\'s per-topic scope');
  it.todo('REGRESSION THIS FILE EXISTS TO CATCH: writes the primer to kb/<name>-primer.md via fs.writeFileSync BEFORE the refs.length >= 6 check ever runs (line 63 precedes line 70) — i.e. a primer scoring 0 real citations still ships, unlike build-l2 which routes the equivalent case to rejected/ and never overwrites the accepted output path');
  it.todo('never retries generation regardless of how few real paths are cited — unlike build-l2\'s one retry at line 53 — so a thin first draft is final');
  it.todo('once countRefs and isGrounded are shared with build-l2.mjs (see file header fix), a primer below the grounding threshold is written to kb/<name>-primer.md.rejected (or an equivalent non-shipping path) instead of the live primer path — the parity check this whole file is written to eventually enforce');
});
