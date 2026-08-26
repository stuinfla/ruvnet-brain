// brain-stamp-resolve.mjs — pure helper split out of brain-stamp.mjs specifically so it can be unit
// tested. brain-stamp.mjs is 100% top-level script: importing it for real shells out to git and
// writes data/manifest.json + rewrites primer/ruvnet-primer.md as a side effect of the import alone
// (documented in tests/unit/brain-stamp-manifest.test.mjs's header, and confirmed the hard way while
// writing this candidate's test — an early version imported resolveBuiltFromSha straight from
// brain-stamp.mjs and it silently restamped this checkout's own manifest/primer on `vitest run`).
// This module has zero side effects on import; brain-stamp.mjs imports resolveBuiltFromSha from here.

// `builtFromSha` promises the commit the SHIPPED RVF bytes were built from — not whatever HEAD the
// local clone happens to sit at when the stamper runs. RVF-GENERATIONS.json's `sourceCommit` is
// recorded once, at actual build time (rvf-generation.mjs's writeRvfGeneration); the clone's live
// HEAD drifts from it the moment the clone is pulled or rebuilt after that. ADR-069's audit named
// this exact gap ("clone freshness is not artifact freshness") and cites synthlang/autogenous as
// cases where the two values already disagree in this repo's own committed kb/RVF-GENERATIONS.json.
// Prefer the recorded generation; fall back to the live clone HEAD only for stores with no generation
// record yet. Case-insensitive lookup matches brain-stamp.mjs's own findClone() convention (store
// names are lowercased, clone dirs are not).
export function resolveBuiltFromSha(name, { generations = {}, localSha = null } = {}) {
  const key = Object.keys(generations).find((k) => k.toLowerCase() === String(name).toLowerCase());
  const recorded = key ? generations[key].sourceCommit : null;
  return recorded || localSha || 'unknown';
}
