#!/usr/bin/env node
/**
 * lesson-gate.mjs — canonical plugin-payload wire that makes a stored lesson change behaviour.
 *
 * THIS IS THE L3 STEP. ADR-029 mines which lessons are universal; ADR-030 says a lesson must
 * INTERRUPT at a decision point or it is prose. Both shipped. And nothing read the store: a grep for
 * `lessonsFor` across every gate returned zero. Lessons were written, schema-validated, weighted,
 * trust-boundaried — and consumed by nobody.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, 2026-07-22, and it is two separate corrections that happen to point the same way.
 *
 * CORRECTION 1 — THE BLOCK NEVER BLOCKED. Two independent reviewers found it; running it confirmed
 * it. The previous version printed the word "BLOCKED" and then allowed the action, in three
 * compounding ways:
 *
 *     scripts/lesson-gate.mjs:86     exited 1, not 2. Exit 1 is a NON-BLOCKING error: the live hooks
 *                                    doc says other non-zero codes show a "hook error" notice to the
 *                                    USER and "execution continues". Only exit 2 refuses anything.
 *     scripts/lesson-gate.mjs        15 console.log, 0 console.error. On exit 2 the doc is explicit:
 *                                    "Claude Code ignores stdout... stderr text is fed back to
 *                                    Claude". The refusal reason went to the one stream a refusal
 *                                    cannot use.
 *     plugin/scripts/lesson-hooks.sh `|| true` then exit 0 — discarding whatever code did survive.
 *
 * Measured before the fix:  `bash plugin/scripts/lesson-hooks.sh Stop` → printed "⛔ BLOCKED", exit 0.
 *
 * ADR-028 claimed "five gates exit 1 and refuse the action — proven by exit code". That proof was
 * obtained by running this file BY HAND on a terminal, which is the one caller that is not a hook.
 * The exit code was real; the claim that it blocked anything was not. This is L01 — verify through a
 * channel CAPABLE of observing the change — violated by the very file that enforces L01.
 *
 * CORRECTION 2 — AND WE DO NOT WANT IT TO BLOCK. The owner, the same day:
 *
 *     "Nudging somebody is very fair. Forcing them through a gate is not."
 *     "That respect for the individual and how they do it is a big part of the win."
 *
 * So the fix is NOT to turn six silent blocks into six real ones. That would ship, for the first
 * time, the product the owner has just rejected — and it would land on existing users as a machine
 * that suddenly started refusing work it accepted yesterday. Every ratified `block` lesson is now a
 * NUDGE. Blocking is a per-lesson decision the USER makes, in a file only the user writes.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT, verified against code.claude.com/docs/en/hooks on 2026-07-22 rather than recalled:
 *
 *   NUDGE  → exit 0 + JSON `hookSpecificOutput.additionalContext` on stdout.  Informs, never refuses.
 *   BLOCK  → exit 2 + reason on stderr.  Refuses. Opt-in per lesson, by the user, only.
 *
 * The nudge channel is NOT stderr, and this is the subtle part that a plausible-sounding design got
 * wrong twice. On exit 0 the doc says stdout "is written to the debug log but not shown in the
 * transcript" for most events, with only UserPromptSubmit / UserPromptExpansion / SessionStart as
 * exceptions — and it says nothing about exit-0 stderr at all, because exit-0 stderr is not a
 * delivery channel. A nudge written to stderr at Stop or PreToolUse reaches NOBODY: it would have
 * been the identical built-tested-unwired defect, rebuilt one file to the left.
 *
 * What actually works, quoted from the live doc:
 *
 *     "The `additionalContext` field passes a string from your hook into Claude's context window.
 *      Claude Code wraps the string in a system reminder and inserts it into the conversation at the
 *      point where the hook fired."
 *
 * and it is supported at every event this gate fires on — PreToolUse, Stop, UserPromptSubmit
 * included. (An adversarial review asserted a non-blocking nudge at Stop was IMPOSSIBLE because Stop
 * accepts only `decision: "block"`. The live doc contradicts it: "Stop and SubagentStop also accept
 * hookSpecificOutput.additionalContext for non-error feedback that continues the conversation." The
 * reviewer was reasoning from an older contract. Checked, not assumed — which is the whole rule.)
 *
 * That gives a nudge everything the block was supposed to have and the one thing it should not:
 * it reaches the model, at the decision point, carrying the user's own words — and it refuses nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DESIGN CONSTRAINT, unchanged and load-bearing: a gate must never break the thing it guards. Any
 * failure here — missing store, corrupt JSON, unreadable file — exits 0 silently. A lesson gate that
 * blocked a push because it could not read a config file would be worse than no lesson gate, and
 * would be switched off within a day, which is how every over-eager gate dies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLessons, lessonsFor, ENFORCEMENT, STATUS, ORIGIN, TRIGGERS } from './lesson-store.mjs';
import { looksLikeOutsideRepoMutation } from './lesson-command-scope.mjs';
import { buildLessonPresentation } from './lesson-presentation.mjs';
export { looksLikeOutsideRepoMutation } from './lesson-command-scope.mjs';

// The two codes that mean something to the harness. Anything else is an error, and an error here
// must never be mistaken for a refusal — see ALLOW-on-failure throughout.
const EXIT_ALLOW = 0;
const EXIT_BLOCK = 2;

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
// --trigger is REPEATABLE. One real event carries several decision points at once (ending a turn is
// simultaneously "reporting status" and "claiming done"), and they must resolve to ONE verdict and
// ONE JSON object — two JSON documents on stdout is not JSON, and two node spawns on every event is
// latency on the hot path for no gain.
const allArgs = (f) => argv.reduce((acc, v, i) => (v === f && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const triggers = allArgs('--trigger');
const event = arg('--event');          // the real Claude Code event name → hook mode
const quiet = argv.includes('--quiet');
const json = argv.includes('--json');
// Session identity for the per-session frequency cap (below). The dispatcher passes the harness's
// real session_id; a caller that predates this (or a manual run) gets a cwd+day fallback so the cap
// is still BOUNDED — at worst it repeats an advisory once per project per day — rather than unbounded.
const session = arg('--session');
// NOT `arg('--command')`: that helper treats a falsy VALUE the same as an ABSENT flag
// (`argv[i+1] ? ... : d`), so a real event whose command happens to be "" would silently fall back to
// the unfiltered default — precisely the false-nag path this fix exists to close. Presence of the flag,
// not truthiness of its value, is what distinguishes "an old caller that never learned about this" from
// "the dispatcher, telling us the command text (however short)".
const commandIdx = argv.indexOf('--command');
const command = commandIdx >= 0 ? (argv[commandIdx + 1] ?? '') : null;

// CANDIDATE MODE (ADR-040 / DDD-0004 "the enforcement chokepoint"). Set by unprompted-runtime.mjs on
// every producer child. When on, hook mode writes ZERO user-facing bytes and NEVER exits 2 itself:
// it emits ONE JSON candidate per line on stdout and lets the runtime — the SOLE writer of user bytes
// — turn a `block` candidate into the real exit 2 + stderr and an `advisory` candidate into the
// nudge. Unset (every direct/legacy/CLI invocation, and every existing test), behaviour is byte-for-
// byte unchanged, exit-2 block semantics included. Purely additive.
const EMIT_CANDIDATES = process.env.RUVNET_EMIT_CANDIDATES === '1';

/**
 * THE CONSENT FILE — where "yes, actually refuse me" is recorded, and why it is not in the lesson store.
 *
 * Two reasons, and the first is a measured fact rather than a preference:
 *
 * 1. A per-lesson flag in the store WOULD NOT SURVIVE. `makeLesson()` destructures a fixed field set
 *    and returns a frozen object built from exactly those fields; any unknown key is silently
 *    dropped on load. Verified 2026-07-22 by construction — `makeLesson({...,userOptedIntoBlocking:
 *    true})` returns an object without it. A consent flag stored there would read back as absent on
 *    every load, i.e. consent that silently evaporates, which is the worst possible failure mode for
 *    a consent record.
 *
 * 2. It is the right trust boundary anyway. `lessons.json` is written by the MINING pipeline —
 *    unattended, over session transcripts, over content that may have been planted (ADR-031's whole
 *    subject). If "may block" lived in that file, anything that could get a lesson mined could grant
 *    itself the power to refuse the user's work. It lives in a file the pipeline never writes.
 *
 * Honest about what this is NOT: it is not a defence against a model that can run shell commands —
 * such a model can write any file on the machine. It is a boundary against MINED and IMPORTED
 * content reaching enforcement, which is the path the adversarial review actually found.
 *
 * The empty default is the point: no file, no blocking. Consent is never inferred from silence.
 */
