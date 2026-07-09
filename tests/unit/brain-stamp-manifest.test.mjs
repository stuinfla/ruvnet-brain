// tests/unit/brain-stamp-manifest.test.mjs — scripts/brain-stamp.mjs (64 lines) has ZERO tests and was
// never mentioned in any of the nine prior coverage-gap passes (memory `test-coverage-gaps-2026-07-07`
// deferred it alongside ingest-repo.mjs/behavioral-l1-l4.mjs/brain-grade-groundtruth.mjs/prove.mjs —
// this file closes brain-stamp.mjs specifically; the other four remain deferred, see reasoning below).
//
// Why this one is worth closing NOW, not later: brain-stamp.mjs is the PRODUCER of the exact
// `builtFromSha: 'unknown'` sentinel whose CONSUMER side (self-update.mjs's isBehind logic) was just
// fixed and tested in tests/unit/self-update-plan.test.mjs ("'unknown' stamped SHA cannot prove
// freshness — treat as changed whenever upstream is reachable", self-update.mjs:59-62). Fixing the
// consumer without ever testing the producer leaves the other half of the same bug class open: if
// brain-stamp.mjs's OWN logic for deciding *when* to stamp 'unknown' (cloneDir resolution, the
// shaOf() try/catch) is wrong, it can still silently mis-stamp a manifest that self-update.mjs will
// now — correctly — treat as needing a rebuild that never actually happens, or vice versa. A THIRD
// site duplicates the identical `foo || 'unknown'` sentinel pattern: scripts/build-bundle.mjs:171
// (`priorSha[name.toLowerCase()] || 'unknown'`) — noted here, not skeletoned, since it inherits
// brain-stamp.mjs's manifest as its input rather than deciding freshness itself.
//
// PREREQUISITE (why this is a skeleton): every function below is inline top-level script logic in
// brain-stamp.mjs — nothing is exported, and running the file for real shells out to git and writes
// data/manifest.json + rewrites primer/ruvnet-primer.md in place. Five small, pure extractions make
// the highest-value logic testable with no behavior change to the CLI (same additive pattern used
// throughout this suite):
//
//   export function shaOf(dir) {
//     try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim(); }
//     catch { return null; }
//   }
//   export function remoteSha(slug, org = 'ruvnet') {
//     try { return execFileSync('git', ['ls-remote', `https://github.com/${org}/${slug}`, 'HEAD'])
//       .toString().split(/\s/)[0] || null; }
//     catch { return null; }
//   }
//   export function resolveCloneDir(root, clones, name) {
//     return clones[name] || path.join(root, 'clones', name);
//   }
//   export function buildRepoEntry({ name, tier, stars, isBuilt, localSha }) {
//     return {
//       name, tier, stars,
//       builtFromSha: isBuilt ? (localSha || 'unknown') : null,
//       latestRemoteSha: null,
//       status: isBuilt ? 'built' : 'pending',
//     };
//   }
//   export function stampPrimerHeader(primerText, brainVersion, builtCount, totalCount, dateIso) {
//     const stamp = `\`Brain version: ${brainVersion} · Built: ${dateIso} · Covers: ${builtCount}/${totalCount} repos built @ pinned SHAs (see data/manifest.json)\``;
//     return primerText.replace(/`Brain version:[^`]*`/, stamp);
//   }
//
// Deliberately NOT skeletoned here (documented, not silently dropped — same triage carried forward
// from pass 6): ingest-repo.mjs (pure clone/build subprocess orchestrator, real git+network side
// effects — best suited to a forge-mcp-server.test.mjs-style subprocess integration test, not a unit
// skeleton), prove.mjs (its repoOk/relOk/pass predicate logic is pure and testable in principle, but
// it's 100% top-level script code with an immediate top-level `await searchAll(...)` against the real
// embedding models — same "requires live infra" bucket as behavioral-l1-l4.mjs/brain-grade-
// groundtruth.mjs, confirmed unchanged since pass 6 via `git log` on all four files: last touched
// 2026-07-07, none refactored to export pure logic since).
import { describe, it, expect } from 'vitest';

