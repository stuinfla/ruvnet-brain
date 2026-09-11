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
 *   decision-gate       write authorization   at PreToolUse (write) claude
 *   grounding-stamp     grounding receipt     at PostToolUse        claude
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
 * STILL NOT IN THIS PLANE, and deliberately so: decision-gate's BASH route and ADR-075's
 * ExecutionPolicy. The mandate was the write path; and no host has proven PreToolUse or PostToolUse
 * delivery for Codex (probe below), so under the measured-not-assumed rule the grounding
 * registrations on Codex are ground-ruvnet only. Both remain reachable through hook-shim's dispatch
 * table by explicit invocation.
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
 */
export const CONTINUITY_EVENTS = Object.freeze({
  SessionStart: Object.freeze([
    registration('session-start', 'startup|resume|clear|compact|fork', ['claude', 'codex']),
  ]),
  UserPromptSubmit: Object.freeze([
    registration('unprompted-speech', '*', ['claude', 'codex']),
    registration('ground-ruvnet', '*', ['claude', 'codex']),
  ]),
  // The write gate and its key (ADR-0012 / ADR-067), re-registered 2026-09-11 — see the header.
  // Claude only: Codex PreToolUse/PostToolUse delivery has not been observed (probe 2026-09-11).
  PreToolUse: Object.freeze([
    registration('decision-gate', '^(Write|Edit|MultiEdit|NotebookEdit)$', ['claude']),
  ]),
  PostToolUse: Object.freeze([
    registration('grounding-stamp', '^(?:.*__)?search_ruvnet$', ['claude']),
  ]),
  Stop: Object.freeze([
    registration('continuation-gate', '*', ['claude', 'codex']),
    registration('session-snapshot', '*', ['claude']),
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
