/**
 * pack-completeness.test.mjs — what bin/install.mjs IMPORTS must be what `npm pack` SHIPS.
 *
 * RED, verbatim (origin/main b73176a, `npm pack --dry-run --json`):
 *
 *     files: 21
 *     MISSING   scripts/install-scope.mjs
 *     MISSING   scripts/selfcheck.mjs
 *     MISSING   scripts/upgrade-notice.mjs
 *
 * Every dynamic import bin/install.mjs makes was absent from package.json `files[]`. The installer's
 * three post-install blocks therefore could not run on a real npm install — including
 * scripts/selfcheck.mjs, which had merged the previous day as "the post-install self-check (D8) — the
 * installer can finally FAIL". It could not fail; it was not there. And a comment inside install.mjs
 * asserted the opposite in plain words ("shipped in package.json `files`"), written from intent and
 * never checked against `npm pack` — which is the whole reason this file derives the list from the
 * source instead of restating it.
 *
 * The list is DERIVED, never hardcoded: a fourth dynamic import added tomorrow is covered the moment
 * it is written, without anyone remembering this file exists.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { packedPaths as manifestPaths, parseNpmPack } from '../helpers/npm-pack-json.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

/** Every `await import(new URL('../<path>', import.meta.url))` bin/install.mjs performs. */
function dynamicImportsOfInstaller() {
  const src = fs.readFileSync(INSTALLER, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/import\(\s*new URL\(\s*['"]\.\.\/([^'"]+)['"]/g)) found.add(m[1]);
  return [...found].sort();
}

/** The real tarball manifest — npm's own answer, not a re-implementation of its glob rules. */
function packedPaths() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  return manifestPaths(parseNpmPack(out, { expectName: 'ruvnet-brain' }));
}

describe('npm pack ships every module bin/install.mjs dynamically imports', () => {
  it('ships the Codex bootstrap assets the npm installer copies directly', () => {
    const packed = packedPaths();
    for (const required of [
      'bin/install.mjs',
      'plugin/mcp/server.mjs',
      'plugin/scripts/codex-hook-wrapper.mjs',
      'scripts/subscription-hosts.mjs',
      'scripts/dual-host-deliberation.mjs',
      'scripts/dual-host-suggest.mjs',
    ]) {
      expect(packed.has(required), `npm pack is missing Codex bootstrap asset: ${required}`).toBe(true);
    }
  }, 120_000);

  it('the installer actually has dynamic imports to check (the list is not vacuously empty)', () => {
    expect(dynamicImportsOfInstaller().length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('each one is present in the tarball', () => {
    const packed = packedPaths();
    const missing = dynamicImportsOfInstaller().filter((p) => !packed.has(p));
    expect(missing, `bin/install.mjs imports these, npm pack does not ship them: ${missing.join(', ')}`)
      .toEqual([]);
  }, 120_000);

  it("a shipped module's own local imports ship too (the defect one hop down)", () => {
    const packed = packedPaths();
    const missing = [];
    for (const rel of dynamicImportsOfInstaller()) {
      const file = path.join(ROOT, rel);
      if (!fs.existsSync(file)) continue;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
        const dep = path.relative(ROOT, path.resolve(path.dirname(file), m[1]));
        if (!packed.has(dep)) missing.push(`${rel} → ${dep}`);
      }
    }
    expect(missing, `shipped, but their imports are not: ${missing.join(', ')}`).toEqual([]);
  }, 120_000);
});
