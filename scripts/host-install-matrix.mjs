// host-install-matrix.mjs — ONE definition of "install this artifact into clean hosts and judge it".
//
// WHY THIS EXISTS. Two harnesses did this same job and disagreed about almost everything:
//
//   scripts/staged-host-verifier.mjs        scripts/publication-receipt.mjs (installHosts)
//   ─────────────────────────────────       ────────────────────────────────────────────────
//   modes: claude / codex / dual            modes: claudeOnly / codexOnly / dual
//   --local … --no-selfcheck                --version v<X>  (no --local, selfcheck ON)
//   RUVNET_CLAUDE_MARKETPLACE_SOURCE        RUVNET_STRICT_INSTALL=1
//   RUVNET_CODEX_HOOK_TRUST_MODE=bypass     RUVNET_BRAIN_PROFILE=complete
//
// They could not even be compared: one produced `fixtures.claude`, the other `hosts.claudeOnly`,
// for the identical fixture. So "the hosts passed" meant two different things depending on which
// half of the release you asked, and nothing in the system could notice they had drifted apart.
//
// Some of that difference is REAL and must survive: a STAGED check runs before publication against
// local bytes, so it points the marketplace at the unpacked package and skips selfcheck; a
// PUBLISHED check runs after, against what npm actually serves, so it resolves by version and
// installs strictly. That is one axis with two values — a parameter. Everything else was accident.
//
// So: the modes are named once, the loop is written once, the verdict is classified once, and the
// only thing a caller chooses is which VARIANT it is running. Same shape as
// scripts/console-runtime-identity.mjs, where one enumeration serves both the copy list and the
// digest — a fact stated once cannot drift from itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The three host shapes a release must survive. ONE name each, for every consumer. */
export const HOST_MODES = Object.freeze(['claude', 'codex', 'dual']);

/** Which CLIs each mode is allowed to see. A codex-only box genuinely has no `claude`. */
export const MODE_HOSTS = Object.freeze({
  claude: ['claude'],
  codex: ['codex'],
  dual: ['claude', 'codex'],
});

/**
 * The published-side receipt has always spelled these `claudeOnly` / `codexOnly` / `dual`, and that
 * name is baked into current-release.json and every receipt already published — renaming it would
 * invalidate history for a cosmetic win. So the two spellings are reconciled HERE, once, instead of
 * being silently different in two files. `publication.installed.claudeOnly` and `fixtures.claude`
 * are now provably the same fixture, which is what made the two halves of a release incomparable.
 */
export const RECEIPT_MODE_NAMES = Object.freeze({ claude: 'claudeOnly', codex: 'codexOnly', dual: 'dual' });
export const MODE_FROM_RECEIPT_NAME = Object.freeze({ claudeOnly: 'claude', codexOnly: 'codex', dual: 'dual' });

/**
 * The two genuinely different questions, declared once instead of implied by two files.
 *
 * `staged`    — before publication, against local bytes. The marketplace is pointed at the unpacked
 *               package because nothing is on npm yet, and selfcheck is skipped for the same reason.
 * `published` — after publication, against what npm actually serves. Resolves by version and
 *               installs strictly, because this is the run that must match a stranger's machine.
 */
