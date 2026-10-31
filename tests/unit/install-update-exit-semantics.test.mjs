/**
 * `install.mjs --update` exit contract (4.7.21, shared by WP-B1/B2/B3):
 *   0  the knowledge phases passed — including when the only host gap is a pending restart, or Codex has a
 *      config dir but no binary on PATH (no host to converge);
 *   12 cleanup pending; 2 transient network; 1 a real failure.
 *   Lifecycle-evidence retention is an advisory and never flips the terminal verdict.
 *
 * Before (audit C, both readers; a real receipt on the owner's Mac, Oct 24: update=PASS [applied],
 * host-convergence=FAIL, status FAILED):
 *   - host-restart-required (Codex reports restartScope 'unproven' on every boot-level change) set exit 1 and
 *     skipped reconcileNightlyModules, so the nightly kept running yesterday's coordinator;
 *   - a retention problem (.DS_Store, a leftover .prune-*) turned every good update into recovery-required
 *     exit 1, and the installer then fell back to a ~745 MB fresh reinstall that hit the same wall, nightly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireRefreshLock, openRefreshReceipt, recordRefreshPhase, settleRefreshRun,
  UPDATE_REFRESH_PHASES } from '../../kb/refresh-run.mjs';
import { CONSOLE_RUNTIME_SURFACE } from '../../scripts/console-runtime-identity.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const temps = [];
const temporary = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
let install;
let isolatedHome;
const priorEnv = {};

beforeAll(async () => {
  isolatedHome = temporary('install-exit-home-');
  const isolated = { HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: path.join(isolatedHome, '.codex'),
    RUVNET_BRAIN_HOME: path.join(isolatedHome, '.cache', 'ruvnet-brain'), RUVNET_BRAIN_IMPORT_ONLY: '1' };
  for (const [key, value] of Object.entries(isolated)) { priorEnv[key] = process.env[key]; process.env[key] = value; }
  install = await import(`${pathToFileURL(INSTALLER).href}?exit-semantics=${Date.now()}`);
});
afterAll(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('classifyUpdaterExit: no reinstall for what a reinstall cannot fix', () => {
  it('a signal-interrupted updater is reported as interrupted, never a fresh-reinstall fallback', () => {
    expect(install.classifyUpdaterExit(143, { result: { terminalVerdict: 'interrupted' }, requireResult: true }))
      .toEqual({ verdict: 'interrupted', fallback: false, exitCode: 143 });
    expect(install.classifyUpdaterExit(130, {})).toEqual({ verdict: 'interrupted', fallback: false, exitCode: 130 });
  });

  it('recovery-required (e.g. lifecycle retention) is returned as is, never a fresh-reinstall fallback', () => {
    const result = { terminalVerdict: 'recovery-required', exitCode: 1,
      reason: 'lifecycle evidence retention failed: refresh-runs/.DS_Store is not a receipt' };
    expect(install.classifyUpdaterExit(1, { result, requireResult: true }))
      .toEqual({ verdict: 'recovery-required', fallback: false, exitCode: 1 }); // before: { verdict:'failed', fallback:true }
  });

  it('exit 5 (incompatible or remembered-rejected corpus) is not retried by reinstalling the same runtime', () => {
    const result = { terminalVerdict: 'failed', exitCode: 5, reason: 'corpus release corpus-x was already rejected by this brain' };
    expect(install.classifyUpdaterExit(5, { result, requireResult: true }))
      .toEqual({ verdict: 'refused-incompatible', fallback: false, exitCode: 5 }); // before: fallback:true
  });

  // Opus review #3 (4.7.21): forge-update exit 3 = "the signature could not be fetched". After a 745 MB bundle
  // downloaded, a 5xx or timeout on its 64-byte .sig fell to the fresh-reinstall fallback (another ~745 MB).
  it('exit 3 from a transient .sig fetch failure is transient-network, never a reinstall; a missing .sig (404) keeps the fallback', () => {
    const net = { terminalVerdict: 'failed', exitCode: 3,
      reason: 'network failure downloading signature https://x/bundle.zip.sig: socket hang up — nothing changed locally.' };
    expect(install.classifyUpdaterExit(3, { result: net, requireResult: true }))
      .toEqual({ verdict: 'transient-network', fallback: false, exitCode: 3 }); // before: { verdict:'failed', fallback:true }
    const busy = { terminalVerdict: 'failed', exitCode: 3, reason: 'signature download returned HTTP 503 for https://x/bundle.zip.sig — nothing changed.' };
    expect(install.classifyUpdaterExit(3, { result: busy, requireResult: true }))
      .toEqual({ verdict: 'transient-network', fallback: false, exitCode: 3 });
    const missing = { terminalVerdict: 'failed', exitCode: 3, reason: 'signature download returned HTTP 404 for https://x/bundle.zip.sig — nothing changed.' };
    expect(install.classifyUpdaterExit(3, { result: missing, requireResult: true }))
      .toEqual({ verdict: 'failed', fallback: true, exitCode: 3 });
  });

  it('an ordinary updater failure keeps its documented fallback; the other verdicts are unchanged', () => {
    expect(install.classifyUpdaterExit(1, { result: { terminalVerdict: 'failed', reason: 'boom' } }))
      .toEqual({ verdict: 'failed', fallback: true, exitCode: 1 });
    expect(install.classifyUpdaterExit(2, { result: { reason: 'network failure fetching x' } }))
      .toEqual({ verdict: 'transient-network', fallback: false, exitCode: 2 });
    expect(install.classifyUpdaterExit(12, { result: { terminalVerdict: 'cleanup-pending' } }))
      .toEqual({ verdict: 'cleanup-pending', fallback: false, exitCode: 12 });
    expect(install.classifyUpdaterExit(0, { result: { terminalVerdict: 'noop' }, requireResult: true }))
      .toEqual({ verdict: 'noop', fallback: false, exitCode: 0 });
  });
});

/** A refresh run whose seven knowledge phases PASSED, exactly as runUpdate records them before the tail. */
function knowledgePassedRun() {
  const brainHome = temporary('install-exit-brain-');
  const kbDir = path.join(brainHome, 'kb');
  fs.mkdirSync(kbDir);
  const lock = acquireRefreshLock({ kbDir, brainHome, action: 'nightly' });
  const handle = openRefreshReceipt({ brainHome, lock, action: 'nightly', desiredVersion: VERSION });
  for (const phase of UPDATE_REFRESH_PHASES) {
    recordRefreshPhase(handle, phase, 'PASS', { execution: { kind: 'executed', runId: handle.runId } });
  }
  const settled = {};
  const settle = (code, detail) => {
    settled.code = code;
    settled.receipt = settleRefreshRun({ handle, lock, status: code === 0 ? 'SUCCEEDED' : 'FAILED', detail }).receipt;
  };
  return { brainHome, kbDir, handle, lock, settle, settled };
}
const converged = { ok: true, convergence: { healthy: true, state: 'channels-converged' }, results: {} };
const restartOnly = { ok: false, restartOnly: true, results: {},
  convergence: { healthy: false, state: 'host-restart-required', action: 'boot-level declarations changed: hooks/hooks.json' },
  error: 'host convergence is host-restart-required: boot-level declarations changed: hooks/hooks.json' };
