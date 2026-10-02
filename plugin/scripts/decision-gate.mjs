#!/usr/bin/env node
/**
 * decision-gate.mjs — ONE PreToolUse decision, from N policies, with ONE reason.
 *
 * WHY: four independent processes could each refuse the same Write, with no precedence and no shared
 * context, so the user got one arbitrary reason and no hint a second wall stood behind it. The
 * measurement and the full rationale are in docs/adr/0067 — not repeated here.
 *
 * This is ADR-040's speech-chokepoint invariant applied to REFUSAL. One pattern used twice, not two.
 *
 * THE POLICIES ARE UNCHANGED. Each already speaks `exit 0` = allow, `exit 2` + stderr = refuse — a
 * verdict function that was only ever missing a caller. The gate runs each as a CAPTURED child and
 * composes one decision, naming every policy that refused, in declared precedence order.
 *
 * FAIL-OPEN, deliberately: any failure of the GATE ITSELF allows. A gate that blocks because it
 * cannot read a file is one users switch off, and a disabled gate protects nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// resolveBash ONLY. `skipNoBash` is not a predicate — it is a one-time notice emitter that returns 0
// and WRITES TO STDERR, which on this hot path is the refusal channel: calling it would have injected
// an install hint into the middle of a refusal reason, or manufactured stderr on an allow. Read the
// signature, do not infer it from the name.
import { resolveBash } from './hook-shim-bash.mjs';
import { append as appendOutcome, actionKey, recordRefusal, resolve as resolveOutcome, sweepStale } from './decision-outcomes.mjs';
// Grok sends its own tool names (`write`) and a snake_case event; every policy below reads Claude's
// shape. Normalised ONCE here, so the policies (four of them bash, matching tool_name textually) never
// see a host-native spelling — the 4.4 measurement was a Grok write silently allowed. hook-input.mjs.
import { normalizePayloadText } from './hook-input.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVENT = process.argv[2] || '';

/** Exit codes that mean something to the host. Anything else from a policy is an ERROR, not a refusal. */
const ALLOW = 0;
const REFUSE = 2;
/** A policy that could not decide and says why on stderr (e.g. duplicate-gate's index under overload). */
const SKIPPED_SELF = 3;

/**
 * ── THE BUDGET AND THE HOST TIMEOUT ARE ONE NUMBER, NOT TWO ──────────────────────────────────────
 *
 * THE DEFECT, measured by an adversarial audit on 2026-08-13. hooks.json declared `timeout: 5` for
 * both PreToolUse entries; this file enforced an internal 4000ms budget. Those two numbers were never
 * compared anywhere — not in code, not in a test — and 4000ms of policy work plus two node boots does
 * not fit in 5000ms. Fourteen timed runs, in projects with no ruvnet-brain content:
 *
 *     3166 3579 3622 3816 4431 4464 4615 4959 | 5109 5118 5401 5526 5579 5700 ms
 *                                             ^ the 5s manifest timeout
 *
 * SIX OF FOURTEEN were killed by the host — including a plain `ls -la` at 5109ms and a Write at
 * 5401ms. The host renders a killed hook as a FAILED PreToolUse HOOK, so the guard that exists to
 * teach was instead producing the owner's literal complaint: "a ton of hook errors" on opening this
 * plugin in another project. The gate was not refusing anything. It was timing out, and a timeout
 * looks exactly like a broken plugin.
 *
 * The relationship, stated once so it can be asserted (tests/unit/decision-gate.test.mjs derives the
 * manifest value FROM hooks.json — restating 5000 in the test would only re-create the drift):
 *
 *     DEFAULT_BUDGET_MS + MIN_HEADROOM_MS  ≤  hooks.json PreToolUse timeout × 1000
 *
 * MIN_HEADROOM_MS is not padding. It is the work outside the budget's control: the shim's node boot,
 * this gate's node boot, the outcome-ledger writes, and the SIGKILL teardown of whatever the budget
 * just cancelled.
 *
 * NARROWED BACK 2026-08-19, from 4000+5000 (which required a 10s manifest) to 2000+3000 (which fits
 * the original 5s). The widening above was honest when it was made — those fourteen runs really did
 * straddle the limit. What made it stale was the adr-currency-gate two-pass fix, which stopped the
 * gate reading all 83 ADR bodies on every tool call. Re-measured through the FULL registered path
 * (`hook-shim.mjs decision-gate write`, the way the host actually invokes it), eight runs in a
 * stranger project and six in this repo:
 *
 *     stranger:  424 405 405 415 417 416 411 415 ms
 *     this repo: 438 416 412 416 412 436 ms
 *
 * ~415ms against a 5000ms ceiling — twelve times the headroom, where before SIX OF FOURTEEN runs
 * were being killed. The 10s ceiling was no longer buying anything, and a ceiling is not free: a
 * sibling test caps PreToolUse at 5s precisely because the USER waits behind this hook on every
 * Write and every Bash, and a 10s stall is the /rvbc hang that already burned people. THE RULE THIS
 * ENCODES: a budget widened by evidence must be narrowed again when the evidence expires. Otherwise
 * every emergency ratchets the ceiling up one notch permanently and nothing ever ratchets it back.
 */
