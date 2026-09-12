// console-scope-client.test.mjs — the "what's in the brain" page must let a person find a repo or
// gist three ways the owner named on 2026-09-12: newest first, A–Z, and "behind first"; and the
// search box must match what a repo DOES, not only its name ("is the stuff on Federation loaded
// into Ruflo?" is a description question, not a name question).
//
// scope.js is a browser IIFE. It is loaded here in a bare vm context with the four globals it
// touches at load stubbed, and its pure helpers are read back from `window.RBScope` — the same
// functions the page calls, not a re-implementation of them.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCOPE_JS = path.join(ROOT, 'console/scope.js');
const SCOPE_HTML = fs.readFileSync(path.join(ROOT, 'console/scope.html'), 'utf8');

function loadScope() {
  const window = {};
  const ctx = {
    window,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => new Promise(() => {}), // never resolves: nothing renders, nothing is wired
    performance: { now: () => 0 },
    console,
  };
  vm.runInNewContext(fs.readFileSync(SCOPE_JS, 'utf8'), ctx, { filename: 'scope.js' });
  return window.RBScope;
}

const row = (name, over = {}) => ({ name, desc: null, bucket: 'current', ruvChangedAt: null, brainReadAt: null, ...over });

describe('scope page — search matches the name AND what the repo does', () => {
  it('exposes its pure helpers for the page and for this test', () => {
    const api = loadScope();
    expect(api, 'scope.js must publish window.RBScope').toBeTruthy();
    expect(typeof api.match).toBe('function');
    expect(typeof api.sortFor).toBe('function');
  });

  it('matches by name, by description, case-insensitively, and never on an empty query miss', () => {
    const { match } = loadScope();
    const ruflo = row('ruflo', { desc: 'The leading agent meta-harness for Claude — swarms, memory, federation' });
    expect(match(ruflo, 'ruflo')).toBe(true);
    expect(match(ruflo, 'RUFLO')).toBe(true);
    expect(match(ruflo, 'federation')).toBe(true);
    expect(match(ruflo, 'Meta-Harness')).toBe(true);
    expect(match(ruflo, 'latent mesh')).toBe(false);
    expect(match(row('LatentMesh'), 'latent')).toBe(true); // name-only rows still match by name
    expect(match(row('x', { desc: null }), 'anything')).toBe(false);
    expect(match(ruflo, '')).toBe(true); // empty query shows everything
  });
});

describe('scope page — three views: newest first, A–Z, behind first', () => {
  const rows = [
    row('alpha', { bucket: 'current', ruvChangedAt: '2026-08-01T00:00:00Z' }),
    row('beta', { bucket: 'behind', ruvChangedAt: '2026-08-20T00:00:00Z' }),
    row('gamma', { bucket: 'not-in-brain', ruvChangedAt: '2026-07-01T00:00:00Z' }),
    row('delta', { bucket: 'behind', ruvChangedAt: '2026-08-25T00:00:00Z' }),
    row('epsilon', { bucket: 'unverified', ruvChangedAt: null }),
    row('Zed', { bucket: 'current', ruvChangedAt: '2026-09-01T00:00:00Z' }),
  ];
  const names = (sorted) => sorted.map((r) => r.name);

  it('newest first: rUv\'s last change descending, unknown dates last', () => {
    const { sortFor } = loadScope();
    expect(names(rows.slice().sort(sortFor('newest')))).toEqual(['Zed', 'delta', 'beta', 'alpha', 'gamma', 'epsilon']);
  });

  it('A–Z: by name, case-insensitive', () => {
    const { sortFor } = loadScope();
    expect(names(rows.slice().sort(sortFor('az')))).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'Zed']);
  });

  it('behind first: behind → unverified → not in the brain → current, newest first inside each', () => {
    const { sortFor } = loadScope();
    expect(names(rows.slice().sort(sortFor('behind')))).toEqual(['delta', 'beta', 'epsilon', 'gamma', 'Zed', 'alpha']);
  });

  it('an unknown view falls back to newest first rather than throwing', () => {
    const { sortFor } = loadScope();
    expect(names(rows.slice().sort(sortFor('nonsense')))).toEqual(names(rows.slice().sort(sortFor('newest'))));
  });
});

describe('scope page — the markup carries the three views, the wider search, and the purpose line', () => {
  it('has three accessible view buttons, newest pressed by default', () => {
    const buttons = [...SCOPE_HTML.matchAll(/<button[^>]*class="view"[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(3);
    const view = (b) => (b.match(/data-view="([a-z]+)"/) || [])[1];
    expect(buttons.map(view)).toEqual(['newest', 'az', 'behind']);
    expect(buttons.filter((b) => /aria-pressed="true"/.test(b)).map(view)).toEqual(['newest']);
    expect(buttons.filter((b) => /aria-pressed="false"/.test(b))).toHaveLength(2);
    expect(SCOPE_HTML).toMatch(/Newest first/);
    expect(SCOPE_HTML).toMatch(/A–Z/);
    expect(SCOPE_HTML).toMatch(/Behind first/);
  });

  it('the search box says it searches by what a repo does, not only by name', () => {
    const input = SCOPE_HTML.match(/<input id="search"[^>]*>/)[0];
    expect(input).toMatch(/placeholder="search repos and gists — by name or what they do…"/);
  });

  it('states the owner\'s question in one line under the title', () => {
    expect(SCOPE_HTML).toMatch(/Is the latest thing rUv shipped in here\? Search a repo or gist below; if rUv's last change is on or before the brain's read date, it's in\./);
  });
});
