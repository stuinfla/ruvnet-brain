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
  // degradation-watch sits second because it decides whether ANY record this system keeps is real.
  // Measured 2026-08-13: better_sqlite3.node was built for NODE_MODULE_VERSION 141 against a node
  // needing 137, ruflo fell back to sql.js, and nothing persisted for three days while every write
  // printed `[OK] Data stored successfully`. A warning was printed on every one of those writes and
  // read. It could not stop anything, because a warning is text and text is skimmable — so this is
  // a refusal instead. It probes only for commands whose truth DEPENDS on durable memory (a lesson
  // store, a ship), so ordinary Bash pays nothing.
  POLICY('degradation-watch', 'degradation-watch.mjs', 'node'),
  // identifier-preflight is FIRST among the cheap checks and costs one file read: it refuses a
  // command that names a model this machine's CLI does not accept. `codex exec --model gpt-5.6`
  // (correct: gpt-5.6-sol, in ~/.codex/config.toml) printed a 400 and EXITED 0 into a redirected
  // file on 2026-08-13, so a 50-minute audit produced nothing and there was no exit code to catch.
  // It refuses ONLY a positively-known-wrong value and allows every unknown, because a wall that
  // fabricates a reason is one people learn to route around.
  POLICY('identifier-preflight', 'identifier-preflight.mjs', 'node'),
  POLICY('hijack-ruvnet', 'hijack-ruvnet.sh'),
  POLICY('ground-before-write', 'ground-before-write.sh'),
  POLICY('design-wall', 'design-wall.sh'),
];
const SPEECH = { id: 'unprompted-speech', file: 'unprompted-runtime.mjs', interpreter: 'node' };

/** Which policies apply to which PreToolUse sub-event, mirroring the matchers they replaced. */
const REGISTRY = {
  'write': ['protect-state', 'hijack-ruvnet', 'ground-before-write'],
  // degradation-watch is bash-only on purpose: the acts it guards — `ruflo memory store`, `git
  // push` — are commands, so the dependency is observable there and nowhere else.
  'bash': ['protect-state', 'identifier-preflight', 'degradation-watch', 'hijack-ruvnet', 'design-wall'],
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