export const DEFAULT_BUDGET_MS = 2000;
export const MIN_HEADROOM_MS = 3000;

/**
 * ── THE TWO FAIL-OPEN CASES, STATED AS POLICY (4.5) ──────────────────────────────────────────────
 *
 * 1. ALLOW ON TIMEOUT. A policy still running at the budget is killed and the write is ALLOWED — a gate
 *    that blocks because it is slow is one users switch off. Never silent: the outcome ledger records
 *    `budget-exceeded` with the policies that did not vote, and ONE stderr line says the allow was a
 *    timeout, not a verdict (reportBudget below).
 *
 * 2. OVERSIZE: ONLY THE FIRST 64 KiB IS CHECKED. The host hands this gate the payload through
 *    hook-shim.mjs, which reads at most TRANSPORT_CAP_BYTES (its TABLE entry), and the bash policies cap
 *    their own read at the same number. A bigger Write arrives cut mid-JSON. The policies still run on
 *    that prefix and a refusal found there STANDS (measured 2026-10-01: an ungrounded rUv import at the
 *    top of a 100 KB file, and a 100 KB write to the protected settings file, are both refused). What
 *    the prefix cannot show — a rUv import after the first 64 KiB — is ALLOWED. Measured before 4.5 that
 *    allow left no trace at all; it is now recorded as `payload-oversize` (with the session, tool and path
 *    recovered from the prefix, so refusals of oversize writes are counted too). No stderr on that allow:
 *    a large file is ordinary work, and stderr is what a host renders as a hook error.
 * tests/unit/write-gate-policy.test.mjs holds both, through the real registered command.
 */
export const TRANSPORT_CAP_BYTES = 65536;

/** Pure: is this the complete JSON event, or the transport cap's cut-off prefix of a bigger one? */
export function classifyPayload(raw) {
  const text = String(raw ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object') return { complete: true, truncated: false, bytes };
  } catch { /* fall through */ }
  const str = (k) => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1] ?? '';
  return {
    complete: false,
    truncated: bytes >= TRANSPORT_CAP_BYTES,
    bytes,
    session: str('session_id') || str('sessionId'),
    tool: str('tool_name') || str('toolName'),
    filePath: str('file_path'),
  };
}