describe.todo('brain-stamp.mjs — buildRepoEntry({ name, tier, stars, isBuilt, localSha }) (requires export, see file header)', () => {
  it.todo('stamps builtFromSha: "unknown" (never throws, never leaves it undefined) when isBuilt is true but localSha is null — the exact sentinel self-update.mjs\'s isBehind() now depends on treating as "needs rebuild"');
  it.todo('stamps builtFromSha: null (NOT the string "unknown") when isBuilt is false — null and "unknown" are not interchangeable downstream: self-update.mjs only special-cases the literal string "unknown", so a pending repo wrongly stamped "unknown" would be silently treated as a stale BUILT repo instead of correctly-pending');
  it.todo('stamps the real 40-char SHA string when isBuilt is true and localSha resolved successfully — the happy path');
  it.todo('sets status: "built" whenever isBuilt is true, independent of whether localSha resolved — a built-but-unknown-SHA repo must still read as "built", never silently demoted to "pending" just because the SHA lookup failed');
  it.todo('always sets latestRemoteSha: null on the initial stamp regardless of isBuilt/localSha — only --check-remote (a separate, network-gated path in self-update.mjs) is allowed to fill this field');
});

describe.todo('brain-stamp.mjs — shaOf(dir) (requires export, see file header)', () => {
  it.todo('returns the trimmed HEAD SHA for a real git repo directory');
  it.todo('returns null, not a thrown error, when the directory has no .git — the caller relies on this to fall through to the "unknown" sentinel; a bare throw here would crash the entire stamp run after the first repo without a local clone');
  it.todo('returns null (not throw) when the git binary itself is unavailable (simulated ENOENT) — same "must not crash the batch of ~20+ repos" guarantee');
});

describe.todo('brain-stamp.mjs — remoteSha(slug, org) (requires export, see file header) — locks in the file\'s own "no shell" safety claim', () => {
  it.todo('is called via execFileSync (no shell) so a slug containing shell metacharacters — "foo; touch /tmp/pwned", "foo`touch /tmp/pwned`", "foo && touch /tmp/pwned" — is passed as one literal URL path segment and never spawns a subshell (regression test for the inline comment "no shell: slug is placed in a URL arg, never interpreted by a shell")');
  it.todo('returns null, not a thrown error, for a nonexistent repo slug (git ls-remote exits non-zero for a 404)');
  it.todo('parses only the first whitespace-delimited token (the SHA) from "git ls-remote" output, discarding the trailing ref name (e.g. "HEAD")');
});

describe.todo('brain-stamp.mjs — resolveCloneDir(root, clones, name) (requires export, see file header)', () => {
  it.todo('prefers the RUVNET_KNOWN_CLONES override path when the repo name has an explicit entry');
  it.todo('falls back to "<root>/clones/<name>" when no override exists for that name — this is the exact fallback the file\'s own comment says was ONCE MISSING ("the env override is the exception, not the only source... made unknown-SHA repos permanently invisible to the freshness loop")');
});

describe.todo('brain-stamp.mjs — stampPrimerHeader(primerText, brainVersion, builtCount, totalCount, dateIso) (requires export, see file header)', () => {
  it.todo('replaces an existing backtick-delimited "Brain version: ..." line with the new stamp, leaving every other line of the primer byte-for-byte untouched');
  it.todo('is a SILENT no-op — returns the input completely unchanged — when the primer text has no existing stamp line to match, because String.replace() with zero matches just returns the original string; brain-stamp.mjs writes that unchanged output straight back to disk with no warning that the stamp never actually landed (same silent-failure class as the build-primer.mjs countRefs gap found in pass 7, tests/unit/countrefs-primer-l2-drift.test.mjs)');
});

describe.todo('brain-stamp.mjs — manifest coverage math (built.length / catalogued / pending)', () => {
  it.todo('computes pending as exactly (catalogued - built.length), always, even when orgTotalApprox (a hardcoded 248) and catalogued (a live count from data/registry.tiers.json) have drifted apart — flags that these are two independently-maintained "total repo count" numbers with no assertion tying them together');
});
