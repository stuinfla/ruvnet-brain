// tests/unit/installer-sibling-imports-packaged.test.mjs
//
// EVERY sibling module bin/install.mjs imports must actually be IN THE PUBLISHED TARBALL.
//
// This gate exists because the same defect shipped four times, silently, and was only ever found
// by accident:
//
//   - scripts/install-scope.mjs   — install.mjs's OWN comment already said it "is not in files[]
//                                   — so on a real npm install it silently never runs"
//   - scripts/selfcheck.mjs       — found 2026-07-27 while fixing something else. install.mjs:1135
//                                   asserts "selfcheck.mjs is shipped in package.json files".
//                                   It was not. Measured on the real packed artifact:
//                                   ERR_MODULE_NOT_FOUND. So D8 — the entire post-install
//                                   self-check feature — had NEVER RUN for a single npm user.
//                                   It worked only from a git checkout, which is the one place
//                                   nobody needed it.
//   - scripts/hook-registry.mjs   — imported by selfcheck.mjs, same gap
//   - scripts/upgrade-notice.mjs  — imported at two sites, same gap
//
// Every one of these is wrapped in a catch that degrades quietly, which is exactly why nobody
// noticed: the feature does not crash, it just is not there. A capability that silently does not
// exist on real installs is worse than one that was never built, because the team believes it is
// running and stops looking.
//
// The list is DERIVED from install.mjs by reading its actual import sites — never hand-maintained.
// A hand-written list would drift the moment someone adds an import, which is the failure mode
// this gate is supposed to end.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packedPaths, parseNpmPack } from '../helpers/npm-pack-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Matches: await import(new URL('../scripts/foo.mjs', import.meta.url).href)
const SIBLING_IMPORT = /new URL\(\s*['"]\.\.\/([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

function siblingImportsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...new Set([...src.matchAll(SIBLING_IMPORT)].map((m) => m[1]))].sort();
}

// `npm pack --dry-run --json` reports exactly what WOULD be published, honoring files[], .npmignore
// and npm's own always-include/always-exclude rules — without writing a tarball. That last part
// matters: files[] alone is not the answer, because npm overrides it in both directions.
function packedFiles() {
  // Spawning npm on Windows took three tries, so the reasoning is recorded rather than the answer:
  //   'npm'      -> spawnSync npm ENOENT     (execFileSync does no PATHEXT resolution; npm is a shim)
  //   'npm.cmd'  -> spawnSync npm.cmd EINVAL (node refuses to spawn .cmd/.bat without a shell — the
  //                                           CVE-2024-27980 argument-injection mitigation)
  //   'npm.cmd' + shell:true -> works
  // shell:true is safe HERE specifically because every argument is a fixed literal — nothing from
  // the repo, the environment, or a test fixture reaches this command line. Do not add a dynamic
  // argument to this call without removing the shell.
  const isWin = process.platform === 'win32';
  const out = execFileSync(isWin ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120000,
    shell: isWin,
  });
  // Normalize separators: on Windows npm reports `scripts\selfcheck.mjs` while the import
  // specifiers this gate derives are always POSIX-style `scripts/selfcheck.mjs`. Comparing them
  // raw made every path "missing" on windows-unit — a gate that fails for a reason unrelated to
  // the thing it guards teaches people to ignore it, which is how the defect it exists to catch
  // gets waved through.
  return packedPaths(parseNpmPack(out, { expectName: 'ruvnet-brain' }));
}

describe('the published tarball contains every module the installer imports', () => {
  const imports = siblingImportsOf('bin/install.mjs');

  it('finds the import sites at all (the gate must not pass vacuously)', () => {
    // If a refactor changes the import STYLE, this gate would silently guard nothing and report
    // green. An empty derived list is therefore itself a failure, not a pass.
    expect(imports.length, 'no sibling imports found in bin/install.mjs — has the import style changed? this gate is now blind').toBeGreaterThan(0);
  });

  it('every sibling module install.mjs imports is present on disk', () => {
    const absent = imports.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(absent, `install.mjs imports files that do not exist: ${absent.join(', ')}`).toEqual([]);
  });

  it('every sibling module install.mjs imports is in the PUBLISHED tarball', () => {
    const packed = packedFiles();
    const missing = imports.filter((rel) => !packed.has(rel));
    expect(
      missing,
      `bin/install.mjs imports these at runtime but npm would NOT publish them, so on a real ` +
        `install each import throws into its catch and the feature silently never runs: ${missing.join(', ')}. ` +
        `Add them to package.json "files".`,
    ).toEqual([]);
  }, 120000);

  it('modules those modules import are packaged too — one level deeper', () => {
    // selfcheck.mjs imports hook-registry.mjs. Shipping the first without the second reproduces
    // the same silent failure one layer down, which is exactly how hook-registry.mjs was missed.
    const packed = packedFiles();
    const second = new Set();
    for (const rel of imports) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const src = fs.readFileSync(abs, 'utf8');
      for (const m of src.matchAll(/from\s+['"]\.\/([^'"]+\.mjs)['"]/g)) {
        second.add(path.posix.join(path.dirname(rel), m[1]));
      }
    }
    const missing = [...second].filter((rel) => !packed.has(rel));
    expect(
      missing,
      `these are imported by modules the installer loads, but would not be published: ${missing.join(', ')}`,
    ).toEqual([]);
  }, 120000);
});
