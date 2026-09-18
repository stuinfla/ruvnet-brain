#!/usr/bin/env node

/**
 * Native continuity acceptance runner.
 *
 * This deliberately invokes the installed subscription hosts. It records only bounded host
 * status, progression identities, and digest/readback facts; model output is never written to the
 * receipt. A transition is PASS only when the host emitted a durable canonical row and the outbox
 * contains its matching commit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnNativeHost } from './native-host-process.mjs';
import { subscriptionOnlyEnv } from './subscription-hosts.mjs';
import { withProgressionReader } from '../plugin/scripts/project-progression-reader.mjs';
import { validateProgressionSnapshot, restoreProjectProgression } from '../plugin/scripts/project-progression-contract.mjs';
import { ProgressionOutbox } from '../plugin/scripts/project-progression-outbox.mjs';
import { sourceIdentity } from './qa-contract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOSTS = Object.freeze({
  claude: { binary: 'claude', args: ['--print', '--plugin-dir', path.join(ROOT, 'plugin'), '--strict-mcp-config', '--mcp-config', path.join(ROOT, 'plugin/.mcp.json'), '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--output-format', 'json', '--allowedTools', 'Bash(pwd)'] },
  codex: { binary: 'codex', args: ['exec', '-m', 'gpt-5.6-luna', '-s', 'read-only', '--skip-git-repo-check', '--json'] },
});

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export { nativeFinalAnswer, nativeRolloutContextEvidence, nativeEventStructure, nativeTerminalSuccess } from './continuity-host-evidence.mjs';
import { nativeFinalAnswer, nativeRolloutContextEvidence, nativeEventStructure, nativeTerminalSuccess } from './continuity-host-evidence.mjs';

export function sourceFence() { return sourceIdentity(ROOT); }
function json(value) { return JSON.stringify(value); }
function cleanupFixture(fx) {
  try { fs.rmSync(fx.root, { recursive: true, force: true }); return true; } catch { return false; }
}

function fixture(host, index) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `continuity-${host}-${index}-`)));
  try {
  const project = path.join(root, 'project');
  const brain = path.join(root, 'brain');
  const home = path.join(root, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(brain, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  const claudeCredentials = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(claudeCredentials)) {
    fs.copyFileSync(claudeCredentials, path.join(claudeHome, '.credentials.json'), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(claudeHome, '.credentials.json'), 0o600);
  }
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'continuity@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'continuity fixture'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), `continuity fixture ${host} ${index}\n`);
  execFileSync('git', ['add', 'README.md'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: project });
  // Stage the current source in the disposable installed-spine layout. Codex registration is
  // completed through the real installer/plugin marketplace path below; no invocation-only hook
  // override is authoritative evidence of a production registration.
  const versionDir = path.join(brain, 'versions', 'continuity-current');
  fs.cpSync(path.join(ROOT, 'plugin'), versionDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'), path.join(brain, 'codex-hook.mjs'));
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ generation: 'continuity-current', version: 'continuity-current', codeRoot: versionDir }, null, 2));
  const ledgerPath = path.join(root, 'owned-work-ledger.json');
  if (host === 'codex' || host.includes('codex')) {
    const codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    // Authentication is private input to the native host. Keep the source auth file untouched and
    // never include its contents in a receipt.
    fs.symlinkSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '');
    return { root, project, brain, home, codexHome, ledgerPath, markerPath: path.join(root, 'codex-hook-fired.marker'), tracePath: path.join(root, 'codex-hook-trace.jsonl') };
  }
  return { root, project, brain, home, ledgerPath };
  } catch (error) { cleanupFixture({ root }); throw error; }
}

/** Run arbitrary disposable fixture work with cleanup covering setup, work, and inspection failures. */
export async function withNativeFixture(host, index, work) {
  const fx = fixture(host, index);
  let receipt;
  try {
    receipt = await work(fx);
    return receipt;
  } finally {
    const cleaned = cleanupFixture(fx);
    if (receipt?.fixture) {
      receipt.fixture.cleaned = cleaned;
      if (!cleaned) receipt.verdict = 'FIXTURE_CLEANUP_FAILED';
    }
  }
}

