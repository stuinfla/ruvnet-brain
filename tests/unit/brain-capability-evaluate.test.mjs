// tests/unit/brain-capability-evaluate.test.mjs — scripts/brain-capability-check.mjs's evaluate()
// (line 33) is the pass/fail scoring logic for the ENTIRE capability battery — the thing that
// decides whether "can RuvNet do X?" is graded correct. It currently only gets exercised
// end-to-end via plugin/test/run-tests.mjs's capability section, which silently SKIPS whenever the
// brain bundle isn't present (true on every default CI run today — no REQUIRE_BRAIN gate is wired,
// see this pass's integration-gap findings). evaluate()'s tie-break logic (the nested `||`
// condition deciding which candidate becomes `best` when one candidate is confident+evidenced and
// another has a higher raw ceScore) has real branch complexity that direct unit tests would catch
// far cheaper than a full brain-bundle integration run.
//
// PREREQUISITE: evaluate() and TAU (line 24) are module-private; the file runs its battery
// unconditionally at top level, same guard-needed pattern as the other gap skeletons in this repo.
// Additive, no-behavior-change fix: `export function evaluate(results, qq) {...}` and `export const
// TAU = ...` (or guard the top-level battery the same way verify-bundle.mjs does, line 39 there).
// Flag to Stuart before applying, per this repo's established pattern.
import { describe, it, expect } from 'vitest';

describe.todo('brain-capability-check.mjs — evaluate() (requires export, see file header)', () => {
  it.todo('picks a hit from the expected repo over a higher-scored hit from a different repo');
  it.todo('accepts a "concepts" store hit whose path is prefixed with expectRepo + "/" as if it were that repo');
  it.todo('evidenced:true requires at least ceil(evidence.length/2) evidence terms present in the hit text');
  it.todo('prefers a confident+evidenced candidate over a higher-ceScore candidate that is not evidenced');
  it.todo('returns null when results is empty (no candidate to score)');
  it.todo('a NO-capability (truth:"no") question passes when no confident+evidenced hit exists — the absence IS correct');
});
