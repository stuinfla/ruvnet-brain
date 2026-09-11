#!/usr/bin/env node
// advocacy-route.mjs — THE RECOMMENDATION PRODUCER. One bounded UserPromptSubmit emitter that reads an
// ORDINARY build request, decides whether a shipped RuvNet building block would materially help it, and
// returns ONE structured advocacy candidate. It never writes user-facing bytes: unprompted-runtime.mjs
// is the sole writer (ADR-040 / DDD-0004), it alone applies the dial and the DismissalLedger, and it
// alone records the OFFERED denominator.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MEASURED GAP THIS CLOSES. On 2026-09-10 both hosts were given six ordinary requests with the
// Brain installed. Claude Code answered all six but took a MEDIAN 14.5 MINUTES and up to 39 tool calls
// — web searches, throwaway installs — before naming anything, and never once offered Agentic-QE for a
// quality-gates request. Codex called search_ruvnet 0/6 times and missed AIMDS for a customer-facing
// chatbot and model routing for a doubled LLM bill. The capability knowledge was present; the MOMENT of
// recommendation was not. This file is that moment: it fires on the prompt, before any tool call.
//
// WHAT IT IS NOT. It is not a second goal-match.mjs and not a second suppression policy — see
// advocacy-catalog.mjs's header for the measured reason goal-match structurally cannot serve this
// traffic (its GLOBAL_VETO rejects `customers`/`production`/`deploy` by design, and two of the six
// scenarios are vetoed on their first noun). Suppression is advocacy-outcomes.mjs. Delivery is
// unprompted-runtime.mjs. Prose is kb/capability-cards.md. This file contributes the matcher and the
// lifecycle adapter, nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE CANDIDATE ACTUALLY IS — and the mistake it would be easy to make here.
//
// A UserPromptSubmit hook's stdout does NOT reach the user. It is injected into the MODEL's context as
// `additionalContext`. Writing user-facing prose into it produces a line the user never sees and a
// model that may or may not paraphrase it. So `copy` is phrased as ONE INSTRUCTION TO THE MODEL, with
// the user-facing sentence quoted inside it, and it tells the model to say it once and move on.
// Acceptance is therefore measured in two separate places, and they must not be conflated:
//   CANDIDATE EMITTED — this file's job, observable at the hook boundary
//                       (`claude -p --include-hook-events`, or the tests here at the process boundary).
//   USER SAW IT       — the model's job, observable only in a real-host run. Reported separately.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// LEXICAL, IN-PROCESS, NO CHILDREN. No embedder, no network, no search_ruvnet at prompt time. An
// embedder's cold init alone is ~3 s against a 3 s hooks.json timeout, so a semantic matcher here
// would not be a better matcher — it would be a dead one, silent in exactly the way a healthy one is
// silent. Grounding is not skipped, it is MOVED to the two places that can bear the cost: a test pins
// every claim to kb/capability-cards.md, and SKILL.md instructs the model to confirm with
// search_ruvnet before it builds.
//
// BUDGET, DERIVED NOT ASSERTED: hooks.json timeout 3000 ms > unprompted-runtime global producer
// deadline (default 4000 ms, but this producer self-bounds first) > BUDGET_MS 1500 ms. Every exit
// past the budget is SILENCE. tests/unit/advocacy-route-budget.test.mjs measures p95 over 20 COLD
// node invocations, because a warm in-process call proves nothing about the path that actually runs.
//
// CLI (read-only surfaces — a control this file renders must really exist):
//   advocacy-route.mjs --summary            precision over the route's own offers, JSON
//   advocacy-route.mjs --sweep <sessionId>  resolve that session's unresolved offers to `ignored`
// Kill switch: RUVNET_ADVOCACY_ROUTE=0
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, INTENTS, MIN_CUES } from './advocacy-catalog.mjs';
import {
  ACTIONS, record, shouldStillOffer, stateHashOf, precision, pendingOffers, reconcileIgnored,
} from './advocacy-outcomes.mjs';

const HOME = process.env.RUVNET_HOME_OVERRIDE || os.homedir();

