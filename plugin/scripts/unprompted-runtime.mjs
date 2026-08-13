#!/usr/bin/env node
// unprompted-runtime.mjs — THE enforcement chokepoint for unprompted speech (ADR-040 / DDD-0004 §"The
// enforcement chokepoint"). This is the CORE of the 4.0 dial-scope work. Read this header as the
// contract every producer, test, and later hooks.json rewrite must build to.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS. DDD-0004 states the invariant verbatim: "Every unprompted utterance passes
// through ONE runtime that reads the level and the DismissalLedger and alone decides whether bytes
// reach the user. An emitter returns a structured candidate; it never writes user-facing bytes
// directly. Raw text from an emitter is a protocol violation — dropped, not forwarded." Until this
// build no such runtime existed: anticipate.sh read the dial itself, lesson-gate read no dial at all,
// and both were wired BARE in hooks.json (`bash … || true`) instead of through the shim. This file is
// that ONE runtime. It is the SOLE writer of user-facing bytes for unprompted hooks.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SEAM (build to THIS — do not invent a parallel one).
//
// INVOCATION. hook-shim.mjs dispatches this file under the single id 'unprompted-speech', forwarding
// the Claude Code event name as argv:
//     node hook-shim.mjs unprompted-speech <CCEventName>   →   node unprompted-runtime.mjs <CCEventName>
// <CCEventName> is the token hooks.json passes (a real CC event like "UserPromptSubmit", or an
// internal sub-event like "PreToolUse-bash"/"PreToolUse-write" that distinguishes which producer to
// run — the same tokens lesson-hooks.sh already switches on). The CC hook JSON payload arrives on this
// process's stdin, exactly as it would for a bare hook.
//
// PRODUCER CANDIDATE MODE. For the given event the runtime spawns the real producer(s) as CAPTURED
// child processes (stdio piped, NEVER inherited) with env RUVNET_EMIT_CANDIDATES=1 and the payload on
// their stdin. A producer in candidate mode writes ZERO user-facing bytes and instead prints ONE JSON
// object per line to stdout:
//     {"channel":"advocacy|promotion|lesson|alarm","effect":"advisory|block","copy":"<text>","hookEventName":"<CCevent>"}
// advocacy/promotion candidates additionally carry: "findingId","severity","observationHash".
// With RUVNET_EMIT_CANDIDATES unset a producer behaves EXACTLY as today (its own CLI/direct output) —
// candidate mode is purely additive. The runtime captures every producer's stdout, discards its
// stderr, and never lets a producer touch the real process streams.
//
// PER-CHANNEL POLICY (applied by the runtime to each parsed candidate, keyed on the candidate's own
// `channel`, never on which producer emitted it):
//   advocacy  → honour the advocacy dial (settings `.settings.advocacy`) AND the DismissalLedger
//               (advocacy-outcomes.shouldStillOffer). Off ⇒ dropped. Suppressed ⇒ dropped. On delivery
//               the runtime records the OFFERED denominator centrally via advocacy-outcomes.record.
//               The real modules are reused — suppression is NOT hand-rolled here.
//   promotion → onboarding policy + advocacy level: delivered only at advocacy `all` (DDD-0004's
//               "silenced by anything below all"); the once-per-install / never-repeat part is the
//               promotion producer's own job (it emits a candidate only when it is due).
//   lesson    → NEVER the advocacy dial. The lesson producer (lesson-gate via lesson-hooks) owns its
//               frequency cap, project scope, and blocking opt-in. `effect:'advisory'` is delivered as
//               a nudge; `effect:'block'` becomes exit 2 with the reason on stderr and byte-empty
//               stdout — an opted-in refusal is never swallowed.
//   alarm     → always delivered. Not gated by anything. Silence here = a broken install looking healthy.
//
// DELIVERY (the runtime writes the final envelope to the REAL streams, itself):
//   advisory → exit 0, stdout = {"hookSpecificOutput":{"hookEventName":…, "additionalContext":…}}.
//   block    → exit 2, reason on stderr, stdout byte-empty.
// A block (only ever from the lesson channel) dominates: if any block survives policy, advisories are
// discarded and the runtime exits 2. Otherwise every surviving advisory copy is concatenated into ONE
// additionalContext string under ONE envelope (two JSON documents on stdout parse as neither).
//
// THE DROP RULE that makes "raw bytes are a protocol violation" mechanically true: on the ADVISORY
// path, invalid JSON / a non-object / an unknown channel / an unknown effect / a missing copy / a
// missing required advocacy field is SILENTLY dropped. A rogue producer that prints raw bytes instead
// of candidate JSON therefore reaches NEITHER user stream. A block is only ever produced by a VALID
// lesson candidate with `effect:'block'`; raw bytes can never manufacture a refusal.
//
// FAIL-SAFE. This never throws out to the caller. Any internal failure resolves toward SILENCE (exit
// 0, empty stdout) — never toward speaking, and never toward a spurious refusal.
//
// NON-NEGOTIABLE INVARIANTS (each proven by a test that breaks it):
//   1. An opted-in BLOCK lesson still exits 2 with byte-empty stdout.
//   2. advocacy=off ⇒ an advocacy candidate yields exit 0 and byte-EXACT stdout === "".
//   3. A rogue producer printing raw bytes ⇒ nothing reaches either user stream on the advisory path.
//   4. (Registry-test territory, not this file) a bare unprompted line in hooks.json fails the test.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { resolveBash } from './hook-shim-bash.mjs';

