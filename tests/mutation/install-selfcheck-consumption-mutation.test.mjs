// tests/mutation/install-selfcheck-consumption-mutation.test.mjs — M-D8b (ADR-058 §D8).
//
// bin/install.mjs's closing self-check consumes the post-install verdict with exactly one line:
//
//     if (selfcheck.exitCode !== 0) { ...; process.exitCode = selfcheck.exitCode; }
//
// That line IS the D8 fix — before it existed, `verifyInstall()`/`smokeQuery()` returned real
// verdicts that were called as bare statements and thrown away, so a broken install still exited 0
// (the exact "40/100" finding scripts/selfcheck.mjs's own header documents). This file proves the
// consumption line is load-bearing by reverting it to that historical shape — "a bare statement" —
// and showing a genuinely broken install now exits 0 again. House rule: "a test that cannot fail on
// broken code is not a test."
//
// WHY A REAL PACKED-AND-RUN INSTALL, NOT AN IN-PROCESS IMPORT: bin/install.mjs's main() is a
// top-level IIFE with real side effects (network, plugin wiring, a real npm install) — importing it
// would run all of that inline in the test process. Every other mutation test in this repo
// (tests/mutation/claims-freshness-mutation.test.mjs, tests/unit/selfcheck-battery.test.mjs §8)
// mutates the REAL source, writes it to a scratch copy, and imports/runs THAT — this file does the
// same, but via `spawnSync` (a script, not a module) against a scratch tree that mirrors
// bin/install.mjs's own relative layout (bin/ + scripts/ + kb/ + dist/), so its dynamic imports of
// scripts/selfcheck.mjs (the exact module the consumption line reads from) and its `--local` bundle
// lookup both resolve exactly as they would in a real install — never the checkout.
//
// SAFETY: a full install run reaches wirePlugin(), which shells out to the REAL `claude` CLI if one
// is on PATH. This is neutralized two ways, both load-bearing: (1) PATH is filtered to remove any
// directory containing a `claude`/`ruflo`/`claude-flow` executable, so `have('claude')` is false and
// wirePlugin() takes its non-mutating "I couldn't run claude" branch (a legitimate, common real-world
// path — the header comment names VS Code/desktop users as exactly this case); (2) HOME/USERPROFILE
// point at an isolated scratch dir for the whole run, so even the file-writing offers (Codex host,
// telemetry, statusline) can only touch that scratch tree. `--local` means zero network calls at all
// (verified: the only two network functions in this file, resolveRelease's fetchJson and download(),
// are both skipped in local mode). A before/after snapshot of the REAL machine's plugin directories
// closes the loop: if any of this were wrong, the assertion at the bottom would catch it.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONSOLE_RUNTIME_SURFACE } from '../../scripts/console-runtime-identity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_INSTALLER = path.join(REPO, 'bin/install.mjs');
const ANCHOR = 'process.exitCode = selfcheck.exitCode;';

const canRun = process.platform !== 'win32'; // safePath() executable filtering is POSIX-shaped