/** Every id this route can ever name is namespaced, so it can never collide with a capability-registry
 *  key that anticipate.sh offers into the SAME ledger. One ledger, two producers, disjoint identities. */
export const FINDING_PREFIX = 'recommend:';

export const BUDGET_MS = Number(process.env.RUVNET_ADVOCACY_ROUTE_BUDGET_MS) || 1500;

/** At most ONE recommendation per session. anticipate.sh allows two; this route is louder per offer
 *  (it names a thing to install, not a switch to flip), so it gets the stricter ceiling. */
export const MAX_PER_SESSION = 1;

/**
 * The sample floor for THIS route's precision, deliberately higher than advocacy-outcomes'
 * MIN_PRECISION_SAMPLES (5). That constant governs the whole ledger; a route that offers at most once
 * per session reaches five resolutions across five different sessions, where a single unlucky week
 * would read as a verdict. Ten is the floor at which reporting a rate here is not noise. Below it the
 * answer is `null` — "not yet judgeable" — never 0.
 */
export const ROUTE_MIN_SAMPLES = 10;

export const STATE_FILE = process.env.RUVNET_ADVOCACY_ROUTE_STATE
  || path.join(HOME, '.config', 'ruvnet-brain', 'advocacy-route-state.json');
const STATE_VERSION = 1;
const KEEP_SESSIONS = 20;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// ── Availability: cheap, in-process, and NEVER asserted as absence ────────────────────────────────
// We can see one npm root and the cwd. We cannot see nvm, pnpm, volta, bun, yarn PnP, or a monorepo
// workspace root. So a miss is reported as `unknown`, never `absent` — the same discipline
// capability-registry.mjs's header sets out ("'unknown' is a first-class state and it outranks 'off'
// every time a probe could not run"). The copy downstream says "install state unknown" in those words,
// so the model cannot relay a claim this file did not make.
// RUVNET_ADVOCACY_ROUTE_ROOTS is an EXCLUSIVE override, not an addition: when it is set these are the
// only places probed, bin directory included. A partial override is how a test "proving" the unknown
// path silently passes against the developer's own ~/.npm-global — measured here on 2026-09-11, where
// an override pointing at an empty directory still reported `installed` because the real `aqe` binary
// was found by the un-overridden half.
const PROBE_ROOTS = (process.env.RUVNET_ADVOCACY_ROUTE_ROOTS || '')
  .split(path.delimiter).filter(Boolean);
function probeDirs() {
  if (PROBE_ROOTS.length) return { modules: PROBE_ROOTS, bins: PROBE_ROOTS };
  return {
    modules: [path.join(process.cwd(), 'node_modules'), path.join(HOME, '.npm-global', 'lib', 'node_modules')],
    bins: [path.join(HOME, '.npm-global', 'bin')],
  };
}
export function availabilityOf(capabilityId) {
  const cap = CAPABILITIES[capabilityId];
  if (!cap) return 'unknown';
  try {
    const { modules, bins } = probeDirs();
    for (const root of modules) {
      for (const pkg of cap.probe.pkgs) {
        if (fs.existsSync(path.join(root, ...pkg.split('/')))) return 'installed';
      }
    }
    for (const root of bins) {
      for (const bin of cap.probe.bins) {
        if (fs.existsSync(path.join(root, bin))) return 'installed';
      }
    }
  } catch { /* a probe that cannot run is not evidence of absence */ }
  return 'unknown';
}

// ── The matcher ───────────────────────────────────────────────────────────────────────────────────
/**
 * Which intent (if any) this prompt supports, with the cues that carried it.
 *
 * Returns null — SILENCE — for: a short prompt, no intent reaching MIN_CUES, or a tie nobody wins.
 * The returned `cues` are the real matched sources, so every downstream claim is evidence-bound and a
 * test can assert WHY a prompt matched rather than only that it did.
 */