export const OPTIN_PATH = process.env.RUVNET_LESSON_OPTIN
  || path.join(os.homedir(), '.config', 'ruvnet-brain', 'blocking-optin.json');

if (!triggers.length) {
  console.log('lesson-gate — surface the lessons in force at a decision point\n');
  console.log('  --trigger <key>   one of: ' + Object.values(TRIGGERS).map((t) => t.key).join(', '));
  console.log('                    repeatable; one event may carry several decision points');
  console.log('  --event <name>    Claude Code event (Stop, PreToolUse, UserPromptSubmit) → hook mode:');
  console.log('                    nudges emit JSON additionalContext (exit 0), blocks emit stderr (exit 2)');
  console.log('  --json            machine-readable');
  console.log('  --quiet           print nothing; exit code only\n');
  console.log('  blocking is OPT-IN per lesson: ' + OPTIN_PATH);
  process.exit(EXIT_ALLOW);
}

function loadBlockingOptIn(file = OPTIN_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Tolerant of both shapes because a human is expected to hand-edit this: a bare array reads
    // fine, and so does the documented object. Being fussy about a consent file's punctuation would
    // silently downgrade someone's explicit "yes" to a "no".
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.blocking) ? raw.blocking : [];
    return new Set(list.filter((x) => typeof x === 'string' && x.length));
  } catch { return new Set(); }   // absent or unparseable → nobody blocks. Never fail INTO refusing.
}