// WHERE THIS FILE'S SIBLINGS LIVE. Resolved from THIS file's own location so it is correct under the
// Stable Spine (an immutable versions/<gen> tree) and in a dev checkout alike — hook-shim.mjs has
// already chosen the tree by the time it dispatches this body.
//
// THIS USED TO ALSO COMPUTE `CODE_ROOT = SCRIPTS_DIR/../..`, and that line was WRONG in exactly the
// way anticipate.sh's was (PR #114): it assumed `scripts/` is a sibling of `plugin/`, which holds
// ONLY in a git checkout. Both shipped layouts flatten the `plugin/` level —
//
//   ~/.cache/ruvnet-brain/versions/<gen>/scripts/…        → ../.. = …/versions
//   ~/.claude/plugins/cache/…/<ver>/scripts/…             → ../.. = …/ruvnet-brain
//   <src>/plugin/scripts/…                                → ../.. = <src>            ← only this one
//
// — so `$CODE_ROOT/scripts/user-settings.mjs` pointed at nothing on every real install. Both consumers
// (the 1–5 advocacy dial and the DismissalLedger, wired at SETTINGS_MODULE/ADVOCACY_MODULE below)
// `catch` an import failure and fall back to defaults, so the dial was silently UNREAD for every user
// while the code read as if it were honoured. Same defect class, same fix: the modules are SIBLINGS of
// this file inside the payload, so name them from SCRIPTS_DIR and never reach outside it.
const SELF = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SELF);                     // the payload's scripts/ dir, whatever its parent

// The CC event name the shim forwarded. No event → nothing to run; stay silent.
const EVENT = process.argv[2] || '';

// Bound the whole runtime well under the 5s hook budget: producers run sequentially and each has its
// own internal watchdog, but a backstop timeout here means a wedged producer can never hang the turn.
const PRODUCER_TIMEOUT_MS = Number(process.env.RUVNET_UNPROMPTED_TIMEOUT_MS) || 4000;
const MAX_BUFFER = 1 << 20;

const VALID_CHANNELS = new Set(['advocacy', 'promotion', 'lesson', 'alarm']);
const VALID_EFFECTS = new Set(['advisory', 'block']);

/** Exit 0 with byte-empty stdout — the fail-safe and the "nothing to say" path. */
function silent() { process.exit(0); }