/**
 * THE POLICY REGISTRY — the whole point of this file, and the thing that was previously scattered
 * across seven hooks.json entries with no relationship to each other.
 *
 * ORDER IS PRECEDENCE, most fundamental first, and it is a claim about what matters most when two
 * policies both object:
 *
 *   protect-state       the user's own consent boundary. It guards the OFF switch itself, so it
 *                       outranks everything — ADR-054 §3 already says it matters MORE while the
 *                       brain is off.
 *   hijack-ruvnet       the managed-memory boundary (ADR-063): a correctness rule about where data
 *                       goes, ahead of anything about process.
 *   ground-before-write don't write RuvNet-product code ungrounded (ADR-0012).
 *
 * `unprompted-speech` is LAST and is not really a peer: it is the speech chokepoint, which refuses
 * only for a lesson the user personally opted into blocking. It is included so that Write/Edit have
 * exactly ONE process that can refuse them — which is the entire invariant — and its allow-path
 * stdout envelope is forwarded untouched.
 *
 * H5 (this repo's own dead-code audit): a 'bash' route used to sit alongside 'write' here, gating
 * identifier-preflight, spend-guard, degradation-watch, hijack-ruvnet (a SECOND use, alongside its
 * 'write' one) and design-wall on a PreToolUse-Bash event. It was never registered in
 * plugin/hooks/hooks.json or codex-hooks.json — continuity-hook-policy.mjs's own header names this
 * explicitly: "decision-gate's BASH route ... remains reachable through hook-shim's dispatch table
 * by explicit invocation" only, never wired into the automatic plane. Removed as dead routing, not
 * as a verdict on the four now-orphaned policies' worth: identifier-preflight.mjs, spend-guard.mjs,
 * degradation-watch.mjs and design-wall.sh all remain in the tree with their own passing tests
 * (each exports/exposes pure, independently-tested logic — `check`/`identifierIn`, `dependentEvent`,
 * etc. — used elsewhere, e.g. tests/unit/lesson-gate.test.mjs imports degradation-watch.mjs's
 * `dependentEvent` directly to cross-check lesson-hooks.sh's own pattern). Only their SELECTION by
 * this gate's dead 'bash' route is removed here.
 */
const POLICY = (id, file, interpreter = 'bash') => ({ id, file, interpreter });
const REFUSAL_POLICIES = [
  POLICY('protect-state', 'protect-brain-state.sh'),
  POLICY('hijack-ruvnet', 'hijack-ruvnet.sh'),
  POLICY('ground-before-write', 'ground-before-write.sh'),
  // adr-currency-gate fires on the EDIT, where the pre-push gate fires on the push. Same rule, same
  // machinery (it calls doc-currency.mjs, never a second copy of the logic) — moved to the earliest
  // moment it has enough information. On 2026-08-13 four ADRs went stale together and were caught
  // only at push, after three commits, when the work read as a toll booth. A gate at the end cannot
  // shape the work; it can only penalise it, and it trains running at the wall. This one refuses
  // DEBT, not change: you may edit governed code freely, but not while a document governing it is
  // still unreconciled from the last round.
  POLICY('adr-currency', 'adr-currency-gate.mjs', 'node'),
  // duplicate-code (2026-09-30, owner: "is it the simplest version of the code that works, that doesn't
  // create duplicates or replication across the project?"). Last: it is a question about craft, not a
  // boundary, and it refuses at most once per path per session. Tuned on replayed history — the
  // numbers and the method are in duplicate-gate.mjs and scripts/duplicate-gate-replay.mjs.
  POLICY('duplicate-code', 'duplicate-gate.mjs', 'node'),
];
const SPEECH = { id: 'unprompted-speech', file: 'unprompted-runtime.mjs', interpreter: 'node' };

/** Which policies apply to which PreToolUse sub-event, mirroring the matchers they replaced. */
const REGISTRY = {
  'write': ['protect-state', 'hijack-ruvnet', 'ground-before-write', 'adr-currency', 'duplicate-code'],
};

export function policiesFor(event, registry = REGISTRY, all = REFUSAL_POLICIES) {
  const ids = registry[event] || [];
  // Ordered by REFUSAL_POLICIES, never by the registry entry — precedence is a property of the
  // policy, not of where someone happened to list it.
  return all.filter((p) => ids.includes(p.id));
}

