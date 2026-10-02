// codex-hook-trust.mjs — which Brain hooks will Codex refuse to run after this update until the user
// re-reviews them? Answered OFFLINE, from the two hooks files, with Codex's own trust identity.
//
// THE MECHANISM (source, not inference — openai/codex at tag rust-v0.159.3, the installed codex-cli):
//   codex-rs/hooks/src/engine/discovery.rs
//     · key  = hook_key("<plugin_id>:<relative hooks file>", event, group_index, handler_index)
//              e.g. "ruvnet-brain@ruvnet-brain:hooks/codex-hooks.json:user_prompt_submit:0:1"
//     · hash = hook_hash(): sha256 over the canonical JSON of the NORMALISED identity
//              { event_name, matcher (tool/session events only), hooks: [normalised handler] } —
//              command, timeout (normalised), async, statusMessage; "so equivalent hooks from config
//              TOML and hooks.json converge on the same trust identity".
//     · hook_trust_status(): trusted_hash == current hash -> Trusted; a different stored hash ->
//              Modified; none -> Untrusted. Only Managed|Trusted handlers are pushed to run (unless
//              bypass_hook_trust). So a release that edits a command's text, its timeout or its
//              matcher, or that shifts a hook to another group/handler index, silently stops that
//              hook on every machine until the user trusts it again.
//   codex-rs/config/src/fingerprint.rs version_for_toml(): "sha256:" + hex(sha256(serde_json::to_vec(
//              canonical_json(value)))) — keys sorted recursively, compact.
//   codex-rs/tui/src/startup_hooks_review.rs: the interactive prompt "Hooks need review" offers
//              "Review hooks" / "Trust all and continue" / "Continue without trusting (hooks won't run)".
// MEASURED 2026-10-01 in an isolated CODEX_HOME (codex-cli 0.159.3, no credentials): fresh install ->
// all 11 Brain hooks `untrusted`; trusted_hash written -> `trusted`; one command's text changed ->
// that one hook `modified`, the other ten still `trusted`. currentHash from `hooks/list` equals
// codexHookHash() below for every hook (tests/unit/codex-hook-trust.test.mjs pins the real values).
import crypto from 'node:crypto';

const EVENT_LABEL = Object.freeze({
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact', PostCompact: 'post_compact', SessionStart: 'session_start', SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop',
  Stop: 'stop', Interrupt: 'interrupt',
});
const NO_MATCHER = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const DEFAULT_CONTEXT_LIMIT = 2500;

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

/** discovery.rs normalize_command_hook(): SessionEnd/Interrupt default 1s, clamped 1..3; others default 600, min 1. */
function normalisedTimeout(event, t) {
  const n = Number.isInteger(t) && t >= 0 ? t : null;
  if (event === 'SessionEnd' || event === 'Interrupt') return Math.min(3, Math.max(1, n ?? 1));
  return Math.max(1, n ?? 600);
}

/** The exact `currentHash` Codex computes for one command handler, or null for a handler Codex would skip. */
export function codexHookHash(event, group, handler) {
  if (!EVENT_LABEL[event] || handler?.type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) return null;
  const h = { type: 'command', command: handler.command, timeout: normalisedTimeout(event, handler.timeout), async: handler.async === true };
  if (typeof handler.statusMessage === 'string') h.statusMessage = handler.statusMessage;
  const limit = handler.additionalContextLimit;
  if (CONTEXT_EVENTS.has(event) && Number.isInteger(limit) && limit !== DEFAULT_CONTEXT_LIMIT) h.additionalContextLimit = limit;
  const identity = { event_name: EVENT_LABEL[event], hooks: [h] };
  if (!NO_MATCHER.has(event) && typeof group?.matcher === 'string') identity.matcher = group.matcher;
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;
}

/** key -> hash for every handler in a Codex hooks file ({ hooks: { Event: [groups] } }). */
export function codexHookIdentities(hooksFile, keySource = 'ruvnet-brain@ruvnet-brain:hooks/codex-hooks.json') {
  const out = new Map();
  for (const [event, groups] of Object.entries(hooksFile?.hooks || {})) {
    if (!EVENT_LABEL[event] || !Array.isArray(groups)) continue;
    groups.forEach((group, gi) => (group?.hooks || []).forEach((handler, hi) => {
      const hash = codexHookHash(event, group, handler);
      if (hash) out.set(`${keySource}:${EVENT_LABEL[event]}:${gi}:${hi}`, hash);
    }));
  }
  return out;
}

/**
 * The Brain hooks an update leaves needing review: every key of the NEW file whose hash differs from the
 * OLD file's hash at the same key ('modified') or that did not exist before ('untrusted'). A hook the user
 * had already trusted at the old hash stops running until reviewed; that is the whole point of the list.
 */
export function codexTrustChanges(prevHooksFile, nextHooksFile, keySource) {
  const prev = codexHookIdentities(prevHooksFile, keySource);
  const next = codexHookIdentities(nextHooksFile, keySource);
  const changes = [];
  for (const [key, hash] of next) {
    if (!prev.has(key)) changes.push({ key, status: 'untrusted' });
    else if (prev.get(key) !== hash) changes.push({ key, status: 'modified' });
  }
  return changes;
}

/** The exact instruction for a user whose Brain hooks Codex is holding back. */
export const CODEX_TRUST_ACTION = 'Start Codex (interactive, in any project). At the "Hooks need review" prompt choose'
  + ' "Trust all and continue" — or type /hooks and trust each RuvNet Brain hook. Until then Codex skips them'
  + ' (codex exec never asks). Then re-run npx ruvnet-brain --doctor.';