let lessons = [];
try { lessons = loadLessons(); } catch { process.exit(EXIT_ALLOW); }   // never break the caller

const optedIn = loadBlockingOptIn();

/**
 * THE PER-SESSION FREQUENCY CAP — because a true advisory repeated verbatim on every matching event is
 * the nag ADR-030 bans (measured 2026-07-22: the mutate-machine advisory rendered on every Bash call of
 * a session). anticipate.sh already caps its own nudges per session; this is the same discipline for the
 * lesson gate. A PURE-ADVISORY lesson is shown at most MAX_SHOWS times per session, then stays silent
 * until a new session.
 *
 * THE LOAD-BEARING INVARIANT: an actual REFUSAL is never capped. A lesson the user has opted into as a
 * block (isBlocking, below) exits 2 and refuses the action — the cap must never touch it. But a merely
 * block-CAPABLE lesson the user has NOT opted into renders as an ADVISORY (exit 0): it is a reminder, not
 * a refusal, and it is capped like any other advisory. An earlier version exempted block-capable lessons
 * too — which left exactly the lesson doing the nagging (the block-capable "gate on blast radius", never
 * opted in) repeating unbounded on every mutating command; an independent regrade caught it. Capping a
 * block-capable ADVISORY silences no refusal: a refusal exits 2 regardless of this file's display budget,
 * and the one-time "you could turn this into a refusal" offer needs to be seen a few times, not forever.
 *
 * FAIL-OPEN: any error reading or writing the state degrades to the pre-cap behaviour (show it), never to
 * suppression — a gate that goes quiet because it could not read a JSON file is worse than a repeat.
 */
const GATE_STATE_PATH = process.env.RUVNET_LESSON_GATE_STATE
  || path.join(os.homedir(), '.config', 'ruvnet-brain', 'lesson-gate-state.json');
const MAX_SHOWS = (() => {
  const n = Number(process.env.RUVNET_LESSON_MAX_SHOWS);
  return Number.isInteger(n) && n > 0 ? n : 3;
})();
const KEEP_SESSIONS = 20;   // bound the state file to the most-recent sessions, same as anticipate.sh
const SID = (typeof session === 'string' && session.trim())
  ? session.trim()
  : `fallback:${process.cwd()}:${new Date().toISOString().slice(0, 10)}`;
/**
 * BLOCKING = four conditions, all required; the user's opt-in is necessary and NOT sufficient. Defined
 * here (rather than at the emit site) because the frequency cap below must key its exemption on it: the
 * last two conditions are also guaranteed by makeLesson, and are re-asserted deliberately — this is the
 * one place the answer is "refuse the human's work", and a security invariant enforced only at a distance
 * is one refactor from being enforced nowhere.
 */
const isBlocking = (l) => optedIn.has(l.id)
  && l.enforcement === ENFORCEMENT.BLOCK
  && (l.status === STATUS.RATIFIED || l.status === STATUS.ACTIVE)
  && l.origin === ORIGIN.USER_STATED;