// ── Producer registry: CC event token → the producers to spawn in candidate mode ──────────────────
// Each producer is an argv array + whether it is fed the payload on stdin. The channel is NOT declared
// here — it travels on each emitted candidate, so one producer may legitimately emit more than one
// channel and the runtime still routes every line by its own `channel`.
//
// Producers are the adapters that already own event→trigger mapping and payload parsing (lesson-hooks
// maps "PreToolUse-bash" → the mutate-machine trigger and pulls session_id/command off stdin;
// anticipate reads the prompt off stdin). Keeping that mapping in the producer layer is deliberate:
// this core file decides WHETHER bytes reach the user, not WHAT each producer looks for.
//
// TEST SEAM: RUVNET_UNPROMPTED_PRODUCERS, when set to a JSON array of {argv:[...],feedStdin:bool},
// REPLACES the built-in registry for every event — so a test can inject a fake block-emitter, an
// advocacy-emitter, or a rogue raw-bytes emitter without touching real producers.
// `channels` binds each producer to the ONLY channels it is authorised to emit (GPT-5.6-Sol anti-spoof).
// Without it, any producer could emit `{channel:'alarm'}` (always-delivered) or `lesson:block` (force
// exit 2) and bypass its intended per-channel policy — defeating the whole point of the chokepoint.
// BASH COMES FROM THE RESOLVER, NEVER A LITERAL. Found 2026-08-13 by an adversarial audit: with
// `/bin/bash` hardcoded here, win32 has no such file, spawnSync errors, the fail-closed filter at
// `!r.error && r.status === 0` discards every candidate, and the runtime exits 0 through silent().
// That is the ENTIRE unprompted plane — every lesson delivery, every advocacy card, every promotion
// — dead on Windows and indistinguishable from "nothing to say". The invariant tests all inject
// producers through the RUVNET_UNPROMPTED_PRODUCERS seam, so they stay green while the real registry
// is broken: a suite that cannot fail on the shipped path. resolveBash() has handled this since
// issue #38 and sat one import away.
const BASH = resolveBash();
const ANTICIPATE = { argv: [BASH, path.join(SCRIPTS_DIR, 'anticipate.sh')], feedStdin: true, channels: ['advocacy', 'promotion'] };
const lesson = (subEvent) => ({ argv: [BASH, path.join(SCRIPTS_DIR, 'lesson-hooks.sh'), subEvent], feedStdin: true, channels: ['lesson'] });

const BUILTIN_REGISTRY = {
  'UserPromptSubmit': [ANTICIPATE, lesson('UserPromptSubmit')],
  'PreToolUse-write': [lesson('PreToolUse-write')],
  'PreToolUse-bash':  [lesson('PreToolUse-bash')],
  'PreToolUse-push':  [lesson('PreToolUse-push')],
};

function resolveProducers(event) {
  const override = process.env.RUVNET_UNPROMPTED_PRODUCERS;
  if (override) {
    try {
      const specs = JSON.parse(override);
      if (Array.isArray(specs)) {
        return specs
          .filter((s) => s && Array.isArray(s.argv) && s.argv.length && s.argv.every((a) => typeof a === 'string'))
          .map((s) => ({
            argv: s.argv,
            feedStdin: s.feedStdin !== false,
            // The test seam may declare `channels` to exercise the anti-spoof; absent, it defaults to all
            // (a test injects a trusted fake). Production spoof-protection lives on the built-in entries.
            channels: Array.isArray(s.channels) ? s.channels.filter((c) => VALID_CHANNELS.has(c)) : [...VALID_CHANNELS],
          }));
      }
    } catch { /* malformed override → fall through to the built-in registry */ }
  }
  return BUILTIN_REGISTRY[event] || [];
}

// ── Read the payload ONCE, forward the same bytes to every producer ────────────────────────────────
// Claude Code pipes the hook JSON and closes stdin, so a synchronous read to EOF is safe and simplest.
// GUARD: an interactive/attached stdin (a TTY) is NOT piped and would block readFileSync(0) forever —
// so read only when fd 0 is a real pipe/file. A manual run with no redirect yields empty, not a hang.
let payload = Buffer.alloc(0);
if (!process.stdin.isTTY) {
  try { payload = await readStdinBounded(); } catch { payload = Buffer.alloc(0); }
}