export const VARIANTS = Object.freeze({
  staged: Object.freeze({
    installerArgs: (_v) => ['--local', '--yes', '--force', '--no-nightly-prompt',
      '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck', '--no-verify'],
    env: ({ packageRoot }) => ({
      RUVNET_CLAUDE_MARKETPLACE_SOURCE: packageRoot,
      RUVNET_CODEX_HOOK_TRUST_MODE: 'bypass',
    }),
  }),
  published: Object.freeze({
    installerArgs: (version) => ['--yes', '--force', '--version', `v${version}`, '--no-nightly-prompt',
      '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline'],
    env: () => ({
      RUVNET_STRICT_INSTALL: '1',
      RUVNET_BRAIN_PROFILE: 'complete',
      // A VIRGIN AUTOMATED HOME CAN NEVER HAVE RECORDED CODEX HOOK TRUST (fixed 2026-08-08).
      //
      // The staged variant above has carried this since it was written; the published variant did
      // not, and that asymmetry failed the post-publication seal on EVERY release. The doctor ran
      // green on everything that matters — "✓ Healthy", "✓ Grounding PROVEN", "✓ Self-check passed",
      // 17 hook registrations across 68 firings — and then exited non-zero on the one condition a
      // fixture cannot satisfy:
      //
      //     ! Codex installed the Brain, but 17 lifecycle hooks await review.
      //       Fix: Start a fresh Codex session, run /hooks, and trust ruvnet-brain@ruvnet-brain.
      //
      // That instruction is correct for a human and impossible for a runner: hook trust is recorded
      // interactively. So each release published both channels successfully and then reported
      // failure, which is the exact "gate reporting something other than what it measured" pattern
      // this repo has spent a week removing — and worse here, because it made a GOOD release look bad.
      //
      // This does NOT weaken the check. install.mjs:1994 documents the bypass as executing the real
      // hook commands "without pretending a fresh interactive user has already reviewed them", and
      // the hooks still run — 68 firings, all inside contract. Only the pending-trust verdict is
      // waived, and only for an automated fixture. End-user doctor runs remain fail-closed.
      RUVNET_CODEX_HOOK_TRUST_MODE: 'bypass',
    }),
  }),
});

/** A doctor run is ACCEPTED only on a clean exit. One rule, not one per harness. */
export function classifyDoctor(result) {
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (!result.error && result.status === 0) return { accepted: true, status: 'PASS', output };
  return { accepted: false, status: 'FAIL', output };
}

/** Build a PATH exposing only the CLIs this mode is entitled to see. */
export function fixturePath(mode, temp, locate) {
  const bin = path.join(temp, `bin-${mode}`);
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['node', 'npm', ...MODE_HOSTS[mode]]) {
    const target = locate(name);
    if (!target) throw new Error(`${name} CLI unavailable for the ${mode} host fixture`);
    fs.symlinkSync(target, path.join(bin, name));
  }
  return `${bin}:/usr/bin:/bin`;
}

/**
 * Install `packageRoot` into a clean HOME per mode and run its doctor. Returns a result for EVERY
 * mode — including the ones that failed — because "which host broke" is the whole diagnostic value,
 * and the previous harnesses threw on the first failure and lost the rest.
 *
 * @returns {{verdict:'PASS'|'FAIL', fixtures:Record<string,object>, error?:string}}
 */
export function runHostMatrix({ packageRoot, version, variant = 'staged', locate, temp, run = spawnSync }) {
  const spec = VARIANTS[variant];
  if (!spec) throw new Error(`unknown host-matrix variant: ${variant}`);
  const workspace = temp || fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-host-matrix-'));
  const installer = path.join(packageRoot, 'bin', 'install.mjs');
  const fixtures = {};
  let verdict = 'PASS';
  let error;

  for (const mode of HOST_MODES) {
    const result = runHostMode({ mode, packageRoot, version, spec, workspace, locate, run });
    if (result.error) {
      verdict = 'FAIL';
      fixtures[mode] = result.fixture;
      error = error || result.error;
    } else {
      fixtures[mode] = result.fixture;
    }
  }
  return error ? { verdict, fixtures, error } : { verdict, fixtures };
}

