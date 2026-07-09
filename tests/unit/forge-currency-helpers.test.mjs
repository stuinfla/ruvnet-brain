// tests/unit/forge-currency-helpers.test.mjs — kb/forge-currency.mjs (the "what has rUv shipped
// that the brain doesn't index yet" radar) has zero tests of any kind. isRuvnetOrigin/pad/sh are
// pure string logic with no I/O — the cheapest possible tests in this file, once exported.
//
// PREREQUISITE: isRuvnetOrigin (line 139), pad (line 162), and sh (line 161, currently a `const sh =
// (s) => ...` arrow, not a `function`) are all module-private. The file runs its report/subcommand
// dispatch unconditionally at module top level (no IIFE guard), so importing it today would fire
// real `gh`/`git`/`fetch` calls as an import side effect — same pattern as check-indexation.mjs and
// self-update.mjs's own gap skeletons. Two additive, no-behavior-change edits unblock this file:
//   1. `export function isRuvnetOrigin(url) {...}`, `export const sh = (s) => ...`,
//      `export function pad(s, n) {...}` (currently unexported).
//   2. Guard the dispatch with `if (import.meta.url === \`file://${process.argv[1]}\`) { ... }`
//      (the same in-repo pattern verify-bundle.mjs already uses, line 39 there).
// Flag both to Stuart before applying, per this repo's established pattern for these gap skeletons.
import { describe, it, expect } from 'vitest';

describe.todo('forge-currency.mjs — isRuvnetOrigin() (requires export, see file header)', () => {
  it.todo('true for git@github.com:ruvnet/agentic-flow.git (SSH form)');
  it.todo('true for https://github.com/ruvnet/daa (HTTPS form, no .git suffix)');
  it.todo('false for a fork under a different owner (github.com/someone-else/ruv-fann)');
  it.todo('false for an empty/undefined origin (repo has no remote configured)');
});

describe.todo('forge-currency.mjs — pad() (requires export)', () => {
  it.todo('right-pads a short string to width n with spaces');
  it.todo('truncates (not pads) a string already >= width n — never widens the column');
});

describe.todo('forge-currency.mjs — sh() (requires export)', () => {
  it.todo('returns the first 9 chars of a real SHA');
  it.todo('returns "(none)" for a falsy/empty SHA (unresolvable remote, detached state)');
});
