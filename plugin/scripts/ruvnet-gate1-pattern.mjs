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

/**
 * H1 / GitHub #316: the plain substring vocabulary mechanically derived from RUVNET_GATE1_PATTERN —
 * one lowercased term per `|`-separated alternative, with the `\b` word-boundary anchors stripped
 * (irrelevant to a substring scan) and the one optional-plural alternative ("swarms?") reduced to
 * its shortest substring-safe form ("swarm", which is a substring of both "swarm" and "swarms").
 *
 * This is the ONE vocabulary grounding-stamp.sh's GATE1_ONLY_TERMS must mirror byte-for-byte
 * (tests/unit/grounding-stamp-terms.test.mjs enforces it, same idiom as
 * tests/unit/ruvnet-gate1-pattern.test.mjs's byte-identity check against ground-ruvnet.sh). Before
 * that fix, grounding-stamp.sh hard-coded its own narrower 9-term list that omitted `ruvnet` itself
 * — so a search literally about "ruvnet" minted no stamp and grounding-turn-gate.mjs's Stop-time
 * check wrongly reported "no successful search_ruvnet call this turn".
 */
export const RUVNET_GATE1_TERMS = RUVNET_GATE1_PATTERN
  .split('|')
  .map((alt) => alt.replace(/\\b/g, '').replace(/s\?$/, '').toLowerCase());


/** Prompt-trigger scope only; never used for retrieval or write safety. */
const SCOPE_ALIASES = { rvf: 'ruvector', 'ruvector-postgres': 'ruvector', 'claude-flow': 'ruflo', swarms: 'swarm' };
export function normalizeGroundingScope(raw) {
  if (raw === 'all') return { ok: true, value: 'all' };
  if (!Array.isArray(raw) || !raw.length || raw.length > RUVNET_GATE1_TERMS.length) return { ok: false, value: 'all' };
  const terms = raw.map((x) => typeof x === 'string' ? x.toLowerCase() : '');
  if (terms.some((x) => !RUVNET_GATE1_TERMS.includes(x) && x !== 'ruvector-postgres')) return { ok: false, value: 'all' };
  return { ok: true, value: [...new Set(terms.map((x) => SCOPE_ALIASES[x] || x))] };
}
export function groundingScopeMatches(text, scope = 'all') {
  const value = normalizeGroundingScope(scope).value;
  if (value === 'all') return ruvnetGate1Matches(text);
  const terms = value.flatMap((x) => x === 'ruvector' ? ['ruvector', 'rvf'] : x === 'ruflo' ? ['ruflo', 'claude-flow'] : [x]);
  return terms.some((x) => new RegExp(`\\b${x === 'swarm' ? 'swarms?' : x}\\b`, 'i').test(String(text ?? '')));
}
export function groundingSubjectAllowed(subject, scope = 'all') {
  return !ruvnetGate1Matches(subject) || groundingScopeMatches(subject, scope);
}
export function mergeGroundingScopes(a = 'all', b = 'all') {
  const x = normalizeGroundingScope(a).value, y = normalizeGroundingScope(b).value;
  return x === 'all' || y === 'all' ? 'all' : [...new Set([...x, ...y])];
}
// The shell body's Gate1 invokes this existing packaged module only after its full regex matches.
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/ruvnet-gate1-pattern.mjs') && process.argv[2] === '--scope-matches') setImmediate(async () => {
  try {
    const { loadSettings } = await import('./user-settings.mjs');
    const { readStdinBounded } = await import('./hook-input.mjs');
    const text = (await readStdinBounded({ maxBytes: 32768 })).toString('utf8');
    process.stdout.write(groundingScopeMatches(text, loadSettings().values.groundingScope) ? '1' : '0');
  } catch { process.stdout.write('1'); } // uncertain config preserves default enforcement
});
