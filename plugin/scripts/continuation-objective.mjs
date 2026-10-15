import crypto from 'node:crypto';
import path from 'node:path';
import { resolveProjectStore } from './project-store-resolver.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const text = (value) => typeof value === 'string' && value.trim().length > 0;

// Repository identity is the canonical common git directory, NOT a basename or remote URL.
// Linked worktrees share a project identity but require their own explicit worktree authorization.
export function continuationProjectIdentity(cwd) {
  if (!text(cwd) || !path.isAbsolute(cwd)) return null;
  try {
    const resolved = resolveProjectStore({ projectDir: cwd });
    return { projectId: resolved.projectIdentity.id, worktreeId: hash(resolved.checkoutRoot),
      root: resolved.checkoutRoot };
  } catch { return null; }
}

// Non-authoritative continuation preferences in the EXISTING ledger, not a second task store.
// These request/suppress a hook nudge only; they neither prove user provenance nor establish task
// completion. Canonical project progression remains in AgentDB. No automatic writer or native
// continuation bridge is supplied here. Configuration must cite an actual user authorization.
export function authorizedContinuationObjective(objective, input, identity) {
  if (!identity || input?.hook_event_name !== 'Stop' || !text(input.session_id)
    || input.interrupted || input.cancelled || input.stop_hook_active) return null;
  if (objective?.schemaVersion !== 1 || objective.kind !== 'continuation-preferences'
    || objective.authoritative !== false || !['active', 'completed'].includes(objective.state)
    || !text(objective.id) || !text(objective.text) || !Number.isFinite(Date.parse(objective.at))
    || objective.authorization?.kind !== 'user' || !text(objective.authorization.reference)
    || objective.projectId !== identity.projectId
    // '*' is the ONLY session wildcard, and it exists for exactly one reason: `--commit-to` (the CLI
    // a model actually runs to arm this gate) writes the objective from a bare terminal invocation,
    // which has no access to the session_id a future Stop event will carry — only a live Stop hook
    // ever sees that. Every OTHER writer must still name real session ids; a wildcard is never
    // implied by omission, only by this exact literal.
    || !Array.isArray(objective.sessionIds)
    || !(objective.sessionIds.includes(input.session_id) || objective.sessionIds.includes('*'))
    || !Array.isArray(objective.worktreeIds) || !objective.worktreeIds.includes(identity.worktreeId)) return null;
  return objective;
}

// Automatic assistant commitments never confer project-wide user authority. Retained legacy
// wildcards belong only to their proven capturing session; unknown ownership stays historical.
export function assistantCommitmentOwned(item, sessionId, identity) {
  return Boolean(identity && text(sessionId) && sessionId !== '*'
    && item?.kind === 'assistant-commitment' && item.schemaVersion === 1
    && item.done !== true && text(item.text) && Number.isFinite(Date.parse(item.at))
    && item.authorization?.kind === 'owner-mandate' && text(item.authorization.reference)
    && item.projectId === identity.projectId
    && Array.isArray(item.worktreeIds) && item.worktreeIds.includes(identity.worktreeId)
    && item.capturedFrom?.sessionId === sessionId
    && Array.isArray(item.sessionIds)
    && (item.sessionIds.includes(sessionId) || item.sessionIds.includes('*')));
}

const noncompletedStates = new Set(['blocked', 'deferred', 'superseded', 'disputed']);

/** Explicit owner-session preference, not verified completion or authority to cancel user work. */
export function setAssistantCommitmentState(ledger, { itemText, state, sessionId, reason,
  replacementReference, identity, at = new Date().toISOString() } = {}) {
  if (!noncompletedStates.has(state) || !text(reason) || reason.length > 4000
    || !text(sessionId) || sessionId === '*' || !Number.isFinite(Date.parse(at))) {
    throw new Error('commitment state requires a supported noncompleted state, exact session id and reason');
  }
  if (state === 'superseded' && (!text(replacementReference) || replacementReference === itemText)) {
    throw new Error('superseded requires a distinct replacement reference');
  }
  const matches = (Array.isArray(ledger.items) ? ledger.items : []).filter((item) => item.text === itemText
    && assistantCommitmentOwned(item, sessionId, identity));
  if (matches.length !== 1) throw new Error('exact assistant commitment is not uniquely owned by this session and worktree');
  const item = matches[0];
  if (item.stateHistory !== undefined && !Array.isArray(item.stateHistory)) {
    throw new Error('existing commitment state history is malformed; retain it for explicit recovery');
  }
  const transition = { from: item.state || 'active', to: state, at, reason: reason.trim(),
    provenance: { kind: 'explicit-session-cli', sessionId },
    ...(text(replacementReference) ? { replacementReference: replacementReference.trim() } : {}) };
  item.stateHistory = [...(Array.isArray(item.stateHistory) ? item.stateHistory : []), transition];
  item.state = state;
  item.stateChangedAt = at;
  return item;
}

// A state change suppresses only this assistant's nudge. The independent user objective is untouched.
export function authorizedPromiseItems(items, input, identity) {
  if (!identity || input?.hook_event_name !== 'Stop' || !text(input.session_id)
    || input.interrupted || input.cancelled || input.stop_hook_active) return [];
  return (Array.isArray(items) ? items : []).filter((item) => assistantCommitmentOwned(item, input.session_id, identity)
    && (item.state === undefined || item.state === 'active'));
}
