#!/usr/bin/env node
// scripts/ci/stranger-scenario.mjs — the shared driver behind .github/workflows/stranger-matrix.yml
// (ADR-058 §D8). ONE portable script so all five images (ubuntu, windows Git-Bash, windows
// PowerShell, macos, hostile container) run the IDENTICAL scenario logic. The `--local` contract is
// the assembled dist/ruvnet-brain/ directory, so this harness gives the packed installer that exact
// shape. Published Release ZIP extraction is a separate path with its own release/update tests.
//
// Runs against the PACKED, INSTALLED copy — the caller is expected to have already run
// `npm pack` + `npm install <tarball>` and pass --installed pointing at
// <scratch>/node_modules/ruvnet-brain. This script never touches the checkout's own bin/install.mjs
// (the whole point of D8: never install from the checkout, the checkout is the thing that always
// works and is why #42/#43 shipped broken).
//
// SCENARIOS:
//   healthy           — a complete fixture bundle. Asserts exit 0, then runs --doctor --hooks and
//                        asserts automatic hooks are absent from the INSTALLED registries, and
//                        that no author-local ~/.claude/settings.json exists in this virgin image.
//   seeded-broken     — forge-mcp-all.mjs deleted from the fixture (M-D8a). Asserts exit NON-ZERO.
//   strict-ungrounded — a healthy-shaped fixture (already never ships forge-ask-all.mjs — see
//                        buildKbFixture below) with RUVNET_STRICT_INSTALL=1: grounding can never be
//                        proven in this hermetic run, and strict mode makes that FATAL. Asserts
//                        exit NON-ZERO — proving the strict path is real even though it is never the
//                        default (the SAME fixture, no strict flag, is the `healthy` scenario above
//                        and stays exit 0).
//
// Usage:
//   node scripts/ci/stranger-scenario.mjs --scenario <name> --installed <dir> --home <dir> --plugin-src <dir>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selfCheckOuterTimeoutMs } from './stranger-timeout.mjs';
import { stageLocalBundle } from './stranger-fixture-stage.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (flag, def = null) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const SCENARIO = arg('--scenario');
const INSTALLED = arg('--installed'); // <scratch>/node_modules/ruvnet-brain
const HOME_DIR = arg('--home'); // virgin HOME for this run
const PLUGIN_SRC = arg('--plugin-src'); // the checkout's plugin/ dir, at the candidate SHA

if (!SCENARIO || !INSTALLED || !HOME_DIR || !PLUGIN_SRC) {
  console.error('usage: node stranger-scenario.mjs --scenario <healthy|seeded-broken|strict-ungrounded> --installed <dir> --home <dir> --plugin-src <dir>');
  process.exit(2);
}

const hooksDoc = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, 'hooks', 'hooks.json'), 'utf8'));
const INSTALL_TIMEOUT_MS = selfCheckOuterTimeoutMs(hooksDoc);

function log(msg) { console.log(`[stranger-scenario:${SCENARIO}] ${msg}`); }
function fail(msg) { console.error(`[stranger-scenario:${SCENARIO}] FAIL: ${msg}`); process.exit(1); }

/**
 * PATH with every directory holding a `ruflo`/`claude-flow`/`claude` executable removed — same
 * safety net tests/mutation/install-selfcheck-consumption-mutation.test.mjs uses (bin/install.mjs's
 * OWN detectEnvironment() checks `have('ruflo') || have('claude-flow')` for the exact same tools —
 * confirmed live via search_ruvnet: rUv's published orchestration CLI ships bins `claude-flow`,
 * `cli`, `claude-flow-mcp` from the `claude-flow` / `@claude-flow/cli` npm packages), so a developer
 * reproducing a CI failure locally does not risk their own machine's real Claude Code plugin
 * marketplace or a real orchestration binary. On a hosted CI runner these binaries are already
 * absent, so this is a no-op there.
 */
