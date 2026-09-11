#!/usr/bin/env node
/**
 * project-progression-checkpoint.mjs — the EXPLICIT capture boundary behind /ruvnet-brain:checkpoint.
 *
 * The automatic boundaries (Stop, PreCompact, SessionEnd) capture what can be READ from the machine:
 * git, the work ledger, the owner's note, a bounded transcript reference. They cannot read what only
 * the model knows — the acceptance contract it is working to, the decision it just made and why, the
 * exact next action. This entry point lets the model hand that over, once, deliberately.
 *
 * IT IS NOT A SECOND WRITER. Everything still goes through the producer and
 * captureProjectTransition, so the snapshot is validated, redacted, fsynced to the outbox, written
 * by `ruflo memory store`, and read back by its exact key before this prints a receipt. The model's
 * `--json` contributes FIELDS; it never contributes a write path.
 *
 * The supplied fields are merged OVER the produced ones, and each supplied field is recorded in
 * `provenance` as `model-checkpoint` with `authoritative: false`. A model asserting its own goal is
 * a useful record and is not the same kind of fact as a line the user wrote in their ledger, and the
 * snapshot must not lose that distinction on the way in.
 *
 * Usage:
 *   node project-progression-checkpoint.mjs --json '<completeProjectState fragment>' [--session <id>]
 *   node project-progression-checkpoint.mjs --json-file <path> [--project-dir <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureProjectTransition } from './project-progression-hook.mjs';
import { buildProjectProgression } from './project-progression-producer.mjs';
import { ProjectProgressionStore } from './project-progression-store.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { projectDirectory } from './project-identity.mjs';

/** Fields a checkpoint may contribute. Anything else is ignored rather than silently stored. */
export const CHECKPOINT_FIELDS = Object.freeze([
  'currentGoal', 'acceptanceContract', 'nextAction', 'activeStep',
  'decisions', 'blockers', 'failures', 'completed', 'inProgress', 'plan',
  'changedFiles', 'commands', 'proofArtifacts', 'untested',
]);

const ARRAY_FIELDS = new Set([
  'decisions', 'blockers', 'failures', 'completed', 'inProgress', 'plan',
  'changedFiles', 'commands', 'proofArtifacts', 'untested',
]);

export function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    out[flag.slice(2)] = argv[index + 1]?.startsWith('--') ? true : argv[index + 1];
  }
  return out;
}

export function readCheckpointState({ json, 'json-file': jsonFile } = {}) {
  let text = json;
  if (typeof jsonFile === 'string' && jsonFile) text = fs.readFileSync(jsonFile, 'utf8');
  if (typeof text !== 'string' || !text.trim()) throw new Error('a checkpoint needs --json or --json-file');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('checkpoint state is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('checkpoint state must be an object');
  const state = {};
  for (const field of CHECKPOINT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
    if (ARRAY_FIELDS.has(field) && !Array.isArray(parsed[field])) throw new Error(`checkpoint ${field} must be an array`);
    state[field] = parsed[field];
  }
  if (Object.keys(state).length === 0) {
    throw new Error(`a checkpoint must set at least one of: ${CHECKPOINT_FIELDS.join(', ')}`);
  }
  return state;
}

export function runCheckpoint({
  projectDir = projectDirectory(),
  state,
  host = process.env.RUVNET_HOOK_HOST || 'claude',
  sessionId = process.env.CLAUDE_SESSION_ID || `checkpoint-${Date.now()}`,
  produce = buildProjectProgression,
  capture = captureProjectTransition,
  storeFactory,
} = {}) {
  const resolution = resolveProjectStore({ projectDir });
  if (!fs.existsSync(path.dirname(resolution.canonicalAgentDbPath))) {
    throw new Error(`this project has not adopted the canonical store (${resolution.canonicalAgentDbPath})`);
  }
  const payload = { session_id: sessionId, hook_event_name: 'checkpoint' };
  const produced = produce({ resolution, payload, host, trigger: 'checkpoint' });

  // Commit any durable-but-uncommitted snapshot first, so an explicit checkpoint also settles the
  // debt SessionStart is forbidden from settling. Same ordering as the automatic boundaries.
  const store = (storeFactory ?? ((options) => new ProjectProgressionStore(options)))({
    projectDir, requestedStorePath: resolution.canonicalAgentDbPath,
  });
  let replayed = 0;
  try { replayed = store.replay().length; } catch { /* the checkpoint itself is still worth writing */ }

  const provenance = { ...produced.projectProgression.completeProjectState.provenance };
  for (const field of Object.keys(state)) provenance[field] = { source: 'model-checkpoint', authoritative: false };

  const result = capture({
    host,
    projectDir,
    storeFactory,
    payload: {
      ...payload,
      projectProgression: {
        ...produced.projectProgression,
        completeProjectState: {
          ...produced.projectProgression.completeProjectState,
          ...state,
          provenance,
        },
      },
    },
  });
  return { receipt: result.receipt, replayed, provenance, sequence: result.snapshot.sequence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const outcome = runCheckpoint({
      state: readCheckpointState(args),
      ...(typeof args['project-dir'] === 'string' ? { projectDir: args['project-dir'] } : {}),
      ...(typeof args.session === 'string' ? { sessionId: args.session } : {}),
    });
    // THE RECEIPT IS THE POINT. It names the exact key, and it says the row was read BACK by that
    // key and matched — which is the only evidence that distinguishes a checkpoint from a claim.
    console.log(JSON.stringify({
      checkpoint: 'stored',
      eventKey: outcome.receipt.eventKey,
      sequence: outcome.sequence,
      payloadDigest: outcome.receipt.payloadDigest,
      readbackDigest: outcome.receipt.readbackDigest,
      readbackVerified: outcome.receipt.readbackDigest === outcome.receipt.payloadDigest,
      alreadyStored: outcome.receipt.alreadyStored,
      replayedPending: outcome.replayed,
      committedAt: outcome.receipt.committedAt,
    }, null, 2));
  } catch (error) {
    console.error(`[checkpoint] ${error.message}`);
    process.exitCode = 1;
  }
}