/**
 * ── APPLICABILITY: THE CHEAPEST POLICY IS THE ONE NEVER SPAWNED ──────────────────────────────────
 *
 * H5: this table's one entry (degradation-watch, applicable only to the now-removed 'bash' route)
 * was removed along with that route — see the REGISTRY comment above. The mechanism itself stays:
 * an empty table costs nothing (skipReason below returns null immediately for every policy, so every
 * currently-registered policy is consulted exactly as if this file did not exist), and it is the
 * correct extension point for a future policy that only applies to SOME invocations of its event.
 */
/**
 * Resolved once per invocation by the runtime block below; null means no bash on this host.
 *
 * Declared HERE, and not next to runPolicy() where it reads more naturally: the `if (isMain())`
 * block runs during module evaluation, so a `let` declared after it sits in the temporal dead zone
 * and the assignment throws — the identical mistake `speechEventFor` was already a hoisted
 * `function` to avoid, recorded a few lines further down.
 */
let BASH = null;
const APPLICABILITY = {};

/** Returns a skip reason, or null if the policy must be consulted. */
export function skipReason(policy, toolInput, table = APPLICABILITY) {
  const test = table[policy.id];
  if (!test) return null;
  try { return test(toolInput || {}) ? null : 'not-applicable'; } catch { return null; }
}

/**
 * Compose one decision from many verdicts.
 *
 * Pure and exported so the precedence rule is testable without spawning anything — the rule is the
 * product here, and a rule only provable by running four bash scripts is a rule nobody re-checks.
 */
export function decide(verdicts) {
  const refusals = verdicts.filter((v) => v.code === REFUSE);
  if (!refusals.length) return { allow: true, refusals: [] };
  const [first, ...also] = refusals;
  // The winning policy's own words are the message — it wrote them for this moment, and replacing
  // them with a summary of our own would lose the specific instruction the user needs.
  let reason = (first.stderr || '').trim() || `refused by ${first.id} (no reason given)`;
  if (also.length) {
    // NAMING THE OTHERS IS THE POINT. Under four racing hooks the user fixed the first refusal, ran
    // the command again, and hit the second — with no way to know it was there. One round-trip per
    // wall is how a guard becomes something people route around.
    reason += `\n\n  Also refusing this action (fix these too, or they will stop you next):\n`
      + also.map((v) => `    · ${v.id}: ${firstLine(v.stderr) || 'no reason given'}`).join('\n');
  }
  return { allow: false, refusals: refusals.map((v) => v.id), reason };
}

const firstLine = (s) => String(s || '').trim().split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';

