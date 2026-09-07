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
    || objective.authoritative !== false || objective.state !== 'active'
    || !text(objective.id) || !text(objective.text) || !Number.isFinite(Date.parse(objective.at))
    || objective.authorization?.kind !== 'user' || !text(objective.authorization.reference)
    || objective.projectId !== identity.projectId
    || !Array.isArray(objective.sessionIds) || !objective.sessionIds.includes(input.session_id)
    || !Array.isArray(objective.worktreeIds) || !objective.worktreeIds.includes(identity.worktreeId)) return null;
  return objective;
}