// AN UNPROMPTED UTTERANCE MUST BE OCCASIONED BY A REAL EVENT (fixed 2026-07-27).
//
// Measured on origin/main, the same runtime, three inputs:
//
//     empty stdin  -> 2453 bytes, exit 0
//     garbage      -> 2453 bytes
//     real payload -> 0 bytes
//
// Read those together: it was silent when a real event arrived and spoke when none did. The producers
// downstream match triggers that are true unconditionally (report-status, claim-done), so with no
// payload to constrain them they emit on every fire — payload-independent speech, which is noise with
// a JSON envelope around it, injected into the user's context.
//
// The header already commits to the shape of this: "never speak on a guess" is why an unknown event
// stays silent. A payload that is absent, truncated, or not a JSON object is the same class of
// not-knowing, and resolves the same way — toward silence, per the FAIL-SAFE rule above. Claude Code
// always writes a JSON object and closes, so no real fire is affected; the test seam's fixtures all
// pass a real payload for the same reason.
let event = null;
try {
  const parsed = JSON.parse(payload.toString('utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) event = parsed;
} catch { /* not JSON → no occasion → silence, below */ }
if (!event) silent();

const producers = resolveProducers(EVENT);
if (!producers.length) silent();   // unknown event, or nothing wired for it — never speak on a guess

// ── Spawn producers as CAPTURED children, collect candidate lines ──────────────────────────────────
// stdio is piped (input buffer for stdin; stdout/stderr captured into the result). NOTHING a producer
// writes touches the real streams — that is what makes the runtime the sole writer, and what drops a
// rogue producer's raw bytes before they can reach a terminal.
// ONE global deadline for ALL producers combined (GPT-5.6-Sol): sequential per-producer timeouts could
// otherwise sum past the 5s hook budget. Each producer gets only the remaining budget; once it is spent,
// no further producer runs. rawLines carries each line WITH its producer's authorised channel set.
const rawLines = [];   // { s, channels }
const DEADLINE = Date.now() + PRODUCER_TIMEOUT_MS;
for (const p of producers) {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) break;                 // global budget spent → run no more producers
  let out = '';
  try {
    const r = spawnSync(p.argv[0], p.argv.slice(1), {
      input: p.feedStdin ? payload : Buffer.alloc(0),
      env: { ...process.env, RUVNET_EMIT_CANDIDATES: '1' },
      timeout: remaining,
      maxBuffer: MAX_BUFFER,
    });
    // FAIL CLOSED (GPT-5.6-Sol): a producer that errored, exited non-zero, was signalled (a timeout kill),
    // or overflowed maxBuffer has UNTRUSTWORTHY partial output — discard it, never deliver a fragment.
    if (!r.error && r.status === 0 && !r.signal && r.stdout) out = r.stdout.toString('utf8');
  } catch { out = ''; }   // a failed spawn contributes no candidates — never a failure of the turn
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (s) rawLines.push({ s, channels: p.channels });
  }
}

// ── Parse candidates. Anything that is not a well-formed candidate object is dropped here, which is
// where the "raw bytes are a protocol violation" guarantee is actually enforced. ───────────────────
const MAX_COPY = 8192;   // a real advisory is short; cap so a rogue/buggy 900KB emission cannot bloat delivery
const candidates = [];
for (const { s, channels } of rawLines) {
  let c;
  try { c = JSON.parse(s); } catch { continue; }              // not JSON → drop (a rogue's raw line)
  if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
  if (!VALID_CHANNELS.has(c.channel)) continue;               // unknown/absent channel → drop
  if (!channels.includes(c.channel)) continue;                // ANTI-SPOOF (GPT-5.6-Sol): this producer is
                                                              // not authorised for this channel → drop
  if (!VALID_EFFECTS.has(c.effect)) continue;                 // unknown/absent effect → drop
  if (typeof c.copy !== 'string' || !c.copy.trim()) continue; // nothing to say → drop
  c.copy = c.copy.slice(0, MAX_COPY);                         // cap size; delivery below is synchronous
  candidates.push(c);
}
if (!candidates.length) silent();

