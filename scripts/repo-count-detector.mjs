// repo-count-detector.mjs — THE ONE detector for corpus-size claims in public surfaces.
//
// Extracted from tests/unit/repo-count.test.mjs on 2026-08-10 so the WRITER (sync-census.mjs)
// and the GATE (repo-count.test.mjs) consult the same code. They had drifted by construction:
// the gate found every phrasing, while the writer enumerated a handful by hand and missed
// "71 of rUv's repos", "71 RuvNet building-block repos", "71 built today", and the
// HTML-entity variant. A checker and a fixer that disagree guarantee recurring red builds.

export const MIN_CORPUS_MAGNITUDE = 20;

// Deliberate, documented exceptions: the literal is correct AS WRITTEN because it describes a
// PAST state (a "before" baseline in a receipts table), not a current claim — not stale data.
// Anything else that disagrees with ALLOWED fails. Keyed `${file}::${matched text}` so a typo'd
// exemption can't silently swallow an unrelated real regression.
export const EXEMPT = new Set([
  'README.md::24 repos', // v1 (pre-2.0) baseline column in the "what 2.0 proved" before/after table
  'README.md::24→69 verified repos', // same v1-baseline row, "24→<current>" delta phrasing
  // 2026-08-06: the corpus grew 69 → 71 (tonight's rebuild). The CURRENT claims were updated to 71
  // in README.md and SKILL.md, but these two are HISTORICAL — they describe what release 2.0
  // proved, inside a collapsed "Earlier — what 2.0 proved" section and its before/after table.
  // Rewriting them to 71 would be the easy way to make this gate green and would falsify the record:
  // 2.0 shipped with 69, not 71. A gate that pressures you into editing history is worse than the
  // stale number it caught, so historical mentions are exempted by name and current ones are not.
  'README.md::69 verified repos', // "what 2.0 proved" summary line — a claim about 2.0, not today
  'README.md::69 repos', // the 2.0 column of the same v1→v2.0 before/after table
]);

/** @param {string} src @returns {{text: string, n: number}[]} */
export function findRepoCountLiterals(src) {
  const found = [];
  // Covers "repo(s)" and the spelled-out "repositor(y|ies)" (SKILL.md line 8's own phrasing:
  // "32 RuvNet (rUv / Reuven Cohen) repositories" — real prose puts several filler words/
  // parentheticals between the number and the noun, so this can't be a fixed word count).
  const REPO_WORD = '(?:repos?|repositor(?:y|ies))';
  // Digit NOT immediately followed by "+": an open lower-bound like "20+ repos" is a true,
  // deliberately-vague qualifier, not a precise count claim — exempt from matching at all rather
  // than needing a per-mention exemption. Filler between the digit and the repo-word is capped at
  // 50 chars and may not cross a sentence end / table-cell boundary (".", "|", newline), so this
  // can't accidentally bridge two unrelated numbers separated by prose.
  // `(?<!\d\.)` — never treat a SEMVER COMPONENT as a repo count. Real false positive: the primer's
  // header line "…v3.4.21-dev · Built: 2026-07-20 · Covers: 69/192 repos" made the detector read the
  // patch number `21` (the `-` after it is a word boundary) and then walk 40-odd filler chars to
  // "repos", reporting a stale count on a line whose actual claim — 69/192 — was correct. The
  // published number was right and the gate cried wolf, which is how a gate loses its authority.
  // Two guards, both added after REAL false positives on the primer's own header line
  // "…<version> · Built: <date> · Covers: 69/192 repos", whose actual claim (69/192) is correct:
  //   (?<!\d\.)  — a SEMVER COMPONENT is never a repo count. The patch number was being read as
  //                one, because the `-` before a prerelease suffix is a word boundary.
  //   `·` in the filler exclusion — a middle dot separates INDEPENDENT facts. Without it the walk
  //                crossed from the build DATE into the count and reported `2026` as a repo count
  //                (found by this file's own detector tests, after the semver fix unmasked it).
  const reSpaced = new RegExp(`(?<!\\d\\.)\\b(\\d{1,4})(?!\\+)\\b(?:(?![.|·\\n])[\\s\\S]){0,50}?\\b${REPO_WORD}\\b`, 'gi');
  const reHyphen = new RegExp(`(?<!\\d\\.)\\b(\\d{1,4})(?!\\+)-repos?\\b`, 'gi');
  for (const re of [reSpaced, reHyphen]) {
    for (const m of src.matchAll(re)) {
      const n = Number(m[1]);
      if (n >= MIN_CORPUS_MAGNITUDE) found.push({ text: m[0], n });
    }
  }
  return found;
}