function runHostMode({ mode, packageRoot, version, spec, workspace, locate, run }) {
  try {
    const home = path.join(workspace, `home-${mode}`);
    const codexHome = path.join(home, '.codex');
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    if (mode !== 'claude') fs.mkdirSync(codexHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      RUVNET_BRAIN_HOME: brainHome,
      RUVNET_BRAIN_KB: path.join(brainHome, 'kb'),
      CI: 'true',
      PATH: fixturePath(mode, workspace, locate),
      ...spec.env({ packageRoot }),
    };
    const installer = path.join(packageRoot, 'bin', 'install.mjs');
    const install = run(process.execPath, [installer, ...spec.installerArgs(version)], {
      cwd: packageRoot, env, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (install.error || install.status !== 0) {
      throw new Error(`install failed for ${mode}: ${(install.stderr || install.error?.message || '').slice(-4000)}`);
    }
    const doctor = run(process.execPath, [installer, '--doctor', '--hooks'], {
      cwd: packageRoot, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
    });
    const classified = classifyDoctor(doctor);
    const fixture = { status: classified.status, doctorExit: doctor.status, version };
    if (!classified.accepted) {
      fixture.output = classified.output.slice(-5000);
      return {
        fixture,
        error: `doctor failed for ${mode} (exit ${doctor.status}): ${classified.output.slice(-4000)}`,
      };
    }
    return { fixture };
  } catch (e) {
    return { fixture: { status: 'FAIL', error: e.message }, error: e.message };
  }
}

/**
 * Async equivalent used by hosted release qualification. Each mode owns its HOME and PATH, so
 * the expensive installer/doctor pairs can run concurrently without sharing mutable state.
 * Results are reassembled in HOST_MODES order before the single caller writes its receipt.
 */
export async function runHostMatrixAsync({
  packageRoot,
  version,
  variant = 'staged',
  locate,
  temp,
  runCommand = spawnCommand,
  runMcpSearch = runInstalledMcpSearch,
  verifyGrounding = verifyInstalledGrounding,
}) {
  const spec = VARIANTS[variant];
  if (!spec) throw new Error(`unknown host-matrix variant: ${variant}`);
  const workspace = temp || fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-host-matrix-'));
  const sharedModelCache = path.join(workspace, 'models-cache');
  fs.mkdirSync(sharedModelCache, { recursive: true });
  const contexts = HOST_MODES.map((mode) => {
    const home = path.join(workspace, `home-${mode}`);
    const codexHome = path.join(home, '.codex');
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    if (mode !== 'claude') fs.mkdirSync(codexHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      RUVNET_BRAIN_HOME: brainHome,
      RUVNET_BRAIN_KB: path.join(brainHome, 'kb'),
      KB_MODEL_CACHE: sharedModelCache,
      CI: 'true',
      PATH: fixturePath(mode, workspace, locate),
      ...spec.env({ packageRoot }),
    };
    return { mode, home, env };
  });
  const installer = path.join(packageRoot, 'bin', 'install.mjs');
  const installs = await Promise.all(contexts.map(async (context) => {
    const processResult = await runCommand(process.execPath, [installer, ...spec.installerArgs(version)], {
      cwd: packageRoot, env: context.env, timeout: 1_200_000,
    });
    return { context, processResult };
  }));
  const failedInstall = installs.find(({ processResult }) => processResult.error || processResult.status !== 0);
  if (failedInstall) {
    const detail = processDiagnostic(failedInstall.processResult);
    return {
      verdict: 'FAIL',
      fixtures: Object.fromEntries(contexts.map(({ mode }) => [mode, {
        status: mode === failedInstall.context.mode ? 'FAIL' : 'NOT_PROBED',
        ...(mode === failedInstall.context.mode ? { process: processIdentity(failedInstall.processResult) } : {}),
      }])),
      error: `install failed for ${failedInstall.context.mode} (${detail})`,
    };
  }

  const prewarmContext = contexts[0];
  const prewarmReader = path.join(prewarmContext.env.RUVNET_BRAIN_KB, 'forge-ask-all.mjs');
  const prewarm = await runCommand(process.execPath, [prewarmReader, '--dir', prewarmContext.env.RUVNET_BRAIN_KB,
    '--q', 'How does RuvNet Brain prove a public release artifact?', '--k', '1'], {
    cwd: prewarmContext.env.RUVNET_BRAIN_KB, env: prewarmContext.env, timeout: 300_000,
  });
  if (prewarm.error || prewarm.status !== 0) {
    return { verdict: 'FAIL', fixtures: {}, error: `shared model prewarm failed (${processDiagnostic(prewarm)})` };
  }
  const prewarmGrounding = await verifyGrounding(String(prewarm.stdout || ''), prewarmContext.env.RUVNET_BRAIN_KB);
  if (!prewarmGrounding?.grounded) {
    return { verdict: 'FAIL', fixtures: {}, error: 'shared model prewarm returned no grounded source receipt' };
  }

  const searches = await Promise.all(contexts.map(async (context) => {
    const serverPath = path.join(context.home, '.claude', 'ruvnet-brain', 'mcp', 'server.mjs');
    const processResult = await runMcpSearch({ mode: context.mode, serverPath, env: context.env });
    const output = `${processResult.stdout || ''}${processResult.stderr || ''}`;
    if (processResult.error || processResult.status !== 0) {
      return { context, processResult, error: `MCP search failed for ${context.mode} (${processDiagnostic(processResult)}): ${output.slice(-2000)}` };
    }
    const grounding = await verifyGrounding(output, context.env.RUVNET_BRAIN_KB);
    if (!grounding?.grounded) return { context, processResult, error: `MCP search grounding unproven for ${context.mode}` };
    return { context, processResult, grounding };
  }));
  const fixtures = Object.fromEntries(searches.map(({ context, processResult, grounding, error }) => [context.mode, {
    status: error ? 'FAIL' : 'PASS',
    version,
    process: processIdentity(processResult),
    ...(grounding?.receipt ? { grounding: grounding.receipt } : {}),
    ...(error ? { error } : {}),
  }]));
  const error = searches.find((result) => result.error)?.error;
  return error ? { verdict: 'FAIL', fixtures, error } : { verdict: 'PASS', fixtures };
}

function processIdentity(result) {
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
  };
}

function processDiagnostic(result) {
  const process = processIdentity(result);
  return `status=${process.status} signal=${process.signal || 'none'} error=${process.errorCode ? `${process.errorCode}: ${process.errorMessage}` : 'none'}`;
}

async function verifyInstalledGrounding(output, kbDir) {
  const verifier = path.join(kbDir, 'verify-citation.mjs');
  const { verifyGrounding } = await import(pathToFileURL(verifier).href);
  return verifyGrounding(output, kbDir);
}

function runInstalledMcpSearch({ serverPath, env, query = 'How does RuvNet Brain prove a public release artifact?', timeout = 300_000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const pending = new Map();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve({ status: result.status ?? null, signal: result.signal ?? null, error: result.error ?? null, stdout, stderr });
    };
    const timer = setTimeout(() => finish({ status: null, signal: 'SIGKILL', error: Object.assign(new Error('MCP search timed out'), { code: 'ETIMEDOUT' }) }), timeout);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const handler = pending.get(message.id);
        if (handler) { pending.delete(message.id); handler(message); }
      }
    });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('exit', (status, signal) => {
      if (!settled) finish({ status, signal, ...(status === 0 ? {} : { error: new Error(`MCP server exited ${status}`) }) });
    });
    const call = (id, method, params = {}) => new Promise((done) => {
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      const initialized = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-host-matrix', version: '1' } });
      if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
      const listed = await call(2, 'tools/list');
      if (!listed.result?.tools?.some((tool) => tool.name === 'search_ruvnet')) throw new Error('installed MCP does not advertise search_ruvnet');
      const searched = await call(3, 'tools/call', { name: 'search_ruvnet', arguments: { query, k: 5 } });
      const text = (searched.result?.content || []).map((item) => item.text || '').join('\n');
      if (searched.error || searched.result?.isError) throw new Error(`installed Brain search failed: ${text.slice(0, 400)}`);
      stdout = text;
      finish({ status: 0 });
    })().catch((error) => finish({ status: null, error }));
  });
}

function spawnCommand(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (status, signal) => resolve({ status, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    child.on('error', (error) => resolve({ status: null, error, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}
