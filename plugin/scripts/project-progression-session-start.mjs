import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectProgressionStore } from './project-progression-store.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';

export const SESSION_CONTINUITY_LIMIT_BYTES = 8 * 1024;
export const SESSION_CONTINUITY_DEADLINE_MS = 2_500;

const RESTORED_HEADER = '[RuvNet Brain — PROJECT CONTINUITY RESTORED]';
const UNKNOWN_HEADER = '[RuvNet Brain — PROJECT CONTINUITY UNKNOWN]';

const UNKNOWN_EXPLANATIONS = Object.freeze({
  'canonical-path': 'The canonical project AgentDB path could not be verified.',
  'initialization-failed': 'The canonical project AgentDB could not be initialized through managed Ruflo.',
  'managed-ruflo-unavailable': 'The managed global Ruflo CLI is unavailable.',
  'pagination-unavailable': 'Structural AgentDB pagination is unavailable on the managed global Ruflo CLI.',
  'malformed-store': 'Structural AgentDB output is malformed or internally inconsistent.',
  'exact-readback': 'An exact-listed AgentDB row could not be read back by its exact key.',
  'outbox-replay': 'The durable progression outbox could not be replayed safely.',
  'output-bound': 'The verified resume payload exceeds the host context bound.',
  'no-coherent-state': 'No coherent progression head survived validation.',
  'restore-failed': 'The exact structural restore did not complete.',
});

function unknown(reason) {
  const explanation = UNKNOWN_EXPLANATIONS[reason] ?? UNKNOWN_EXPLANATIONS['restore-failed'];
  return {
    status: 'unknown',
    reason,
    context: `${UNKNOWN_HEADER}\n${explanation} Do not claim project state was restored; verify the canonical store before relying on remembered state.`,
  };
}

function classify(error) {
  const message = String(error?.message ?? error ?? '');
  if (/ruflo was not found|managed global ruflo/i.test(message)) return 'managed-ruflo-unavailable';
  if (/canonical agentdb initialization failed/i.test(message)) return 'initialization-failed';
  if (/structural pagination failed/i.test(message)
    && /unknown option|page-info|--offset|unsupported/i.test(message)) return 'pagination-unavailable';
  if (/malformed pagination|pagination total changed|non-advancing pagination|duplicate progression key/i.test(message)) {
    return 'malformed-store';
  }
  if (/exact retrieval failed|exact key\/payload identity mismatch|readback is not json/i.test(message)) {
    return 'exact-readback';
  }
  if (/outbox|replay/i.test(message)) return 'outbox-replay';
  if (/resume payload.*bound/i.test(message)) return 'output-bound';
  if (/no coherent progression state/i.test(message)) return 'no-coherent-state';
  return 'restore-failed';
}

function validResume(result) {
  if (!result || typeof result !== 'object' || typeof result.rendered !== 'string') return false;
  let parsed;
  try { parsed = JSON.parse(result.rendered); } catch { return false; }
  return parsed?.schema === 'ruvnet-brain.project-resume'
    && parsed.schemaVersion === 1
    && Array.isArray(parsed.heads)
    && parsed.heads.length > 0
    && parsed.state && typeof parsed.state === 'object'
    && Array.isArray(parsed.state.resumeConflicts)
    && JSON.stringify(parsed) === JSON.stringify(result.payload);
}

function resultStatus(result) {
  return Number.isInteger(result?.status) ? result.status : 1;
}