/** Exempt from the cap: ONLY a lesson that refuses RIGHT NOW (an opted-in block, exit 2). A block-capable
 *  lesson that is not opted in is an advisory and is capped like any other — see the invariant above. */
const capExempt = isBlocking;
function readGateState() {
  try { const s = JSON.parse(fs.readFileSync(GATE_STATE_PATH, 'utf8')); return s && typeof s === 'object' ? s : {}; }
  catch { return {}; }
}
function writeGateState(st) {
  try {
    fs.mkdirSync(path.dirname(GATE_STATE_PATH), { recursive: true });
    fs.writeFileSync(GATE_STATE_PATH, JSON.stringify(st));
    return true;
  } catch { return false; }
}
/** How many times THIS session has already surfaced a given advisory lesson (0 if never). */
function shownCount(st, id) {
  const c = st?.sessions?.[SID]?.shown?.[id];
  return Number.isInteger(c) && c > 0 ? c : 0;
}
// Read ONCE, up front — the same snapshot gates the filter and seeds the write below.
const gateState = event ? readGateState() : {};

// Merge every requested decision point into one ranked, de-duplicated list. A lesson registered at
// two triggers must appear once, or the model reads the same correction twice and learns to skim.
/**
 * PROJECT SCOPE — a lesson learned in one project has no standing to interrupt work in another.
 *
 * THE BREAKAGE, 2026-07-22: these hooks were installed machine-wide and 8 of 16 lessons were scoped
 * to a SINGLE project, yet fired everywhere. A WhitSentry session was being told about
 * ruvnet-brain's stop-and-report habit on every prompt. The owner's report was blunt: "I've got
 * other repos that are using this thing, and they're breaking."
 *
 * The rule is ADR-029's own promotion bar applied at read time: cross-project rediscovery is what
 * makes a lesson universal. Taught in ONE project, it is local knowledge — real, worth keeping, and
 * not entitled to speak elsewhere. Taught in two or more, it has earned the right to travel.
 *
 * This is P3 (nudge, never force) and P4 (the user is the arbiter) applied to OUR OWN footprint:
 * the fastest way to make someone uninstall a nudge is to nudge them about something that has
 * nothing to do with what they are doing.
 */
const HERE = (() => {
  let d = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) { d = process.cwd(); break; }
    d = up;
  }
  return path.basename(d);
})();
/** Does this lesson belong to the project we are standing in? Match is loose on purpose — stored
 *  names carry prefixes like `Code-` that the directory name does not. */
const isHome = (l) => {
  const ps = Array.isArray(l.projects) ? l.projects : [];
  if (!ps.length) return true;                       // unscoped: applies anywhere, by declaration
  return ps.some((p) => {
    const n = String(p).replace(/^Code-/, '');
    return n === HERE || String(p) === HERE || HERE.endsWith(n) || n.endsWith(HERE);
  });
};
const isUniversal = (l) => Array.isArray(l.projects) && l.projects.length >= 2;

// Apply the mutate-machine predicate defined above. `mutate-machine` is requested for EVERY Bash
// call (plugin/scripts/lesson-hooks.sh:98) — it is the ONLY trigger the dispatcher fires unconditionally
// on a tool, so it is the only one that needs narrowing here. When no `--command` was supplied (a bare
// CLI invocation, or a caller that predates this fix), behavior is UNCHANGED — fail open to the old,
// unfiltered behavior rather than silently swallow a trigger nobody asked to have filtered.
const MUTATE_KEY = TRIGGERS.MUTATE_MACHINE.key;
const effectiveTriggers = command === null
  ? triggers
  : triggers.filter((t) => t !== MUTATE_KEY || looksLikeOutsideRepoMutation(command));

const seen = new Set();
const candidates = [];
for (const t of effectiveTriggers) {
  for (const l of lessonsFor(t, lessons, { limit: 3 })) {
    if (seen.has(l.id)) continue;
    // Away from home, only a lesson with cross-project evidence may speak.
    if (!isHome(l) && !isUniversal(l)) continue;
    seen.add(l.id); candidates.push(l);
  }
}