async function installCodexRuntime(fx) {
  const prior = process.env.RUVNET_BRAIN_HOME;
  const priorImportOnly = process.env.RUVNET_BRAIN_IMPORT_ONLY;
  const priorDaemonAutostart = process.env.RUFLO_DAEMON_AUTOSTART;
  process.env.RUVNET_BRAIN_HOME = fx.brain;
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  process.env.RUFLO_DAEMON_AUTOSTART = '0';
  try {
    const installer = await import('../bin/install.mjs');
    const host = installer.wireCodexHost({
      codexDir: fx.codexHome,
      configPath: path.join(fx.codexHome, 'config.toml'),
      serverDir: path.join(fx.brain, 'codex-server'),
      announce: false,
    });
    const plugin = installer.wireCodexPlugin({
      codexDir: fx.codexHome,
      codexHome: fx.codexHome,
      cwd: fx.project,
      announce: false,
    });
    const lifecycle = await installer.codexLifecycleStatus({ codexHome: fx.codexHome, cwd: fx.project });
    const trustable = (lifecycle.hooks || []).filter((hook) => hook?.pluginId === 'ruvnet-brain@ruvnet-brain' && hook?.key && hook?.currentHash);
    if (trustable.length !== 9) throw new Error(`isolated plugin trust expected exactly 9 hooks, found ${trustable.length}`);
    let config = fs.readFileSync(path.join(fx.codexHome, 'config.toml'), 'utf8');
    if (trustable.length) {
      config += `${config.endsWith('\n') ? '' : '\n'}\n[hooks.state]\n`;
      for (const hook of trustable) config += `[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`;
      fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), config);
    }
    const trustedLifecycle = await installer.codexLifecycleStatus({ codexHome: fx.codexHome, cwd: fx.project });
    const trustedHookCount = (trustedLifecycle.hooks || []).filter((hook) => hook?.pluginId === 'ruvnet-brain@ruvnet-brain' && hook?.trustStatus === 'trusted').length;
    if (trustedHookCount !== 9) throw new Error(`isolated plugin trust expected exactly 9 trusted hooks, found ${trustedHookCount}`);
    // Instrument only the disposable bridge path. The installed plugin still supplies the hook
    // registration; this marker distinguishes a registered hook from one actually invoked.
    const bridge = path.join(fx.brain, 'codex-hook.mjs');
    const productionBridge = path.join(fx.brain, 'codex-hook-production.mjs');
    fs.renameSync(bridge, productionBridge);
    fs.writeFileSync(bridge, `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport { spawnSync } from 'node:child_process';\ntry { fs.appendFileSync(${JSON.stringify(fx.markerPath)}, 'fired\\n'); } catch {}\nconst r = spawnSync(process.execPath, [${JSON.stringify(productionBridge)}, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'pipe'], input: fs.readFileSync(0), env: process.env, encoding: 'utf8' });\nlet envelope = null; try { envelope = JSON.parse(r.stdout || ''); } catch {}\nconst context = envelope?.hookSpecificOutput?.additionalContext || ''; const nonce = context.match(/continuity-source-[a-f0-9]{24}/)?.[0] || '';\ntry { fs.appendFileSync(${JSON.stringify(fx.tracePath)}, JSON.stringify({ args: process.argv.slice(2), status: r.status, signal: r.signal, stdoutBytes: Buffer.byteLength(r.stdout || '', 'utf8'), stdoutSha256: crypto.createHash('sha256').update(r.stdout || '').digest('hex'), envelopeValid: Boolean(envelope?.hookSpecificOutput), contextBytes: Buffer.byteLength(context, 'utf8'), contextSha256: crypto.createHash('sha256').update(context).digest('hex'), nonceCount: nonce ? context.split(nonce).length - 1 : 0, nonceSha256: nonce ? crypto.createHash('sha256').update(nonce).digest('hex') : null, nonceOffset: nonce ? context.indexOf(nonce) : -1, nonceBytes: nonce && context.includes(nonce) ? Buffer.byteLength(nonce, 'utf8') : 0 }) + '\\n'); } catch {}\nif (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exit(r.status ?? 1);\n`);
    fs.chmodSync(bridge, 0o755);
    return {
      host: { action: host.action, serverPath: host.serverPath, hookWrapperInstalled: host.hookWrapperInstalled },
      plugin: { action: plugin.action, installed: plugin.installed, enabled: plugin.enabled, version: plugin.version },
      lifecycle: {
        state: trustedLifecycle.state,
        hookCount: lifecycle.hooks?.length || 0,
        errors: lifecycle.errors || [],
        trustedHookCount,
        hookMetadata: (trustedLifecycle.hooks || []).map((hook) => Object.fromEntries(
          Object.entries(hook).filter(([key]) => key !== 'command'))),
      },
    };
  } finally {
    if (prior === undefined) delete process.env.RUVNET_BRAIN_HOME;
    else process.env.RUVNET_BRAIN_HOME = prior;
    if (priorImportOnly === undefined) delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
    else process.env.RUVNET_BRAIN_IMPORT_ONLY = priorImportOnly;
    if (priorDaemonAutostart === undefined) delete process.env.RUFLO_DAEMON_AUTOSTART;
    else process.env.RUFLO_DAEMON_AUTOSTART = priorDaemonAutostart;
  }
}

