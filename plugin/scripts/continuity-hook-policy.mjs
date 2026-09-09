/**
 * The only automatic lifecycle surface RuvNet Brain permits.
 *
 * The 4.3.16 stabilization retired the old collection of grounding, learning, routing, and
 * release interceptors. Continuity is deliberately narrower: SessionStart restores the canonical
 * project checkpoint, and Stop may request one continuation only when an explicitly authorized,
 * project-scoped objective remains open. Keeping this allowlist in one module prevents a registry
 * from quietly growing another pile of independent gates.
 */

export const CONTINUITY_EVENTS = Object.freeze({
  SessionStart: Object.freeze({ id: 'session-start', matcher: 'startup|resume|clear|compact|fork' }),
  Stop: Object.freeze({ id: 'continuation-gate', matcher: '*' }),
});

const commandHas = (command, id) => {
  const text = String(command || '');
  if (!/(?:hook-shim\.mjs|codex-hook\.mjs)/i.test(text)) return false;
  return new RegExp(`(?:^|[\\s"'])${id}(?:$|[\\s"'])`).test(text);
};

export function continuityHookId(command) {
  for (const [event, spec] of Object.entries(CONTINUITY_EVENTS)) {
    if (commandHas(command, spec.id)) return { event, id: spec.id };
  }
  return null;
}

export function isAllowedContinuityRegistration({ event, matcher, command } = {}) {
  const spec = CONTINUITY_EVENTS[event];
  if (!spec || String(matcher ?? '') !== spec.matcher) return false;
  return commandHas(command, spec.id);
}

export function continuityContractIds() {
  return Object.values(CONTINUITY_EVENTS).map(({ id }) => id);
}
