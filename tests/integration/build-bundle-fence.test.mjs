// tests/integration/build-bundle-fence.test.mjs — the private-store fence is the ONLY thing
// standing between the public release zip and shipping Stuart's private cognitum-* source
// (SEC-0010 #4). scripts/build-bundle.mjs has never had this fence tested — see
// docs adr history + memory `test-coverage-gaps-2026-07-07`.
//
// WHY SUBPROCESS, NOT IMPORT: loadPrivateStores() runs at MODULE TOP LEVEL (build-bundle.mjs line
// 73) and calls process.exit(1) on every fail-closed path. Importing the module in-process would
// kill the test runner itself. This is a repo-wide pattern (forge-guard.mjs's `main().catch()`,
// sign-bundle.mjs's unconditional `signBundle()` call, check-indexation.mjs's top-level IIFE all do
// the same thing) — none of these CLI scripts are in-process-importable; subprocess is the only
// correct harness, mirroring how tests/integration/install-smoke.mjs already tests bin/install.mjs.
//
// WHY A CLONED ROOT, NOT node_modules/tmp COPY OF THE WHOLE REPO: build-bundle.mjs computes
// ROOT = path.dirname(script's own location).."/..", so copying just
// {scripts/build-bundle.mjs, scripts/version.mjs, a scoped index-audit stub, kb/,
// data/registry.tiers.json} into a fresh tmpdir
// gives it a fully isolated ROOT — no risk of mutating the real repo's kb/ or dist/.
//
// discoverBuilt() (line 79) matches repos by FILENAME PATTERN ONLY (`<name>.rvf`) — it never opens
// the file — so placeholder empty files are enough to test discovery/exclusion; only the "fully
// assembled, no missing files" happy path would need real store contents (out of scope here).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// Imported under RUVNET_BRAIN_IMPORT_ONLY=1 so the installer main never runs on import.
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import(path.join(REPO_ROOT, 'bin/install.mjs'));

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-bundle-fence-'));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'plugin/.claude-plugin'), { recursive: true });
  // THE DEPENDENCY LIST IS DERIVED, NOT HAND-LISTED (2026-08-12).
  //
  // This copied build-bundle.mjs plus two siblings named as literals — a second copy of that file's
  // import graph. Adding ONE import to build-bundle (the derived org-repo count) broke all nine cases
  // here with `node:internal/modules/esm/resolve`, and the symptom read as "the private-store fence
  // stopped FATALing" — a packaging failure wearing a security-gate's clothes.
  //
  // Third occurrence of this exact class in one session: wireCodexHost hand-listed the MCP server's
  // deps, the mesh mutation fixture hand-listed the installer's, and this hand-listed build-bundle's.
  // All three now walk the real imports. `serverDependencies` is generic over any entry file, which
  // is why it is reused here rather than reimplemented a fourth time.
  const src = path.join(REPO_ROOT, 'scripts/build-bundle.mjs');
  fs.copyFileSync(src, path.join(tmp, 'scripts/build-bundle.mjs'));
  for (const dep of serverDependencies(src)) {
    const target = path.resolve(path.join(tmp, 'scripts'), dep.spec);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dep.from, target);
  }
  // This suite measures only the private-store fence. The production bundle builder's independent
  // RVF-index gate is covered by rvf-index-audit.test.mjs and build-bundle release tests; using
  // empty placeholder RVFs here cannot exercise the native reader. Keep the dependency present and
  // explicitly pass it so a missing import cannot prevent these fence assertions from running.
  fs.writeFileSync(path.join(tmp, 'scripts/rvf-index-audit.mjs'),
    'export async function auditRvfIndexes(paths) { return paths.map((path) => ({ path, state: "PASS" })); }\n');
  // Minimal registry: build-bundle.mjs reads this before it ever reaches the fence.
  fs.writeFileSync(path.join(tmp, 'data/registry.tiers.json'), JSON.stringify({ tiers: {} }));
  // version.mjs's single source of truth — build-bundle.mjs resolves the version tag before the fence.
  fs.writeFileSync(path.join(tmp, 'plugin/.claude-plugin/plugin.json'), JSON.stringify({ version: '0.0.0-test' }));
  // SOURCE.json is now a required identity surface: the bundle builder rewrites both fields to the
  // candidate version and must fail before publication if that source surface is absent.
  fs.writeFileSync(path.join(tmp, 'kb/SOURCE.json'), JSON.stringify({
    brainVersion: '0.0.0-previous', releaseTag: 'v0.0.0-previous',
  }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function runBuildBundle(env = {}, args = []) {
  // spawnSync (not execFileSync) — execFileSync only returns stdout on a zero exit, and the
  // ALLOW_NO_PRIVATE_FENCE warning is written to stderr on the SUCCESS path via console.warn.
  const r = spawnSync('node', ['scripts/build-bundle.mjs', ...args], {
    cwd: tmp, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function stampGenerationLedger(assets, stores) {
  const rows = {};
  for (const store of stores) {
    const file = `${store}.big.rvf`;
    const bytes = fs.readFileSync(path.join(assets, file));
    rows[store] = {
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      model: 'fixture-model',
      dimensions: 384,
      sourceCommit: 'a'.repeat(40),
      builtUtc: '2026-08-21T00:00:00.000Z',
    };
  }
  fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1,
    brainVersion: '0.0.0-test',
    releaseTag: 'v0.0.0-test',
    stores: rows,
  }));
}

describe('build-bundle.mjs — private-store fence (fail-closed)', () => {
  it('FATALs (exit 1) when PRIVATE-STORES.json is missing and no bypass is set', () => {
    const r = runBuildBundle();
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/FATAL.*private-store fence missing/i);
  });

  it('accepts an empty fence ONLY when ALLOW_NO_PRIVATE_FENCE=1 is explicit, then applies the independent RVF gate', () => {
    const r = runBuildBundle({ ALLOW_NO_PRIVATE_FENCE: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ALLOW_NO_PRIVATE_FENCE=1.*proceeding with NO fence/i);
    expect(r.stderr).toMatch(/FATAL.*zero public RVF/i);
  });

  it('FATALs (exit 1) when PRIVATE-STORES.json is present but corrupt JSON', () => {
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), '{ not valid json');
    const r = runBuildBundle();
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unreadable\/corrupt/i);
  });

  it('FATALs (exit 1) when "privateStores" is present but not an array', () => {
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: 'cognitum-seed' }));
    const r = runBuildBundle();
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no valid "privateStores" array/i);
  });

  it('excludes a named private store from discovery and never surfaces it in the manifest/README', () => {
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['cognitum-seed'] }));
    // Placeholder store files — discoverBuilt() matches by filename only, never opens them.
    fs.writeFileSync(path.join(tmp, 'kb/cognitum-seed.big.rvf'), '');
    fs.writeFileSync(path.join(tmp, 'kb/public-repo.big.rvf'), '');
    stampGenerationLedger(path.join(tmp, 'kb'), ['cognitum-seed', 'public-repo']);
    const r = runBuildBundle();
    expect(r.stdout).toMatch(/EXCLUDED 1 PRIVATE store\(s\): cognitum-seed/);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'dist/ruvnet-brain/manifest.json'), 'utf8'));
    const names = manifest.builtRepos.map((b) => b.name.toLowerCase());
    expect(names).not.toContain('cognitum-seed');
    expect(names).toContain('public-repo');
    const readme = fs.readFileSync(path.join(tmp, 'dist/ruvnet-brain/README.md'), 'utf8');
    expect(readme).not.toMatch(/cognitum-seed/i);
  });
});