function canonicalRows(project) {
  const db = path.join(project, '.swarm', 'memory.db');
  if (!fs.existsSync(db)) return [];
  try {
    const result = withProgressionReader(db, (reader) => reader.listKeys('project-progression')
      .map((key) => reader.readContent('project-progression', key)).filter(Boolean).map(JSON.parse));
    return result.ok ? result.value : [{ readError: result.reason }];
  } catch (error) {
    return [{ readError: error.message }];
  }
}

function outbox(project) {
  try { return new ProgressionOutbox({ projectRoot: project }).records(); } catch { return []; }
}

function progressionEvidence(project, expectedHost, expectedNonce) {
  const rows = canonicalRows(project).filter((row) => row.schema === 'ruvnet-brain.project-progression');
  const commits = outbox(project).filter((row) => row.type === 'commit');
  // A capture row is not necessarily the current continuity head: later rows may be
  // causally chained from it, and concurrent heads are a conflict. Reduce the complete
  // journal first, then admit exactly one canonical head for this host.
  let restored;
  try { restored = restoreProjectProgression(rows); } catch { restored = null; }
  const byKey = new Map(rows.map((row) => [row.eventKey, row]));
  const heads = (restored?.heads || []).map((key) => byKey.get(key)).filter(Boolean);
  const candidates = heads.filter((row) => row.hostIdentity?.host === expectedHost && isDurablyCommitted(row, commits));
  const source = candidates.length === 1 ? candidates[0] : null;
  return {
    source,
    rows,
    commits,
    valid: Boolean(source
      && source.completeProjectState?.currentGoal?.includes(expectedNonce)
      && source.completeProjectState?.provenance?.currentGoal?.source === 'ledger'
      && source.completeProjectState?.provenance?.nextAction?.source === 'ledger'
      && source.completeProjectState?.completed?.includes(`completed-${expectedNonce}`)
      && source.completeProjectState?.inProgress?.some((item) => item.includes(expectedNonce))
      && source.completeProjectState?.evidence?.workLedger?.present === true),
  };
}