const NUDGE_CHAR_BUDGET = Number(process.env.RUVNET_NUDGE_BUDGET) || 1200;
const presentation = buildLessonPresentation({
  candidates,
  event,
  shownCount: (id) => shownCount(gateState, id),
  isBlocking,
  triggers,
  optInPath: OPTIN_PATH,
  maxShows: MAX_SHOWS,
  nudgeBudget: NUDGE_CHAR_BUDGET,
});
const { inForce, blocking, blockCapable, body: renderedBody, advisoryContext } = presentation;
const renderBody = () => renderedBody;

// ── Emit ─────────────────────────────────────────────────────────────────────────────────────────

if (json) {
  console.log(JSON.stringify({
    triggers, event: event ?? null, inForce,
    blocking: blocking.map((l) => l.id),
    blockCapable: blockCapable.map((l) => l.id),
    optInPath: OPTIN_PATH,
  }, null, 2));
  process.exit(blocking.length ? EXIT_BLOCK : EXIT_ALLOW);
}

if (event) {
  // RECORD what this session is about to SURFACE, so the frequency cap can act next time. Only
  // pure-advisory lessons count toward their own cap; block-capable lessons are exempt (capExempt) and
  // never recorded. Skipped when nothing will render (quiet with no block). Best-effort and fail-open —
  // a lost write repeats an advisory once more, it never suppresses one. Persisted BEFORE the streams
  // are touched, so a crash mid-emit under-counts (safe) rather than over-counts.
  const willRender = blocking.length > 0 || (inForce.length > 0 && !quiet);
  if (willRender) {
    const st = gateState && typeof gateState === 'object' ? gateState : {};
    st.sessions = st.sessions && typeof st.sessions === 'object' ? st.sessions : {};
    const prev = st.sessions[SID] && typeof st.sessions[SID] === 'object' ? st.sessions[SID] : {};
    const shown = prev.shown && typeof prev.shown === 'object' ? { ...prev.shown } : {};
    for (const l of inForce) {
      if (capExempt(l)) continue;
      shown[l.id] = (Number.isInteger(shown[l.id]) && shown[l.id] > 0 ? shown[l.id] : 0) + 1;
    }
    st.sessions[SID] = { shown, ts: Date.now() };
    // Bound the file to the most-recent sessions, same discipline as anticipate.sh.
    st.sessions = Object.fromEntries(
      Object.entries(st.sessions).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)).slice(0, KEEP_SESSIONS),
    );
    writeGateState(st);
  }

  // CANDIDATE MODE — emit JSON candidates, let the runtime own the real streams and the exit code.
  // A block DOMINATES exactly as in the stream contract below: when any opted-in block is in force we
  // emit only the block candidate and no advisory. The `copy` of each candidate is byte-identical to
  // what the legacy path would have written (renderBody() to stderr for a block; the advisory preamble
  // + renderBody() as additionalContext for a nudge), so the runtime's delivered bytes match. The
  // frequency-cap persist above already ran, so persist-before-speak holds here too.
  if (EMIT_CANDIDATES) {
    if (blocking.length) {
      process.stdout.write(JSON.stringify({
        channel: 'lesson', effect: 'block', copy: renderBody(), hookEventName: event,
      }) + '\n');
    } else if (inForce.length && !quiet) {
      process.stdout.write(JSON.stringify({
        channel: 'lesson', effect: 'advisory', hookEventName: event,
        copy: advisoryContext,
      }) + '\n');
    }
    process.exit(EXIT_ALLOW);
  }

  // HOOK MODE — the streams are the contract, so nothing else may touch them.
  if (blocking.length) {
    // Exit 2: stdout is ignored by the harness, stderr becomes the model's error message. Writing
    // the reason anywhere but stderr is exactly the bug this file exists to fix.
    process.stderr.write(renderBody() + '\n');
    process.exit(EXIT_BLOCK);
  }
  if (inForce.length && !quiet) {
    // Exit 0 + additionalContext: reaches the model, at the decision point, refusing nothing.
    // hookEventName MUST name the firing event or the harness discards the envelope.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: advisoryContext,
      },
    }));
  }
  process.exit(EXIT_ALLOW);
}

// ── CLI MODE (no --event) ────────────────────────────────────────────────────────────────────────
// Plain text on stdout, unchanged. version-bump-gate.sh captures this stdout verbatim and appends it
// to its own refusal under "── from your own lesson store ──"; changing the stream or the shape here
// would silently empty that section of the only gate in the system that genuinely works.
if (!quiet && inForce.length) console.log(renderBody());
process.exit(blocking.length ? EXIT_BLOCK : EXIT_ALLOW);
