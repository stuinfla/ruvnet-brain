/**
 * project-progression-producer.mjs — the thing that was missing.
 *
 * `captureProjectTransition` has always been able to store a complete project snapshot. Nothing ever
 * BUILT one: it was only reachable when a host payload already carried a `projectProgression`
 * extension, and no host emits one. So the North Star's "append-only full project snapshots" had a
 * verified writer, a verified reader, and no producer — which is why the canonical store held zero
 * rows in the project-progression namespace while 378 hand-written `project-state-current` notes
 * accumulated beside it. This module is the producer.
 *
 * EVERY FIELD CARRIES PROVENANCE, and the order of authority is fixed:
 *
 *   ledger             the user's own work ledger — they wrote it, so it wins
 *   owner-note         the newest `project-state-current%` note — the owner's own narrative
 *   prior-head         the previous snapshot: sequence, parent links, carried acceptance
 *   git                branch / HEAD / the three tree digests — mechanical, never inferred
 *   transcript-derived a bounded single-sentence reduction, used ONLY where nothing above spoke
 *
 * Anything derived from the transcript or from repository contents is marked
 * `authoritative: false`. A later session reading this snapshot can then tell the difference between
 * "the user said this" and "we guessed this from the tail of a conversation" — a distinction that
 * disappears the moment provenance is dropped, and whose disappearance is how an inferred goal ends
 * up being obeyed as an instruction.
 *
 * THE PRIVACY BOUNDARY. The user's prompt and the assistant's reply are never persisted. The
 * transcript contributes a REFERENCE (path, byte span, record count, sha256 of the exact bytes read)
 * and at most two derived sentences of DERIVED_TEXT_LIMIT each. redactProgression then runs over the
 * whole snapshot inside createProgressionSnapshot, so secret-shaped material cannot survive even
 * within those bounds.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { digestCanonical, restoreProjectProgression } from './project-progression-contract.mjs';
import { readOwnerNote, readSourceIdentity, readTranscriptReference, readWorkLedger } from './project-progression-sources.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';

const PROGRESSION_NAMESPACE = 'project-progression';
const OWNER_NOTE_NAMESPACES = Object.freeze(['default']);

export const PROVENANCE_SOURCES = Object.freeze(['ledger', 'owner-note', 'prior-head', 'git', 'transcript-derived']);

const AUTHORITATIVE = Object.freeze({
  ledger: true, 'owner-note': true, 'prior-head': true, git: true, 'transcript-derived': false,
});

function marker(source) {
  if (!PROVENANCE_SOURCES.includes(source)) throw new Error(`unknown provenance source: ${source}`);
  return { source, authoritative: AUTHORITATIVE[source] };
}

/**
 * Read the owner's `project-state-current%` notes from the canonical store WITHOUT a CLI spawn.
 * The owner's convention writes them into the project's own namespace and into `default`; both are
 * checked, because which one a given session used depends on whether `-n` was passed.
 */
function ownerNoteRows(canonicalAgentDbPath, projectNamespace) {
  const namespaces = [...new Set([projectNamespace, ...OWNER_NOTE_NAMESPACES].filter(Boolean))];
  const result = withProgressionReader(canonicalAgentDbPath, (reader) => {
    const rows = [];
    for (const namespace of namespaces) {
      for (const key of reader.listKeys(namespace)) {
        if (!key.startsWith('project-state-current')) continue;
        const content = reader.readContent(namespace, key);
        if (typeof content === 'string') rows.push({ key, namespace, content });
      }
    }
    return rows;
  });
  return result.ok ? result.value : [];
}