const within = () => ({ schemaVersion: 1, kind: 'ruvnet-brain-lifecycle-evidence-retention', withinBudget: true, unsafe: [] });

async function finish(run, overrides = {}) {
  const reconcile = vi.fn(() => ({ status: 'PASS' }));
  const result = await install.finishUpdate({
    kbDir: run.kbDir, brainHome: run.brainHome, refreshReceipt: run.handle,
    outcome: { verdict: 'applied' }, updaterResult: null, cleanupPending: false, settle: run.settle,
    converge: async () => converged, reconcile,
    routerDefault: () => ({ action: 'unchanged' }), managedCatalog: () => ({ action: 'unchanged', added: [] }),
    prune: within, enforce: () => null, enroll: () => {},
    ...overrides,
  });
  return { result, reconcile };
}
const phase = (receipt, name) => receipt.phases.find((entry) => entry.phase === name);

describe('finishUpdate: the host and retention outcomes after the knowledge phases passed', () => {
  it('a host restart as the ONLY gap: exit 0, receipt SUCCEEDED, the nightly modules are reconciled', async () => {
    const run = knowledgePassedRun();
    const { result, reconcile } = await finish(run, { converge: async () => restartOnly });
    expect(result.exitCode).toBe(0); // before: 1
    expect(reconcile).toHaveBeenCalledTimes(1); // before: never called
    expect(run.settled.receipt).toMatchObject({ status: 'SUCCEEDED', terminalVerdict: 'applied' });
    expect(phase(run.settled.receipt, 'host-convergence')).toMatchObject({ status: 'PASS', required: false,
      evidence: { state: 'host-restart-required', restartPending: true } });
    expect(fs.existsSync(run.lock.path)).toBe(false);
  });

  it('a restart that hides another gap (no restartOnly) is still a failure, but the modules are reconciled', async () => {
    const run = knowledgePassedRun();
    const { restartOnly: _drop, ...hidden } = restartOnly;
    const { result, reconcile } = await finish(run, { converge: async () => hidden });
    expect(result.exitCode).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(run.settled.receipt).toMatchObject({ status: 'FAILED' });
    expect(phase(run.settled.receipt, 'host-convergence')).toMatchObject({ status: 'FAIL', required: true });
  });

  it('any other convergence failure exits 1 and still reconciles the nightly modules', async () => {
    const run = knowledgePassedRun();
    const { result, reconcile } = await finish(run, { converge: async () => ({ ok: false, results: {},
      convergence: { healthy: false, state: 'host-pending', action: 're-run host synchronization' }, error: 'Codex plugin failed' }) });
    expect(result.exitCode).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1); // before: reconcile ran only on exit 0
  });

  it('lifecycle retention failure is an advisory: exit 0, SUCCEEDED/applied, recorded beside the updater\'s own advisory', async () => {
    const run = knowledgePassedRun();
    const updaterAdvisory = { withinBudget: false, unsafe: [{ path: 'refresh-runs/.prune-123', reason: 'quarantine left behind' }] };
    const { result } = await finish(run, {
      prune: () => ({ schemaVersion: 1, kind: 'ruvnet-brain-lifecycle-evidence-retention', withinBudget: false,
        unsafe: [{ path: path.join(run.brainHome, 'refresh-runs', '.DS_Store'), reason: 'not a receipt' }] }),
      updaterResult: { terminalVerdict: 'applied', retentionAdvisory: updaterAdvisory },
    });
    expect(result.exitCode).toBe(0); // before: 1, terminalVerdict recovery-required
    expect(run.settled.receipt).toMatchObject({ status: 'SUCCEEDED', terminalVerdict: 'applied' });
    expect(phase(run.settled.receipt, 'cleanup')).toMatchObject({ status: 'PASS', required: true });
    const advisory = run.settled.receipt.advisories.find((entry) => entry.advisory === 'lifecycle-retention');
    expect(advisory).toMatchObject({ status: 'FAIL', evidence: { updater: updaterAdvisory, installer: { withinBudget: false } } });
  });

  it('cleanup pending still exits 12 (applied, with redundant rollback cleanup owed)', async () => {
    const run = knowledgePassedRun();
    const { result } = await finish(run, { cleanupPending: true });
    expect(result.exitCode).toBe(12);
    expect(run.settled.receipt).toMatchObject({ status: 'FAILED', terminalVerdict: 'cleanup-pending' });
  });

  // Codex r3 #2 (4.7.21): cleanup pending AND a required host convergence that failed returned 12, which the
  // coordinator and host-update accept as "knowledge applied", so the genuine host failure was masked.
  it('cleanup pending beside a failed host convergence exits 1 with terminal verdict failed, not 12', async () => {
    const run = knowledgePassedRun();
    const { result, reconcile } = await finish(run, { cleanupPending: true, converge: async () => ({ ok: false, results: {},
      convergence: { healthy: false, state: 'host-pending', action: 're-run host synchronization' }, error: 'Codex plugin failed' }) });
    expect(result.exitCode).toBe(1); // before: 12
    expect(run.settled.code).toBe(1);
    expect(run.settled.receipt).toMatchObject({ status: 'FAILED', terminalVerdict: 'failed', // before: cleanup-pending
      detail: { phase: 'failed', terminalVerdict: 'failed' } });
    expect(phase(run.settled.receipt, 'host-convergence')).toMatchObject({ status: 'FAIL', required: true });
    expect(phase(run.settled.receipt, 'cleanup')).toMatchObject({ status: 'FAIL', required: true }); // still recorded
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(run.lock.path)).toBe(false);
  });

  it('cleanup pending beside a restart-only host gap still exits 12 (the restart is an advisory)', async () => {
    const run = knowledgePassedRun();
    const { result } = await finish(run, { cleanupPending: true, converge: async () => restartOnly });
    expect(result.exitCode).toBe(12);
    expect(run.settled.receipt).toMatchObject({ status: 'FAILED', terminalVerdict: 'cleanup-pending' });
  });

  it('a clean converged run is unchanged: exit 0, every required phase PASS', async () => {
    const run = knowledgePassedRun();
    const { result, reconcile } = await finish(run, { outcome: { verdict: 'noop' } });
    expect(result.exitCode).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(run.settled.receipt).toMatchObject({ status: 'SUCCEEDED', terminalVerdict: 'noop' });
    expect(run.settled.receipt.phases.every((entry) => entry.status === 'PASS')).toBe(true);
  });
});