const scratchDirs = [];
afterEach(() => { for (const d of scratchDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** PATH with every directory holding a `claude`/`ruflo`/`claude-flow` executable removed. */
function safePath() {
  const sep = path.delimiter;
  const risky = ['claude', 'ruflo', 'claude-flow'];
  return (process.env.PATH || '').split(sep).filter((dir) => {
    if (!dir) return true;
    try { return !risky.some((exe) => fs.existsSync(path.join(dir, exe))); } catch { return true; }
  }).join(sep);
}

/**
 * A minimal assembled KB directory, matching the real `--local` contract.
 * Staging is delegated to scripts/ci/build-fixture-kb.mjs — the SAME script the stranger-matrix
 * workflow uses, so this test and the CI matrix can never drift onto two different fixture shapes.
 */
function buildFixtureDir({ includeRvf }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-kb-stage-'));
  scratchDirs.push(stage);
  const root = path.join(stage, 'ruvnet-brain');
  execFileSync(process.execPath, [
    path.join(REPO, 'scripts/ci/build-fixture-kb.mjs'), '--out', root,
    ...(includeRvf ? [] : ['--no-rvf']),
  ]);
  return root;
}

/**
 * A scratch tree mirroring bin/install.mjs's own relative layout, so its dynamic imports and its
 * `--local` bundle lookup resolve for real. `mutateTo`, when given, replaces the ONE anchor line;
 * omit it to run the REAL, unmutated file (the baseline).
 */
function buildScratchRoot({ mutateTo, includeRvf }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-installer-'));
  scratchDirs.push(root);
  for (const d of ['bin', 'kb', 'dist', 'plugin', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });

  const source = fs.readFileSync(REAL_INSTALLER, 'utf8');
  expect(source.includes(ANCHOR), 'mutation anchor not found in bin/install.mjs — the target moved').toBe(true);
  const written = mutateTo !== undefined ? source.replace(ANCHOR, mutateTo) : source;
  if (mutateTo !== undefined) expect(written, 'mutation changed nothing — it would silently run the unmutated file').not.toBe(source);
  fs.writeFileSync(path.join(root, 'bin', 'install.mjs'), written);

  // Use the real runtime directory instead of maintaining a second, partial import list.
  // Only bin/install.mjs is mutated; every dependency remains byte-identical to the candidate.
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  for (const rel of ['kb/verify-citation.mjs', 'kb/brain-profile.mjs', 'kb/model-requirements.mjs']) {
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  // installConsoleRuntime() is part of the real installer contract, so this fake package must carry
  // the runtime surface or the mutation fails earlier than the self-check verdict it targets. Taken
  // from the shipped list rather than copied into a fourth private enumeration of it — bin/install.mjs
  // is the only file this fixture is allowed to differ on.
  for (const relative of CONSOLE_RUNTIME_SURFACE) {
    if (relative === 'bin/install.mjs') continue;   // the mutant, already written above
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(REPO, relative), target, { recursive: true });
  }

  fs.cpSync(buildFixtureDir({ includeRvf }), path.join(root, 'dist', 'ruvnet-brain'), {
    recursive: true,
  });
  return root;
}

/**
 * Seed a marketplace-clone-shaped plugin surface with ZERO registrations directly under the
 * isolated HOME — `claude` is unreachable (safePath()), so wirePlugin() never installs a real one,
 * and scripts/selfcheck.mjs's resolveInstalledSurface() otherwise reports `no-plugin` for EVERY
 * machine without a wired plugin, which is not what M-D8b is about. An empty hooks.json is a
 * legitimate "installed, nothing registered" surface — the battery runs, finds nothing to fire, and
 * reports zero violations, exactly like the `healthy` fixtures in tests/unit/selfcheck-battery.test.mjs.
 */
function seedEmptyPluginSurface(home) {
  const root = path.join(home, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(root, 'scripts', 'hook-shim.mjs'), 'const TABLE = {};\nprocess.exit(0);\n');
}

function runFullInstall(scratchRoot) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-home-'));
  scratchDirs.push(home);
  seedEmptyPluginSurface(home);
  const r = spawnSync(process.execPath, [
    path.join(scratchRoot, 'bin', 'install.mjs'), '--local',
    '--no-stack', '--no-enhance', '--no-statusline', '--no-telemetry', '--no-nightly-prompt',
  ], {
    env: { ...process.env, PATH: safePath(), HOME: home, USERPROFILE: home, RUVNET_BRAIN_TEST: '1' },
    input: '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r;
}

describe.skipIf(!canRun)('mutation M-D8b — process.exitCode = selfcheck.exitCode must be load-bearing', () => {
  // Snapshot the REAL developer machine's plugin dirs — proof this test's safety net actually holds,
  // not just an assertion that it should.
  const realMarketplace = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'ruvnet-brain');
  const realInstalled = path.join(os.homedir(), '.claude', 'plugins', 'ruvnet-brain');
  const before = { marketplace: fs.existsSync(realMarketplace), installed: fs.existsSync(realInstalled) };

  it('baseline (REAL code): a broken install (no .rvf store) exits NON-ZERO', () => {
    const root = buildScratchRoot({ includeRvf: false });
    const r = runFullInstall(root);
    expect(r.error, `spawn failed: ${r.error && r.error.message}`).toBeUndefined();
    expect(r.status, `expected non-zero on a broken install; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).not.toBe(0);
  }, 60_000);

  it('baseline (REAL code): a HEALTHY install (an .rvf store present) exits ZERO — the mutation target is not a hardcoded fail', () => {
    const root = buildScratchRoot({ includeRvf: true });
    const r = runFullInstall(root);
    expect(r.error, `spawn failed: ${r.error && r.error.message}`).toBeUndefined();
    expect(r.status, `expected zero on a healthy install; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  }, 60_000);

  it('MUTANT: revert the consumption line to a bare statement → the SAME broken install now exits ZERO (the historical defect, reproduced)', () => {
    const root = buildScratchRoot({ includeRvf: false, mutateTo: 'selfcheck.exitCode;' });
    const r = runFullInstall(root);
    expect(r.error, `spawn failed: ${r.error && r.error.message}`).toBeUndefined();
    // The defect this whole file exists to catch: "Needs attention" prose can still print, but the
    // exit code — the one thing a script or CI job actually reads — lies and says success.
    expect(r.status, `mutant should have regressed to exit 0; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  }, 60_000);

  it("didn't touch the real developer machine's Claude Code plugin directories", () => {
    expect(fs.existsSync(realMarketplace)).toBe(before.marketplace);
    expect(fs.existsSync(realInstalled)).toBe(before.installed);
  });
});
