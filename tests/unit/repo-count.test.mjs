import { describe, it, expect } from 'vitest';
import { findRepoCountLiterals, EXEMPT } from '../../scripts/repo-count-detector.mjs';
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
// The detector now lives in scripts/repo-count-detector.mjs so sync-census.mjs can use the SAME
// code this gate fails on. A writer and a checker with separate copies drift, and did.

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