export function classify(promptText) {
  if (typeof promptText !== 'string') return null;
  const text = promptText.trim().toLowerCase();
  if (text.length < 20) return null;   // "ok", "continue", "yes" — nothing to reason about
  let best = null;
  for (const intent of INTENTS) {
    const cues = intent.cues.filter((re) => re.test(text)).map((re) => re.source);
    if (cues.length < MIN_CUES) continue;
    if (!best || cues.length > best.cues.length) best = { intent, capability: intent.capability, cues };
  }
  return best;
}

// ── Session state: the delivery-evidence record ───────────────────────────────────────────────────
// The outcome LEDGER is canonical for what became of an offer, and its row schema is fixed (id,
// action, at, project, severity, stateHash, scope) — correlation fields do not fit in it and must not
// be smuggled in. They live here instead: session id, offer id, prompt hash, timestamp. That is the
// division the ledger's own header asks for — it measures, this remembers.
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && typeof j === 'object' && j.version === STATE_VERSION && j.sessions && typeof j.sessions === 'object') return j;
  } catch { /* absent or unreadable → defaults */ }
  return { version: STATE_VERSION, sessions: {} };
}

/** Atomic, sibling temp file, entirely inside the config dir. Returns false on any failure, never throws. */
function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    return true;
  } catch { return false; }
}

const offersOf = (st, sid) => (Array.isArray(st.sessions?.[sid]?.offers) ? st.sessions[sid].offers : []);

function putSession(st, sid, offers) {
  st.sessions[sid] = { offers, ts: Date.now() };
  st.sessions = Object.fromEntries(
    Object.entries(st.sessions).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)).slice(0, KEEP_SESSIONS),
  );
  return st;
}

