/**
 * codex-hook-events.mjs — the Codex event catalogue, as pure data.
 *
 * Split out of codex-hook-adapter.mjs (Dream Cycle 2026-08-30) because that file's top level reads
 * stdin synchronously (`fs.readFileSync(0, 'utf8')`) the moment it is imported — the same
 * import-time side-effect hazard the 2026-08-26 brain-stamp.mjs finding named (a test importing the
 * side-effecting module directly hangs/misbehaves rather than observing its constants). That is
 * exactly why `tests/unit/codex-claude-hook-parity.test.mjs` never imported the adapter's own
 * CONTEXT_EVENTS and instead carried a hand-copied array — which had already drifted to 4 of the
 * real 6 events, so `PermissionRequest` and `SubagentStart` had zero coverage proving the
 * wrap-in-envelope branch runs for them at all. Extracting the pure data here, with no filesystem or
 * stdin access at import time, lets both the adapter and its test read the same values instead of
 * two copies that only stay in sync by whoever remembers to edit both.
 */

/**
 * Events whose output schema defines a *HookSpecificOutputWire with `additionalContext`. Only these
 * may carry a hook's prose back to the model.
 */
export const CONTEXT_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SessionStart', 'SubagentStart', 'UserPromptSubmit',
]);

/**
 * The complete Codex hook-event catalogue, PascalCase to match every event name used in this file's
 * sibling and its manifest — not this repo's invention. Read from the live host and recorded
 * verbatim (as snake_case) in `plugin/hooks/codex-hooks.json`'s own `description`: "pre_tool_use,
 * permission_request, post_tool_use, pre_compact, post_compact, session_start, session_end,
 * user_prompt_submit, subagent_start, subagent_stop, stop." `codex-hooks.json` currently wires only
 * 7 of these 11 (see its `DECLARED ABSENT` note for the one Claude-Code-only event, `TeammateIdle`,
 * which Codex has no equivalent for at all); the remaining 4 registered-nowhere-yet events
 * (PermissionRequest, PostCompact, SubagentStart, SubagentStop) still pass through the adapter's
 * event classification the moment anything is ever wired to them, so the classification itself is
 * worth proving correct now rather than the day a hook body first reaches one unproven.
 */
export const ALL_HOST_EVENTS = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop',
];
