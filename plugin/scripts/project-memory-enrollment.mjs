/** Consent-gated lazy enrollment. Hooks queue derived events before a detached native bootstrap. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProjectStore, globalEnrollmentAllowed } from './project-store-resolver.mjs';
import { resolveTurnDb, turnCapturePolicyFile } from './turn-outcome-capture.mjs';
import { resolveRuflo, rufloInvocation } from './ruflo-bin.mjs';
import { redactText } from './continuity-events.mjs';
import { enrichStateWithObservation } from './project-progression-hook.mjs';
import { redactProgression } from './project-progression-contract.mjs';
import { normalizeHostEvent } from './hook-input.mjs';
import { maskExcludedPaths, privateProgressionState } from './turn-capture-privacy.mjs';

const canonical = (value) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
export const ENROLLMENT_NAMESPACE = 'project-enrollment';
const receiptName = '.memory-enrollment.json';
const queueName = '.memory-enrollment-pending';

export function enrollmentPlan({ projectDir, env = process.env, deadlineAt = Infinity,
  temporaryRoots = [os.tmpdir(), '/tmp', '/private/tmp'], systemRoots = ['/System', '/Library', '/usr', '/etc', '/var', '/private/var', '/proc', '/sys', '/dev'] } = {}) {
  const home = canonical(env.HOME || env.USERPROFILE || os.homedir());
  const brainHome = canonical(env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain'));
  const resolution = resolveProjectStore({ projectDir, gitTimeoutMs: 500, deadlineAt });
  // The consent guard and the plan must agree on which roots are excluded from default enrollment.
  const consent = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: 500, deadlineAt, enrollmentRoots: { temporaryRoots, systemRoots } });
  if (consent.skipped) return { ...resolution, state: 'disabled', reason: consent.skipped };
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(turnCapturePolicyFile(brainHome), 'utf8')); } catch { /* resolveTurnDb validates any present policy */ }
  const explicit = policy.paths?.[canonical(projectDir)] ?? policy.projects?.[resolution.projectRoot];
  const hasDb = fs.existsSync(resolution.canonicalAgentDbPath);
  // RUVNET_TURN_CAPTURE=off means turn capture is off: it never creates a store. (It does not suspend progression or
  // continuity capture on an existing store; queueBoundary additionally withholds the assistant text while it is off.)
  if (!hasDb && String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') return { ...resolution, state: 'disabled', reason: 'RUVNET_TURN_CAPTURE=off' };
  if (!hasDb && explicit !== 'on') {
    if (resolution.kind !== 'git') return { ...resolution, state: 'disabled', reason: 'non-Git enrollment requires explicit project opt-in' };
    if (!globalEnrollmentAllowed({ resolution, home, brainHome, temporaryRoots, systemRoots })) {
      return { ...resolution, state: 'disabled', reason: 'global enrollment excludes home, temporary, system and Brain cache roots' };
    }
  }
  let enrollmentPending = false;
  const receipt = path.join(resolution.projectRoot, '.swarm', receiptName);
  if (fs.existsSync(receipt)) {
    const stat = fs.lstatSync(receipt);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe enrollment receipt');
    // An unparsable receipt is a torn write from a killed hook: it means "not ready", never "unavailable forever".
    try { enrollmentPending = JSON.parse(fs.readFileSync(receipt, 'utf8')).state === 'pending'; } catch { enrollmentPending = true; }
  }
  return { ...resolution, state: hasDb && !enrollmentPending ? 'existing' : 'pending', brainHome, contentPathExcludes: consent.contentPathExcludes || [] };
}

/** Create-if-absent. A hook killed mid-write leaves a torn FINAL file, which every reader tolerates (an unparsable
 * receipt means pending; an unparsable queue entry is preserved as .corrupt). No hard-link or rename dance: a link
 * window leaves nlink 2 on a killed hook, which the readers' nlink check would then reject forever. */
function createExclusive(file, text) {
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function safeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(directory) !== directory) throw new Error('enrollment directory is not canonical');
}