// ── Lifecycle: offered → applied | dismissed | ignored, WITHOUT PreToolUse/PostToolUse ────────────
// Those interceptors are retired since 4.3.17 and stay retired, so "did the user act on it?" cannot be
// observed by watching tool calls. It is observed at the ONLY boundary still wired: the NEXT
// UserPromptSubmit. An offer is `pending` until the next prompt either accepts it or declines it, and
// `ignored` when the session ends with neither — swept at the SessionEnd capture boundary by
// sweepSession(), which continuity's session-snapshot hook calls.
//
// A BARE "yes"/"no" ONLY COUNTS WHEN IT CANNOT BE AMBIGUOUS: exactly one offer pending and a short
// prompt. Otherwise the capability must be named. Crediting an `applied` on a coincidental "ok" would
// inflate the one number that judges this feature, which is the failure advocacy-outcomes' header
// names first.
const ACCEPT_BARE = /^(y|yes|yeah|yep|ok|okay|sure|do it|go ahead|please do|sounds good|let'?s do it|use it)\b/i;
const DECLINE_BARE = /^(n|no|nope|nah|skip|not now|no thanks|leave it|don'?t)\b/i;
const acceptNamed = (id) => new RegExp(`\\b(use|add|wire|set ?up|install|try|go with|switch to)\\b[^.!?]{0,30}\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
const declineNamed = (id) => new RegExp(`\\b(no|not|don'?t|skip|drop|without|forget)\\b[^.!?]{0,30}\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

/**
 * Resolve this session's still-pending offers against the prompt that just arrived.
 *
 * Writes at most one row per offer, through record(), and never throws: a lost transition costs one
 * ledger row, never the turn. Returns what it actually resolved, so a test can assert the transition
 * rather than infer it.
 */
export function resolvePriorOffers(promptText, sessionId, { file, state } = {}) {
  const out = { applied: [], dismissed: [] };
  const text = typeof promptText === 'string' ? promptText.trim() : '';
  if (!text || !sessionId) return out;
  const st = state || readState();
  const offers = offersOf(st, sessionId).filter((o) => o && !o.resolved);
  if (!offers.length) return out;

  // THE LEDGER IS THE SOLE ARBITER, exactly as it is for reconcileIgnored(). This state file knows we
  // DECIDED to offer; only the ledger knows the card was actually DELIVERED — the runtime writes the
  // OFFERED row after the dial and the DismissalLedger have both let it through, and at advocacy=off
  // it never writes one. Without this check a user whose dial is off could still be credited an
  // `applied` for a card they were never shown, which puts a number in the numerator that describes
  // nothing. A miss here leaves the offer pending; the SessionEnd sweep is likewise a no-op on it.
  let deliverable;
  try { deliverable = new Set(pendingOffers(file ? { file } : {}).map((p) => p.id)); } catch { return out; }

  const bareOk = offers.length === 1 && text.length <= 80;
  let changed = false;
  for (const offer of offers) {
    if (!deliverable.has(offer.id)) continue;
    const cap = String(offer.capability || '');
    let action = null;
    if (cap && declineNamed(cap).test(text)) action = ACTIONS.DISMISSED;
    else if (cap && acceptNamed(cap).test(text)) action = ACTIONS.APPLIED;
    else if (bareOk && DECLINE_BARE.test(text)) action = ACTIONS.DISMISSED;
    else if (bareOk && ACCEPT_BARE.test(text)) action = ACTIONS.APPLIED;
    if (!action) continue;
    let ok = false;
    try {
      ok = record({ id: offer.id, action, severity: offer.severity || 'normal' }, file ? { file } : {}).ok;
    } catch { ok = false; }
    if (!ok) continue;   // ledger write failed → leave it pending; a silent "resolved" would be a lie
    offer.resolved = action;
    offer.resolvedAt = new Date().toISOString();
    changed = true;
    (action === ACTIONS.APPLIED ? out.applied : out.dismissed).push(offer.id);
  }
  if (changed && !state) writeState(st);
  return out;
}

/**
 * SessionEnd sweep: every offer this session left unresolved becomes `ignored`.
 *
 * EXPORTED FOR CONTINUITY — their session-snapshot hook calls this at the SessionEnd capture boundary.
 * It delegates the decision to reconcileIgnored(), which verifies each id still has a real pending
 * offer, so a stale or duplicated call is a no-op rather than a double count. Never throws.
 */
export function sweepSession(sessionId, { file, state } = {}) {
  if (!sessionId) return [];
  const st = state || readState();
  const offers = offersOf(st, sessionId).filter((o) => o && !o.resolved && typeof o.id === 'string');
  if (!offers.length) return [];
  let done = [];
  try { done = reconcileIgnored(offers.map((o) => o.id), file ? { file } : {}); } catch { done = []; }
  if (!done.length) return [];
  const swept = new Set(done);
  for (const offer of offers) if (swept.has(offer.id)) { offer.resolved = ACTIONS.IGNORED; offer.resolvedAt = new Date().toISOString(); }
  if (!state) writeState(st);
  return done;
}

/**
 * This route's own precision, read-only. Restricted to `recommend:` ids so anticipate.sh's dormant-
 * capability offers cannot flatter or drag it, and reported as null below ROUTE_MIN_SAMPLES.
 * The lower bound comes from advocacy-outcomes.precision() — not recomputed here.
 */
export function summary({ file } = {}) {
  // precision() filters by an EXACT id, not a prefix, so this sums one scoped read per capability
  // rather than re-implementing loadOutcomes' reset-aware, position-ordered definition of a
  // resolution here. Seven cheap reads beat a second copy of that logic drifting from the first.
  const counts = { applied: 0, dismissed: 0, ignored: 0 };
  let target = null;
  for (const capId of Object.keys(CAPABILITIES)) {
    try {
      const p = precision({ ...(file ? { file } : {}), id: `${FINDING_PREFIX}${capId}` });
      counts.applied += p.applied || 0;
      counts.dismissed += p.dismissed || 0;
      counts.ignored += p.ignored || 0;
      target = p.target;
    } catch { /* unreadable ledger → zeros, which `sufficient:false` below reports honestly */ }
  }
  let pending = 0;
  try { pending = pendingOffers(file ? { file } : {}).filter((p) => String(p.id).startsWith(FINDING_PREFIX)).length; } catch { pending = 0; }

  const resolved = counts.applied + counts.dismissed + counts.ignored;
  const sufficient = resolved >= ROUTE_MIN_SAMPLES;
  return {
    scope: FINDING_PREFIX,
    ...counts,
    resolved,
    pending,
    target,
    minSamples: ROUTE_MIN_SAMPLES,
    sufficient,
    precision: sufficient ? +(counts.applied / resolved).toFixed(4) : null,
    reason: sufficient ? null
      : `only ${resolved} resolved offer(s) — below the ${ROUTE_MIN_SAMPLES}-sample floor, so precision is unknown, not zero`,
  };
}

// ── Candidate construction ────────────────────────────────────────────────────────────────────────
/**
 * The candidate, as DDD-0004's advocacy aggregate — an ADAPTER onto the existing identities, not a new
 * schema. `findingId` is the Finding identity, `observationHash` the Observation fingerprint,
 * `severity` the class the DismissalLedger budgets on, and the Remedy is carried as an executable
 * `nextAction` with its `undo`. Everything the runtime needs it already understands; the extra fields
 * ride along for correlation and are inert to it.
 *
 * SEVERITY IS ALWAYS `normal`, including for the safety intent. DISMISSAL_BUDGET gives `high` three
 * lives, i.e. it re-fires twice after a refusal — and ADR-028 is explicit that one false alarm costs
 * more trust than ten true ones earn. A recommendation the user has declined once is finished.
 *
 * The OBSERVATION is hashed over intent+capability, NOT over the prompt. Hashing the prompt would make
 * every new wording a "state change" and hand the reprieve in shouldStillOffer() a way to reopen a
 * settled dismissal on every turn — a dismissal that does not stick is the nag with extra steps.
 */
export function buildCandidate({ prompt, match, availability }) {
  const cap = CAPABILITIES[match.capability];
  if (!cap) return null;
  const avail = availability === 'installed'
    ? `It is already installed here.`
    : `Install state unknown from here — say so rather than claiming it is available.`;
  const copy = [
    `[RuvNet Brain — capability advocacy] If it genuinely fits, tell the user in ONE sentence: `
      + `"Consider ${cap.id} — ${cap.benefit}. Say 'use ${cap.id}' to proceed, or ignore this." ${avail}`,
    `If they accept, the safe first step is \`${cap.nextAction}\` (undo: ${cap.undo}); confirm it with `
      + `search_ruvnet before you build. Say it once, do not expand it, then carry on with the actual work.`,
  ].join('\n');
  return {
    channel: 'advocacy',
    effect: 'advisory',
    hookEventName: 'UserPromptSubmit',
    findingId: `${FINDING_PREFIX}${cap.id}`,
    severity: 'normal',
    observationHash: stateHashOf([`intent:${match.intent.id}`, `capability:${cap.id}`]),
    copy,
    capability: cap.id,
    intent: match.intent.id,
    fit: match.intent.fit,
    availability: availability === 'installed' ? 'installed' : 'unknown',
    nextAction: cap.nextAction,
    undo: cap.undo,
    cues: match.cues,
    promptHash: sha(String(prompt || '').trim().toLowerCase()),
  };
}

/**
 * The whole decision, minus process IO. Returns the candidate to emit, or null for SILENCE, and says
 * WHY it stayed silent so a test can distinguish "no intent" from "already said" from "suppressed" —
 * three very different bugs that all look identical from the outside.
 */
export function decide({ prompt, sessionId, file, state, now = Date.now(), startedAt = Date.now() }) {
  if (Date.now() - startedAt > BUDGET_MS) return { candidate: null, reason: 'budget-exceeded' };
  const match = classify(prompt);
  if (!match) return { candidate: null, reason: 'no-intent' };
  const st = state || readState();
  const offers = offersOf(st, sessionId);
  if (offers.filter((o) => o && o.at).length >= MAX_PER_SESSION) return { candidate: null, reason: 'session-cap' };
  if (offers.some((o) => o && o.capability === match.capability)) return { candidate: null, reason: 'already-offered' };

  const id = `${FINDING_PREFIX}${match.capability}`;
  const stateHash = stateHashOf([`intent:${match.intent.id}`, `capability:${match.capability}`]);
  let allowed = true;
  try { allowed = shouldStillOffer(id, { severity: 'normal', stateHash, ...(file ? { file } : {}) }); } catch { allowed = false; }
  if (!allowed) return { candidate: null, reason: 'suppressed' };

  const candidate = buildCandidate({ prompt, match, availability: availabilityOf(match.capability) });
  if (!candidate) return { candidate: null, reason: 'no-card' };
  if (Date.now() - startedAt > BUDGET_MS) return { candidate: null, reason: 'budget-exceeded' };

  // PERSIST FIRST, SPEAK SECOND — anticipate.sh's SILENCE RULE 3, and the ordering is the whole rule.
  // Killed between the two we lose one recommendation (silent, harmless). The other order risks
  // speaking without remembering it, which repeats on the very next prompt; repeating is what gets a
  // hook switched off for good.
  offers.push({
    id, capability: match.capability, intent: match.intent.id,
    at: new Date(now).toISOString(), promptHash: candidate.promptHash,
    sessionId, severity: 'normal', resolved: null,
  });
  putSession(st, sessionId, offers);
  if (!state && !writeState(st)) return { candidate: null, reason: 'state-unwritable' };
  return { candidate, reason: null };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  const startedAt = Date.now();
  const arg = process.argv[2] || '';

  if (arg === '--summary') { process.stdout.write(`${JSON.stringify(summary(), null, 2)}\n`); return 0; }
  if (arg === '--sweep') {
    const done = sweepSession(process.argv[3] || '');
    process.stdout.write(`${JSON.stringify({ swept: done }, null, 2)}\n`);
    return 0;
  }
  if (arg) return 0;   // an unknown flag is not an occasion to speak

  switch (process.env.RUVNET_ADVOCACY_ROUTE) {
    case '0': case 'off': case 'false': case 'no': return 0;
    default: break;
  }

  // The payload arrives on stdin exactly as unprompted-runtime.mjs forwards it. A TTY is not a pipe
  // and readFileSync(0) on one blocks forever, so a manual run with no redirect yields empty, not a hang.
  let raw = '';
  if (!process.stdin.isTTY) {
    try {
      const { readStdinBounded } = await import('./hook-input.mjs');
      raw = (await readStdinBounded()).toString('utf8');
    } catch { raw = ''; }
  }
  let payload = null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) payload = p;
  } catch { /* not JSON → no occasion → silence */ }
  if (!payload) return 0;

  const prompt = [payload.prompt, payload.user_prompt, payload.input].find((v) => typeof v === 'string' && v.trim()) || '';
  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim()
    ? payload.session_id.trim()
    : `fallback:${process.cwd()}:${new Date().toISOString().slice(0, 10)}`;

  // Lifecycle first: this prompt may be the ANSWER to the last one's offer. Doing it before the new
  // decision is what lets "use agentic-qe" record an `applied` and still be classified on its merits.
  try { resolvePriorOffers(prompt, sessionId); } catch { /* a lost transition costs one row, never the turn */ }

  const { candidate } = decide({ prompt, sessionId, startedAt });
  if (!candidate) return 0;

  if (process.env.RUVNET_EMIT_CANDIDATES === '1') {
    // CANDIDATE MODE: one JSON line, no prose. The runtime honours the dial and the DismissalLedger on
    // it and records the OFFERED denominator centrally — so this path deliberately does NOT record
    // OFFERED here, which would double-count precision's denominator.
    process.stdout.write(`${JSON.stringify(candidate)}\n`);
    return 0;
  }
  // DIRECT MODE (a human running this file, or a host without the runtime). Here this process IS the
  // writer, so it owns the denominator too.
  try { record({ id: candidate.findingId, action: ACTIONS.OFFERED, severity: 'normal', stateHash: candidate.observationHash }); } catch { /* never break the surface we measure */ }
  process.stdout.write(`${candidate.copy}\n`);
  return 0;
}

if (isMain) {
  main().then((code) => process.exit(code || 0)).catch(() => process.exit(0));
}