// The candidate is built from the shipped surface (same rule as console-runtime-transaction.test.mjs).
function candidate() {
  const root = temporary('install-exit-candidate-');
  for (const relative of CONSOLE_RUNTIME_SURFACE) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(ROOT, relative), target, { recursive: true });
  }
  return root;
}
function hostSync(overrides) {
  const cache = temporary('install-exit-cache-');
  const brainHome = temporary('install-exit-hosthome-');
  install.installConsoleRuntime(cache, candidate());
  const result = install.syncHostsAfterUpdate(cache, { sourceRoot: candidate(), brainHome,
    wireClaude: () => ({ host: false, wired: false }), wireCodexHost: () => ({ host: true, action: 'unchanged' }),
    runStableSpine: () => ({ status: 0 }), ...overrides });
  const receipt = fs.existsSync(path.join(brainHome, 'host-convergence.json'))
    ? JSON.parse(fs.readFileSync(path.join(brainHome, 'host-convergence.json'), 'utf8')) : null;
  return { result, receipt };
}

describe('syncHostsAfterUpdate: what counts as a converged host', () => {
  it('~/.codex present but no codex binary on PATH is an absent host, not a failed update', () => {
    const { result, receipt } = hostSync({ wireCodexPlugin: () => ({ host: true, action: 'codex-unavailable',
      available: false, installed: false, enabled: false, missingBinary: true, error: 'codex: command not found' }) });
    expect(result.ok, JSON.stringify(result)).toBe(true); // before: false, "Codex plugin codex-unavailable"
    expect(receipt.hosts.codex).toEqual({ state: 'absent', version: null });
  });

  it('a Codex binary that RAN and failed is still a failure', () => {
    const { result } = hostSync({ wireCodexPlugin: () => ({ host: true, action: 'codex-unavailable',
      available: false, error: 'plugin list exited 1' }) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/codex-unavailable/);
  });

  // Owner's Mac, 2026-10-28..30: `codex plugin list` timed out every night, syncHostsAfterUpdate returned before the
  // Stable Spine, and the machine sat with Claude Code on the new plugin, runtime + Codex on the old, no receipt.
  it('a failed Codex host no longer stops the runtime: the spine runs, the receipt records codex failed, the run is not ok', () => {
    const spine = vi.fn(() => ({ status: 0 }));
    const { result, receipt } = hostSync({ runStableSpine: spine,
      wireClaude: () => ({ host: true, wired: true, version: VERSION }),
      wireCodexPlugin: () => ({ host: true, action: 'codex-unavailable', available: false, error: 'spawnSync codex ETIMEDOUT' }) });
    expect(spine).toHaveBeenCalledTimes(1); // before: never called — Codex returned first
    expect(result.ok).toBe(false);
    expect(result.failedHosts).toEqual(['codex']);
    expect(result.error).toMatch(/Codex plugin codex-unavailable: spawnSync codex ETIMEDOUT/);
    expect(result.error).toMatch(new RegExp(`runtime ${VERSION.replace(/\./g, '\\.')} and the other hosts converged`));
    expect(receipt).not.toBeNull(); // before: no receipt at all
    expect(receipt.desiredVersion).toBe(VERSION);
    expect(receipt.hosts.claude).toEqual({ state: 'ready', version: VERSION });
    expect(receipt.hosts.codex).toMatchObject({ state: 'failed', error: expect.stringMatching(/ETIMEDOUT/) });
    expect(install.classifyHostConvergence(receipt)).toMatchObject({ healthy: false, state: 'host-pending' });
  });

  it('a failed Claude Code host does not stop Codex or the runtime, and a thrown Codex error is recorded too', () => {
    const spine = vi.fn(() => ({ status: 0 }));
    const codex = vi.fn(() => { throw new Error('codex exploded'); });
    const { result, receipt } = hostSync({ runStableSpine: spine, wireCodexPlugin: codex,
      wireClaude: () => ({ host: true, wired: false, action: 'verification-failed', version: '0.0.1' }) });
    expect(codex).toHaveBeenCalledTimes(1); // before: never reached
    expect(spine).toHaveBeenCalledTimes(1);
    expect(result.failedHosts.sort()).toEqual(['claude', 'codex']);
    expect(result.error).toMatch(/Claude Code plugin verification-failed/);
    expect(result.error).toMatch(/Codex plugin failed: codex exploded/);
    expect(receipt.hosts.claude).toMatchObject({ state: 'failed', version: '0.0.1' });
    expect(receipt.hosts.codex).toMatchObject({ state: 'failed' });
  });

  it('runCodexJson gives Codex the bounded catalog-refresh limit, not 30 s (a cold catalog fetch measured 38-40 s)', () => {
    const seen = [];
    install.runCodexJson(['plugin', 'list', '--json'], { run: (_bin, _args, options) => { seen.push(options.timeout); return { status: 0, stdout: '{}' }; } });
    expect(install.CODEX_PLUGIN_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(install.CODEX_PLUGIN_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(600_000); // still bounded
    expect(seen).toEqual([install.CODEX_PLUGIN_COMMAND_TIMEOUT_MS]); // before: [30000]
  });

  it('a busy Stable Spine (update-apply exit 75) is not applied, and says so', () => {
    const { result } = hostSync({ wireCodexPlugin: () => ({ host: true, action: 'unchanged', version: VERSION }),
      runStableSpine: () => ({ status: 75 }) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/busy/); // before: "Stable Spine activation failed"
  });

  it('marks a Codex restart as the only gap (restartOnly) so --update can keep exit 0', () => {
    const { result } = hostSync({ wireCodexPlugin: () => ({ host: true, action: 'updated', version: VERSION,
      restartRequired: true, restartScope: 'unproven', sessionSafetyReason: 'boot-level declarations changed: hooks/hooks.json' }) });
    expect(result.ok).toBe(false);
    expect(result.convergence.state).toBe('host-restart-required');
    expect(result.restartOnly).toBe(true);
  });

  it('a restart beside a host at the wrong version is not restart-only', () => {
    expect(install.hostRestartIsOnlyGap({ desiredVersion: VERSION, consoleRuntime: { state: 'ready' }, hosts: {
      claude: { state: 'ready', version: '0.0.1' },
      codex: { state: 'ready', version: VERSION, restartRequired: true, restartScope: 'unproven' } } })).toBe(false);
    expect(install.hostRestartIsOnlyGap({ desiredVersion: VERSION, consoleRuntime: { state: 'pending-console-restart' }, hosts: {
      codex: { state: 'ready', version: VERSION, restartRequired: true, restartScope: 'unproven' } } })).toBe(false);
    expect(install.hostRestartIsOnlyGap({ desiredVersion: VERSION, consoleRuntime: { state: 'ready' }, hosts: {
      codex: { state: 'ready', version: VERSION, restartRequired: true, restartScope: 'unproven' } } })).toBe(true);
  });
});

describe('doctor: the Nightly fix for a run that fired and failed', () => {
  it('prescribes the update, not re-enabling a job that is loaded and running', () => {
    expect(install.nightlyFix({ state: 'degraded', lastExitCode: 1 })).toBe('npx ruvnet-brain@latest --update');
    expect(install.nightlyFix({ state: 'degraded' })).toBe('npx ruvnet-brain --enable-nightly'); // not loaded / drift
    expect(install.nightlyFix({ state: 'on', runHealth: { state: 'failed' } })).toBe('npx ruvnet-brain --update');
  });
});
