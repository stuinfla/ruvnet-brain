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
 *   owner-note         the newest `project-state-current%` narrative — context, not authorization
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
import fs from 'node:fs';
import path from 'node:path';
import { digestCanonical, fieldAuthorityAllows, redactProgression, restoreProjectProgression } from './project-progression-contract.mjs';
import { readOwnerNote, readSourceIdentity, readTranscriptReference, readWorkLedger } from './project-progression-sources.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';

const PROGRESSION_NAMESPACE = 'project-progression';
const OWNER_NOTE_NAMESPACES = Object.freeze(['default']);

/**
 * `none` is not a filler value, it is the honest answer to "where did this come from?" when the
 * answer is "nowhere — no source had one". Labelling an empty goal `git` (as the first version did,
 * simply because git was the last branch in the chain) claims a provenance the field does not have,
 * and provenance that can be wrong is worse than no provenance at all.
 */
export const PROVENANCE_SOURCES = Object.freeze([
  'ledger', 'owner-note', 'prior-head', 'git', 'transcript-derived', 'model-checkpoint', 'none',
]);

const AUTHORITATIVE = Object.freeze({
  ledger: true,
  'owner-note': false,
  'prior-head': true,
  git: true,
  'transcript-derived': false,
  'model-checkpoint': false,
  none: false,
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
      if (typeof content !== 'string') throw new Error('enumerated progression snapshot is unreadable');
      let snapshot;
      try { snapshot = JSON.parse(content); } catch { throw new Error('progression store contains a malformed snapshot'); }
      if (snapshot?.eventKey !== key) throw new Error('progression store exact key/payload identity mismatch');
      snapshots.push(snapshot);
    }
    return snapshots;
  });
  if (!result.ok) {
    try { fs.lstatSync(canonicalAgentDbPath); } catch (error) {
      if (error.code === 'ENOENT') return { heads: [], readPath: 'store not created' };
      throw error;
    }
    throw new Error(`progression store unreadable: ${result.reason}`);
  }
  const restored = restoreProjectProgression(result.value, { expectedProjectIdentity: projectIdentity });
  if (restored.rejected.some(row => !row.reasons?.every(reason => reason === 'causally stale'))) {
    throw new Error('progression store contains rejected snapshot evidence');
  }
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
  reconcile,
} = {}) {
  if (!resolution || typeof resolution !== 'object') throw new TypeError('resolution must be a project store resolution');
  const source = readSourceIdentity({ checkoutRoot: resolution.checkoutRoot, kind: resolution.kind });
  const ledger = readWorkLedger({ projectId: resolution.projectIdentity.id, env });
  const note = readOwnerNote(() => ownerNoteRows(resolution.canonicalAgentDbPath, path.basename(resolution.projectRoot)));
  const transcript = readTranscriptReference(payload.transcript_path, { host });
  let { heads } = committedHeads(resolution.canonicalAgentDbPath, resolution.projectIdentity);

  if (reconcile) {
    if (!Array.isArray(reconcile.expectedHeads)) throw new Error('reconciliation expected heads are required');
    const expected = new Map(reconcile.expectedHeads.map((head) => [head.eventKey, head]));
    if (expected.size !== reconcile.expectedHeads.length || expected.size !== heads.length
      || heads.some((head) => expected.get(head.eventKey)?.payloadDigest !== head.payloadDigest)) {
      throw new Error('progression heads changed; inspect again before applying reconciliation');
    }
    heads = heads.filter((head) => expected.has(head.eventKey));
  }

  if (heads.length > 1 && !reconcile) {
    return { projectProgression: null, provenance: {},
      skipped: { reason: 'concurrent progression heads require explicit reconciliation before automatic capture' } };
  }

  const priorSequence = heads.reduce((highest, head) => Math.max(highest, head.sequence ?? 0), 0);
  if (priorSequence >= Number.MAX_SAFE_INTEGER) throw new Error('progression sequence overflow');
  const priorState = reconcile?.state ?? (heads.length === 1 ? heads[0].completeProjectState : null);

  const provenance = { ...priorState?.provenance };
  const priorSource = (field) => priorState && priorState.provenance?.[field]?.source !== 'none' ? 'prior-head' : 'none';
  const record = (field, sourceName) => {
    if (sourceName !== 'none' && !fieldAuthorityAllows(field === 'sourceIdentity' ? 'sourceIdentity' : field, sourceName)) {
      throw new Error(`source ${sourceName} is not authoritative for progression field ${field}`);
    }
    provenance[field] = sourceName === 'prior-head'
      ? { ...priorState?.provenance?.[field], ...marker(sourceName) } : marker(sourceName);
    if (sourceName === 'prior-head') {
      // Carrying a guess through storage does not make it an owner's commitment.
      const previous = priorState?.provenance?.[field];
      provenance[field].authoritative = previous?.authoritative === true;
      provenance[field].origin = previous?.origin ?? previous?.source ?? 'unknown';
    }
  };

  // GOAL — the ledger's oldest open item is what the user actually committed to. A coherent prior
  // head carries that commitment forward; an owner note or transcript can provide context only when
  // no durable goal exists. Neither contextual source is an instruction.
  let currentGoal = ledger.open[0] ?? null;
  if (ledger.present) record('currentGoal', 'ledger');
  else if (priorState && (priorState.currentGoal !== null || priorSource('currentGoal') !== 'none')) {
    currentGoal = priorState.currentGoal;
    record('currentGoal', 'prior-head');
  } else if (note?.excerpt) {
    currentGoal = note.excerpt.split('\n')[0].slice(0, 240);
    record('currentGoal', 'owner-note');
  } else if (transcript.derivedGoal) {
    currentGoal = transcript.derivedGoal;
    record('currentGoal', 'transcript-derived');
  } else record('currentGoal', 'none');

  // NEXT ACTION — only a ledger commitment or coherent prior state may become a resumable action.
  // Transcript text is evidence/context, never an invented structured action.
  let nextAction = ledger.open[1] ?? ledger.open[0] ?? null;
  if (ledger.present) record('nextAction', 'ledger');
  else if (priorState && (priorState.nextAction !== null || priorSource('nextAction') !== 'none')) {
    nextAction = priorState.nextAction;
    record('nextAction', 'prior-head');
  } else record('nextAction', 'none');

  let decisions = [];
  if (ledger.objective && typeof ledger.objective.text === 'string' && ledger.objective.text) {
    decisions.push({ text: ledger.objective.text, state: ledger.objective.state ?? null, source: 'ledger' });
    record('decisions', 'ledger');
  } else if (priorState && (priorState.decisions?.length || priorSource('decisions') !== 'none')) {
    decisions = priorState.decisions;
    record('decisions', priorSource('decisions'));
  } else if (note?.excerpt) {
    decisions.push({ text: note.excerpt, note: note.key, truncated: note.truncated, source: 'owner-note' });
    record('decisions', 'owner-note');
  } else if (priorState) {
    decisions = priorState.decisions;
    record('decisions', priorSource('decisions'));
  } else record('decisions', 'none');

  record('plan', ledger.present ? 'ledger' : priorSource('plan'));
  record('completed', ledger.present ? 'ledger' : priorSource('completed'));
  record('inProgress', ledger.present ? 'ledger' : priorSource('inProgress'));
  record('changedFiles', 'git');
  record('sourceIdentity', 'git');

  const completeProjectState = {
    // A capture refreshes fields it owns; absence of an input is not an instruction to erase
    // durable work, decisions, failures, or proof collected by an earlier host.
    ...priorState,
    currentGoal,
    nextAction,
    acceptanceContract: priorState?.acceptanceContract ?? null,
    activeProcess: priorState ? priorState.activeProcess : 'ProjectContinuity',
    activeStep: priorState ? priorState.activeStep : trigger ?? 'unknown',
    plan: ledger.present ? ledger.open.map((text) => ({ id: digestCanonical(text).slice(0, 16), text, status: 'open', source: 'ledger' })) : priorState?.plan ?? [],
    completed: ledger.present ? uniqueStrings(ledger.done) : priorState?.completed ?? [],
    inProgress: ledger.present ? uniqueStrings(ledger.open) : priorState?.inProgress ?? [],
    blockers: priorState?.blockers ?? [],
    failures: priorState?.failures ?? [],
    decisions,
    // The three digests already identify the tree exactly; enumerating paths here would duplicate
    // that and, for an untracked file, would put a filename we were never asked to keep into a row.
    changedFiles: [],
    commands: priorState?.commands ?? [],
    proofArtifacts: priorState?.proofArtifacts ?? [],
    untested: priorState?.untested ?? [],
    resumeConflicts: priorState?.resumeConflicts ?? [],
    provenance,
    evidence: {
      ...priorState?.evidence,
      // Exact immutable parent references retain earlier capture evidence without copying an
      // ever-growing chain into every snapshot. Current observations below stay current.
      priorCapture: heads.length === 1 ? { eventKey: heads[0].eventKey, payloadDigest: heads[0].payloadDigest } : null,
      lastKnownInputs: {
        workLedger: ledger.present ? { file: ledger.file, present: true, open: ledger.open.length, done: ledger.done.length }
          : priorState?.evidence?.lastKnownInputs?.workLedger ?? (priorState?.evidence?.workLedger?.present ? priorState.evidence.workLedger : null),
        transcript: transcript.reference ?? priorState?.evidence?.lastKnownInputs?.transcript
          ?? (priorState?.evidence?.transcript?.excerptSha256 ? priorState.evidence.transcript : null),
        ownerNote: note ? { key: note.key, excerptSha256: note.excerptSha256, truncated: note.truncated }
          : priorState?.evidence?.lastKnownInputs?.ownerNote ?? priorState?.evidence?.ownerNote ?? null,
      },
      workLedger: { file: ledger.file, present: ledger.present, open: ledger.open.length, done: ledger.done.length },
      ownerNote: note ? { key: note.key, excerptSha256: note.excerptSha256, truncated: note.truncated } : null,
      transcript: transcript.reference ?? { skipped: transcript.skipped },
      sourceCapture: { headStable: source.headStable, headAfter: source.headAfter ?? source.identity.head, kind: source.kind },
    },
  };

  // REDACT HERE, NOT ONLY AT THE STORE.
  //
  // createProgressionSnapshot already redacts, so the STORED row was always safe. What was not safe
  // was everything between: this function's return value is passed through a hook payload, appears
  // in a receipt, and is exactly the kind of object a diagnostic line prints. A secret that is
  // scrubbed on the way into the database but readable on the way there has not been protected, it
  // has been moved. Redacting at the point of derivation makes the store's own pass a no-op second
  // check rather than the only one (redactProgression is idempotent, so running it twice is free).
  const { value: redactedProgression } = redactProgression({
    canonicalAgentDbPath: resolution.canonicalAgentDbPath,
    sourceIdentity: source.identity,
    sequence: priorSequence + 1,
    occurredAt: now(),
    parentEventKeys: heads.map((head) => head.eventKey),
    dedupId: `${host}:${payload.session_id ?? 'unknown-session'}:${trigger ?? 'unknown'}:${priorSequence + 1}${reconcile ? `:${reconcile.proposalDigest}` : ''}`,
    completeProjectState,
  });
  const projectProgression = redactedProgression;

  // RETENTION (ADR-073). Three capture boundaries per session times every session is unbounded
  // growth unless a capture that changes nothing writes nothing. Compare what a snapshot MEANS —
  // the project state and the tree it describes — while deliberately ignoring the fields that always
  // differ (sequence, timestamp, dedup id, the trigger that happens to be firing, and the prior-capture pointer), because comparing those would make every capture look novel.
  const meaning = digestCanonical({
    state: { ...projectProgression.completeProjectState, activeStep: null,
      evidence: { ...projectProgression.completeProjectState.evidence, priorCapture: null } },
    source: projectProgression.sourceIdentity,
  });
  const priorMeaning = heads.length === 1 ? digestCanonical({
    state: { ...priorState, activeStep: null, evidence: { ...priorState.evidence, priorCapture: null } },
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