// ── Lazy access to the REAL dial read and the REAL DismissalLedger. Reused, not re-implemented. ────
// The dial comes from user-settings.loadSettings() (the versioned-envelope reader that honours
// RUVNET_SETTINGS_FILE); suppression comes from advocacy-outcomes.shouldStillOffer()/record(). Both
// are loaded only if an advocacy/promotion candidate is actually present, so a lesson- or alarm-only
// event pays nothing for them.
// SIBLINGS, not `$CODE_ROOT/scripts/…` — see the SCRIPTS_DIR note at the top of this file for the
// measured layouts that made the old path resolve to nothing on every shipped install.
const SETTINGS_MODULE = process.env.RUVNET_USER_SETTINGS_MODULE || path.join(SCRIPTS_DIR, 'user-settings.mjs');
const ADVOCACY_MODULE = process.env.RUVNET_ADVOCACY_OUTCOMES_MODULE || path.join(SCRIPTS_DIR, 'advocacy-outcomes.mjs');

// THE 1–5 DIAL (ADR-052). This runtime is the SINGLE enforcement chokepoint (DDD-0004): the level maps
// to exactly what each channel is allowed to deliver, and no producer decides. LEVEL_POLICY is the one
// source of truth for that mapping — it is mirrored in the human copy of user-settings.mjs's `levels`,
// and the two must move together.
//   1 Only-when-I-ask : nothing unprompted (alarms still fire)
//   2 Critical-only   : advocacy for HIGH-severity findings only; no promotions
//   3 Balanced        : advocacy for relevant findings; no promotions          ← default
//   4 Proactive       : advocacy + lesson-promotion nudges
//   5 Maximum help    : advocacy + promotions (broadest)
const LEVEL_POLICY = {
  1: { advocacy: false, promotion: false, severityFloor: null },
  2: { advocacy: true,  promotion: false, severityFloor: 'high' },
  3: { advocacy: true,  promotion: false, severityFloor: null },
  4: { advocacy: true,  promotion: true,  severityFloor: null },
  5: { advocacy: true,  promotion: true,  severityFloor: null },
};
const LEGACY_LEVEL = { off: 1, 'important-only': 3, all: 4 };   // defensive: map a raw pre-migration value too

let _level;
async function advocacyLevel() {
  if (_level !== undefined) return _level;
  // Default 3 (Balanced) — matches user-settings' default AND preserves the old 'important-only'
  // behaviour (advocacy on, promotion off) for anyone who never touched the setting.
  _level = 3;
  try {
    const m = await import(pathToFileURL(SETTINGS_MODULE).href);
    if (typeof m.loadSettings === 'function') {
      const v = m.loadSettings().values?.advocacy;   // loadSettings already migrates legacy strings → 1-5
      const n = typeof v === 'number' ? v : LEGACY_LEVEL[v];
      if (Number.isInteger(n) && n >= 1 && n <= 5) _level = n;
    }
  } catch { /* keep the safe default */ }
  return _level;
}
async function policy() { return LEVEL_POLICY[await advocacyLevel()] || LEVEL_POLICY[3]; }

let _ledger = null;      // { shouldStillOffer, record, ACTIONS } or null if unavailable
let _ledgerTried = false;
async function ledger() {
  if (_ledgerTried) return _ledger;
  _ledgerTried = true;
  try {
    const m = await import(pathToFileURL(ADVOCACY_MODULE).href);
    if (typeof m.shouldStillOffer === 'function' && typeof m.record === 'function' && m.ACTIONS) {
      _ledger = { shouldStillOffer: m.shouldStillOffer, record: m.record, ACTIONS: m.ACTIONS };
    }
  } catch { _ledger = null; }
  return _ledger;
}

// ── Apply per-channel policy ───────────────────────────────────────────────────────────────────────
const advisories = [];   // { copy, hookEventName }
const blocks = [];       // reason strings