/** Payload accessors — tolerant, because a malformed payload must degrade to "no measurement". */
function parsed(payload) { try { const o = JSON.parse(payload); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function sessionOf(payload) { return String(parsed(payload).session_id || ''); }
function payloadTool(payload) { return String(parsed(payload).tool_name || ''); }
function payloadInput(payload) { return parsed(payload).tool_input || {}; }

/**
 * The sub-event token unprompted-runtime switches on.
 *
 * A hoisted `function`, not a `const` arrow: the `if (isMain())` block below runs DURING module
 * evaluation, so an arrow declared after it sits in the temporal dead zone — it threw
 * `Cannot access 'speechEventFor' before initialization` on this gate's first live refusal.
 */
function speechEventFor(event) { return event === 'bash' ? 'PreToolUse-bash' : 'PreToolUse-write'; }

// ── Runtime ──────────────────────────────────────────────────────────────────────────────────────


if (isMain()) {
  const started = Date.now();
  const payload = normalizePayloadText(readPayload());
  const selected = policiesFor(EVENT);
  // An unknown event is not an occasion to refuse anything. Same rule as unprompted-runtime's
  // "never speak on a guess", pointed at the other decision. 'write' is the only registered route
  // (H5 removed the dead 'bash' one — see the REGISTRY comment above), so it is the only exception.
  if (!selected.length && EVENT !== 'write') process.exit(ALLOW);

  const budgetMs = Number(process.env.RUVNET_DECISION_BUDGET_MS) || DEFAULT_BUDGET_MS;
  const deadline = started + budgetMs;
  // Resolved ONCE. On win32 resolveBash() can shell out to `where.exe`; four bash policies meant up
  // to four of those per tool call, for an answer that cannot change mid-invocation.
  BASH = resolveBash();

  const trace = [];            // one row per policy — surfaced by RUVNET_DECISION_TRACE=1
  const unconsulted = [];      // policies the budget cost us. NEVER silent; see reportBudget().
  const toolInput = payloadInput(payload);
  const consulted = [];
  for (const p of selected) {
    const why = skipReason(p, toolInput);
    if (why) trace.push({ id: p.id, ms: 0, skipped: why });
    else consulted.push(p);
  }

  // ── PARALLEL, and the reason is arithmetic ─────────────────────────────────────────────────────
  // Sequentially the gate's wall time was SUM(policies); run together it is MAX(policies). Measured
  // on a `git push` payload by the 2026-08-13 audit: 182 + 345 + 2145..3990 + 629 + 743 ≈ 4.0-5.9s
  // sequential, against a 5s host timeout. Nothing about these policies wanted to be sequential —
  // they share no state, write no files (only stderr), and `decide()` re-sorts the verdicts into
  // REFUSAL_POLICIES precedence order regardless of which finished first. Every selected policy ran
  // on every call before this change too: the gate never short-circuited on the first refusal,
  // because naming EVERY wall is the whole point of ADR-067.
  const results = await Promise.all(consulted.map((p) => runPolicy(p, payload, deadline, undefined, trace)));
  const verdicts = results.filter((r) => typeof r.code === 'number');
  for (const r of results) if (r.skipped === 'budget') unconsulted.push(r.id);
  // A policy that exits SKIPPED (3) did not vote and said why (duplicate-gate under overload). Same
  // two channels as a blown budget, below — never silence standing in for a verdict.
  const selfSkipped = results.filter((r) => r.skipped === 'self');

  const decision = decide(verdicts);

  // ── OBEDIENCE MEASUREMENT (ADR-067 §outcomes) ──────────────────────────────────────────────────
  // This gate is the ONLY thing that sees every Write/Edit/Bash, so it can close the loop with no new
  // hook: resolve first (did this call retry something we refused?), then open a new debt if we are
  // about to refuse. Order matters — resolving after recording would close the debt we just opened.
  // Entirely best-effort: measurement may never affect the verdict, so it runs after `decide`.
  // An oversize payload is cut mid-JSON (see TRANSPORT_CAP_BYTES): recover session/tool/path from its
  // prefix so its refusals and allows are counted like any other.
  const shape = classifyPayload(payload);
  const session = sessionOf(payload) || (shape.truncated ? shape.session : '');
  try {
    const key = shape.truncated
      ? actionKey(shape.tool, { file_path: shape.filePath })
      : actionKey(payloadTool(payload), toolInput);
    const ts = Date.now();
    if (session && key) {
      sweepStale({ session, ts });   // debts from dead sessions become `abandoned`, never vanish
      resolveOutcome({ session, key, allowed: decision.allow, ts });
      if (!decision.allow) recordRefusal({ session, key, policies: decision.refusals, ts });
    }
  } catch { /* a ledger must never break a tool call */ }

  reportSelfSkipped({ session, selfSkipped });
  if (decision.allow && shape.truncated) {
    // OVERSIZE POLICY (header): allowed on a check of the first TRANSPORT_CAP_BYTES only. Recorded, never silent.
    try { appendOutcome({ kind: 'payload-oversize', event: EVENT, session, bytesSeen: shape.bytes, capBytes: TRANSPORT_CAP_BYTES, tool: shape.tool, filePath: shape.filePath, ts: Date.now() }); } catch { /* a ledger must never break a tool call */ }
  }
  if (!decision.allow) {
    reportBudget({ session, unconsulted, trace, started, budgetMs });
    process.stderr.write(`${decision.reason}\n`);
    process.exit(REFUSE);
  }

  // Nothing refused: run the speech chokepoint and forward its envelope verbatim. It owns its own
  // per-channel policy; this gate does not inspect or re-decide anything it says.
  //
  // SEQUENTIAL ON PURPOSE, unlike the batch above. unprompted-runtime.mjs records an OFFERED row in
  // the advocacy ledger when it delivers (its line ~372), so starting it in parallel and discarding
  // its stdout after a refusal would book an offer the user never saw — inflating the denominator
  // this project has a CI gate against fabricating. A saved ~280ms is not worth a fabricated number.
  if (deadline - Date.now() <= 0) {
    unconsulted.push(SPEECH.id);
  } else {
    const speech = await runPolicy(SPEECH, payload, deadline, speechEventFor(EVENT), trace);
    if (speech.skipped === 'budget') unconsulted.push(SPEECH.id);
    if (speech.code === REFUSE) {
      reportBudget({ session, unconsulted, trace, started, budgetMs });
      process.stderr.write(`${(speech.stderr || '').trim()}\n`);
      process.exit(REFUSE);
    }
    reportBudget({ session, unconsulted, trace, started, budgetMs });
    if (speech.stdout?.trim()) process.stdout.write(speech.stdout);
    process.exit(ALLOW);
  }
  reportBudget({ session, unconsulted, trace, started, budgetMs });
  process.exit(ALLOW);
}

/**
 * ── A BUDGET THAT CAN BE EXCEEDED SILENTLY FAILS OPEN WITHOUT SAYING SO ──────────────────────────
 *
 * The old loop did `break` when the budget ran out. Every remaining policy AND the speech chokepoint
 * were then skipped with no record anywhere — the gate allowed, and nothing distinguished "five
 * policies agreed this was fine" from "we ran out of time and stopped asking". That is this repo's
 * signature defect wearing a different hat: silence standing in for a measurement. degradation-watch
 * exists because a warning was printed and skimmed; this exists because nothing was printed at all.
 *
 * TWO CHANNELS, because each fails differently:
 *   · the outcome ledger (~/.config/ruvnet-brain/, survives `--update`) so a trip COMPOUNDS into
 *     evidence instead of scrolling past. `kind: 'budget-exceeded'` is inert in report()'s buckets —
 *     it counts neither as a refusal nor as a resolution, so it cannot move the obedience rate.
 *   · one stderr line, unconditionally, allow or refuse. Yes, that puts bytes on stderr during an
 *     exit-0 allow, which tests/unit/decision-gate.test.mjs asserts never happens on an ordinary
 *     write. That assertion is now a SECOND tripwire and is meant to be: after the parallel batch and
 *     the applicability skip, an ordinary write measures ~360ms against a 4000ms budget, so a trip
 *     there is not noise to be tolerated — it is the defect, and the suite should go red for it.
 */
function reportBudget({ session, unconsulted, trace, started, budgetMs }) {
  const elapsed = Date.now() - started;
  if (process.env.RUVNET_DECISION_TRACE === '1') {
    process.stderr.write(`[decision-gate] ${EVENT} ${elapsed}ms budget=${budgetMs}ms ${JSON.stringify(trace)}\n`);
  }
  if (!unconsulted.length) return;
  try {
    appendOutcome({ kind: 'budget-exceeded', event: EVENT, session, unconsulted, elapsedMs: elapsed, budgetMs, ts: Date.now() });
  } catch { /* a ledger must never break a tool call */ }
  process.stderr.write(
    `[decision-gate] ${budgetMs}ms budget exhausted after ${elapsed}ms — ALLOWED WITHOUT CONSULTING: `
    + `${unconsulted.join(', ')}. These policies did not vote; this allow is a timeout, not a verdict.\n`,
  );
}

/** Record and print each policy that skipped itself (exit 3), with its own one-line reason. */
function reportSelfSkipped({ session, selfSkipped }) {
  for (const r of selfSkipped) {
    try { appendOutcome({ kind: 'policy-skipped', event: EVENT, session, policy: r.id, reason: r.reason, ts: Date.now() }); } catch { /* a ledger must never break a tool call */ }
    process.stderr.write(`[decision-gate] ${r.reason || `${r.id} skipped`} — ${r.id} did not vote; this allow is not its verdict.\n`);
  }
}

/**
 * Run one policy as a CAPTURED child. Never lets its bytes touch the real streams.
 *
 * Always resolves, never rejects, and always to an object — `{ id, code }` for a real verdict, or
 * `{ id, skipped }` for anything else. The old version returned bare `null` for a missing file, a
 * missing bash, a crash AND a timeout alike, which is precisely why a blown budget could not be
 * reported: by the time the caller saw the result, the reason was gone.
 */
function runPolicy(p, payload, deadline, extraArg, trace) {
  const t0 = Date.now();
  const done = (r) => {
    trace?.push({ id: p.id, ms: Date.now() - t0, ...(r.skipped ? { skipped: r.skipped } : { code: r.code }) });
    return r;
  };
  const file = path.join(SCRIPTS_DIR, p.file);
  if (!fs.existsSync(file)) return Promise.resolve(done({ id: p.id, skipped: 'missing' }));
  let cmd; const args = [file];
  if (p.interpreter === 'bash') {
    if (!BASH) return Promise.resolve(done({ id: p.id, skipped: 'no-bash' }));  // this policy cannot speak here
    cmd = BASH;
  } else {
    cmd = process.execPath;
  }
  if (extraArg) args.push(extraArg);
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve(done({ id: p.id, skipped: 'budget' }));

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(done(r)); };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RUVNET_DECISION_GATE: '1', RUVNET_DECISION_DEADLINE: String(deadline) } });
    } catch { return finish({ id: p.id, skipped: 'spawn' }); }
    // SIGKILL, not SIGTERM: a bash policy that has spawned its own child (jq, node, ruflo) can sit in
    // a TERM handler, and the host's own kill is what we are racing. The whole batch shares ONE
    // deadline, so a single slow policy cancels only the time it actually consumed.
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish({ id: p.id, skipped: 'budget' }); }, left);
    let stdout = ''; let stderr = ''; let bytes = 0;
    const MAX = 1 << 20;   // same ceiling spawnSync's maxBuffer enforced; a policy is not a data source
    child.stdout.on('data', (d) => { if (bytes < MAX) { stdout += d; bytes += d.length; } });
    child.stderr.on('data', (d) => { if (bytes < MAX) { stderr += d; bytes += d.length; } });
    child.on('error', () => finish({ id: p.id, skipped: 'spawn' }));
    // EPIPE when a policy exits before reading its payload (degradation-watch's fast path does).
    // Unhandled, that error event would take the whole gate down and turn an allow into a hook error.
    child.stdin.on('error', () => { /* the child did not want the payload; that is not a failure */ });
    child.on('close', (code) => {
      // A spawn failure, a timeout, or any code other than 0/2 is an ERROR — and an error here must
      // never be mistaken for a refusal. That distinction is the one lesson-gate.mjs had to learn twice.
      if (code === SKIPPED_SELF) return finish({ id: p.id, skipped: 'self', reason: firstLine(stderr) });
      if (code !== ALLOW && code !== REFUSE) return finish({ id: p.id, skipped: `exit:${code}` });
      finish({ id: p.id, code, stderr, stdout });
    });
    try { child.stdin.end(payload); } catch { /* handled by the stdin error listener above */ }
  });
}

function readPayload() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Never able to crash a caller that merely imported this (see tests/unit/entrypoint-guard-safety). */
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
