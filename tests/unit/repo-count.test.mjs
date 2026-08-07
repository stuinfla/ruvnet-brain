import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// LIE #1 (found 2026-07-18): SKILL.md (line 8, agent-facing ground truth) and primer.md both
// asserted "32 RuvNet repos" / "32-repo corpus" while data/manifest.json's real coverage was
// built=57 (catalogued=181, orgTotalApprox=248) — README carried its own stale "36 repos"/"197
// live ruvnet repos" on top of that. A wrong corpus-size literal in SKILL.md doesn't just look
// bad, it actively misleads every agent session that reads it as ground truth. This gate reads
// the live manifest and fails the build the instant any repo-count literal in these three public
// surfaces drifts from it again — same "single source of truth" shape as
// narrative-version.test.mjs (version strings) and sync-version.mjs (semver fields).
const ROOT = process.cwd();
const coverage = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/manifest.json'), 'utf8')).coverage;
const ALLOWED = new Set([coverage.built, coverage.catalogued, coverage.orgTotalApprox]);

// explainer/index.html and explainer/llms.txt added 2026-07-18 (issues B4/B5): the LIVE public
// marketing page hardcoded "56 repos" in ~8 places and llms.txt contradicted itself ("36 indexed
// repos" on line 3 vs "69 RuvNet repos" on line 18) — neither was watched because they weren't in
// SURFACES. The detector already does the right thing; it just wasn't pointed at them.
const SURFACES = [
  'README.md',
  'plugin/skills/ruvnet-brain/SKILL.md',
  'primer/ruvnet-primer.md',
  'explainer/index.html',
  'explainer/llms.txt',
  // plugin/.claude-plugin/plugin.json — its `description` is shown in the Claude Code plugin
  // MARKETPLACE (user-facing); it shipped "across 32 rUv repositories" while the truth was 57
  // (2026-07-18). Not caught because it wasn't watched. Now it is.
  'plugin/.claude-plugin/plugin.json',
];

// Below this magnitude a "N repos" mention is never a corpus-size claim in these docs — e.g.
// "the 8 newest repos are findable by name" names a small named subset, not the corpus total.
// Restricting the net to plausible corpus magnitudes avoids that whole false-positive class
// without an exemption entry per incidental small-number mention.
const MIN_CORPUS_MAGNITUDE = 20;

