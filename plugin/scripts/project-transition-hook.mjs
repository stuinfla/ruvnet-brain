/** Observed transitions are context, never instructions or completion claims. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { developmentHooksSuspended } from './development-maintenance.mjs';
import { resolveTurnDb } from './turn-outcome-capture.mjs';
import { privateTransitionObservation } from './turn-capture-privacy.mjs';
import { automaticProgressionSuspensionResult } from './project-progression-suspension.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactText, normalizeToolOutcome } from './continuity-events.mjs';
import { conditionNotice } from './continuity-journal.mjs';
import { normalizeHostEvent } from './hook-input.mjs';
import { runNativeUserIntake } from './native-user-intake.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { redactProgression, restoreProjectProgression, digestCanonical, validateProgressionSnapshot } from './project-progression-contract.mjs';
import { runSessionSnapshotHook, effectiveBudgetMs, queueCapture, replayOutboxDetached, runOutboxReplay } from './session-snapshot-hook.mjs';

const EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop']);
const TOPICS = [
  [/\b(agentdb|memory|recall|capture|checkpoint)\b/i, 'project memory'],
  [/\b(test|tests|vitest|pytest|qa|check)\b/i, 'validation'],
  [/\b(release|publish|deploy|deployment)\b/i, 'release'],
  [/\b(doc|docs|documentation|readme)\b/i, 'documentation'],
  [/\b(security|authentication|permission|secret)\b/i, 'security'],
  [/\b(runtime|hook|hooks|process|session)\b/i, 'runtime integration'],
  [/\b(ui|interface|page|browser)\b/i, 'user interface'],
];
const ACTIONS = ['fix', 'repair', 'implement', 'add', 'remove', 'update', 'audit', 'review', 'verify', 'test', 'explain', 'build'];
const MEANINGFUL_TOOLS = /(?:^|__)(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch|Bash|exec_command|write_stdin|agent_spawn|Task|Agent)$/i;

// Classification deliberately returns dictionary words only. Redaction alone cannot
// distinguish a password from an ordinary word in arbitrary free text.
export function semanticIntent(text) {
  const safe = String(text ?? '').slice(0, 8192);
  const action = ACTIONS.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(safe)) || 'discuss';
  const topics = TOPICS.filter(([pattern]) => pattern.test(safe)).map(([, label]) => label);
  return { action, subjects: topics.length ? topics : ['project work'] };
}

/** Selected user task clause, not a raw prompt archive and never authority to resume. */
export function selectedUserIntent(value) {
  if (typeof value !== 'string') return null;
  const bounded = value.slice(0, 64 * 1024);
  const redacted = redactText(bounded);
  const prose = redacted.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '');
  const lines = prose.split(/\r?\n/).filter((line) => line.trim()
    && !/^\s*(?:>|\{|\[|(?:tool|stdout|stderr|output|log|trace|result)\s*:|\d{4}-\d\d-\d\d)/i.test(line));
  const selected = lines.find((line) => /\b(?:fix|repair|implement|add|remove|update|audit|review|verify|test|explain|build|why|how|what)\b/i.test(line));
  if (!selected) return null;
  const clause = selected.trim().split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ');
  if (/\[REDACTED|password|passwd|credential|private key|authorization|bearer|api.?key|secret|(?:access|auth)[-_ ]?token/i.test(clause)) return null;
  let excerpt = '';
  for (const character of clause) {
    if (Buffer.byteLength(excerpt + character, 'utf8') > 240) break;
    excerpt += character;
  }
  if (!excerpt) return null;
  return { text: excerpt, source: 'user-prompt-excerpt', authoritative: false,
    redacted: bounded !== redacted, truncated: excerpt !== clause || bounded !== value };
}

export function normalizeTransition(payload, event, { now = () => new Date().toISOString(), eventId = () => crypto.randomUUID(), host } = {}) {
  const input = normalizeHostEvent(payload);
  if (!EVENTS.has(event)) return { skipped: 'unsupported transition' };
  if (!input || typeof input.session_id !== 'string' || !input.session_id) return { skipped: 'no session identity' };
  const common = { id: eventId(), occurredAt: now(), trigger: event, source: 'host-observation', authoritative: false };
  if (event === 'UserPromptSubmit') {
    const text = input.prompt ?? input.user_prompt;
    if (typeof text !== 'string' || !text.trim()) return { skipped: 'no user intent supplied' };
    const selectedIntent = selectedUserIntent(text);
    return { ...common, kind: 'user-goal-observation', intent: semanticIntent(text),
      ...(selectedIntent ? { selectedIntent } : {}), outcome: 'requested' };
  }
  if (event === 'SubagentStop') return { ...common, kind: 'child-observation', outcome: 'child-stopped', parentGoalChanged: false };
  if (!MEANINGFUL_TOOLS.test(String(input.tool_name ?? ''))) return { skipped: 'non-material tool observation' };
  const toolInput = input.tool_input ?? {};
  const response = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const normalized = normalizeToolOutcome({ ...input, content: input.tool_response,
    ...(event === 'PostToolUseFailure' ? { is_error: true } : {}) });
  const exitCode = normalized.exitCode;
  const error = typeof response.error === 'string' && response.error ? redactText(response.error).slice(0, 4096) : undefined;
  const signal = typeof response.signal === 'string' && response.signal ? redactText(response.signal).slice(0, 100) : undefined;
  // Measured native Claude Bash PostToolUse has no exit code. Its completion envelope
  // is host-reported success, never an inferred exit-code zero. Other hosts stay unknown.
  const claudeBashCompletion = host === 'claude' && input.tool_name === 'Bash' && event === 'PostToolUse'
    && typeof response.stdout === 'string' && typeof response.stderr === 'string'
    && response.interrupted === false && typeof response.isImage === 'boolean'
    && typeof response.noOutputExpected === 'boolean';
  const outcome = event === 'PreToolUse' ? 'pending'
    : normalized.outcome === 'fail' ? 'failure'
    : ['interrupted', 'pending'].includes(normalized.outcome) ? normalized.outcome
    : normalized.outcome === 'pass' || normalized.successfulToolResult ? 'success'
    : !normalized.uncertain && (response.outcome === 'success' || claudeBashCompletion) ? 'success' : 'unknown';
  return { ...common, kind: 'tool-observation', tool: String(input.tool_name).split('__').at(-1).slice(0, 100),
    intent: semanticIntent(toolInput.description ?? toolInput.command ?? toolInput.cmd ?? toolInput.file_path), outcome,
    ...(outcome === 'success' && claudeBashCompletion ? { outcomeEvidence: 'claude-bash-completion' } : {}),
    ...(event !== 'PreToolUse' && Number.isSafeInteger(exitCode) ? { exitCode } : event !== 'PreToolUse' && (response.exit_code === null || response.exitCode === null) ? { exitCode: null } : {}),
    ...(event !== 'PreToolUse' && error ? { error } : {}),
    ...(event !== 'PreToolUse' && signal ? { signal } : {}) };
}

export function readTransitionHistory(resolution, { deadlineAt = Infinity, signal } = {}) {
  const remaining = () => { if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('transition history deadline exceeded or aborted'); };
  remaining();
  const result = withProgressionReader(resolution.canonicalAgentDbPath, (reader) => {
    const keys = reader.listKeys('project-progression');
    // Complete ancestry under the shared deadline; never a lifetime row cap or latest-N window.
    remaining();
    return keys.map((key) => { remaining(); return JSON.parse(reader.readContent('project-progression', key)); });
  }, { deadlineAt, signal });
  remaining();
  if (!result.ok) throw new Error('canonical transition history unavailable');
  return result.value;
}

export function buildTransitionProgression({ resolution, observation, snapshots = [], sessionIdentity, host, sourceIdentity: originalSourceIdentity }) {
  const restored = restoreProjectProgression(snapshots, { expectedProjectIdentity: resolution.projectIdentity });
  if (snapshots.length && !restored.ok) throw new Error('nonempty transition journal has no coherent ancestry');
  return buildRestoredTransitionProgression({ resolution, observation, snapshots, sessionIdentity, host, sourceIdentity: originalSourceIdentity }, restored);
}

// Only the validated result computed in this module can reach this private builder.
function buildRestoredTransitionProgression({ resolution, observation, snapshots, sessionIdentity, host, sourceIdentity: originalSourceIdentity }, restored) {
  const heads = snapshots.filter((snapshot) => restored.heads.includes(snapshot.eventKey));
  const prior = restored.state;
  const empty = Object.fromEntries(['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions', 'changedFiles', 'commands', 'proofArtifacts', 'untested', 'resumeConflicts'].map((key) => [key, []]));
  const state = prior ? structuredClone(prior) : { ...empty, currentGoal: null, nextAction: null, acceptanceContract: null, activeProcess: null, activeStep: null };
  delete state.sourceIdentity;
  delete state.journalHeads;
  state.activeStep = observation.trigger;
  state.observations = [...(Array.isArray(state.observations) ? state.observations : []), observation];
  if (observation.kind === 'tool-observation') {
    state.commands = [...state.commands, observation];
    if (['failure', 'interrupted'].includes(observation.outcome)) state.failures = [...state.failures, observation];
  }
  state.evidence = { ...(state.evidence ?? {}), transition: { originalEventId: observation.id, originalOccurredAt: observation.occurredAt,
    sourceMeasurement: 'head-only; tree digests not measured at this boundary', authoritative: false } };
  // Source identity was measured at observation time, never reconstructed by a later drainer.
  const sourceIdentity = originalSourceIdentity || observeTransitionSource(resolution);
  return redactProgression({ canonicalAgentDbPath: resolution.canonicalAgentDbPath, sourceIdentity,
    sequence: Math.max(0, ...heads.map((item) => item.sequence)) + 1, occurredAt: observation.occurredAt,
    parentEventKeys: restored.heads, dedupId: `${host}:${sessionIdentity}:${observation.id}`, completeProjectState: state }).value;
}

export function observeTransitionSource(resolution, projectDir = resolution.checkoutRoot, { deadlineAt = Infinity, signal } = {}) {
  const check = () => { if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('transition source deadline exceeded or aborted'); }; check();
  let head = 'unmeasured';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolution.checkoutRoot, encoding: 'utf8', timeout: Math.max(1, Math.floor(Math.min(300, deadlineAt - Date.now()))), killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { check(); /* explicitly unmeasured */ }
  check();
  return { checkoutPath: resolution.checkoutRoot, capturePath: fs.realpathSync.native(projectDir),
    worktreeId: crypto.createHash('sha256').update(resolution.checkoutRoot).digest('hex'), branch: 'unmeasured', head,
    trackedDigest: 'unmeasured-at-transition', untrackedDigest: 'unmeasured-at-transition', dirtyTreeDigest: 'unmeasured-at-transition' };
}

/** Called only by the fenced queue drainer; current heads merge, original observations stay fixed. */
export function captureNormalizedTransition(job, { readHistory = readTransitionHistory, capture = runSessionSnapshotHook,
  budgetMs = 6500, makeStoreFactory, now = Date.now, env = process.env,
  deadlineAt: inheritedDeadlineAt = Infinity, signal } = {}) {
  const suspended = automaticProgressionSuspensionResult(env);
  if (suspended) return suspended;
  const deadlineAt = Math.min(inheritedDeadlineAt, now() + budgetMs);
  const checkDeadline = () => { if (signal?.aborted || now() >= deadlineAt) throw new Error('restore deadline exceeded'); };
  checkDeadline();
  const resolution = resolveProjectStore({ projectDir: job.originProjectDir, gitTimeoutMs: Math.max(1, Math.floor(Math.min(500, budgetMs, deadlineAt - now()))), deadlineAt });
  const normalized = job.payload.normalizedTransition;
  if (!normalized || normalized.observation?.authoritative !== false || !normalized.observation?.id
    || normalized.sourceIdentity?.checkoutPath !== resolution.checkoutRoot) throw new Error('invalid normalized transition binding');
  const policy = resolveTurnDb({ projectDir: job.originProjectDir, brainHome: env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain'), deadlineAt, signal });
  checkDeadline();
  if (policy.skipped) throw new Error(policy.skipped);
  if (digestCanonical(privateTransitionObservation(normalized.observation, policy.contentPathExcludes, job.originProjectDir)) !== digestCanonical(normalized.observation)) throw new Error('content exclusions changed; immutable transition retained');
  const snapshots = readHistory(resolution, { deadlineAt, signal });
  checkDeadline();
  const restored = restoreProjectProgression(snapshots, { expectedProjectIdentity: resolution.projectIdentity });
  if (snapshots.length && !restored.ok) {
    throw new Error('nonempty transition journal has no coherent ancestry');
  }
  // A failed first store already fsynced a snapshot to the outbox. If startup/replay committed
  // that snapshot before returning to its observation job, verify the same event rather than
  // turn one observed action into a second event at a new sequence.
  const dedupId = `${job.host}:${job.payload.session_id}:${normalized.observation.id}`;
  const committed = snapshots.find((snapshot) => snapshot.dedupId === dedupId
    && validateProgressionSnapshot(snapshot, { expectedProjectIdentity: resolution.projectIdentity }).ok
    && digestCanonical(snapshot.sourceIdentity) === digestCanonical(normalized.sourceIdentity)
    && snapshot.completeProjectState.observations?.some((value) => digestCanonical(value) === digestCanonical(normalized.observation)));
  if (committed) return { progressionCaptured: true, eventId: normalized.observation.id,
    receipt: { eventKey: committed.eventKey, payloadDigest: committed.payloadDigest,
      readbackDigest: committed.payloadDigest, readPath: 'canonical progression reader' } };
  const progression = buildRestoredTransitionProgression({ resolution, observation: normalized.observation,
    snapshots, sessionIdentity: job.payload.session_id, host: job.host,
    sourceIdentity: normalized.sourceIdentity }, restored);
  checkDeadline();
  const result = capture(job.originProjectDir, job.event, { host: job.host, env, budgetMs: Math.max(0, deadlineAt - now()), deadlineAt, signal,
    ...(makeStoreFactory ? { makeStoreFactory } : {}), writeMetadata: false,
    rawInput: JSON.stringify({ session_id: job.payload.session_id, hook_event_name: job.event, projectProgression: progression }),
    captureTurn: () => ({ recorded: false, skipped: 'transition boundary' }),
    captureEvents: () => ({ recorded: 0, skipped: 'transition boundary' }) });
  return { ...result, eventId: normalized.observation.id };
}

export function runProjectTransitionHook(projectDir, event, { payload = {}, host = process.env.RUVNET_HOOK_HOST || 'claude',
  readHistory = readTransitionHistory, capture = runSessionSnapshotHook, captureNativeIntake = runNativeUserIntake, env = process.env,
  deadlineAt: inheritedDeadlineAt = Infinity, signal } = {}) {
  const deadlineAt = Number.isFinite(inheritedDeadlineAt) ? inheritedDeadlineAt : Date.now() + Math.min(6500, effectiveBudgetMs(env));
  const check = () => { if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('transition capture deadline exceeded or aborted; unavailable'); }; check();
  if (developmentHooksSuspended(projectDir)) return { state: 'skipped', reason: 'development hooks suspended' };
  const suspended = automaticProgressionSuspensionResult(env, { state: 'suspended', reason: 'automatic project progression is operator-suspended' });
  if (suspended) return suspended;
  payload = normalizeHostEvent(payload);
  let observation = normalizeTransition(payload, event, { host });
  const nativeBoundary = ['UserPromptSubmit', 'PreToolUse'].includes(event) && payload.hook_event_name === event;
  if (observation.skipped && !nativeBoundary) return { state: 'skipped', reason: observation.skipped };
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  const consent = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: Math.max(1, Math.floor(Math.min(500, deadlineAt - Date.now()))), deadlineAt, signal });
  check();
  if (consent.skipped) return { state: 'skipped', reason: consent.skipped };
  const resolution = resolveProjectStore({ projectDir, gitTimeoutMs: Math.max(1, Math.floor(Math.min(500, deadlineAt - Date.now()))), deadlineAt });
  check();
  if (!fs.existsSync(resolution.canonicalAgentDbPath)) return { state: 'skipped', reason: 'no adopted canonical store' };
  const nativeIntake = () => nativeBoundary ? captureNativeIntake(projectDir, { payload, host, env, deadlineAt, signal }) : undefined;
  if (observation.skipped) return { state: 'skipped', reason: observation.skipped, nativeUserIntake: nativeIntake() };
  observation = privateTransitionObservation(observation, consent.contentPathExcludes, projectDir, payload);
  const transportEvent = event === 'PostToolUseFailure' ? 'PostToolUse' : event;
  // Fsync the selected observation BEFORE any history enumeration/merge. A deadline, corruption,
  // or long-lived project must leave it pending rather than erase it or fabricate root ancestry.
  const queued = queueCapture({ projectDir: resolution.projectRoot, originProjectDir: projectDir, env, event: transportEvent, host, deadlineAt, signal,
    payload: { session_id: payload.session_id, hook_event_name: transportEvent,
      normalizedTransition: { observation, sourceIdentity: observeTransitionSource(resolution, projectDir, { deadlineAt, signal }) } } });
  if (!queued) return { state: 'degraded', reason: 'normalized observation queue unwritable', eventId: observation.id };
  // Preserve the selected observation before a canonical intake writer can exhaust its budget.
  const nativeUserIntake = nativeIntake();
  if (signal?.aborted || Date.now() >= deadlineAt) return { state: 'pending', eventId: observation.id, nativeUserIntake, reason: 'durable observation retained; capture deadline exceeded or aborted' };
  let result = null;
  runOutboxReplay({ projectDir: resolution.projectRoot, env, deadlineAt: deadlineAt - 500, signal,
    budgetMs: Math.max(0, Math.min(6500, deadlineAt - 500 - Date.now())),
    captureNormalized: (job, options) => captureNormalizedTransition(job, { ...options, env, readHistory, capture }),
    onCaptured: (captured) => { if (captured?.eventId === observation.id) result = captured; } });
  if (!result?.receipt && !signal?.aborted && Date.now() < deadlineAt) replayOutboxDetached({ projectDir: resolution.projectRoot, env, deadlineAt, signal });
  return { state: result?.progressionCaptured && result.receipt ? 'committed' : 'pending', eventId: observation.id, result, nativeUserIntake };
}

/** One pending-readback condition across prompt/tool boundaries and both CLI entrypoints. */
export function transitionPendingNotice(projectDir, payload, message, { deadlineAt = Infinity, signal } = {}) {
  if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('transition notice deadline exceeded or aborted');
  const { projectRoot } = resolveProjectStore({ projectDir, gitTimeoutMs: Math.max(1, Math.floor(Math.min(500, deadlineAt - Date.now()))), deadlineAt });
  if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('transition notice deadline exceeded or aborted');
  return conditionNotice({ swarm: path.join(projectRoot, '.swarm'),
    session: normalizeHostEvent(payload)?.session_id, condition: 'project-transition-pending-readback', message });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const supplied = Number(process.env.RUVNET_SESSION_SNAPSHOT_DEADLINE_AT);
    const deadlineAt = Math.min(performance.timeOrigin + Math.min(6500, effectiveBudgetMs()), Number.isFinite(supplied) ? supplied : Infinity);
    const result = runProjectTransitionHook(projectDir, process.argv[2], { payload, deadlineAt });
    if (result.state === 'degraded') process.stdout.write(JSON.stringify({ systemMessage: 'Project memory transition capture degraded; the new observation was not durably queued or exact-readback verified.' }));
    if (result.state === 'pending') {
      const message = transitionPendingNotice(projectDir, payload, 'Project memory transition is pending; exact AgentDB readback was not verified at this boundary.', { deadlineAt });
      if (message) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: process.argv[2], additionalContext: message } }));
    }
  } catch { process.stdout.write(JSON.stringify({ systemMessage: 'Project memory transition capture degraded; exact readback was not verified.' })); }
}