function safePath() {
  const sep = path.delimiter;
  const risky = ['claude', 'ruflo', 'claude-flow'];
  return (process.env.PATH || '').split(sep).filter((dir) => {
    if (!dir) return true;
    try { return !risky.some((exe) => fs.existsSync(path.join(dir, exe))); } catch { return true; }
  }).join(sep);
}

function buildKbFixture({ dropMcp, noRvf }) {
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-kb-stage-'));
  const root = path.join(stageParent, 'ruvnet-brain');
  const args = [path.join(REPO_ROOT, 'scripts', 'ci', 'build-fixture-kb.mjs'), '--out', root];
  if (dropMcp) args.push('--drop-mcp');
  if (noRvf) args.push('--no-rvf');
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  return root;
}

/**
 * Marketplace-clone-shaped plugin surface, the REAL plugin/ tree at the candidate SHA — never a
 * synthetic fixture — so retirement is checked against the real installed registry.
 */
function seedPluginSurface() {
  const dest = path.join(HOME_DIR, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(PLUGIN_SRC, dest, { recursive: true });
  return dest;
}

/**
 * `spawnSync().status` is null in THREE completely different situations, and reporting all three as
 * the string "null" is how windows-powershell produced the least useful failure line in the matrix:
 *
 *     [stranger-scenario:healthy] FAIL: expected exit 0 on a healthy install, got null
 *
 * null is not an exit code — it means no exit code was ever produced. Which of these it was decides
 * what you go fix, and they have nothing to do with each other:
 *   · r.error set, code ENOENT     -> the binary was never launched (wrong path / missing tool)
 *   · r.error set, code ETIMEDOUT  -> the child ran and was KILLED at the timeout (a hang)
 *   · r.error set, code ENOBUFS    -> the child was KILLED because it out-printed maxBuffer
 *   · r.signal set, no error       -> something else killed it (OOM killer, SIGKILL)
 * So describe the outcome from error.code / signal, never from `status` alone.
 */
function describeExit(r) {
  if (r.error) {
    const code = r.error.code || r.error.name || 'unknown';
    const sig = r.signal ? `, signal ${r.signal}` : '';
    const why = code === 'ENOENT' ? ' — the process was never launched (binary not found)'
      : code === 'ETIMEDOUT' ? ' — the process HUNG and was killed at the timeout, it did not exit'
        : code === 'ENOBUFS' ? ' — the process was killed for exceeding maxBuffer on stdout/stderr, it did not exit'
          : '';
    return `NO EXIT CODE: spawn error ${code}${sig}${why} (${r.error.message})`;
  }
  if (r.status === null) {
    return r.signal
      ? `NO EXIT CODE: killed by signal ${r.signal} (nothing was returned by the process itself)`
      : 'NO EXIT CODE and no signal — spawnSync returned neither, which should be impossible; treat as a harness bug';
  }
  return `exit code ${r.status}`;
}

function runInstaller(args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(INSTALLED, 'bin', 'install.mjs'), ...args], {
    env: {
      ...process.env,
      PATH: safePath(),
      HOME: HOME_DIR,
      USERPROFILE: HOME_DIR,
      RUVNET_BRAIN_TEST: '1',
      // Preserve stage timing in the exact stranger path. The Windows cold-start miss that
      // escaped PR #70 was visible only as one aggregate 4597ms number; future failures must
      // identify the slow lifecycle stage in the same CI receipt.
      RUVNET_SESSION_TRACE: '1',
      ...extraEnv,
    },
    input: '',
    encoding: 'utf8',
    // This outer watchdog encloses the installer's post-install selfcheck. On Windows, 68 real
    // shell/process fires can legitimately exceed the old fixed 120s even while every individual
    // hook remains inside its own declared watchdog. Derive the ceiling from those inner budgets so
    // the matrix receives the named selfcheck verdict instead of killing the healthy installer first.
    timeout: INSTALL_TIMEOUT_MS,
    // spawnSync's default maxBuffer is 1MB, and BLOWING IT KILLS THE CHILD and yields status null —
    // indistinguishable, in the old reporting, from a hang or a missing binary. The installer prints
    // a full narrated plan plus a self-check battery, so 1MB is not a comfortable margin. Raised so
    // that a chatty-but-correct install cannot be mistaken for a broken one; describeExit() still
    // names ENOBUFS explicitly if it is ever hit again.
    maxBuffer: 64 * 1024 * 1024,
  });
}