async function pinAndRemoveSyntheticLedger(fx, host, nonce) {
  const before = progressionEvidence(fx.project, host, nonce);
  if (!before.valid) return { valid: false, reason: 'source capture did not bind the synthetic owner note', source: before.source };
  // Host exit closes the transport before lifecycle hooks necessarily finish their final writes.
  // Require a quiet canonical file before the deletion can be considered source-pinned.
  let previous = '';
  let stable = 0;
  for (let attempt = 0; attempt < 20 && stable < 3; attempt++) {
    const marker = sha(`${canonicalRows(fx.project).map((row) => JSON.stringify(row)).join('\n')}\n${outbox(fx.project).map((row) => JSON.stringify(row)).join('\n')}`);
    stable = marker === previous ? stable + 1 : 0;
    previous = marker;
    execFileSync('sleep', ['0.1']);
  }
  if (stable < 3) return { valid: false, reason: 'canonical store did not quiesce after source host exit', source: before.source };
  try { fs.unlinkSync(fx.ledgerPath); } catch (error) {
    return { valid: false, reason: `owned work-ledger removal failed: ${error.message}`, source: before.source };
  }
  let remaining;
  for (let attempt = 0; attempt < 10; attempt++) {
    remaining = { ok: !fs.existsSync(fx.ledgerPath), value: [] };
    if (remaining.ok) break;
    execFileSync('sleep', ['0.1']);
  }
  if (!remaining?.ok || fs.existsSync(fx.ledgerPath)) return { valid: false, reason: 'owned work-ledger remained readable after removal', source: before.source };
  const after = progressionEvidence(fx.project, host, nonce);
  return {
    valid: Boolean(after.source && after.source.eventKey === before.source.eventKey && after.source.payloadDigest === before.source.payloadDigest),
    reason: after.source ? null : 'source canonical evidence disappeared during ledger removal',
    source: before.source,
  };
}

export function isDurablyCommitted(snapshot, commits) {
  return snapshot?.schema === 'ruvnet-brain.project-progression'
    && typeof snapshot.eventKey === 'string'
    && typeof snapshot.payloadDigest === 'string' && snapshot.payloadDigest.length > 0
    && validateProgressionSnapshot(snapshot).ok
    && commits.some((commit) => commit.type === 'commit' && commit.eventKey === snapshot.eventKey
      && commit.payloadDigest === snapshot.payloadDigest
      && typeof commit.readbackDigest === 'string' && commit.readbackDigest.length > 0
      && commit.readbackDigest === commit.payloadDigest
      && commit.readbackDigest === snapshot.payloadDigest);
}

function inspect(fx, host, result, interrupted) {
  const rows = canonicalRows(fx.project);
  const snapshots = rows.filter((row) => row.schema === 'ruvnet-brain.project-progression');
  const commits = outbox(fx.project).filter((row) => row.type === 'commit');
  const matching = snapshots.filter((row) => row.hostIdentity?.host === host && isDurablyCommitted(row, commits));
  const verdict = interrupted
    ? (result.signal && snapshots.length === 0 ? 'INTERRUPTED_NO_CAPTURE' : 'UNEXPECTED_CAPTURE')
    : (matching.length > 0 ? 'PASS' : host === 'codex' && result.status === 0 ? 'HOST_NO_LIFECYCLE_EVENT' : 'NO_DURABLE_CAPTURE');
  return {
    verdict,
    host,
    native: { status: result.status, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs },
    projectPathDigest: sha(fx.project),
    rows: snapshots.map((row) => ({ eventKey: row.eventKey, host: row.hostIdentity?.host, session: row.sessionIdentity, payloadDigest: row.payloadDigest, sourceIdentity: row.sourceIdentity })),
    outbox: commits.map((row) => ({ eventKey: row.eventKey, payloadDigest: row.payloadDigest, readbackDigest: row.readbackDigest })),
    transcriptStored: false,
  };
}