describe('build-bundle.mjs — publishable artifact gate (fail-closed)', () => {
  it('ignores AppleDouble RVF metadata even when it sits beside canonical assets', () => {
    const assets = path.join(tmp, 'release-assets');
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
    fs.writeFileSync(path.join(assets, 'public-repo.big.rvf'), '');
    fs.writeFileSync(path.join(assets, '._public-repo.big.rvf'), '');
    stampGenerationLedger(assets, ['public-repo']);

    const r = runBuildBundle({}, ['--assets', assets]);

    expect(r.stdout).not.toContain('._public-repo');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'dist/ruvnet-brain/manifest.json'), 'utf8'));
    expect(manifest.builtRepos.map(({ name }) => name)).toEqual(['public-repo']);
  });

  it('assembles explicitly supplied external release assets while keeping the source-tree private fence authoritative', () => {
    const assets = path.join(tmp, 'release-assets');
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['private-repo'] }));
    fs.writeFileSync(path.join(assets, 'private-repo.big.rvf'), '');
    fs.writeFileSync(path.join(assets, 'public-repo.big.rvf'), '');
    stampGenerationLedger(assets, ['private-repo', 'public-repo']);

    const r = runBuildBundle({}, ['--assets', assets]);

    expect(r.stdout).toMatch(/EXCLUDED 1 PRIVATE store\(s\): private-repo/);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'dist/ruvnet-brain/manifest.json'), 'utf8'));
    expect(manifest.builtRepos.map(({ name }) => name)).toEqual(['public-repo']);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'dist/ruvnet-brain/PRIVATE-STORES.json'), 'utf8')))
      .toEqual({ privateStores: ['private-repo'] });
  });

  it('FATALs when discovery yields zero public RVFs, including a private-only KB', () => {
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['private-repo'] }));
    fs.writeFileSync(path.join(tmp, 'kb/private-repo.big.rvf'), '');

    const r = runBuildBundle();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/FATAL.*zero public RVF/i);
    expect(fs.existsSync(path.join(tmp, 'dist/ruvnet-brain.zip'))).toBe(false);
  });

  it('FATALs instead of publishing a ZIP when any required bundle file is missing', () => {
    fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
    fs.writeFileSync(path.join(tmp, 'kb/public-repo.big.rvf'), '');
    stampGenerationLedger(path.join(tmp, 'kb'), ['public-repo']);

    const r = runBuildBundle();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/FATAL.*missing required bundle files/i);
    expect(r.stderr).toContain('public-repo.big.rvf.idmap.json');
    expect(fs.existsSync(path.join(tmp, 'dist/ruvnet-brain.zip'))).toBe(false);
  });
});
