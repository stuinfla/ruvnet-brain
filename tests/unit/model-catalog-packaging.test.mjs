// tests/unit/model-catalog-packaging.test.mjs — issue #86, both halves of it.
//
// #86 was a RELEASE-BOUNDARY bug, not a logic bug: `data/model-catalog.json` was read by
// scripts/model-catalog.mjs and staged by beginConsoleRuntimeTransaction(), but was absent from the
// npm `files` allow-list, so the published package simply did not contain it. Everything passed in a
// developer checkout. The console then reported the user's OpenAI/Google keys as absent while its own
// native detector saw them.
//
// TWO GUARDS, because a packaging fix alone leaves the lie one regression away:
//
//   1. THE MANIFEST GUARD. The required-asset set is DERIVED from bin/install.mjs's own `required`
//      table and checked against the REAL `npm pack --dry-run --json` file list. A hardcoded list
//      would only restate today's answer; this fails the moment those two independently-maintained
//      lists disagree — which is exactly the divergence that shipped #86.
//   2. THE HONESTY GUARD. With the asset genuinely unreachable, the API must publish an explicit
//      not-verified signal, and the Console must render "not checked" rather than a confident ✗.
//      An instrument that could not run has found nothing; it has not found "no key".

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CATALOG_ASSET = 'data/model-catalog.json';

/** The assets the persistent Console runtime refuses to start without, taken from whichever
 *  declaration the installer currently owns, so this test tracks the code it guards instead of
 *  restating a list of its own. It fails loudly if neither declaration can be found — an empty
 *  required-set would make the guard below vacuous, which is the one outcome that must not be quiet. */
async function requiredConsoleAssets() {
  const surfaceModule = path.join(ROOT, 'scripts', 'console-runtime-identity.mjs');
  if (fs.existsSync(surfaceModule)) {
    const { CONSOLE_RUNTIME_SURFACE } = await import(pathToFileURL(surfaceModule).href);
    if (Array.isArray(CONSOLE_RUNTIME_SURFACE) && CONSOLE_RUNTIME_SURFACE.length) return CONSOLE_RUNTIME_SURFACE;
  }
  const source = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
  const block = source.match(/const required = \[(.*?)\n {2}\];/s);
  expect(block, 'the installer no longer declares its required Console assets anywhere this test can read').toBeTruthy();
  const assets = [...block[1].matchAll(/\['([^']+)',/g)].map((m) => m[1]);
  expect(assets.length).toBeGreaterThan(3);
  return assets;
}

/** The REAL published file list, from npm itself — never a restatement of package.json#files. */
function packedFiles() {
  // On Windows npm is `npm.cmd`; execFileSync spawns without a shell, so a bare 'npm' is
  // ENOENT there. Third instance of this exact class on this branch (ruflo.cmd was the other
  // two), which is why the name is resolved rather than assumed.
  const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const report = JSON.parse(execFileSync(NPM, ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }));
  // npm reports paths with the HOST separator, so on Windows every entry comes back as
  // `data\\model-catalog.json` and every comparison against the declared `data/model-catalog.json`
  // fails — a green-on-POSIX, red-on-Windows test that says nothing about packaging. The manifest
  // is defined in forward slashes because that is what npm publishes, so normalise to that.
  return report[0].files.map((entry) => entry.path.split(path.sep).join('/'));
}

describe('issue #86 — the model catalog must actually ship', () => {
  it('publishes every asset the Console runtime declares it requires', async () => {
    const packed = new Set(packedFiles());
    const missing = (await requiredConsoleAssets()).filter((asset) => {
      if (asset === 'package.json') return false; // npm always includes it, never listed in `files`
      return !packed.has(asset) && ![...packed].some((file) => file.startsWith(`${asset}/`));
    });
    expect(missing, `the published package omits Console-required asset(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('publishes a model catalog that parses with real providers', () => {
    expect(packedFiles()).toContain(CATALOG_ASSET);
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, CATALOG_ASSET), 'utf8'));
    expect(Object.keys(catalog.providers || {}).length).toBeGreaterThan(0);
  });
}, 120_000);

describe('issue #86 — an unreachable catalog is reported as not checked, never as "no key"', () => {
  it('the API publishes keysVerified:false so no consumer can present keys as a measurement', async () => {
    const { gatherRouterEngine } = await import('../../scripts/onboarding-console.mjs');
    const before = process.env.RUVNET_MODEL_CATALOG;
    try {
      process.env.RUVNET_MODEL_CATALOG = path.join(ROOT, 'data', 'model-catalog.json');
      expect(gatherRouterEngine().providerCatalog).toMatchObject({ status: 'ok', keysVerified: true });

      process.env.RUVNET_MODEL_CATALOG = '/definitely/not/packaged/model-catalog.json';
      expect(gatherRouterEngine().providerCatalog).toMatchObject({ status: 'degraded', keysVerified: false });
    } finally {
      if (before === undefined) delete process.env.RUVNET_MODEL_CATALOG;
      else process.env.RUVNET_MODEL_CATALOG = before;
    }
  });

  it('the Console renders a third not-checked state instead of a confident absence', () => {
    const source = fs.readFileSync(path.join(ROOT, 'console', 'app.js'), 'utf8');
    // The chip decision consults catalog health, and the "no key found" claim is unreachable
    // without it: providerKeyChip returns the not-checked branch before it ever reads `keys`.
    expect(source).toMatch(/function providerKeyChip\(id, keys, keysVerified, names\)/);
    expect(source).toMatch(/if \(!keysVerified\) \{[\s\S]*?plan-key unknown[\s\S]*?\}\s*const found = !!keys\[id\];/);
    expect(source).toMatch(/const keysVerified = !catalogHealth\s*\|\|/);
    expect(source).toMatch(/catalogHealth\.keysVerified !== false && catalogHealth\.status !== 'degraded'/);
    expect(source).toContain('providerKeyChip(id, keys, keysVerified, KEY_NAME)');
    // The old shape — a two-state chip computed straight off `keys` inside renderProviders — is gone.
    expect(source).not.toMatch(/\.\.\.others\.map\(\(id\) => \{\s*\n\s*const ok = !!keys\[id\];/);
    expect(fs.readFileSync(path.join(ROOT, 'console', 'style.css'), 'utf8')).toContain('.plan-key.unknown');
  });
});