export async function runNativeCase({ host, index, interrupted = false, timeout = 180_000 } = {}) {
  if (!HOSTS[host]) throw new Error(`unsupported host: ${host}`);
  return withNativeFixture(host, index, async (fx) => {
    const registration = host === 'codex' ? await installCodexRuntime(fx) : null;
    const spec = HOSTS[host];
    const env = { ...subscriptionOnlyEnv(), HOME: fx.home, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_SUBSCRIPTION_ONLY: '1', RUVNET_BRAIN_HOME: fx.brain, RUVNET_HOOK_HOST: host };
    const prompt = 'Run exactly one read-only command: pwd. Do not modify files, call external services, or include private transcript content in your final response. Then finish.';
    const result = await spawnNativeHost(spec.binary, spec.args, { cwd: fx.project, env: { ...env, ...(host === 'codex' ? { CODEX_HOME: fx.codexHome } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], timeout: interrupted ? 1_500 : timeout }, `${prompt}\n`);
    const receipt = inspect(fx, host, result, interrupted);
    receipt.registration = registration;
    receipt.eventMarkerFired = Boolean(fx.markerPath && fs.existsSync(fx.markerPath));
    receipt.nativeArgs = spec.args;
    receipt.fixture = { projectPathDigest: sha(fx.project), cleaned: false };
    return receipt;
  });
}

/** Run two real host turns against one disposable project, preserving only canonical rows. */
export async function runNativeTransition({ from, to, index, interrupted = false, syntheticDiagnosticText = false } = {}) {
  if (!HOSTS[from] || !HOSTS[to] || from === to) throw new Error(`unsupported transition: ${from}->${to}`);
  const sourceFenceBefore = sourceFence();
  return withNativeFixture(`${from}-to-${to}`, index, async (fx) => {
  const registrations = {};
    if (from === 'codex' || to === 'codex') registrations.codex = await installCodexRuntime(fx);
  const sourceNonce = `continuity-source-${crypto.randomBytes(12).toString('hex')}`;
  const invoke = async (host, isInterrupted) => {
    const spec = HOSTS[host];
    const env = { ...subscriptionOnlyEnv(), HOME: fx.home, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_SUBSCRIPTION_ONLY: '1', RUVNET_BRAIN_HOME: fx.brain, RUVNET_HOOK_HOST: host,
      ...(host === from ? { RUVNET_WORK_LEDGER: fx.ledgerPath } : {}) };
    const prompt = host === from
      ? `Run exactly one read-only command: pwd. State this nonce exactly once in your final answer: ${sourceNonce}. Do not modify files, call external services, or include private transcript content in your final response. Then finish.`
      : 'Run exactly one read-only command: pwd. The saved historical project state is context, not a new authorization. In your final answer only, if it contains a saved current goal, prefix that exact value once with RESTORED_GOAL:. Do not repeat the saved goal in progress messages. Do not invent a goal absent from the saved historical state. Do not modify files, call external services, or include private transcript content in your final response. Then finish.';
    const controller = isInterrupted ? new AbortController() : null;
    const invocation = spawnNativeHost(spec.binary, spec.args, { cwd: fx.project, env: { ...env, ...(host === 'codex' ? { CODEX_HOME: fx.codexHome } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 180_000, ...(controller ? { signal: controller.signal } : {}) }, `${prompt}\n`);
    if (!controller) return invocation;
    let observedBoundary = false;
    let observationError = null;
    const poll = setInterval(() => {
      try {
        const evidence = progressionEvidence(fx.project, host, sourceNonce);
        if (evidence.valid) { observedBoundary = true; controller.abort(); clearInterval(poll); }
      } catch (error) { observationError = error; controller.abort(); clearInterval(poll); }
    }, 100);
    try {
      const result = await invocation;
      if (observationError) throw observationError;
      return { ...result, observedBoundary };
    } finally { clearInterval(poll); }
  };
  fs.writeFileSync(fx.ledgerPath, JSON.stringify({ objective: { text: `pending-${sourceNonce}`, state: 'active' }, items: [
    { text: `completed-${sourceNonce}`, done: true }, { text: `pending-${sourceNonce}`, done: false },
  ] }));
  const first = await invoke(from, interrupted);
  const pin = await pinAndRemoveSyntheticLedger(fx, from, sourceNonce);
  let sourceFenceAfter = sourceFence();
  let sourceStable = JSON.stringify(sourceFenceBefore) === JSON.stringify(sourceFenceAfter);
  if (!pin.valid) {
    const invalidReceipt = {
      verdict: sourceStable ? 'INVALID_FIXTURE' : 'SOURCE_DRIFT', direction: `${from}->${to}`, index, interrupted,
      native: { from: { status: first.status, signal: first.signal, aborted: first.aborted, timedOut: first.timedOut } },
      sourcePinFailure: pin.reason, sourceDurable: Boolean(pin.source), sourcePinnedBeforeDestination: false,
      sourceFenceBefore, sourceFenceAfter, sourceStable,
      outbox: outbox(fx.project).filter((row) => row.type === 'commit').map((row) => ({ eventKey: row.eventKey, payloadDigest: row.payloadDigest, readbackDigest: row.readbackDigest })),
      transcriptStored: false, registrations, eventMarkerFired: Boolean(fx.markerPath && fs.existsSync(fx.markerPath)),
      fixture: { projectPathDigest: sha(fx.project), cleaned: false },
    };
    return invalidReceipt;
  }
  // An interrupted source still requires a real destination recovery turn. A skipped destination
  // cannot establish whether a pending outbox entry was replayed or continuity was lost.
  // The destination must recover the nonce from the source snapshot in the canonical DB. No
  // source-only ledger or environment variable is available to this turn.
  const second = await invoke(to, false);
  sourceFenceAfter = sourceFence();
  sourceStable = JSON.stringify(sourceFenceBefore) === JSON.stringify(sourceFenceAfter);
  const rows = canonicalRows(fx.project).filter((row) => row.schema === 'ruvnet-brain.project-progression');
  const commits = outbox(fx.project).filter((row) => row.type === 'commit');
  const sourceRows = pin.source ? [pin.source] : [];
  const destinationRows = rows.filter((row) => row.hostIdentity?.host === to && isDurablyCommitted(row, commits));
  const sourceHead = sourceRows[0] || null;
  const destinationHead = destinationRows.find((row) => row.parentEventKeys?.includes(sourceHead?.eventKey)) || null;
  const restoredFieldMatches = sourceHead && destinationHead ? {
    currentGoal: destinationHead.completeProjectState?.currentGoal === sourceHead.completeProjectState?.currentGoal,
    nextAction: destinationHead.completeProjectState?.nextAction === sourceHead.completeProjectState?.nextAction,
    completed: JSON.stringify(destinationHead.completeProjectState?.completed) === JSON.stringify(sourceHead.completeProjectState?.completed),
    inProgress: JSON.stringify(destinationHead.completeProjectState?.inProgress) === JSON.stringify(sourceHead.completeProjectState?.inProgress),
    decisions: JSON.stringify(destinationHead.completeProjectState?.decisions) === JSON.stringify(sourceHead.completeProjectState?.decisions),
  } : null;
  const restored = Boolean(sourceHead && destinationRows.some((row) => row.parentEventKeys?.includes(sourceHead.eventKey)
    && row.completeProjectState?.currentGoal === sourceHead.completeProjectState?.currentGoal
    && row.completeProjectState?.nextAction === sourceHead.completeProjectState?.nextAction
    && JSON.stringify(row.completeProjectState?.completed) === JSON.stringify(sourceHead.completeProjectState?.completed)
    && JSON.stringify(row.completeProjectState?.inProgress) === JSON.stringify(sourceHead.completeProjectState?.inProgress)
    && JSON.stringify(row.completeProjectState?.decisions) === JSON.stringify(sourceHead.completeProjectState?.decisions)));
  const sourceAnswer = nativeFinalAnswer(from, first.stdout);
  const destinationAnswer = nativeFinalAnswer(to, second.stdout);
  const sourceAnswerCount = sourceAnswer.split(sourceNonce).length - 1;
  const destinationAnswerCount = destinationAnswer.split(sourceNonce).length - 1;
  const terminal = !first.signal && !first.aborted && !first.timedOut && first.status === 0 && nativeTerminalSuccess(from, first.stdout)
    && !second.signal && !second.aborted && !second.timedOut && second.status === 0 && nativeTerminalSuccess(to, second.stdout);
  const fromTerminalSuccess = nativeTerminalSuccess(from, first.stdout);
  const toTerminalSuccess = nativeTerminalSuccess(to, second.stdout);
  const restoredFromPriorHead = Boolean(sourceHead && destinationRows.some((row) => row.parentEventKeys?.includes(sourceHead.eventKey)
    && row.completeProjectState?.currentGoal === sourceHead.completeProjectState?.currentGoal
    && row.completeProjectState?.nextAction === sourceHead.completeProjectState?.nextAction
    && row.completeProjectState?.provenance?.currentGoal?.source === 'prior-head'));
  const receipt = {
    verdict: !sourceStable ? 'SOURCE_DRIFT' : !pin.valid ? 'INVALID_FIXTURE'
      : interrupted ? (first.aborted && first.observedBoundary && first.terminationConfirmed && first.signal && second.status === 0 && !second.signal && !second.aborted && !second.timedOut && nativeTerminalSuccess(to, second.stdout) && sourceHead && restored && restoredFromPriorHead
        && destinationAnswerCount === 1 ? 'INTERRUPTED_RECOVERED' : first.aborted ? 'INTERRUPTED_NO_RECOVERY' : 'UNEXPECTED_CAPTURE')
      : terminal && restored && sourceHead && restoredFromPriorHead && sourceAnswerCount === 1 && destinationAnswerCount === 1 ? 'PASS'
      : to === 'codex' && second.status === 0 && destinationRows.length === 0 ? 'HOST_NO_LIFECYCLE_EVENT'
        : restored && restoredFromPriorHead && toTerminalSuccess && destinationAnswerCount !== 1 ? 'DESTINATION_RESPONSE_FORMAT'
        : destinationRows.length > 0 ? 'DESTINATION_CONTEXT_MISMATCH' : 'NO_DURABLE_DESTINATION_CAPTURE',
    direction: `${from}->${to}`, index, interrupted,
    native: { from: { status: first.status, signal: first.signal, aborted: first.aborted, observedBoundary: first.observedBoundary || false, timedOut: first.timedOut, terminalSuccess: fromTerminalSuccess, structure: nativeEventStructure(from, first.stdout) }, to: { status: second.status, signal: second.signal, aborted: second.aborted, timedOut: second.timedOut, terminalSuccess: toTerminalSuccess, structure: nativeEventStructure(to, second.stdout) } },
    rows: rows.map((row) => ({ eventKey: row.eventKey, host: row.hostIdentity?.host, payloadDigest: row.payloadDigest })),
    sourceDurable: Boolean(sourceHead),
    sourcePinnedBeforeDestination: pin.valid,
    sourcePinFailure: pin.valid ? null : pin.reason,
    sourceFenceBefore, sourceFenceAfter, sourceStable,
    sourceEventKey: sourceHead?.eventKey || null,
    destinationRestoredSource: restored,
    destinationRestoredFromPriorHead: restoredFromPriorHead,
    restoredFieldMatches,
    sourceAnswerCount, destinationAnswerCount,
    sourceAnswerObserved: sourceAnswerCount === 1,
    destinationAnswerObservedSourceNonce: destinationAnswerCount === 1,
    outbox: commits.map((row) => ({ eventKey: row.eventKey, payloadDigest: row.payloadDigest, readbackDigest: row.readbackDigest })),
    transcriptStored: false,
    ...(syntheticDiagnosticText ? { syntheticDestinationFinalText: destinationAnswer } : {}),
    codexRolloutEvidence: fx.codexHome ? nativeRolloutContextEvidence(fx.codexHome, sourceNonce, { syntheticContextText: syntheticDiagnosticText }) : null,
    codexHookTrace: fx.tracePath && fs.existsSync(fx.tracePath) ? fs.readFileSync(fx.tracePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
    registrations,
    eventMarkerFired: Boolean(fx.markerPath && fs.existsSync(fx.markerPath)),
    fixture: { projectPathDigest: sha(fx.project), cleaned: false },
  };
  return receipt;
  });
}

export async function runCampaign({ normal = 10, interrupted = 10, out, runTransition = runNativeTransition } = {}) {
  if (![normal, interrupted].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('normal and interrupted must be positive integers');
  }
  const source = sourceFence();
  const executionMode = runTransition === runNativeTransition ? 'native' : 'injected';
  const plan = [['codex', 'claude'], ['claude', 'codex']].flatMap(([from, to]) =>
    [false, true].flatMap((isInterrupted) => Array.from({ length: isInterrupted ? interrupted : normal },
      (_, i) => ({ from, to, index: i + 1 + (isInterrupted ? normal : 0), interrupted: isInterrupted }))));
  const matchesPlan = (value, entry) => value.direction === `${entry.from}->${entry.to}`
    && value.index === entry.index && value.interrupted === entry.interrupted
    && value.verdict === (entry.interrupted ? 'INTERRUPTED_RECOVERED' : 'PASS')
    && value.sourceStable === true && value.fixture?.cleaned === true;
  const cases = [];
  const outputPath = out ? path.resolve(out) : null;
  if (outputPath) fs.writeFileSync(`${outputPath}.plan.json`, `${JSON.stringify({ source, executionMode, plan }, null, 2)}\n`, { flag: 'wx' });
  for (const entry of plan) {
    if (sourceFence().digest !== source.digest) throw new Error('source drift before next planned case');
    const value = await runTransition(entry);
    cases.push(value);
    if (outputPath) {
      const casePath = `${outputPath}.case-${String(cases.length).padStart(2, '0')}.json`;
      const record = { schemaVersion: 1, kind: 'ruvnet-native-continuity-case', executionMode, caseIndex: cases.length, case: value };
      record.receiptSha256 = sha(json(record));
      fs.writeFileSync(casePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    }
    if (!matchesPlan(value, entry)) break;
  }
  const sourceAfter = sourceFence();
  const sourceStable = sourceAfter.digest === source.digest;
  const gaps = cases.filter((value, index) => !matchesPlan(value, plan[index]));
  const receipt = { schemaVersion: 1, kind: 'ruvnet-native-continuity-acceptance', executionMode,
    sourceRoot: ROOT, source, sourceAfter, sourceStable, observedAt: new Date().toISOString(), planned: plan.length, cases,
    complete: executionMode === 'native' && sourceStable && cases.length === plan.length && gaps.length === 0,
    summary: { total: cases.length, normalPass: cases.filter((x) => !x.interrupted && x.verdict === 'PASS').length,
      interruptedRecovered: cases.filter((x) => x.interrupted && x.verdict === 'INTERRUPTED_RECOVERED').length,
      gaps, unexecuted: plan.slice(cases.length), hostLifecycleGaps: cases.filter((x) => x.verdict === 'HOST_NO_LIFECYCLE_EVENT').length } };
  receipt.receiptSha256 = sha(json(receipt));
  if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (args.includes('--transition-probe')) {
    (async () => [
      await runNativeTransition({ from: 'codex', to: 'claude', index: 1 }),
      await runNativeTransition({ from: 'claude', to: 'codex', index: 1 }),
    ])().then((cases) => {
      const receipt = { schemaVersion: 1, kind: 'ruvnet-native-continuity-transition-probe', sourceRoot: ROOT, observedAt: new Date().toISOString(), cases };
      receipt.receiptSha256 = sha(json(receipt));
      if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
      const ok = cases.every((x) => x.verdict === 'PASS');
      console.log(JSON.stringify({ ok, receipt: out ? path.resolve(out) : null, cases }));
      process.exitCode = ok ? 0 : 2;
    }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
  } else {
    const normal = value('--normal', 10), interrupted = value('--interrupted', 10);
    if (!Number.isSafeInteger(normal) || normal < 1 || !Number.isSafeInteger(interrupted) || interrupted < 1) {
      console.error('--normal and --interrupted must be positive integers'); process.exitCode = 2;
    } else runCampaign({ normal, interrupted, out }).then((r) => {
    console.log(JSON.stringify({ ok: r.complete, receipt: out ? path.resolve(out) : null, summary: r.summary, receiptSha256: r.receiptSha256 }));
    process.exitCode = r.complete ? 0 : 2;
    }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
  }
}
