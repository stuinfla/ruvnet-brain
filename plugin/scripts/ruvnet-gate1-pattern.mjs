/**
 * ruvnet-gate1-pattern.mjs — the ONE copy of ground-ruvnet.sh's "Gate 1" regex outside that file.
 *
 * ground-ruvnet.sh (POSIX/bash) and grounding-turn-mark.mjs (Node) cannot literally `import` one
 * another's source — one is a shell script, the other is JS. The task this file exists for is
 * explicit: "copy it verbatim ... do not redefine a second, drifting copy ... or keep it
 * byte-identical with a test that fails if they diverge". A shared data file both languages could
 * read was considered and rejected: ground-ruvnet.sh is a hot, heavily-tuned, every-prompt hook
 * (see its own header on the 38s-regression bounded-read fix), and editing it to add a file-read
 * indirection for this one string is exactly the kind of non-surgical touch that risks a working,
 * extensively-measured script for a feature that does not need it to change at all.
 *
 * So the copy lives here, in JS, and tests/unit/ruvnet-gate1-pattern.test.mjs parses
 * ground-ruvnet.sh's own "Gate 1" grep line and asserts this string matches it byte-for-byte. A
 * future edit to either side that is not mirrored in the other goes red immediately, which is the
 * actual guarantee "byte-identical with a test that fails if they diverge" asks for.
 *
 * SOURCE OF TRUTH: plugin/scripts/ground-ruvnet.sh, the line beginning
 * `if printf '%s' "$TEXT" | grep -qiE '...'; then` under the "Gate 1: does the task touch the rUv
 * ecosystem?" comment. Copied 2026-09-12, case-insensitive (`-i`) to match `grep -qiE`.
 */
export const RUVNET_GATE1_PATTERN =
  '\\bruvnet\\b|\\bruflo\\b|\\bruvector\\b|\\brvf\\b|\\bagentdb\\b|\\bagenticow\\b|\\brulake\\b|\\bruview\\b|\\brupixel\\b|\\bruv-fann\\b|\\bagentic-flow\\b|\\bsynthlang\\b|\\bdspy\\b|\\bqudag\\b|\\bsafla\\b|\\bmetaharness\\b|\\bcve-bench\\b|\\bsparc\\b|\\bswarms?\\b|\\bclaude-flow\\b|\\brUv\\b';

/** Case-insensitive, matching the shell side's `grep -qiE`. A fresh RegExp per call — `.test()` on a
 *  shared `g`/`y` instance is stateful and a caller-shared singleton here would be a subtle footgun. */
export function ruvnetGate1Matches(text) {
  return new RegExp(RUVNET_GATE1_PATTERN, 'i').test(String(text ?? ''));
}