/** The committed heads, computed the same way a restore computes them. Empty store → no heads. */
function committedHeads(canonicalAgentDbPath, projectIdentity) {
  const result = withProgressionReader(canonicalAgentDbPath, (reader) => {
    const snapshots = [];
    for (const key of reader.listKeys(PROGRESSION_NAMESPACE)) {
      const content = reader.readContent(PROGRESSION_NAMESPACE, key);
      if (typeof content !== 'string') continue;
      try { snapshots.push(JSON.parse(content)); } catch { /* a malformed row is the restore's problem */ }
    }
    return snapshots;
  });
  if (!result.ok) return { heads: [], readPath: `unavailable (${result.reason})` };
  const restored = restoreProjectProgression(result.value, { expectedProjectIdentity: projectIdentity });
  const byKey = new Map(result.value.map((snapshot) => [snapshot?.eventKey, snapshot]));
  return { heads: restored.heads.map((key) => byKey.get(key)).filter(Boolean), readPath: 'node:sqlite' };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

/**
 * Build the `projectProgression` extension for one host payload.
 *
 * @returns {{ projectProgression: object, provenance: object, skipped?: { reason: string } }}
 *   `skipped` is set when this capture would add nothing: a snapshot whose complete project state
 *   and source identity are byte-identical to the previous head is a no-op, and writing it would let
 *   three capture boundaries per session grow memory.db without bound for sessions that changed
 *   nothing. The caller does not write when `skipped` is present.
 */
export function buildProjectProgression({
  resolution,
  payload = {},
  host = 'claude',
  env = process.env,
  now = () => new Date().toISOString(),
  trigger = payload.hook_event_name,
} = {}) {
  if (!resolution || typeof resolution !== 'object') throw new TypeError('resolution must be a project store resolution');
  const source = readSourceIdentity({ checkoutRoot: resolution.checkoutRoot, kind: resolution.kind });
  const ledger = readWorkLedger({ projectId: resolution.projectIdentity.id, env });
  const note = readOwnerNote(() => ownerNoteRows(resolution.canonicalAgentDbPath, path.basename(resolution.projectRoot)));
  const transcript = readTranscriptReference(payload.transcript_path, { host });
  const { heads } = committedHeads(resolution.canonicalAgentDbPath, resolution.projectIdentity);

  const priorSequence = heads.reduce((highest, head) => Math.max(highest, head.sequence ?? 0), 0);
  const priorState = heads.length === 1 ? heads[0].completeProjectState : null;

  const provenance = {};
  const record = (field, sourceName) => { provenance[field] = marker(sourceName); };

  // GOAL — the ledger's oldest open item is what the user actually committed to; the owner note and
  // the prior head come next; the transcript is the last resort and is never authoritative.
  let currentGoal = ledger.open[0] ?? null;
  if (currentGoal) record('currentGoal', 'ledger');
  else if (typeof priorState?.currentGoal === 'string' && priorState.currentGoal) {
    currentGoal = priorState.currentGoal;
    record('currentGoal', 'prior-head');
  } else if (transcript.derivedGoal) {
    currentGoal = transcript.derivedGoal;
    record('currentGoal', 'transcript-derived');
  } else if (note?.excerpt) {
    currentGoal = note.excerpt.split('\n')[0].slice(0, 240);
    record('currentGoal', 'owner-note');
  } else record('currentGoal', 'git');

  // NEXT ACTION — the next open ledger item, else the assistant's own last stated step (derived).
  let nextAction = ledger.open[1] ?? ledger.open[0] ?? null;
  if (nextAction) record('nextAction', 'ledger');
  else if (transcript.derivedNextAction) {
    nextAction = transcript.derivedNextAction;
    record('nextAction', 'transcript-derived');
  } else if (typeof priorState?.nextAction === 'string' && priorState.nextAction) {
    nextAction = priorState.nextAction;
    record('nextAction', 'prior-head');
  } else record('nextAction', 'git');

  const decisions = [];
  if (ledger.objective && typeof ledger.objective.text === 'string' && ledger.objective.text) {
    decisions.push({ text: ledger.objective.text, state: ledger.objective.state ?? null, source: 'ledger' });
    record('decisions', 'ledger');
  } else if (note?.excerpt) {
    decisions.push({ text: note.excerpt, note: note.key, truncated: note.truncated, source: 'owner-note' });
    record('decisions', 'owner-note');
  } else record('decisions', 'prior-head');

  record('plan', ledger.present ? 'ledger' : 'prior-head');
  record('completed', ledger.present ? 'ledger' : 'prior-head');
  record('inProgress', ledger.present ? 'ledger' : 'prior-head');
  record('changedFiles', 'git');
  record('sourceIdentity', 'git');

  const completeProjectState = {
    currentGoal,
    nextAction,
    acceptanceContract: priorState?.acceptanceContract ?? null,
    activeProcess: 'ProjectContinuity',
    activeStep: trigger ?? 'unknown',
    plan: ledger.open.map((text) => ({ id: text.slice(0, 64), status: 'open', source: 'ledger' })),
    completed: uniqueStrings(ledger.done),
    inProgress: uniqueStrings(ledger.open),
    blockers: [],
    failures: [],
    decisions,
    // The three digests already identify the tree exactly; enumerating paths here would duplicate
    // that and, for an untracked file, would put a filename we were never asked to keep into a row.
    changedFiles: [],
    commands: [],
    proofArtifacts: [],
    untested: [],
    resumeConflicts: [],
    provenance,
    evidence: {
      workLedger: { file: ledger.file, present: ledger.present, open: ledger.open.length, done: ledger.done.length },
      ownerNote: note ? { key: note.key, excerptSha256: note.excerptSha256, truncated: note.truncated } : null,
      transcript: transcript.reference ?? { skipped: transcript.skipped },
      sourceCapture: { headStable: source.headStable, headAfter: source.headAfter ?? source.identity.head, kind: source.kind },
    },
  };

  const projectProgression = {
    canonicalAgentDbPath: resolution.canonicalAgentDbPath,
    sourceIdentity: source.identity,
    sequence: priorSequence + 1,
    occurredAt: now(),
    parentEventKeys: heads.map((head) => head.eventKey),
    dedupId: `${host}:${payload.session_id ?? 'unknown-session'}:${trigger ?? 'unknown'}:${priorSequence + 1}`,
    completeProjectState,
  };

  // RETENTION (ADR-073). Three capture boundaries per session times every session is unbounded
  // growth unless a capture that changes nothing writes nothing. Compare what a snapshot MEANS —
  // the project state and the tree it describes — while deliberately ignoring the fields that always
  // differ (sequence, timestamp, dedup id, the trigger that happens to be firing, and the evidence
  // block's own timestamps), because comparing those would make every capture look novel.
  const meaning = digestCanonical({
    state: { ...completeProjectState, activeStep: null, evidence: null },
    source: source.identity,
  });
  const priorMeaning = heads.length === 1 ? digestCanonical({
    state: { ...priorState, activeStep: null, evidence: null },
    source: heads[0].sourceIdentity,
  }) : null;

  return {
    projectProgression,
    provenance,
    meaningDigest: meaning,
    ...(priorMeaning === meaning
      ? { skipped: { reason: 'no-op capture: project state and source identity are identical to the current head' } }
      : {}),
  };
}

/** Stable identifier for one produced snapshot, for logs and receipts. */
export function producedDigest(produced) {
  return crypto.createHash('sha256').update(JSON.stringify(produced.projectProgression)).digest('hex');
}
