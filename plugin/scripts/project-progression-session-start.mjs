import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectProgressionStore } from './project-progression-store.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';

const PROGRESSION_NAMESPACE = 'project-progression';

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

/**
 * UNKNOWN IS NOT NEUTRAL WHEN THERE WAS SOMETHING TO FIND.
 *
 * "I could not read your store" and "your store is empty" render almost identically to a reader, and
 * the first is a FAILURE: verified progression exists on disk and the session is about to proceed
 * without it. So when the canonical store exists and holds progression rows, the banner says so in
 * as many words and the result carries `severity: 'error'` for any surface that colours its output.
 * When we cannot even count the rows, the severity stays 'warning' — claiming a failure we cannot
 * evidence would be the same sin one step over.
 */
function unknown(reason, { rowCount = null } = {}) {
  const explanation = UNKNOWN_EXPLANATIONS[reason] ?? UNKNOWN_EXPLANATIONS['restore-failed'];
  const failing = Number.isInteger(rowCount) && rowCount > 0;
  const header = failing ? `${UNKNOWN_HEADER} — RESTORE FAILED` : UNKNOWN_HEADER;
  const evidence = failing
    ? ` ${rowCount} verified progression row(s) are present in the canonical store and could NOT be restored;`
      + ' treat this as a failure to recover known state, not as a project without history.'
    : '';
  return {
    status: 'unknown',
    reason,
    severity: failing ? 'error' : 'warning',
    rowCount,
    context: `${header}\n${explanation}${evidence}`
      + ' Do not claim project state was restored; verify the canonical store before relying on remembered state.',
  };
}

/**
 * Count committed progression rows WITHOUT paying for a restore. Used only to decide how loudly an
 * UNKNOWN should speak, so it never throws and never falls back to a CLI spawn: a count we cannot
 * take cheaply is reported as null ("cannot tell"), which downgrades the banner rather than the run.
 */
function committedRowCount(canonicalAgentDbPath) {
  try {
    const result = withProgressionReader(canonicalAgentDbPath,
      (reader) => reader.listKeys(PROGRESSION_NAMESPACE).length);
    return result.ok ? result.value : null;
  } catch { return null; }
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

/**
 * One line, only when there is something to say. Durable-but-uncommitted snapshots are evidence the
 * session must know about: they will be committed at the next capture boundary, and until then the
 * restored head is not the newest thing that happened.
 */
function pendingNotice(pendingReplay) {
  if (!Number.isInteger(pendingReplay) || pendingReplay < 1) return '';
  return `\n${pendingReplay} uncommitted snapshot(s) pending replay; they commit at the next capture`
    + ' boundary (Stop / PreCompact / SessionEnd) or when you run /ruvnet-brain:checkpoint.';
}

function isProject(resolution) {
  if (resolution.kind === 'git') return true;
  return ['.swarm', '.claude-flow', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
    .some((name) => fs.existsSync(path.join(resolution.projectRoot, name)));
}

/**
 * ADR-073 §6 — continuity-unavailable. A directory that is not a writable adopted project has no
 * continuity to restore and no store to blame, so this is neither a success nor a failure: it is the
 * absence of the question. Distinct from `unknown`, which means the question was asked and missed.
 */
function unavailable(reason) {
  return {
    status: 'unavailable',
    reason,
    severity: 'info',
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

  if (!isProject(resolution)) return unavailable('non-project');
  if (!writable(resolution.projectRoot)) return unavailable('read-only');
  const initializing = !fs.existsSync(resolution.canonicalAgentDbPath);
  const rowCount = initializing ? 0 : committedRowCount(resolution.canonicalAgentDbPath);
  const miss = (reason) => unknown(reason, { rowCount });

  const prefix = `${RESTORED_HEADER}\n`;
  const payloadLimit = maxOutputBytes - Buffer.byteLength(prefix, 'utf8');
  if (!Number.isSafeInteger(payloadLimit) || payloadLimit < 1) return miss('output-bound');

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
    // COMMITTED ROWS ONLY (ADR-073 §5). Replay is a write, a write is a `ruflo memory store`
    // process, and one of those costs more than this entire boundary's budget. Pending durable
    // snapshots are REPORTED below and replayed at the next capture boundary or by /checkpoint.
    const restored = store.restoreLatest({ maxOutputBytes: payloadLimit, replayPending: false });
    if (!validResume(restored)) return miss('malformed-store');
    const context = `${prefix}${restored.rendered}${pendingNotice(restored.pendingReplay)}`;
    if (Buffer.byteLength(context, 'utf8') > maxOutputBytes) return miss('output-bound');
    return { status: 'restored', severity: 'info', pendingReplay: restored.pendingReplay, context };
  } catch (error) {
    // A structurally enumerated, genuinely empty namespace is normal for a newly adopted project.
    if (/no coherent progression state/i.test(String(error?.message ?? ''))
      && Array.isArray(error?.rejectedCandidates) && error.rejectedCandidates.length === 0) {
      if (initializing && !fs.existsSync(resolution.canonicalAgentDbPath)) return miss('initialization-failed');
      const pending = pendingNotice(error?.pendingReplay);
      return {
        status: initializing ? 'initialized' : 'empty',
        severity: 'info',
        pendingReplay: error?.pendingReplay ?? 0,
        context: (initializing
          ? '[RuvNet Brain — PROJECT CONTINUITY INITIALIZED]\nThe canonical AgentDB store is ready; no prior progression snapshot exists yet.'
          : '[RuvNet Brain — PROJECT CONTINUITY EMPTY]\nThe canonical AgentDB store was structurally enumerated and contains no prior progression snapshot.')
          + pending,
      };
    }
    return miss(classify(error));
  }
}