for (const c of candidates) {
  const hookEventName = typeof c.hookEventName === 'string' && c.hookEventName.trim() ? c.hookEventName.trim() : null;
  const copy = c.copy.trim();

  switch (c.channel) {
    case 'alarm':
      // Always delivered, never gated. Alarms inform; they do not refuse — a stray block effect on an
      // alarm is treated as advisory rather than allowed to refuse the user's work.
      advisories.push({ copy, hookEventName });
      break;

    case 'lesson':
      if (c.effect === 'block') {
        // The lesson producer only emits effect:'block' for a lesson the user personally opted into
        // (blocking-optin.json). The runtime propagates that refusal untouched — it never invents one
        // and never swallows one.
        blocks.push(copy);
      } else {
        advisories.push({ copy, hookEventName });
      }
      break;

    case 'promotion': {
      // DDD-0004's three-channels table + ADR-052's 1–5 dial: lesson-promotion nudges are delivered
      // only at levels 4–5 (Proactive / Maximum). A block effect from promotion is a protocol
      // violation → drop it.
      if (c.effect !== 'advisory') break;
      if (!(await policy()).promotion) break;   // levels 1–3 ⇒ no promotion nudges
      advisories.push({ copy, hookEventName });
      break;
    }

    case 'advocacy': {
      // The dial AND the DismissalLedger, enforced centrally on the candidate — this is the chokepoint's
      // whole point: even a naive or rogue producer that emits an advocacy candidate is dropped when the
      // dial is off or the finding is suppressed.
      if (c.effect !== 'advisory') break;                    // advocacy cannot block
      const findingId = typeof c.findingId === 'string' && c.findingId.trim() ? c.findingId.trim() : '';
      if (!findingId) break;                                 // malformed advocacy candidate → drop
      const severity = typeof c.severity === 'string' && c.severity.trim() ? c.severity.trim() : null;
      const pol = await policy();
      if (!pol.advocacy) break;                              // level 1 ⇒ nothing (INVARIANT 2: exit 0, stdout "")
      if (pol.severityFloor === 'high' && severity !== 'high' && severity !== 'critical') break;   // level 2 ⇒ high-severity only
      const led = await ledger();
      if (!led) break;                                       // cannot verify the ledger → stay silent (safe)
      const stateHash = typeof c.observationHash === 'string' && c.observationHash.trim() ? c.observationHash.trim() : null;
      let offer = true;
      try { offer = led.shouldStillOffer(findingId, { severity, stateHash }); } catch { offer = false; }
      if (!offer) break;                                     // dismissed / budget spent → drop
      // Deliver, and record the OFFERED denominator centrally (best-effort; recording never breaks
      // the hook it measures). Moving OFFERED here is what makes precision computable at the one place
      // that actually decides to show a card.
      try { led.record({ id: findingId, action: led.ACTIONS.OFFERED, severity, stateHash }); } catch { /* a lost row costs one denominator, never the turn */ }
      advisories.push({ copy, hookEventName });
      break;
    }

    default:
      break;   // unreachable — VALID_CHANNELS already filtered
  }
}

// ── Deliver. A surviving block dominates everything. ───────────────────────────────────────────────
if (blocks.length) {
  // Exit 2: stdout is ignored by the harness and MUST be byte-empty; stderr becomes the model's refusal
  // reason. SYNCHRONOUS write (GPT-5.6-Sol) — process.exit() after an async write drops buffered bytes on a
  // pipe (measured 900KB→8KB). Advisories collected this pass are discarded: a refusal supersedes.
  try { fs.writeSync(2, blocks.join('\n') + '\n'); } catch { /* nothing else to do at the boundary */ }
  process.exit(2);
}

if (!advisories.length) silent();

// hookEventName MUST name the firing CC event or the harness discards the envelope. DERIVE it from the
// runtime's own EVENT (GPT-5.6-Sol) rather than trusting a producer-stamped value — the runtime knows the
// real event and a producer must not be able to restamp it. "PreToolUse-bash" → "PreToolUse".
const hookEventName = EVENT ? EVENT.split('-')[0] : 'UserPromptSubmit';

// SYNCHRONOUS write — the truncation fix on the byte-owner itself (see the block path above).
const additionalContext = advisories.map((a) => a.copy).join('\n\n');
try { fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })); }
catch { /* if even the final write fails, silence is the fail-safe */ }
process.exit(0);
