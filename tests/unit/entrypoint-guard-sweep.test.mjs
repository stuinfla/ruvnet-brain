// tests/unit/entrypoint-guard-sweep.test.mjs
//
// ONE ENTRY-POINT CHECK: plugin/scripts/entrypoint.mjs's isDirectInvocation(import.meta.url).
//
// Scripts used to decide "was I run, or imported?" by comparing process.argv[1] with import.meta.url
// by hand. argv[1] keeps the symlinks the caller typed; import.meta.url has them resolved. Run through
// a symlink (npm bin shims, wrapper scripts, every os.tmpdir() path on macOS) the comparison was
// false, main() never ran and the process exited 0 — a release gate that checks nothing and passes.
// Dream Cycle PRs #295, #317, #333, #367, #412 and #484 each found one more copy by hand; on
// 2026-10-25 the scan below found 195 files carrying a hand-written comparison. They now call the
// helper, and this test fails the moment a new hand-written comparison appears.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRawGuards, scanRawGuards } from '../helpers/entrypoint-guard-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = path.join(ROOT, 'plugin', 'scripts', 'entrypoint.mjs');

// Files that may keep an inline comparison, each because it cannot import the helper. Every entry
// must still compare REAL paths (checked below), and an entry that no longer needs to be here fails.
const ALLOW = {
  'kb/forge-ask.mjs': 'ships in the brain bundle, which holds kb/ modules only (scripts/build-bundle.mjs)',
  'kb/forge-ask-all.mjs': 'ships in the brain bundle, which holds kb/ modules only (scripts/build-bundle.mjs)',
  'kb/forge-update.mjs': 'ships in the brain bundle, which holds kb/ modules only (scripts/build-bundle.mjs)',
  'scripts/verify-bundle.mjs': 'copied alone into every brain bundle (scripts/build-bundle.mjs)',
  'overlays/qwntik/rvf-families/registry.mjs': 'the overlay directory is self-contained',
  'scripts/model-routing-launchers.mjs': 'installNativeLaunchers() copies it alone as the launcher runner',
};

function runThroughSymlink(target, args = [], opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-entry-symlink-'));
  const link = path.join(dir, path.basename(target));
  try {
    fs.symlinkSync(target, link);
    return spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', timeout: 60000, input: '', ...opts });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('no hand-written entry-point comparison outside the helper', () => {
  const { scanned, hits } = scanRawGuards(ROOT);

  it('scans the shipped code at all', () => {
    expect(scanned, 'the scan found almost nothing — SCAN_DIRS is wrong').toBeGreaterThan(300);
  });

  it('every other file calls isDirectInvocation(import.meta.url)', () => {
    const offenders = hits.filter((h) => !ALLOW[h.file]).map((h) => `${h.file}:${h.lines.join(',')}`);
    expect(offenders, 'replace the comparison with isDirectInvocation(import.meta.url) from '
      + 'plugin/scripts/entrypoint.mjs; a file that truly cannot import it goes in ALLOW with the reason')
      .toEqual([]);
  });

  it('the allow-list is current, and every allowed inline comparison resolves real paths', () => {
    const flagged = new Map(hits.map((h) => [h.file, h.lines]));
    for (const file of Object.keys(ALLOW)) {
      expect(flagged.has(file), `${file} no longer compares by hand — remove it from ALLOW`).toBe(true);
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
      for (const n of flagged.get(file)) {
        const window = lines.slice(Math.max(0, n - 3), n + 1).join('\n');
        expect(window, `${file}:${n} compares without realpath — the defect this test exists for`).toMatch(/realpathSync/);
      }
    }
  });

  it('TEETH: the detector fires on every shape that shipped broken, and clears the fixed forms', () => {
    const broken = [
      'if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();',
      'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();',
      'if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {',
      'if (import.meta.url === `file://${process.argv[1]}`) {',
      'if (process.argv[1] === new URL(import.meta.url).pathname) {',
      'const SELF = fileURLToPath(import.meta.url);\nif (process.argv[1] && path.resolve(process.argv[1]) === SELF) {',
      'const invokedDirectly = process.argv[1]\n  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
    ];
    for (const src of broken) expect(findRawGuards(src), src).not.toEqual([]);
    const fine = [
      "import { isDirectInvocation } from './entrypoint.mjs';\nif (isDirectInvocation(import.meta.url)) main();",
      '// was: path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)\nif (isDirectInvocation(import.meta.url)) main();',
      "fail('the `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` guard is false');",
      "if (process.argv[1] && process.argv[1].endsWith('upgrade-notice.mjs')) main();",
      'const scriptPath = path.resolve(process.argv[1]);',
    ];
    for (const src of fine) expect(findRawGuards(src), src).toEqual([]);
  });
});