/** Only a small derived outcome is queued; never prompts, transcripts, tool input or environment. */
function queueBoundary(plan, { event, payload, host, projectDir, env = process.env }) {
  if (!event || typeof payload?.session_id !== 'string' || !payload.session_id) return false;
  const directory = path.join(plan.projectRoot, '.swarm', queueName);
  safeDirectory(directory);
  const turnCaptureOff = String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off';
  const text = turnCaptureOff ? '' : String(payload.last_assistant_message || '');
  const filtered = maskExcludedPaths(text, plan.contentPathExcludes, projectDir);
  const last = filtered === text ? redactText(text).slice(0, 12000) : '[REDACTED:excluded-resource-outcome]';
  const normalized = normalizeHostEvent(payload) || payload;
  const observed = enrichStateWithObservation({ commands: [] }, { ...normalized, hook_event_name: event },
    { contentPathExcludes: plan.contentPathExcludes, projectDir }).commands[0];
  const tool = observed ? { tool_name: redactText(observed.tool), tool_input: {
    ...(observed.command ? { command: redactText(observed.command) } : {}),
    ...(observed.filePath ? { file_path: redactText(observed.filePath) } : {}) },
    tool_response: JSON.parse(redactText(JSON.stringify(Object.fromEntries(Object.entries(observed)
      .filter(([key]) => ['outcome', 'exitCode', 'error', 'signal', 'interrupted', 'isError', 'stdout', 'stderr', 'result'].includes(key)))))) } : {};
  let strategic = {};
  if (payload.projectProgression || payload.project_progression) {
    const extension = redactProgression(payload.projectProgression || payload.project_progression).value;
    extension.completeProjectState = privateProgressionState(extension.completeProjectState, plan.contentPathExcludes, projectDir);
    strategic = { projectProgression: extension };
  }
  const boundary = { projectDir: canonical(projectDir), event, host,
    payload: { session_id: payload.session_id, hook_event_name: event, ...tool, ...strategic, ...(last ? { last_assistant_message: last } : {}) } };
  const digest = crypto.createHash('sha256').update(JSON.stringify(boundary)).digest('hex');
  const file = path.join(directory, `${digest}.json`);
  createExclusive(file, JSON.stringify(boundary));
  const dirFd = fs.openSync(directory, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  return true;
}

export function ensureProjectMemory({ projectDir, env = process.env, event, payload, host = env.RUVNET_HOOK_HOST || 'claude', deadlineAt = Infinity,
  launch = launchEnrollment, planOptions = {} } = {}) {
  try {
    const plan = enrollmentPlan({ ...planOptions, projectDir, env, deadlineAt });
    if (plan.state === 'disabled') return plan;
    if (plan.state === 'existing') {
      const queue = path.join(plan.projectRoot, '.swarm', queueName);
      if (!fs.existsSync(queue) || !fs.readdirSync(queue).some((name) => /^[a-f0-9]{64}\.json$/.test(name))) return plan;
    }
    safeDirectory(path.join(plan.projectRoot, '.swarm'));
    if (plan.state === 'pending') {
      const receipt = path.join(plan.projectRoot, '.swarm', receiptName);
      createExclusive(receipt, JSON.stringify({ schemaVersion: 1, state: 'pending', canonicalAgentDbPath: plan.canonicalAgentDbPath }));
    }
    const queued = plan.state === 'pending' && queueBoundary(plan, { event, payload, host, projectDir, env });
    const launched = launch({ projectDir, env });
    return { ...plan, state: plan.state === 'existing' ? 'existing' : 'pending', queued, launched };
  } catch (error) { return { state: 'unavailable', reason: error.message }; }
}

export function launchEnrollment({ projectDir, env }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--enroll', canonical(projectDir)], {
    cwd: os.tmpdir(), env: { ...env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_MEMORY_PATH: undefined }, detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
  return Boolean(child.pid);
}

/** Exact native append and same-path readback; existing stores are never initialized or replaced. */
export async function enrollProjectMemory({ projectDir, env = process.env, run = spawnSync, replay } = {}) {
  const plan = enrollmentPlan({ projectDir, env });
  if (plan.state === 'disabled') return plan;
  const swarm = path.join(plan.projectRoot, '.swarm');
  safeDirectory(swarm);
  const lock = path.join(swarm, '.memory-enrollment.lock');
  const token = `${process.pid} ${crypto.randomUUID()}`;
  try { fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { ...plan, state: 'pending', reason: 'unsafe enrollment lock' };
    const previous = fs.readFileSync(lock, 'utf8');
    const pid = Number(previous.split(' ')[0]);
    let dead = false;
    if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
    if (!dead || fs.readFileSync(lock, 'utf8') !== previous) return { ...plan, state: 'pending', reason: 'enrollment worker busy' };
    fs.unlinkSync(lock);
    try { fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 }); } catch { return { ...plan, state: 'pending', reason: 'enrollment worker busy' }; }
  }
  const workerDeadlineAt = Date.now() + 60000;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-enrollment-worker-'));
  try {
    const binary = resolveRuflo({ env, home: env.HOME || os.homedir() });
    if (!binary) return { ...plan, state: 'pending', reason: 'global Ruflo unavailable' };
    const key = `project-bootstrap-${plan.projectIdentity.id}`;
    const value = JSON.stringify({ schemaVersion: 1, projectIdentity: plan.projectIdentity });
    const invoke = (args) => { const call = rufloInvocation(binary, args); return run(call.executable, call.args,
      { cwd: scratch, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_MEMORY_PATH: undefined }, encoding: 'utf8', timeout: Math.max(1, Math.min(30000, workerDeadlineAt - Date.now())), maxBuffer: 256 * 1024, shell: false }); };
    if (plan.state !== 'existing') {
      invoke(['memory', 'store', '--key', key, '--value', value, '--namespace', ENROLLMENT_NAMESPACE,
        '--path', plan.canonicalAgentDbPath, '--require-native', '--append-only', '--no-upsert', '--no-embedding']);
      // Concurrent workers may lose the strict insertion race; exact readback still establishes readiness.
      const result = invoke(['memory', 'retrieve', '--key', key, '--namespace', ENROLLMENT_NAMESPACE,
        '--path', plan.canonicalAgentDbPath, '--value-only']);
      if (result.status !== 0 || String(result.stdout || '').trim() !== value) return { ...plan, state: 'pending', reason: 'native bootstrap readback unavailable' };
      const receipt = path.join(swarm, receiptName);
      const temporary = `${receipt}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, state: 'ready', key,
        canonicalAgentDbPath: plan.canonicalAgentDbPath, verifiedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, receipt);
    }
    const queue = path.join(swarm, queueName);
    if (fs.existsSync(queue)) {
      safeDirectory(queue);
      const capture = replay || (await import('./session-snapshot-hook.mjs')).runSessionSnapshotHook;
      for (const name of fs.readdirSync(queue).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 32)) {
        if (Date.now() > workerDeadlineAt - 8000) break;
        const file = path.join(queue, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256000) continue;
        let boundary;
        try { boundary = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
          // Preserve the evidence, stop it blocking every later replay.
          try { fs.renameSync(file, `${file}.corrupt`); } catch { /* retry next boundary */ }
          continue;
        }
        // Original path privacy is rechecked, never replaced by the primary worktree identity.
        const consent = enrollmentPlan({ projectDir: boundary.projectDir, env });
        if (consent.state === 'disabled' || consent.canonicalAgentDbPath !== plan.canonicalAgentDbPath) continue;
        const result = capture(boundary.projectDir, boundary.event, { rawInput: JSON.stringify(boundary.payload), host: boundary.host,
          env, enrollMemory: () => ({ state: 'existing' }) });
        if (result?.turn?.queued || result?.turn?.recorded || result?.continuity?.recorded > 0 || result?.progressionCaptured || result?.deferredToReplayer) fs.unlinkSync(file);
      }
    }
    return { ...plan, state: 'ready' };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* ownership changed */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--enroll') {
  enrollProjectMemory({ projectDir: process.argv[3] }).catch(() => { /* pending queue survives; retry at the next boundary */ });
}