// Deliberate, documented exceptions: the literal is correct AS WRITTEN because it describes a
// PAST state (a "before" baseline in a receipts table), not a current claim — not stale data.
// Anything else that disagrees with ALLOWED fails. Keyed `${file}::${matched text}` so a typo'd
// exemption can't silently swallow an unrelated real regression.
const EXEMPT = new Set([
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

function staleLiterals(file, src) {
  return findRepoCountLiterals(src).filter(
    (h) => !ALLOWED.has(h.n) && !EXEMPT.has(`${file}::${h.text}`),
  );
}

// The detector itself, tested directly. A gate that stops firing is indistinguishable from a gate
// that passes, so the semver fix below is proved BOTH ways: it must still catch a genuinely stale
// count, and must no longer flag a correct line that merely contains a version number.
describe('findRepoCountLiterals — the detector', () => {
  it('CATCHES a genuinely stale count (the gate still fires)', () => {
    expect(findRepoCountLiterals('we cover 57 repos').map((h) => h.text)).toEqual(['57 repos']);
  });

  // A SYNTHETIC version on purpose. Using the real current one made this file itself trip the
  // "no hardcoded version literals" gate, and would have needed editing at every release — a test
  // that breaks on an unrelated version bump is a test people learn to ignore.
  const HEADER = `v1.2.34-dev · Built: 2026-07-20 · Covers: ${coverage.built}/${coverage.catalogued} repos`;

  it('catches a stale count even on a line that also carries a version', () => {
    expect(findRepoCountLiterals('v1.2.34-dev · Covers: 57 repos').map((h) => h.n)).toContain(57);
  });

  it('does NOT read a semver component as a repo count (the -dev false positive)', () => {
    // This header used to be reported as a stale literal reading "34-dev · … · Covers: …",
    // because `-` is a word boundary after the patch number.
    const ns = findRepoCountLiterals(HEADER).map((h) => h.n);
    expect(ns, 'the patch number is not a repo count').not.toContain(34);
    expect(ns, 'the build year is not a repo count').not.toContain(2026);
    expect(ns, 'the real claim on the line is still read').toContain(coverage.built);
  });
});

describe(`repo-count literals match data/manifest.json coverage (built=${coverage.built}, catalogued=${coverage.catalogued}, org≈${coverage.orgTotalApprox})`, () => {
  for (const f of SURFACES) {
    it(`${f} — every repo-count literal is ${[...ALLOWED].join('/')} or a documented exemption`, () => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const bad = staleLiterals(f, src);
      expect(
        bad.map((h) => h.text),
        `${f} has stale repo-count literal(s) that disagree with the manifest: ${bad.map((h) => h.text).join(', ')}`,
      ).toEqual([]);
    });
  }

  it('sanity: the manifest coverage numbers this gate trusts are themselves internally consistent', () => {
    expect(coverage.built).toBeGreaterThan(0);
    expect(coverage.catalogued).toBeGreaterThanOrEqual(coverage.built);
    expect(coverage.orgTotalApprox).toBeGreaterThanOrEqual(coverage.catalogued);
  });

  // Self-proving: demonstrates the detector actually catches the exact historical lie (not just
  // "some test exists") without needing to corrupt a real file to prove it works. Regression-proof
  // against the detector logic itself going quietly toothless in a future refactor.
  it('detector: flags the known-bad historical literals — the actual wording that shipped', () => {
    const known_bad = [
      // the real SKILL.md line 8, pre-fix (parenthetical between number and noun)
      'You have a source-grounded brain over 32 RuvNet (rUv / Reuven Cohen) repositories, exposed through the `ruvnet-brain` MCP server.',
      '**36 repos** built (of 197 live ruvnet repos), each verified by a live retrieval query',
      'across the full 32-repo corpus, not just the 3-4 names that come to mind first',
      'a portable brain over **32 RuvNet building-block repos**, embedded and indexed at pinned SHAs',
      'any of the 173 catalogued, or any rUv repo',
      // explainer B4/B5 — the exact live markup that shipped, pre-fix
      "<b>56 repos &middot; rUv's real source, indexed</b>",
      '<span data-count="56" data-decimals="0">56</span> repos',
      '56 repos indexed in total. Together they show the reassuring breadth',
      'SPARC and 36 indexed repos',
    ];
    for (const src of known_bad) {
      const bad = staleLiterals('synthetic', src);
      expect(bad.length, `expected a stale hit in: ${src}`).toBeGreaterThan(0);
    }
  });

  it(`detector: does not flag the correct literals (${coverage.built} / ${coverage.catalogued} / ${coverage.orgTotalApprox}), the documented v1 baseline, or an open "N+" qualifier`, () => {
    // BUILT FROM THE LIVE MANIFEST, NOT FROZEN DIGITS. This block used to spell 69/192 literally,
    // and the title still said "(57 / 181 / 248)" from an even earlier corpus — so every time the
    // corpus grew, the gate that exists to catch stale numbers went red on its OWN stale numbers.
    // It did exactly that on 2026-08-06 when the rebuild took built 69 -> 71, and a red suite blocks
    // the release rail, which is how a documentation gate ends up stalling a publish. Interpolating
    // the same source of truth the detector uses means this fixture can never rot again.
    const B = coverage.built, C = coverage.catalogued, O = coverage.orgTotalApprox;
    const known_good = [
      `You have a source-grounded brain over ${B} RuvNet (rUv / Reuven Cohen) repositories, exposed through the \`ruvnet-brain\` MCP server.`,
      `**${B} repos** built (of ${O} in the org), each verified by a live retrieval query`,
      `across the full ${B}-repo corpus, not just the 3-4 names that come to mind first`,
      `Covers: ${B}/${C} repos built @ pinned SHAs`,
      `24 repos built | **${B} repos** built (of ${O} in the org)`, // v1 baseline + current, same row
      '24→69 verified repos', // v1-baseline delta phrasing (2.0 shipped 69 — a historical fact, never re-derived)
      "or any of rUv's 20+ repos", // deliberately open lower-bound, not a precise count
      'This is a 20+-repo ecosystem, not just the 2-3 most commonly cited',
      `any of the ${C} catalogued, or any rUv repo`,
      // explainer B4/B5 — the fixed forms
      `<span data-count="${B}" data-decimals="0">57</span> repos`,
      `${B} repos indexed in total. Together they show the reassuring breadth`,
      `SPARC and ${B} indexed repos`,
    ];
    for (const src of known_good) {
      expect(staleLiterals('README.md', src), `unexpected stale hit in: ${src}`).toEqual([]);
    }
  });
});
