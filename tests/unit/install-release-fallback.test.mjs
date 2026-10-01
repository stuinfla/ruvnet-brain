// tests/unit/install-release-fallback.test.mjs — RELEASE_VERSION is the installer's safety net: the
// bundle Release tag it falls back to when GitHub is unreachable, rate-limited, or has no releases,
// and the tag `--pin` uses. It used to be DERIVED from this package's own version, which meant the
// safety net asked for a Release that has never existed:
//
//     installer 1.14.0-dev  ->  releases/download/v1.14.0-dev/ruvnet-brain.zip  ->  HTTP 404
//     newest bundle Release ->  releases/download/v0.5.0-dev/ruvnet-brain.zip   ->  HTTP 200
//
// The installer and the brain bundle are independent version streams (README says so explicitly).
// These tests pin the invariant without touching the network: the constant must be a literal bundle
// tag, and it must NOT track package.json. A network probe belongs in a release check, not here —
// unit tests that reach the internet fail on a plane.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const releaseVersion = () => {
  const m = /^const RELEASE_VERSION = '([^']+)'/m.exec(SRC);
  return m ? m[1] : null;
};

describe('install.mjs RELEASE_VERSION — the offline safety net', () => {
  it('is a hardcoded literal, not computed from package.json', () => {
    expect(releaseVersion()).not.toBeNull();
    // The old, broken shape read the installer's own version at runtime.
    expect(SRC).not.toMatch(/RELEASE_VERSION[\s\S]{0,200}?package\.json/);
  });

  it('looks like a v-prefixed semver Release tag', () => {
    expect(releaseVersion()).toMatch(/^v\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i);
  });

  it('does NOT equal this package\'s own version — they are separate version streams', () => {
    // If these ever coincide by accident the test still holds the intent: the moment the installer
    // is bumped, a derived tag would drift to a Release that does not exist.
    expect(releaseVersion()).not.toBe(`v${PKG_VERSION}`);
  });

  it('is used for --pin, via fallbackUrl()', () => {
    expect(SRC).toMatch(/fallbackUrl\(RELEASE_VERSION\)/);
    expect(SRC).toMatch(/const fallbackUrl = \(tag\) =>/);
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
