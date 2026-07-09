// tests/unit/sync-version-drift.test.mjs — scripts/sync-version.mjs (122 lines, SEC-0010 #2 /
// ADR-0009 decision 1: "the ONE hand-edited version number, everything else follows") has zero tests
// and was never mentioned in any prior coverage-gap audit. It DOES run in CI (`--check` mode, per
// .github/workflows/ci.yml — the CI-integration tier from memory `test-coverage-gaps-2026-07-07`),
// but "it runs" only proves the CURRENT repo passes its own check today — it says nothing about
// whether the check's regex logic is actually correct on inputs it hasn't yet seen (a version with a
// double-digit patch, a README badge with no `--` escaping, a stray literal a legitimate exemption
// should have caught). No test has ever exercised the failure modes.
//
// PREREQUISITE (why this is a skeleton): sync-version.mjs is 100% top-level script logic — nothing is
// exported, and running it for real writes files / reads the live README.md. Two small, pure
// extractions make the highest-value logic testable with no behavior change to the CLI (same additive
// pattern used throughout this suite):
//
//   export function readBadgeVersion(readmeText) {
//     const m = readmeText.match(/version_([0-9][^-\s)]*(?:--[^-\s)]*)*)-updated_/);
//     return m ? m[1].replace(/--/g, '-') : null;
//   }
//   export function writeBadgeVersion(readmeText, version) {
//     const vBadge = version.replace(/-/g, '--');
//     return readmeText
//       .replace(/(version_)[0-9][^-\s)]*(?:--[^-\s)]*)*(-updated_)/, `$1${vBadge}$2`)
//       .replace(/(RuvNet Brain version )\S+( — updated )/, `$1${version}$2`);
//   }
//   export function isStrayVersionLiteral(literal, currentVersion) {
//     const lit = literal.replace(/^v/, '');
//     return lit === currentVersion || lit.endsWith('-dev');
//   }
//
// The full-tree `walk()` (lines 88-96) and the EXEMPT/`sync-version-ignore` scanning loop (lines
// 98-109) are left as an integration-style test (spawn `node scripts/sync-version.mjs --check` in a
// tmp copy of the repo) rather than unit-extracted, since their value is in walking REAL files.
import { describe, it, expect } from 'vitest';

describe.todo('sync-version.mjs — readBadgeVersion(readmeText) / writeBadgeVersion(readmeText, version) (requires export, see file header)', () => {
  it.todo('reads "0.5.0-dev" out of a badge URL token "version_0.5.0--dev-updated_2026--07--08" (hyphens shields.io-escaped as `--`)');
  it.todo('returns null when the README has no version_..._updated_ badge token at all — must not throw');
  it.todo('writes a new version into the badge URL token AND the human-readable alt text ("RuvNet Brain version X — updated Y"), re-escaping hyphens as `--` in the URL token only');
  it.todo('leaves the "updated_<timestamp>" portion of the badge completely untouched — only the version segment changes (the nightly publisher owns the timestamp, per the file\'s own comment)');
  it.todo('round-trips: writeBadgeVersion(readBadgeVersion(text) already matching V, V) produces byte-identical text (idempotent on a already-synced README)');
});

describe.todo('sync-version.mjs — isStrayVersionLiteral(literal, currentVersion) (requires export, see file header)', () => {
  it.todo('flags a literal exactly equal to the current version (e.g. "0.5.0-dev" when V is "0.5.0-dev")');
  it.todo('flags ANY "-dev" prerelease literal even when it does not match the current version (e.g. "0.4.0-dev" while V is "0.5.0-dev") — catches a stale hardcoded dev tag left behind after a bump');
  it.todo('does NOT flag an unrelated stable version literal that happens to look like semver but isn\'t the current version and isn\'t a "-dev" tag (e.g. "1.2.3" referenced as a changelog entry for an OLD release)');
  it.todo('strips a leading "v" before comparing, so "v0.5.0-dev" and "0.5.0-dev" are treated identically');
});

describe.todo('sync-version.mjs — targets[].get/set for package.json / kb/package.json / data/manifest.json (already-inline pure functions, exported once named)', () => {
  it.todo('get() reads the current "version" field via JSON.parse for the two package.json targets');
  it.todo('get() reads the "brainVersion" field via regex (not JSON.parse) for data/manifest.json — confirm the regex tolerates surrounding whitespace/formatting variance a JSON.stringify(…, null, 2) run would produce');
  it.todo('set() replaces only the version-bearing field, leaving every other field/formatting in the file byte-for-byte untouched');
});
