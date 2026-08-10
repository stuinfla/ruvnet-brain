#!/usr/bin/env node
/**
 * decision-gate.mjs — ONE PreToolUse decision, from N policies, with ONE reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT. Read from hooks.json's own matchers on 2026-08-10:
 *
 *     Write | Edit  →  hijack-ruvnet · ground-before-write · protect-state · unprompted-speech
 *     Bash          →  hijack-ruvnet · design-wall · unprompted-speech
 *
 * FOUR independent processes could each refuse the same Write, and THREE the same Bash. Five separate
 * `exit 2` sites across four bash scripts, no precedence between them, no shared context, and no way
 * for any of them to know what the others thought. Whichever refused first won, and the user got that
 * one's reason and no hint that a second wall was also standing.
 *
 * The owner named this before it was measured: *"not just a bunch of constraints rules that break and
 * collapse on each other."* That is the concrete form of it. Nothing owned the decision, so everything
 * had an opinion about it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FIX IS NOT A FIFTH WALL. It is the chokepoint pattern this repo ALREADY proved for speech —
 * ADR-040 / DDD-0004, `unprompted-runtime.mjs`: "Every unprompted utterance passes through ONE runtime
 * that alone decides whether bytes reach the user." That invariant was built for advisories and left
 * refusals alone. This file is the same invariant for the other half:
 *
 *     Every refusal of a tool call passes through ONE gate that consults every policy and alone
 *     decides. A policy returns a verdict; it never writes to the user's streams.
 *
 * Deliberately NOT a second mechanism with its own vocabulary — one pattern, applied twice, is how a
 * codebase stays learnable. Inventing a parallel one here would be the exact mistake ADR-066 records
 * (the right pattern existed and a new one got written beside it).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE POLICIES DO NOT CHANGE. Each of the four already speaks a precise contract — `exit 0` allow,
 * `exit 2` + stderr refuse — documented identically at the top of all four files. That contract is
 * exactly a verdict function; it was only ever missing a caller. So the gate runs each policy as a
 * CAPTURED child in its existing mode and reads (code, stderr). Zero edits to any policy, zero new
 * candidate protocol to keep in sync, and every existing per-policy test still exercises the real
 * thing. A rewrite of four working guards to add a new emit-mode would have been change for its own
 * sake, and the risk lands on a hot path that can refuse a user's work.
 *
 * WHAT THE USER GAINS, concretely:
 *   • ONE refusal message, naming the policy that refused AND every other policy that also would have
 *     — because the gate runs them all and reports what it saw, instead of stopping at the first.
 *   • DECLARED PRECEDENCE (POLICIES below, in order). Consent before grounding before taste.
 *   • ONE process on the hot path instead of four, under ONE global deadline.
 *
 * FAIL-OPEN, and this is a decision, not an oversight. Any failure of the GATE ITSELF — unreadable
 * policy, spawn error, blown deadline — allows the action. `lesson-gate.mjs` states the rule this
 * repo learned the hard way: "a gate that blocked a push because it could not read a config file
 * would be worse than no gate, and would be switched off within a day, which is how every over-eager
 * gate dies." A policy that genuinely refuses still refuses; only the gate's own malfunction is
 * resolved toward allowing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// resolveBash ONLY. `skipNoBash` is not a predicate — it is a one-time notice emitter that returns 0
// and WRITES TO STDERR, which on this hot path is the refusal channel: calling it would have injected
// an install hint into the middle of a refusal reason, or manufactured stderr on an allow. Read the
// signature, do not infer it from the name.
import { resolveBash } from './hook-shim-bash.mjs';
import { actionKey, recordRefusal, resolve as resolveOutcome, sweepStale } from './decision-outcomes.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVENT = process.argv[2] || '';

/** Exit codes that mean something to the host. Anything else from a policy is an ERROR, not a refusal. */
const ALLOW = 0;
const REFUSE = 2;

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
 *   design-wall         don't ship a visual surface nobody looked at.
 *
 * `unprompted-speech` is LAST and is not really a peer: it is the speech chokepoint, which refuses
 * only for a lesson the user personally opted into blocking. It is included so that Write/Edit and
 * Bash have exactly ONE process that can refuse them — which is the entire invariant — and its
 * allow-path stdout envelope is forwarded untouched.
 */
const POLICY = (id, file, interpreter = 'bash') => ({ id, file, interpreter });
const REFUSAL_POLICIES = [
  POLICY('protect-state', 'protect-brain-state.sh'),
  POLICY('hijack-ruvnet', 'hijack-ruvnet.sh'),
  POLICY('ground-before-write', 'ground-before-write.sh'),
  POLICY('design-wall', 'design-wall.sh'),
];
const SPEECH = { id: 'unprompted-speech', file: 'unprompted-runtime.mjs', interpreter: 'node' };

/** Which policies apply to which PreToolUse sub-event, mirroring the matchers they replaced. */
const REGISTRY = {
  'write': ['protect-state', 'hijack-ruvnet', 'ground-before-write'],
  'bash': ['protect-state', 'hijack-ruvnet', 'design-wall'],
};

