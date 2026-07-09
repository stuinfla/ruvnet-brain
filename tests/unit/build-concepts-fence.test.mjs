// tests/unit/build-concepts-fence.test.mjs — scripts/build-concepts.mjs (147 lines) has ZERO tests
// and was never even mentioned in any prior coverage-gap audit (test-coverage-gaps-2026-07-07). Found
// during the 2026-07-08 pass by checking which source files are never referenced — not even in a
// comment — by any of the 15 existing test files.
//
// WHY THIS IS THE HIGHEST-SEVERITY NEW GAP: build-concepts.mjs contains a THIRD independent copy of
// the private-data fence pattern already flagged as critical for scripts/build-bundle.mjs
// (`loadPrivateStores()`, tested in tests/integration/build-bundle-fence.test.mjs) — `loadPrivate()`
// (lines 22-38), `isPrivate()` (line 40), and a second layer, `PRIVATE_SLUGS` (lines 47-57), that
// fences an L2 article by its SLUG when the repo attribution is unknown. The file's OWN comment at
// line 42-46 says this second layer exists because "an unknown slug used to default to 'ruvnet'
// (fail-OPEN → it shipped)" — i.e. this is a regression test for a bug that ALREADY SHIPPED ONCE
// (QE-0011 security#1), exactly the "test the fence, not just the feature" pattern from
// build-bundle-fence.test.mjs, and currently has zero coverage.
//
// PREREQUISITE (why this is a skeleton, not a finished test): build-concepts.mjs is a top-level
// self-executing script — loadPrivate() calls `process.exit(1)` directly on fs errors (lines 28, 36),
// and everything below it (REPOS discovery, the L2/PRIMER/CARD passage-building loops) runs
// unconditionally on import. Both make it unsafe to import in-process. The additive, no-behavior-
// change fix (same shape already applied to build-bundle.mjs's loadPrivateStores(), which returns a
// result instead of exiting so its CALLER decides whether to process.exit):
//
//   export function loadPrivateFence(kbDir, { allowNoFence = false } = {}) {
//     const p = path.join(kbDir, 'PRIVATE-STORES.json');
//     if (!fs.existsSync(p)) {
//       if (allowNoFence) return { ok: true, privateSet: new Set() };
//       return { ok: false, reason: `private fence missing (${p})` };
//     }
//     try {
//       const j = JSON.parse(fs.readFileSync(p, 'utf8'));
//       if (!Array.isArray(j.privateStores)) throw new Error('no privateStores array');
//       return { ok: true, privateSet: new Set(j.privateStores.map((s) => String(s).toLowerCase())) };
//     } catch (e) { return { ok: false, reason: `PRIVATE-STORES.json unreadable/corrupt (${e.message})` }; }
//   }
//   export function loadPrivateSlugs(kbDir, privateSet) { /* the lines 47-57 loop, returning {ok,slugs}
//     or {ok:false, reason} on a corrupt per-repo topics file — same fail-closed contract */ }
//   export function isPrivateRepo(privateSet, repo) { return privateSet.has(String(repo).toLowerCase()); }
//
// Then the top-level script becomes: `const r = loadPrivateFence(KB, {allowNoFence: env.ALLOW_NO_PRIVATE_FENCE==='1'});
// if (!r.ok) { console.error(...); process.exit(1); }` — identical external behavior, testable core.
// Flag to Stuart before applying (same pattern as every other export-ask in this repo's test suite).
import { describe, it, expect } from 'vitest';

describe.todo('build-concepts.mjs — loadPrivateFence(kbDir, opts) (requires export + de-exit, see file header)', () => {
  it.todo('returns {ok:false} with a reason naming the missing file when PRIVATE-STORES.json does not exist and allowNoFence is false — the default, fail-closed path');
  it.todo('returns {ok:true, privateSet: new Set()} when PRIVATE-STORES.json is missing but allowNoFence is true (the documented ALLOW_NO_PRIVATE_FENCE=1 escape hatch for a no-private fork)');
  it.todo('returns {ok:false} when PRIVATE-STORES.json exists but is not valid JSON');
  it.todo('returns {ok:false} when PRIVATE-STORES.json parses but privateStores is not an array (e.g. a string or object)');
  it.todo('returns {ok:true, privateSet} with every name lowercased, given a valid ["Seed","V0-Appliance"] array');
});

describe.todo('build-concepts.mjs — isPrivateRepo(privateSet, repo) (pure once extracted)', () => {
  it.todo('returns true for a repo name matching a private entry regardless of case ("Seed" fences "SEED", "seed", "SeEd")');
  it.todo('returns false for a repo name not in the private set');
});

describe.todo('build-concepts.mjs — loadPrivateSlugs(kbDir, privateSet) — the QE-0011 security#1 fix (requires export, see file header)', () => {
  it.todo('skips (not fatal) a private repo that has no l2-topics.<repo>.json file on disk — absence is normal, not corruption');
  it.todo('collects every slug from a private repo\'s l2-topics.<repo>.json into the returned slug set');
  it.todo('returns {ok:false} (fail-closed, matching loadPrivateFence) when a private repo\'s l2-topics file EXISTS but is corrupt JSON — a topics file that can\'t be trusted must abort the build, not silently skip');
  it.todo('THE REGRESSION THIS FILE EXISTS TO CATCH: an L2 article whose repo attribution is unknown (defaults to \'ruvnet\' per the main loop\'s `slugRepo.get(slug) || \'ruvnet\'`) is STILL excluded from the shipped concepts store when its slug is a member of the private-repo slug set — i.e. slug-based fencing catches what repo-based fencing alone would let ship');
});
