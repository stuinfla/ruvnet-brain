// tests/unit/forge-build-chunking.test.mjs — kb/forge-build.mjs (472 lines, the KB indexer every
// `rvf-kb-forge` build runs through) has zero tests of any kind, despite already having shipped ONE
// real bug in this exact area: an empty/whitespace-only source file used to emit a blank passage
// that tripped forge-guard's empty-text check (see the comment at forge-build.mjs's chunk-building
// loop, "Drop empty/whitespace-only chunks... trip forge-guard's empty-text check", and
// MEMORY.md's "Empty-passage build bug fixed (forge-build.mjs skips blank chunks)"). A regression
// test for a bug that already shipped once is higher value than a generic coverage bump.
//
// PREREQUISITE (this file will NOT run until this lands — it's the reason this is a skeleton, not a
// finished test): forge-build.mjs is a top-level self-executing script, same pattern as
// build-bundle.mjs/forge-guard.mjs/sign-bundle.mjs — `titleOf`/`docBlock`/`htmlText`/`chunkText`
// (lines 106, 111, 119, 311) are plain, unexported functions, AND the module unconditionally walks
// the whole target repo tree (STEP 1 CENSUS, right after these function definitions) as an import
// side effect. Two small, additive changes make this testable with no behavior change to the real
// CLI (same pattern already requested for check-indexation.mjs/self-update.mjs — flag to Stuart
// before applying):
//   1. `export function chunkText(text) {...}`, `export function titleOf(text, fallback) {...}`,
//      `export function docBlock(text, n = 30) {...}`, `export function htmlText(html) {...}`.
//   2. Guard the walk/census/embed pipeline the same way scripts/verify-bundle.mjs already does
//      (line 39 there): `if (import.meta.url === \`file://${process.argv[1]}\`) { ...existing body... }`.
//
// Once exported+guarded, these are pure string-in/string-out functions — no fixture repo, no
// filesystem, no model download needed.
import { describe, it } from 'vitest';

describe.todo('chunkText(text) — the function whose empty-output bug already shipped once', () => {
  it.todo('returns [text] unchanged when text.length <= MAX (4000 chars) — no splitting for short docs');
  it.todo('splits text longer than 4000 chars into multiple chunks, each overlapping the previous by 400 chars (the OVERLAP window: chunks[1].slice(0,400) === chunks[0].slice(-400))');
  it.todo('prefers to split at the nearest "\\n\\n" paragraph boundary past the halfway point of the window, over a raw MAX-char cut');
  it.todo('given the same corpus-loop filter forge-build.mjs applies at its call site (parts.filter(p => p && p.trim())), a whitespace-only input contributes ZERO chunks — the exact regression that once let a blank passage slip through and trip forge-guard\'s empty-text check');
});

describe.todo('titleOf(text, fallback) — H1 extraction with a fallback and a 200-char cap', () => {
  it.todo('extracts the first "# Heading" line as the title, trimmed');
  it.todo('falls back to the provided fallback (e.g. the filename) when no "# " line exists');
  it.todo('truncates a title longer than 200 chars');
});

describe.todo('docBlock(text, n) — leading doc-comment extraction (Rust //! / JS/TS block or line comments / Python #)', () => {
  it.todo('extracts consecutive leading "//!" lines (Rust module docs), stripped of the marker');
  it.todo('falls back to leading "*"/"/**"/"//"/"#" comment lines when no "//!" block is present');
  it.todo('returns an empty string when the first n lines contain no recognizable doc-comment marker');
});

describe.todo('htmlText(html) — HTML-to-plain-text used when ingesting rendered docs', () => {
  it.todo('strips <script> and <style> blocks entirely, including their contents');
  it.todo('strips HTML comments');
  it.todo('strips all remaining tags, leaving only text content');
  it.todo('decodes the 6 handled entities: &nbsp; &amp; &lt; &gt; &quot; &#39;');
  it.todo('collapses runs of 3+ newlines down to a single blank line (\\n\\n)');
});
