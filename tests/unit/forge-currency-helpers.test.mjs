// tests/unit/forge-currency-helpers.test.mjs — kb/forge-currency.mjs (the "what has rUv shipped
// that the brain doesn't index yet" radar) has zero tests of any kind. isRuvnetOrigin/pad/sh are
// pure string logic with no I/O — the cheapest possible tests in this file, once exported.
//
// PREREQUISITE for isRuvnetOrigin/pad/sh (still open — see the two `describe.todo` blocks below):
// they remain module-private. Two additive, no-behavior-change edits unblock them:
//   1. `export function isRuvnetOrigin(url) {...}`, `export const sh = (s) => ...`,
//      `export function pad(s, n) {...}` (currently unexported).
//   2. Guard the dispatch with `if (import.meta.url === \`file://${process.argv[1]}\`) { ... }`
//      (the same in-repo pattern verify-bundle.mjs already uses, line 39 there).
// Dream Cycle 2026-08-31 applied #2 repo-wide (the module now guards its CLI dispatch, so importing
// it no longer fires a real gh/git/fetch call) and exported `brainKnownSet` only, the one function
// this night's candidate needed — see the describe block below. isRuvnetOrigin/pad/sh remain
// unexported; flag them to Stuart as a still-open, separate follow-up before exporting those too.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainKnownSet } from '../../kb/forge-currency.mjs';

let dir;
afterEach(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = null; } });
const sandbox = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-currency-')));

describe('forge-currency.mjs — brainKnownSet() sources from the canonical store root', () => {
  it('includes a store present at the given root even when kb/forge-currency.mjs has no local .rvf of that name', () => {
    // This is the exact scenario the bug produced: a store genuinely present in the live corpus
    // (at storeRoot()) was reported "not indexed" because the old code only ever looked next to
    // the script itself (kb/forge-currency.mjs's own directory), never at the canonical root.
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'totally-live-store.rvf'), '');
    const known = brainKnownSet(root);
    expect(known.has('totally-live-store')).toBe(true);
  });

  it('strips the .big.rvf suffix and lowercases, matching the pre-fix behavior', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'Some-Repo.big.rvf'), '');
    const known = brainKnownSet(root);
    expect(known.has('some-repo')).toBe(true);
  });

  it('never throws when the root does not exist (never-materialized root, e.g. this container)', () => {
    const root = path.join(os.tmpdir(), 'forge-currency-never-materialized-' + Date.now());
    expect(() => brainKnownSet(root)).not.toThrow();
  });
});

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
