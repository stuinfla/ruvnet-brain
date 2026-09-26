// tests/unit/forge-currency-helpers.test.mjs — kb/forge-currency.mjs (the "what has rUv shipped
// that the brain doesn't index yet" radar) has zero tests of any kind. isRuvnetOrigin/pad/sh are
// pure string logic with no I/O — the cheapest possible tests in this file, once exported.
//
// The CLI dispatch is guarded and brainKnownSet is exported for the canonical-root regression.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainKnownSet } from '../../kb/forge-currency.mjs';

let dir;
afterEach(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = null; } });
const sandbox = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-currency-')));

describe('forge-currency.mjs — brainKnownSet() sources from the canonical store root', () => {
  it('includes a store present at the given root', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'totally-live-store.rvf'), '');
    expect(brainKnownSet(root).has('totally-live-store')).toBe(true);
  });

  it('strips the .big.rvf suffix and lowercases', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'Some-Repo.big.rvf'), '');
    expect(brainKnownSet(root).has('some-repo')).toBe(true);
  });

  it('does not throw for a root that has not materialized', () => {
    expect(() => brainKnownSet(path.join(os.tmpdir(), `never-${Date.now()}`))).not.toThrow();
  });

  // PR #222 fixed the .rvf-listing half of this function to source from `root` instead of this
  // script's own checkout directory (kb/), but left the name-alias half (SOURCE.json) reading the
  // checkout unconditionally — the exact "clone freshness is not artifact freshness" defect class
  // ADR-069 already named for scripts/brain-stamp.mjs, now a second instance in this sibling file.
  it('reads SOURCE.json from the given root, not from this checkout\'s own kb/SOURCE.json', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'SOURCE.json'), JSON.stringify({
      stores: { 'totally-different-repo': { sourceRepo: 'https://github.com/example/totally-different-repo', kbName: 'totally-different-repo' } },
    }));
    const known = brainKnownSet(root);
    expect(known.has('totally-different-repo')).toBe(true);
    // This checkout's real kb/SOURCE.json names real stores (e.g. "metaharness") that have nothing
    // to do with `root` — if the function ever falls back to reading THIS repo's own kb/SOURCE.json
    // instead of root's, that name leaks in even though `root` never mentioned it.
    expect(known.has('metaharness')).toBe(false);
  });

  it('does not merge in this checkout\'s own kb/SOURCE.json when root has no SOURCE.json at all', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'only-store.rvf'), '');
    const known = brainKnownSet(root);
    expect(known.has('only-store')).toBe(true);
    expect(known.has('metaharness')).toBe(false);
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
