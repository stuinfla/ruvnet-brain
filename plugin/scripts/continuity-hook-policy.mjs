/**
 * The only automatic lifecycle surface RuvNet Brain permits.
 *
 * The 4.3.16 stabilization retired the old collection of grounding, learning, routing, and release
 * interceptors, and they STAY retired — this file is what keeps a registry from quietly regrowing
 * that pile. What it is not is a claim that "two hooks" is the right number forever. The continuity
 * plane had exactly two handlers and could not do its job: SessionStart restored a journal that
 * nothing ever wrote, because no event was allowed to WRITE one. An allowlist that forbids the
 * capture boundary while demanding the restore is not a safety property, it is a contradiction.
 *
 * So the allowlist is now a LIST PER EVENT rather than one entry per event, and each registration
 * declares which hosts may carry it. Adding to it is still a deliberate act that has to pass
 * `npm run hooks:check`; what changed is that the shape can express the plane that actually works.
 *
 * EVENT → OWNER (the same table hook-contracts.json publishes, kept here because this is the file
 * that enforces it). Owner first, event second: wired-check.mjs reads a module header for
 * "<EventName> ... hook|gate" to decide whether a FILE is itself a hook body, and an event-first
 * table made this policy module look like one. The information is identical; the shape is not.
 *
 *   session-start       continuity recovery   at SessionStart       claude, codex
 *   unprompted-speech   advisory delivery     at UserPromptSubmit   claude, codex
 *   continuation-gate   continuation nudge    at turn end           claude, codex
 *   session-snapshot    continuity capture    at turn end           claude
 *   session-snapshot    continuity capture    at PreCompact         claude
 *   session-snapshot    continuity capture    at SessionEnd         claude, codex
 *   ground-ruvnet       grounding injection   at UserPromptSubmit   claude, codex
 *   decision-gate       write authorization   at PreToolUse (write) claude, codex
 *   grounding-stamp     grounding receipt     at PostToolUse        claude, codex
 *   grounding-turn-mark grounding turn marker at UserPromptSubmit   claude, codex
 *   grounding-turn-gate answered-w/o-search   at turn end           claude, codex
 *
 * THE GROUNDING ROWS WERE ADDED 2026-09-11 (Stuart), and this header is the record of why. The
 * 4.3.16 retirement took the ONLY enforcement of ADR-0012 — never write rUv-product code the brain
 * has not seen — out of the automatic plane, leaving it in hook-shim's table where nothing ran it.
 * On 2026-09-11 the exact failure that rule exists to prevent recurred in this repo: a console was
 * built without asking the brain whether one existed (it did: console/, RVBC). Stuart: "the fact
 * that you don't have a hook set up to do that means you're a toy versus a solution." So the write
 * gate is automatic again, WITH its key: decision-gate's write route is the one refuser (ADR-067),
 * grounding-stamp on a successful search_ruvnet is the receipt that opens it, and ground-ruvnet is
 * the prompt-level directive that tells the model to search first. ground-ruvnet is a second owner
 * of UserPromptSubmit alongside unprompted-speech — scoped by ADR-040 §Amendment 2026-09-11 to
 * grounding DIRECTIVES, which are not the advisory speech that seam owns.
 *
 * CODEX EXTENSION, 2026-09-12 — the 2026-09-11 "not proven" claim below (see the probe box) was
 * measured with `codex exec "reply OK"`, a prompt that never invokes a tool at all: of course
 * PreToolUse/PostToolUse never fired, because nothing ever ran a tool for them to fire on. That is
 * "never asked the question", not "asked and got no". Re-measured today against codex-cli 0.154.0
 * with a prompt that actually calls a tool: a real `apply_patch` write fired PreToolUse and
 * PostToolUse with `tool_name:"apply_patch"`, and a real MCP call to this repo's own `search_ruvnet`
 * server fired both with `tool_name:"mcp__ruvnet_brain__search_ruvnet"` — which the EXISTING
 * `^(?:.*__)?search_ruvnet$` matcher already recognizes unchanged (`.*__` absorbs the
 * `mcp__ruvnet_brain__` prefix). So decision-gate's write route and grounding-stamp are extended to
 * Codex: `apply_patch` is added to the shared PreToolUse matcher (Claude's Write/Edit/MultiEdit/
 * NotebookEdit are untouched — the addition is a dead branch on Claude, since Claude never names a
 * tool `apply_patch`), and grounding-stamp's PostToolUse matcher is reused byte-identical. Real
 * transcripts of both round trips, both hosts, live in this change's commit and PROGRESS.md.
 *
 * STILL NOT IN THIS PLANE, and deliberately so: decision-gate's BASH route (Codex `exec_command`)
 * and ADR-075's ExecutionPolicy. Today's measurement proved PreToolUse/PostToolUse delivery for a
 * write and an MCP call specifically — it did not exercise `exec_command`, so extending the bash
 * route on that same evidence would be exactly the assumption this rule exists to forbid. Both
 * remain reachable through hook-shim's dispatch table by explicit invocation.
 *
 * "ANSWERED WITHOUT SEARCHING", ADDED 2026-09-12. ground-ruvnet's Gate 1 is a prompt-level
 * DIRECTIVE ("call search_ruvnet before asserting"), and a directive is advisory — nothing checked
 * whether the model actually complied before the turn ended, which is the "stopping is the absence
 * of an action" gap continuation-gate.mjs's own header already names, applied to grounding instead
 * of unfinished work. grounding-turn-mark (UserPromptSubmit) records that Gate 1 fired for this
 * turn; grounding-turn-gate (Stop) forces continuation if grounding-stamp.sh's evidence shows no
 * search_ruvnet call happened since. Full rationale, including why this is a NEW pair rather than
 * an extension of continuation-gate.mjs, lives in grounding-turn-gate.mjs's own header.
 */