describe('isDirectInvocation — a script run through a symlink executes', () => {
  it('the helper is true through a symlink, where the old comparison was false (fixture)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-entry-fixture-'));
    try {
      const helperUrl = pathToFileURL(HELPER).href;
      const fixed = path.join(dir, 'fixed.mjs');
      fs.writeFileSync(fixed, `import { isDirectInvocation } from ${JSON.stringify(helperUrl)};\n`
        + "if (isDirectInvocation(import.meta.url)) console.log('RAN');\n");
      const old = path.join(dir, 'old.mjs');
      fs.writeFileSync(old, "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n"
        + "if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('RAN');\n");
      const realDir = fs.realpathSync(dir);
      const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-entry-links-')), 'l');
      fs.mkdirSync(linkDir);
      try {
        fs.symlinkSync(path.join(realDir, 'fixed.mjs'), path.join(linkDir, 'fixed.mjs'));
        fs.symlinkSync(path.join(realDir, 'old.mjs'), path.join(linkDir, 'old.mjs'));
        const run = (p) => spawnSync(process.execPath, [p], { encoding: 'utf8', timeout: 20000 }).stdout.trim();
        expect(run(path.join(realDir, 'fixed.mjs'))).toBe('RAN');
        expect(run(path.join(linkDir, 'fixed.mjs')), 'a symlinked entry point must still run').toBe('RAN');
        // The control proves this test can fail: the old comparison really is silent through a link.
        expect(run(path.join(realDir, 'old.mjs'))).toBe('RAN');
        expect(run(path.join(linkDir, 'old.mjs'))).toBe('');
      } finally {
        fs.rmSync(path.dirname(linkDir), { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when imported, and never throws on a path that does not resolve', async () => {
    const { isDirectInvocation } = await import('../../plugin/scripts/entrypoint.mjs');
    expect(isDirectInvocation(pathToFileURL(HELPER).href)).toBe(false); // argv[1] is the test runner
    expect(isDirectInvocation(pathToFileURL(HELPER).href, '/no/such/file.mjs')).toBe(false);
    expect(isDirectInvocation(pathToFileURL(HELPER).href, HELPER)).toBe(true);
    expect(isDirectInvocation(undefined, HELPER)).toBe(false);
  });

  // The release gate the sweep was ordered for (PR #333): through a symlink it used to print nothing
  // and exit 0, which reads as "no substitution found".
  it('scripts/no-silent-substitution.mjs runs its check through a symlink', () => {
    const r = runThroughSymlink(path.join(ROOT, 'scripts', 'no-silent-substitution.mjs'));
    expect(r.error).toBeUndefined();
    expect(r.stdout, `exit ${r.status}, stderr: ${r.stderr}`).toContain('no-silent-substitution');
  });

  // PR #484: the nightly suite-update spawns this file directly. --help mutates nothing.
  it('plugin/scripts/developer-update.mjs runs its CLI through a symlink', () => {
    const r = runThroughSymlink(path.join(ROOT, 'plugin', 'scripts', 'developer-update.mjs'), ['--help']);
    expect(r.error).toBeUndefined();
    expect(r.stdout, `exit ${r.status}, stderr: ${r.stderr}`).toContain('Usage: ruvnet-brain-update');
  });

  // PRs #295 and #317: both print a JSON verdict on every run.
  for (const rel of ['scripts/dream-issue-gate.mjs', 'scripts/development-push-check.mjs']) {
    it(`${rel} prints its verdict through a symlink`, () => {
      const r = runThroughSymlink(path.join(ROOT, rel), ['--help']);
      expect(r.error).toBeUndefined();
      expect(`${r.stdout}${r.stderr}`.trim().length, `${rel} printed nothing through a symlink (exit ${r.status})`)
        .toBeGreaterThan(0);
    });
  }
});
