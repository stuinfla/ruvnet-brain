import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressionSnapshot } from './project-progression-contract.mjs';
import { ProjectProgressionStore } from './project-progression-store.mjs';

const HOSTS = new Set(['claude', 'codex']);
const CAPTURE_TRIGGERS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
]);
const PLUGIN_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function aliased(value, camel, snake) {
  const hasCamel = own(value, camel);
  const hasSnake = own(value, snake);
  if (hasCamel && hasSnake) throw new Error(`ambiguous progression field: ${camel}/${snake}`);
  return hasCamel ? value[camel] : value[snake];
}

function progressionExtension(payload) {
  const hasCamel = own(payload, 'projectProgression');
  const hasSnake = own(payload, 'project_progression');
  if (hasCamel && hasSnake) throw new Error('ambiguous progression extension');
  if (!hasCamel && !hasSnake) return null;
  const value = hasCamel ? payload.projectProgression : payload.project_progression;
  requireRecord(value, 'project progression');
  return value;
}

export function hasProjectProgression(payload) {
  requireRecord(payload, 'host payload');
  return progressionExtension(payload) !== null;
}

export function readProgressionAdapterVersion() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')); } catch {
    throw new Error(`progression adapter version is unreadable: ${PLUGIN_JSON}`);
  }
  return requireString(parsed?.version, 'progression adapter version');
}

function normalizeSourceIdentity(value, checkoutRoot) {
  requireRecord(value, 'sourceIdentity');
  const checkoutPath = requireString(value.checkoutPath, 'sourceIdentity.checkoutPath');
  let canonicalCheckout;
  try { canonicalCheckout = fs.realpathSync.native(checkoutPath); } catch {
    throw new Error('source identity checkout path does not resolve to the active checkout');
  }
  if (canonicalCheckout !== checkoutRoot) {
    throw new Error('source identity checkout path does not match the active checkout path');
  }
  return { ...value, checkoutPath: canonicalCheckout };
}

const OBSERVATION_TEXT_LIMIT = 4_096;

function boundedText(value) {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length <= OBSERVATION_TEXT_LIMIT
    ? value
    : `${value.slice(0, OBSERVATION_TEXT_LIMIT)}...[truncated]`;
}

function toolAction(payload) {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const command = boundedText(input.command ?? input.cmd);
  const filePath = boundedText(input.file_path ?? input.path);
  const action = command || filePath;
  if (!action && !payload.tool_name) return null;

  const response = payload.tool_response;
  const responseRecord = response && typeof response === 'object' && !Array.isArray(response)
    ? response
    : null;
  const exitCode = responseRecord && [responseRecord.exit_code, responseRecord.exitCode, responseRecord.status]
    .find((value) => Number.isSafeInteger(value));
  const interrupted = responseRecord?.interrupted === true;
  const failed = interrupted || (Number.isSafeInteger(exitCode) && exitCode !== 0);
  const outcome = payload.hook_event_name === 'PostToolUse'
    ? (failed ? 'failure' : response === undefined ? 'unknown' : 'success')
    : 'pending';
  const observation = {
    trigger: payload.hook_event_name,
    tool: boundedText(payload.tool_name) || 'unknown',
    ...(command ? { command } : {}),
    ...(filePath && !command ? { filePath } : {}),
    outcome,
    ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(interrupted ? { interrupted: true } : {}),
  };
  if (responseRecord) {
    const stdout = boundedText(responseRecord.stdout);
    const stderr = boundedText(responseRecord.stderr);
    if (stdout) observation.stdout = stdout;
    if (stderr) observation.stderr = stderr;
  } else {
    const text = boundedText(response);
    if (text) observation.result = text;
  }
  return observation;
}

function enrichStateWithObservation(state, payload) {
  requireRecord(state, 'completeProjectState');
  const observation = toolAction(payload);
  if (!observation) return state;
  const commands = Array.isArray(state.commands) ? state.commands : [];
  const failures = Array.isArray(state.failures) ? state.failures : [];
  return {
    ...state,
    commands: [...commands, observation],
    ...(observation.outcome === 'failure' ? { failures: [...failures, observation] } : {}),
  };
}

function verifyReceipt(snapshot, receipt) {
  if (!receipt || typeof receipt !== 'object'
    || receipt.eventKey !== snapshot.eventKey
    || receipt.payloadDigest !== snapshot.payloadDigest
    || receipt.readbackDigest !== snapshot.payloadDigest) {
    throw new Error('progression persistence returned an unverifiable exact-readback receipt');
  }
}

export function captureProjectTransition({
  host,
  payload,
  projectDir,
  adapterVersion = readProgressionAdapterVersion(),
  storeFactory = (options) => new ProjectProgressionStore(options),
} = {}) {
  const normalizedHost = requireString(host, 'host').toLowerCase();
  if (!HOSTS.has(normalizedHost)) throw new Error(`unsupported progression host: ${normalizedHost}`);
  requireRecord(payload, 'host payload');
  const sessionIdentity = requireString(payload.session_id, 'host payload session_id');
  const trigger = requireString(payload.hook_event_name, 'host payload hook_event_name');
  if (!CAPTURE_TRIGGERS.has(trigger)) throw new Error(`unsupported progression trigger: ${trigger}`);
  requireString(adapterVersion, 'adapterVersion');
  const progression = progressionExtension(payload);
  if (!progression) throw new Error('host payload is missing a complete progression extension');

  const requestedStorePath = requireString(
    aliased(progression, 'canonicalAgentDbPath', 'canonical_agent_db_path'),
    'canonicalAgentDbPath',
  );
  if (!path.isAbsolute(requestedStorePath)) throw new Error('canonicalAgentDbPath must be absolute');
  const store = storeFactory({ projectDir, requestedStorePath });
  requireRecord(store?.resolution, 'progression store resolution');
  if (path.resolve(requestedStorePath) !== store.resolution.canonicalAgentDbPath) {
    throw new Error('foreign store root rejected');
  }

  const sourceIdentity = normalizeSourceIdentity(
    aliased(progression, 'sourceIdentity', 'source_identity'),
    store.resolution.checkoutRoot,
  );
  const snapshot = createProgressionSnapshot({
    projectIdentity: store.resolution.projectIdentity,
    sourceIdentity,
    hostIdentity: { host: normalizedHost, adapterVersion },
    sessionIdentity,
    sequence: progression.sequence,
    occurredAt: aliased(progression, 'occurredAt', 'occurred_at'),
    trigger,
    parentEventKeys: aliased(progression, 'parentEventKeys', 'parent_event_keys'),
    dedupId: aliased(progression, 'dedupId', 'dedup_id'),
    completeProjectState: enrichStateWithObservation(
      aliased(progression, 'completeProjectState', 'complete_project_state'),
      payload,
    ),
  });
  const receipt = store.capture(snapshot);
  verifyReceipt(snapshot, receipt);
  return { snapshot, receipt };
}
