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

  it('is used for --pin and for the GitHub-unreachable fallback, via fallbackUrl()', () => {
    expect(SRC).toMatch(/fallbackUrl\(RELEASE_VERSION\)/);
    expect(SRC).toMatch(/const fallbackUrl = \(tag\) =>/);
  });
});