fs.mkdirSync(HOME_DIR, { recursive: true });
seedPluginSurface();

const authorSettings = path.join(HOME_DIR, '.claude', 'settings.json');
if (fs.existsSync(authorSettings)) fail(`author-local settings.json must not exist in a virgin image: ${authorSettings}`);

const dropMcp = SCENARIO === 'seeded-broken';
const fixtureDir = buildKbFixture({ dropMcp, noRvf: false });
stageLocalBundle(fixtureDir, INSTALLED);

const strictEnv = SCENARIO === 'strict-ungrounded' ? { RUVNET_STRICT_INSTALL: '1' } : {};
const install = runInstaller(
  ['--local', '--no-stack', '--no-enhance', '--no-statusline', '--no-telemetry', '--no-nightly-prompt'],
  strictEnv,
);
log(`install result: ${describeExit(install)}`);
console.log(install.stdout);
if (install.stderr) console.error(install.stderr);

if (SCENARIO === 'healthy') {
  if (install.status !== 0) fail(`expected exit 0 on a healthy install, got ${describeExit(install)}`);

  const doctor = runInstaller(['--doctor', '--hooks']);
  log(`--doctor --hooks result: ${describeExit(doctor)}`);
  console.log(doctor.stdout);
  if (doctor.stderr) console.error(doctor.stderr);

  const installedApi = await import(pathToFileURL(path.join(INSTALLED, 'bin', 'install.mjs')).href);
  const retirement = installedApi.automaticHookRetirementStatus(INSTALLED, { scope: 'installed' });
  const installedClaude = installedApi.claudeInstalledHookRetirementStatus({ home: HOME_DIR,
    plugin: { managed: true, installed: true, installPath: path.join(HOME_DIR, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin') } });
  if (!retirement.ok || !installedClaude.ok) fail(`automatic hook retirement failed: ${JSON.stringify({ retirement, installedClaude })}`);
  const out = `${doctor.stdout || ''}${doctor.stderr || ''}`;
  if (!/automatic Brain hook retirement: 0 registration\(s\), 0 manifest error\(s\)/.test(out)) fail('doctor did not verify automatic hook retirement');
  const onlyGrounding = /Grounding UNPROVEN/.test(out) && !/automatic hook retirement failed/i.test(out);
  if (doctor.status !== 0 && !(doctor.status === 1 && onlyGrounding)) {
    fail(`doctor failed beyond unproven grounding: ${describeExit(doctor)}`);
  }
  log(`OK — installed automatic hooks retired across ${retirement.files.length} package surfaces and the actual Claude registry`);

  if (fs.existsSync(authorSettings)) fail('installer must never create an author-local settings.json in a virgin image');
  log('OK — no author-local ~/.claude/settings.json in this virgin image');
} else {
  // seeded-broken / strict-ungrounded: the whole point is a non-zero exit.
  //
  // "not zero" was too weak an assertion, and weak in the direction that hides breakage: a hang, an
  // ENOENT, or an ENOBUFS kill all leave status === null, which is not 0, so this cell reported PASS
  // for a run in which the installer never even executed. A test that a crashed harness satisfies is
  // not a test. Demand a REAL exit code the installer itself produced, and that it be non-zero.
  if (install.status === null) {
    fail(`scenario "${SCENARIO}" requires the installer to EXIT non-zero, but it never exited at all: ${describeExit(install)}`);
  }
  if (install.status === 0) fail(`expected a NON-ZERO exit for scenario "${SCENARIO}", got 0`);
  log(`OK — exited non-zero (${install.status}) as required for scenario "${SCENARIO}"`);
}

log('PASS');