/**
 * @typedef {{ id: string, matcher: string, hosts: readonly string[] }} ContinuityRegistration
 */

const registration = (id, matcher, hosts) => Object.freeze({ id, matcher, hosts: Object.freeze(hosts) });

/**
 * CODEX REGISTRATIONS ARE MEASURED, NOT ASSUMED (probe run 2026-09-11, codex-cli 0.154.0).
 *
 * A name in an event catalogue is not a delivery. Registering a capture on an event the host never
 * fires produces a plane that LOOKS symmetrical and silently captures nothing on one side of it —
 * which is worse than an asymmetry that is written down. So a temporary CODEX_HOME was given a probe
 * hook registered on all twelve event names the installed binary declares, and a real
 * `codex exec "reply OK"` was run against it. What actually arrived:
 *
 *   SessionStart      FIRED   payload captured
 *   UserPromptSubmit  FIRED   payload captured
 *   SessionEnd        FIRED   payload captured (it fires even when the turn errors out)
 *   Stop              NOT OBSERVED — the probe turn never completed, so `run_turn_stop_hooks`
 *                     had no completion to fire on. The binary declares the event and the wire
 *                     struct, so this is "not proven", not "not supported".
 *   PreCompact        NOT OBSERVED — a one-line turn never approaches a compaction threshold.
 *
 * Therefore Codex capture is registered at SessionEnd ONLY. Stop keeps the pre-existing
 * continuation-gate registration (unchanged by this lane); no NEW handler is added to an event whose
 * delivery has not been seen. hook-contracts.json carries the same measurement and its date.
 *
 * RE-MEASURED 2026-09-12, codex-cli 0.154.0, PreToolUse/PostToolUse specifically. The 2026-09-11
 * probe above used `codex exec "reply OK"` — a prompt that never invokes a tool — so PreToolUse and
 * PostToolUse were never exercised at all; "NOT OBSERVED" there described an untested path, not a
 * failing one. Today's probe used prompts that DO invoke a tool:
 *
 *   PreToolUse / PostToolUse (apply_patch)              FIRED   tool_name:"apply_patch",
 *                                                                tool_input.command = the raw patch,
 *                                                                tool_response = "Exit code: 0…
 *                                                                Success. Updated the following
 *                                                                files: A <path>"
 *   PreToolUse / PostToolUse (MCP search_ruvnet, this    FIRED   tool_name:
 *   repo's own plugin/mcp/server.mjs registered as a             "mcp__ruvnet_brain__search_ruvnet",
 *   real MCP server in the probe's CODEX_HOME)                   tool_response.content[0].text =
 *                                                                "Searched N RuvNet repos …"
 *
 * Both are now registered for Codex: decision-gate's write route (`apply_patch` added to the shared
 * PreToolUse matcher below — Claude's tool names are untouched) and grounding-stamp (the existing
 * `^(?:.*__)?search_ruvnet$` matcher already matches `mcp__ruvnet_brain__search_ruvnet` unchanged,
 * since `.*__` absorbs any qualifying prefix). Full transcripts in this change's commit message.
 */
