// tests/unit/install-release-fallback.test.mjs — the installer has NO built-in fallback release.
//
// It used to carry RELEASE_VERSION ('v2.9.0'): first as a silent fallback for a failed latest-release
// lookup, then as what a bare --pin installed. That bundle predates ReleaseCoverage, so every install it
// produced failed validation two steps later ('COVERAGE.json is missing') with the real cause gone from
// the screen. 4.5: a failed lookup stops with its cause, and --pin <tag> names the release it installs,
// exactly like --version <tag>; a bare --pin refuses. No network is touched here.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');

process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { namedReleaseFromArgs } = await import('../../bin/install.mjs');

describe('install.mjs has no built-in fallback release', () => {
  it('carries no hard-coded bundle tag (the old v2.9.0 predates COVERAGE.json and could not install)', () => {
    expect(SRC).not.toMatch(/^const RELEASE_VERSION\b/m);
    expect(SRC).not.toMatch(/fallbackUrl\(RELEASE_VERSION\)/);
  });

  it('--pin names its release, exactly like --version; a bare --pin refuses instead of falling back', () => {
    expect(namedReleaseFromArgs(['--pin', 'v9.9.1'])).toEqual({ tag: 'v9.9.1', source: 'pinned' });
    expect(namedReleaseFromArgs(['--version', 'v9.9.0'])).toEqual({ tag: 'v9.9.0', source: 'forced' });
    expect(namedReleaseFromArgs([])).toBeNull();
    const bare = namedReleaseFromArgs(['--pin']);
    expect(bare.error).toBe('--pin needs the release to install, e.g.  --pin vX.Y.Z');
    expect(bare.hint).toMatch(/no longer falls back to a built-in release/);
    expect(namedReleaseFromArgs(['--pin', '--yes']).error).toMatch(/--pin needs/);
    expect(namedReleaseFromArgs(['--pin', 'v9.9.1', '--version', 'v9.9.0']).error).toMatch(/disagree/);
  });

  it('is NOT a silent fallback for a failed lookup: that bundle predates COVERAGE.json and failed two steps later', () => {
    const resolve = SRC.slice(SRC.indexOf('async function resolveRelease()'), SRC.indexOf('export function releaseLookupFailure'));
    const failurePath = resolve.slice(resolve.indexOf('} catch (e) {')).split('\n')
      .filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(failurePath).not.toMatch(/RELEASE_VERSION|safe and complete/);
    expect(failurePath).toMatch(/throw /);
  });

  it('--help no longer promises the fallback: it says a failed lookup stops and names --version', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/RuvNet Brain installer/);
    expect(r.stdout).not.toMatch(/falls? back to a known-good/i);
    expect(r.stdout).toMatch(/STOPS with the reason and downloads\s+nothing/);
    expect(r.stdout).toMatch(/--version <tag>/);
  });
});

process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { releaseLookupFailure } = await import('../../bin/install.mjs');

describe('releaseLookupFailure — the failed lookup says what happened and what to do', () => {
  it('keeps the HTTP status and the reset time, and explains the anonymous rate limit', () => {
    // The reset time is fixture input: derive it, so the assertion is "the input's reset time survives".
    const resetAt = new Date(Date.UTC(2030, 0, 1)).toISOString();
    const failure = releaseLookupFailure(new Error(`GitHub API returned HTTP 403 (anonymous rate limit used up; it resets at ${resetAt})`));
    expect(failure.message).toMatch(/HTTP 403/);
    expect(failure.message).toContain(resetAt);
    expect(failure.hint).toMatch(/anonymous release checks per hour/);
    expect(failure.hint).toMatch(/--version <tag>/);
  });

  it('keeps a network error verbatim and gives a connection hint, never a rate-limit one', () => {
    const failure = releaseLookupFailure(new Error('getaddrinfo ENOTFOUND api.github.com'));
    expect(failure.message).toMatch(/ENOTFOUND api\.github\.com/);
    expect(failure.hint).toMatch(/Check your connection/);
    expect(failure.hint).not.toMatch(/per hour/);
  });
});