function resultText(result, field) {
  const value = result?.[field];
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function initializeCanonicalStore(store, resolution) {
  const key = 'project-continuity-bootstrap-v1';
  const namespace = 'project-progression-control';
  const value = JSON.stringify({
    schema: 'ruvnet-brain.project-continuity-bootstrap',
    schemaVersion: 1,
    projectIdentity: resolution.projectIdentity,
  });
  store.run([
    'memory', 'store', '--key', key, '--value', value,
    '--namespace', namespace, '--no-upsert', '--provenance', 'system_observation',
    '--path', resolution.canonicalAgentDbPath,
  ]);
  const readback = store.run([
    'memory', 'retrieve', '--key', key, '--namespace', namespace,
    '--value-only', '--path', resolution.canonicalAgentDbPath,
  ]);
  if (resultStatus(readback) !== 0 || resultText(readback, 'stdout') !== value
    || !fs.existsSync(resolution.canonicalAgentDbPath)) {
    throw new Error('canonical AgentDB initialization failed');
  }
}

function isProject(resolution) {
  if (resolution.kind === 'git') return true;
  return ['.swarm', '.claude-flow', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
    .some((name) => fs.existsSync(path.join(resolution.projectRoot, name)));
}

function availableContext(reason) {
  return {
    status: 'unavailable',
    reason,
    context: '[RuvNet Brain — PROJECT CONTINUITY UNAVAILABLE]\n'
      + 'This working directory is not a writable adopted project. No AgentDB store was created and no project state was restored.',
  };
}

/**
 * Restore one canonical project's progression at the shared SessionStart boundary.
 * Empty projects are silent. Any adopted-but-unverifiable store is explicit UNKNOWN.
 */
export function restoreProgressionForSession({
  env = process.env,
  cwd = process.cwd(),
  storeFactory,
  maxOutputBytes = SESSION_CONTINUITY_LIMIT_BYTES,
  deadlineMs = SESSION_CONTINUITY_DEADLINE_MS,
  writable = (projectRoot) => {
    try { fs.accessSync(projectRoot, fs.constants.W_OK); return true; } catch { return false; }
  },
} = {}) {
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  let resolution;
  try {
    resolution = resolveProjectStore({ projectDir });
  } catch {
    return unknown('canonical-path');
  }

  if (!isProject(resolution)) return availableContext('non-project');
  if (!writable(resolution.projectRoot)) return availableContext('read-only');
  const initializing = !fs.existsSync(resolution.canonicalAgentDbPath);

  const prefix = `${RESTORED_HEADER}\n`;
  const payloadLimit = maxOutputBytes - Buffer.byteLength(prefix, 'utf8');
  if (!Number.isSafeInteger(payloadLimit) || payloadLimit < 1) return unknown('output-bound');

  try {
    const deadlineAt = Date.now() + deadlineMs;
    const boundedRunner = (binary, args, options) => {
      const remaining = deadlineAt - Date.now();
      if (remaining < 1) throw new Error('restore deadline exceeded');
      const result = spawnSync(binary, args, { ...options, timeout: Math.min(options.timeout, remaining) });
      if (result.error) throw new Error('restore deadline exceeded');
      return result;
    };
    const makeStore = storeFactory ?? ((options) => new ProjectProgressionStore({
      ...options,
      runner: boundedRunner,
    }));
    const store = makeStore({
      projectDir,
      requestedStorePath: resolution.canonicalAgentDbPath,
    });
    if (initializing) {
      fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true, mode: 0o700 });
      initializeCanonicalStore(store, resolution);
    }
    const restored = store.restoreLatest({ maxOutputBytes: payloadLimit });
    if (!validResume(restored)) return unknown('malformed-store');
    const context = `${prefix}${restored.rendered}`;
    if (Buffer.byteLength(context, 'utf8') > maxOutputBytes) return unknown('output-bound');
    return { status: 'restored', context };
  } catch (error) {
    // A structurally enumerated, genuinely empty namespace is normal for a newly adopted project.
    if (/no coherent progression state/i.test(String(error?.message ?? ''))
      && Array.isArray(error?.rejectedCandidates) && error.rejectedCandidates.length === 0) {
      if (initializing && !fs.existsSync(resolution.canonicalAgentDbPath)) return unknown('initialization-failed');
      return {
        status: initializing ? 'initialized' : 'empty',
        context: initializing
          ? '[RuvNet Brain — PROJECT CONTINUITY INITIALIZED]\nThe canonical AgentDB store is ready; no prior progression snapshot exists yet.'
          : '[RuvNet Brain — PROJECT CONTINUITY EMPTY]\nThe canonical AgentDB store was structurally enumerated and contains no prior progression snapshot.',
      };
    }
    return unknown(classify(error));
  }
}