export const CONTINUITY_EVENTS = Object.freeze({
  SessionStart: Object.freeze([
    registration('session-start', 'startup|resume|clear|compact|fork', ['claude', 'codex']),
  ]),
  UserPromptSubmit: Object.freeze([
    registration('unprompted-speech', '*', ['claude', 'codex']),
    registration('ground-ruvnet', '*', ['claude', 'codex']),
    // The "answered without searching" gate, half 1 of 2 (2026-09-12) — see grounding-turn-gate.mjs's
    // header for the full rationale. Records that ground-ruvnet's Gate 1 fired for this turn, since
    // Stop's own payload carries no prompt text for grounding-turn-gate to test.
    registration('grounding-turn-mark', '*', ['claude', 'codex']),
  ]),
  // The write gate and its key (ADR-0012 / ADR-067), re-registered 2026-09-11 — see the header.
  // Extended to Codex 2026-09-12: a real `apply_patch` write was measured to fire PreToolUse on
  // codex-cli 0.154.0 (see the probe box above). `apply_patch` is Codex's own raw tool name for a
  // write — the matcher tests the RAW host event, before codex-hook-adapter.mjs normalizes it to
  // Claude's `Edit` shape for decision-gate.mjs's own policies (protect-state, hijack-ruvnet,
  // ground-before-write, adr-currency all then see tool_name:"Edit" exactly as on Claude).
  PreToolUse: Object.freeze([
    registration('decision-gate', '^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$', ['claude', 'codex']),
  ]),
  // Extended to Codex 2026-09-12: a real MCP `search_ruvnet` call was measured to fire PostToolUse
  // on codex-cli 0.154.0 with tool_name "mcp__ruvnet_brain__search_ruvnet" — the matcher below
  // already matched that shape unchanged (see the probe box above), and grounding-stamp.sh's own
  // gating logic is a raw-payload substring scan with no host-specific field access, so it needed
  // no change either (proven live: the real MCP tool_response's `content[0].text` carries the exact
  // "Searched N RuvNet repos" banner and query text the script already looks for).
  PostToolUse: Object.freeze([
    registration('grounding-stamp', '^(?:.*__)?search_ruvnet$', ['claude', 'codex']),
  ]),
  Stop: Object.freeze([
    registration('continuation-gate', '*', ['claude', 'codex']),
    registration('session-snapshot', '*', ['claude']),
    // The "answered without searching" gate, half 2 of 2 (2026-09-12). Forces continuation
    // (hookSpecificOutput.additionalContext — the same contract continuation-gate.mjs already uses
    // and codex-hook-adapter.mjs already translates to Codex's decision:block on both hosts) when
    // grounding-turn-mark's marker for this session shows Gate 1 fired and no search_ruvnet stamp
    // (grounding-stamp.sh) postdates it. A separate registration from continuation-gate on purpose —
    // see grounding-turn-gate.mjs's header for why folding it in would corrupt that file's ledger
    // semantics rather than extend them.
    registration('grounding-turn-gate', '*', ['claude', 'codex']),
  ]),
  PreCompact: Object.freeze([
    registration('session-snapshot', '*', ['claude']),
  ]),
  SessionEnd: Object.freeze([
    registration('session-snapshot', '*', ['claude', 'codex']),
  ]),
});

const commandHas = (command, id) => {
  const text = String(command || '');
  if (!/(?:hook-shim\.mjs|codex-hook\.mjs)/i.test(text)) return false;
  return new RegExp(`(?:^|[\\s"'])${id}(?:$|[\\s"'])`).test(text);
};

/** Which continuity handler, if any, a command invokes — scoped to `event` when one is supplied. */
export function continuityHookId(command, event) {
  const events = event ? { [event]: CONTINUITY_EVENTS[event] ?? [] } : CONTINUITY_EVENTS;
  for (const [name, specs] of Object.entries(events)) {
    for (const spec of specs) if (commandHas(command, spec.id)) return { event: name, id: spec.id };
  }
  return null;
}

/**
 * Is this exact (event, matcher, command) registration permitted, for this host?
 * `host` defaults to undefined, meaning "any host that may carry it" — the check every caller used
 * before hosts existed, kept so a host-agnostic caller keeps its old answer.
 */
export function isAllowedContinuityRegistration({ event, matcher, command, host } = {}) {
  const specs = CONTINUITY_EVENTS[event];
  if (!specs) return false;
  return specs.some((spec) => String(matcher ?? '') === spec.matcher
    && commandHas(command, spec.id)
    && (host === undefined || spec.hosts.includes(host)));
}

/** Every registration this policy expects on `host`, as flat {event, id, matcher} rows. */
export function continuityRegistrations(host) {
  return Object.entries(CONTINUITY_EVENTS).flatMap(([event, specs]) => specs
    .filter((spec) => host === undefined || spec.hosts.includes(host))
    .map((spec) => ({ event, id: spec.id, matcher: spec.matcher, hosts: [...spec.hosts] })));
}

/**
 * The (event, id) pairs a contracts manifest must list — PAIRS, not ids, because `session-snapshot`
 * is legitimately registered at three different boundaries and a bare id set cannot say that.
 */
export function continuityContractIds() {
  return continuityRegistrations().map(({ event, id }) => `${event}:${id}`);
}