export function policiesFor(event, registry = REGISTRY, all = REFUSAL_POLICIES) {
  const ids = registry[event] || [];
  // Ordered by REFUSAL_POLICIES, never by the registry entry — precedence is a property of the
  // policy, not of where someone happened to list it.
  return all.filter((p) => ids.includes(p.id));
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

/**
 * The sub-event token unprompted-runtime already switches on.
 *
 * A hoisted `function`, not a `const` arrow: the top-level `if (isMain())` block below runs DURING
 * module evaluation, so an arrow declared after it sits in the temporal dead zone and throws
 * `Cannot access 'speechEventFor' before initialization` on the first real refusal. Measured, not
 * theorised — it fired on the first live-fire of this gate.
 */

/** Payload accessors — tolerant, because a malformed payload must degrade to "no measurement". */
function parsed(payload) { try { const o = JSON.parse(payload); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function sessionOf(payload) { return String(parsed(payload).session_id || ''); }
function payloadTool(payload) { return String(parsed(payload).tool_name || ''); }
function payloadInput(payload) { return parsed(payload).tool_input || {}; }

function speechEventFor(event) { return event === 'bash' ? 'PreToolUse-bash' : 'PreToolUse-write'; }

// ── Runtime ──────────────────────────────────────────────────────────────────────────────────────


if (isMain()) {
  const payload = readPayload();
  const selected = policiesFor(EVENT);
  // An unknown event is not an occasion to refuse anything. Same rule as unprompted-runtime's
  // "never speak on a guess", pointed at the other decision.
  if (!selected.length && EVENT !== 'write' && EVENT !== 'bash') process.exit(ALLOW);

  const budgetMs = Number(process.env.RUVNET_DECISION_BUDGET_MS) || 4000;
  const deadline = Date.now() + budgetMs;
  const verdicts = [];
  for (const p of selected) {
    const left = deadline - Date.now();
    // A blown budget ALLOWS and says nothing. The alternative — refusing because we ran out of time
    // — would make the gate's own slowness indistinguishable from the user doing something wrong.
    if (left <= 0) break;
    const v = runPolicy(p, payload, left);
    if (v) verdicts.push(v);
  }

  const decision = decide(verdicts);

  // ── OBEDIENCE MEASUREMENT (ADR-067 §outcomes) ──────────────────────────────────────────────────
  // This gate is the ONLY thing that sees every Write/Edit/Bash, so it can close the loop with no new
  // hook: resolve first (did this call retry something we refused?), then open a new debt if we are
  // about to refuse. Order matters — resolving after recording would close the debt we just opened.
  // Entirely best-effort: measurement may never affect the verdict, so it runs after `decide`.
  try {
    const session = sessionOf(payload);
    const key = actionKey(payloadTool(payload), payloadInput(payload));
    const ts = Date.now();
    if (session && key) {
      sweepStale({ session, ts });   // debts from dead sessions become `abandoned`, never vanish
      resolveOutcome({ session, key, allowed: decision.allow, ts });
      if (!decision.allow) recordRefusal({ session, key, policies: decision.refusals, ts });
    }
  } catch { /* a ledger must never break a tool call */ }

  if (!decision.allow) {
    process.stderr.write(`${decision.reason}\n`);
    process.exit(REFUSE);
  }

  // Nothing refused: run the speech chokepoint and forward its envelope verbatim. It owns its own
  // per-channel policy; this gate does not inspect or re-decide anything it says.
  const left = deadline - Date.now();
  if (left > 0) {
    const speech = runPolicy(SPEECH, payload, left, speechEventFor(EVENT));
    if (speech?.code === REFUSE) {
      process.stderr.write(`${(speech.stderr || '').trim()}\n`);
      process.exit(REFUSE);
    }
    if (speech?.stdout?.trim()) process.stdout.write(speech.stdout);
  }
  process.exit(ALLOW);
}

/** Run one policy as a CAPTURED child. Never lets its bytes touch the real streams. */
function runPolicy(p, payload, timeout, extraArg) {
  const file = path.join(SCRIPTS_DIR, p.file);
  if (!fs.existsSync(file)) return null;          // a missing policy is not a refusal
  let cmd; let args;
  if (p.interpreter === 'bash') {
    const bash = resolveBash();
    if (!bash) return null;                       // no bash on this host → this policy cannot speak
    cmd = bash; args = [file];
  } else {
    cmd = process.execPath; args = [file];
  }
  if (extraArg) args.push(extraArg);
  try {
    const r = spawnSync(cmd, args, {
      input: payload, encoding: 'utf8', timeout, maxBuffer: 1 << 20,
      env: { ...process.env, RUVNET_DECISION_GATE: '1' },
    });
    // A spawn failure, a timeout, or any code other than 0/2 is an ERROR — and an error here must
    // never be mistaken for a refusal. That distinction is the one lesson-gate.mjs had to learn twice.
    if (r.error || typeof r.status !== 'number') return null;
    if (r.status !== ALLOW && r.status !== REFUSE) return null;
    return { id: p.id, code: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
  } catch { return null; }
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
