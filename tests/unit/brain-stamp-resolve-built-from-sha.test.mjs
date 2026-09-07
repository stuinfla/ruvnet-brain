// tests/unit/brain-stamp-resolve-built-from-sha.test.mjs — Dream Cycle 2026-08-26, DEEP=brain-currency.
//
// `builtFromSha` in data/manifest.json is read downstream (self-update.mjs's isBehind()) as "the
// commit the shipped RVF bytes were built from." Before this candidate, brain-stamp.mjs always
// recomputed it from the local clone's LIVE `git rev-parse HEAD` at stamp time — never from
// RVF-GENERATIONS.json's `sourceCommit`, which rvf-generation.mjs's writeRvfGeneration() records once,
// at actual build time. Whenever a clone is pulled or rebuilt between the RVF build and the next
// stamp run, those two values diverge and the manifest silently reports "built from" a commit the
// shipped bytes were never actually built from — the exact "clone freshness is not artifact
// freshness" defect class ADR-069's audit named (citing synthlang/autogenous as live examples where
// the two already disagree in this repo's own committed kb/RVF-GENERATIONS.json).
//
// Imports from brain-stamp-resolve.mjs, NOT brain-stamp.mjs: the latter is 100% top-level script
// that shells out to git and writes data/manifest.json + primer/ruvnet-primer.md as a side effect of
// being imported at all (see that module's own header) — importing it here would restamp this
// checkout's real files on every `vitest run`, which is exactly what an early version of this test
// did before the pure function was split out.
import { describe, it, expect } from 'vitest';
import { resolveBuiltFromSha } from '../../scripts/brain-stamp-resolve.mjs';

describe('brain-stamp.mjs — resolveBuiltFromSha(name, { generations, localSha })', () => {
  it('prefers the recorded generation sourceCommit over a live clone HEAD that has since moved past it', () => {
    const generations = { synthlang: { sourceCommit: '6959956375073c333b6a57bb9b2ff70ccd8b86ea' } };
    // Simulates the exact drift this candidate fixes: the clone was pulled after the RVF was built.
    const driftedLocalSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(resolveBuiltFromSha('synthlang', { generations, localSha: driftedLocalSha }))
      .toBe('6959956375073c333b6a57bb9b2ff70ccd8b86ea');
  });

  it('matches the generation record case-insensitively — registry.tiers.json names are mixed-case (e.g. "SynthLang"), RVF-GENERATIONS.json keys are lowercase', () => {
    const generations = { synthlang: { sourceCommit: '6959956375073c333b6a57bb9b2ff70ccd8b86ea' } };
    expect(resolveBuiltFromSha('SynthLang', { generations, localSha: 'ffffffffffffffffffffffffffffffffffffffff' }))
      .toBe('6959956375073c333b6a57bb9b2ff70ccd8b86ea');
  });

  it('falls back to the live clone HEAD when no generation record exists for that store yet', () => {
    const localSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(resolveBuiltFromSha('never-generated-store', { generations: {}, localSha })).toBe(localSha);
  });

  it('falls back to the live clone HEAD when the recorded generation exists but sourceCommit is null — the real, committed shape for 51/78 of this repo\'s own kb/RVF-GENERATIONS.json entries', () => {
    const generations = { 'agentic-qe': { sourceCommit: null } };
    const localSha = 'cccccccccccccccccccccccccccccccccccccccc';
    expect(resolveBuiltFromSha('agentic-qe', { generations, localSha })).toBe(localSha);
  });

  it('returns the sentinel string "unknown" — never throws, never undefined — when both the generation and the local clone are unavailable', () => {
    expect(resolveBuiltFromSha('never-cloned-store', { generations: {}, localSha: null })).toBe('unknown');
  });
});
