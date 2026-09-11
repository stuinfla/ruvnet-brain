// query-deadline.mjs — THE GUARANTEE THAT A QUESTION ALWAYS ENDS.
//
// WHY THIS EXISTS (measured 2026-09-11 on this machine, worktree HEAD 2eef2024, corpus
// ~/.cache/ruvnet-brain/kb builtUtc 2026-08-20T07:16:20.675Z):
//
//   `forge-ask-all.mjs --dir <installed kb> --q "What is the latest version of
//    @claude-flow/aidefence and what changed in it recently?"` produced NO OUTPUT for 15 minutes,
//   twice. It was not deadlocked. It was working: the capability-card router could not place the
//   scoped npm name, the scoped attempt returned thin evidence, and the CLI fell through to the
//   FULL-CORPUS lane — 184 stores x pool 64 = 6,691 (query, passage) pairs, every one of them read
//   in full by the cross-encoder, with the pair cap (CE_MAX_PAIRS_DEFAULT) and the cascade
//   (CE_CASCADE_K_DEFAULT) both shipped OFF. At the rate measured on the real pool that is tens of
//   minutes of honest work for one question.
//
// A bound on the POOL (see forge-ask-all.mjs's full-corpus budget) makes that particular query
// fast. This module is the separate, stronger promise: NO question may run unbounded, whatever
// future lane, corpus size, or machine load produces the overrun. A query either answers or it
// FAILS LOUDLY, naming the phase that ran out of time — never a blinking cursor.
//
// TWO MECHANISMS, DELIBERATELY DIFFERENT:
//
//   1. COOPERATIVE CHECKS (`check(phase)`). The phases call in between units of work — between
//      repos in the fanout, between cross-encoder batches. Cheap, precise, and it names the phase
//      that actually overran, which is the only diagnostic a user can act on.
//   2. A WATCHDOG (`armProcessWatchdog`). ONNX inference is a native call on the JS thread: while
//      one batch is inside the model NOTHING in this process runs, including a timer. The
//      cooperative check therefore has a granularity of one batch, and a pathological batch could
//      sail past it. The watchdog is the backstop that force-exits the process with the same
//      structured diagnosis after the deadline plus a grace window. CLI only, by construction:
//      a long-lived MCP worker must never exit under its host (see armProcessWatchdog).
//
// DETERMINISM IS NOT TRADED AWAY. This module never drops candidates, re-orders them, or shortens
// a read to fit the clock — a timing-dependent answer would make every answer nondeterministic,
// which this repo gates against. It either completes the deterministic work or raises. The thing
// that keeps normal queries inside the deadline is the deterministic pool budget, not the clock.

export const DEFAULT_QUERY_DEADLINE_MS = 20_000;
// The watchdog fires after the deadline plus this grace, so a cooperative check that is about to
// win the race is not pre-empted by the backstop. One cross-encoder batch is the natural unit.
export const DEFAULT_WATCHDOG_GRACE_MS = 5_000;
export const DEADLINE_EXIT_CODE = 4;

/** Raised the moment a phase notices it has run out of budget. Carries WHICH phase, not just "slow". */
export class QueryDeadlineExceeded extends Error {
  constructor({ phase, deadlineMs, elapsedMs }) {
    super(`query deadline exceeded after ${elapsedMs}ms (budget ${deadlineMs}ms) during phase "${phase}"`);
    this.name = 'QueryDeadlineExceeded';
    this.code = 'QUERY_DEADLINE_EXCEEDED';
    this.phase = phase;
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Budget in ms. 0 (or a negative/unparseable value) DISABLES the deadline — offline evaluators and
 * corpus builds legitimately run for minutes and must be able to say so explicitly rather than by
 * accident.
 */
export function resolveDeadlineMs(env = process.env) {
  const raw = env.RUVNET_BRAIN_QUERY_DEADLINE_MS;
  if (raw === undefined || raw === '') return DEFAULT_QUERY_DEADLINE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * A deadline handle. `ms <= 0` returns null — every call site uses `deadline?.check(...)`, so a
 * disabled deadline costs one optional-chain per phase and changes nothing else.
 */
export function createDeadline({ ms = DEFAULT_QUERY_DEADLINE_MS, now = Date.now } = {}) {
  if (!(ms > 0)) return null;
  const startedAt = now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let lastPhase = 'start';
  const elapsed = () => now() - startedAt;
  return {
    ms,
    startedAt,
    get signal() { return controller ? controller.signal : undefined; },
    get phase() { return lastPhase; },
    elapsed,
    remaining: () => ms - elapsed(),
    expired: () => elapsed() >= ms,
    /**
     * Record the phase we are about to enter and raise if the budget is gone. Recording BEFORE the
     * work (not after) is what lets the error name the phase that was running when time ran out.
     */
    check(phase) {
      if (phase) lastPhase = String(phase);
      if (elapsed() < ms) return;
      if (controller && !controller.signal.aborted) controller.abort();
      throw new QueryDeadlineExceeded({ phase: lastPhase, deadlineMs: ms, elapsedMs: elapsed() });
    },
    /** Mark a phase without raising — for phases that have their own bounded failure mode. */
    enter(phase) { if (phase) lastPhase = String(phase); },
  };
}

/** One line, the same wording everywhere, so a CLI banner and an MCP error cannot drift apart. */
export function describeDeadline(error) {
  return `⏱ QUERY DEADLINE EXCEEDED — phase "${error?.phase || 'unknown'}" was still running after `
    + `${error?.elapsedMs ?? '?'}ms (budget ${error?.deadlineMs ?? '?'}ms). No answer was produced. `
    + `This is a TIMEOUT, not an empty corpus: do NOT conclude the ecosystem lacks this capability. `
    + `Narrow the query (name a repo or an exact artifact), or raise the budget with `
    + `RUVNET_BRAIN_QUERY_DEADLINE_MS (0 disables it).`;
}

/**
 * The backstop, for ONE-SHOT processes only (the CLI). Returns a disarm function; callers MUST
 * disarm in a `finally`, otherwise the ref'd timer keeps a finished process alive.
 *
 * NOT for the MCP worker: forge-mcp-all.mjs is a warm, long-lived child, and exiting it under its
 * host would turn one slow question into a dead brain for the whole session. That path uses the
 * cooperative checks and returns a structured error instead.
 */
export function armProcessWatchdog(deadline, {
  graceMs = DEFAULT_WATCHDOG_GRACE_MS,
  onExpire = null,
  exit = (code) => process.exit(code),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (!deadline) return () => {};
  const timer = setTimeout(() => {
    const error = new QueryDeadlineExceeded({
      phase: deadline.phase, deadlineMs: deadline.ms, elapsedMs: deadline.elapsed(),
    });
    log(describeDeadline(error));
    log('(the watchdog fired: a phase blocked the event loop past its own checkpoint)');
    // Reap anything this process forked before leaving, so a forced timeout never orphans a
    // cross-encoder child. Best-effort and bounded: the exit must happen either way.
    let settled = false;
    const leave = () => { if (settled) return; settled = true; exit(DEADLINE_EXIT_CODE); };
    setTimeout(leave, 1000).unref?.();
    Promise.resolve()
      .then(() => (onExpire ? onExpire(error) : null))
      .catch(() => {})
      .then(leave);
  }, deadline.ms + graceMs);
  return () => clearTimeout(timer);
}
