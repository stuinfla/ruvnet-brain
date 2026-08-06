#!/bin/sh
# anticipate.sh — the L4 DELIVERY surface (ADR-028 "Anticipatory"; anti-nag contract from ADR-027).
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# WHAT THIS IS. A UserPromptSubmit hook that reads the prompt the user is about to send, asks the
# goal matcher whether any DORMANT capability on this machine serves that goal, and — at most once
# per session per capability — says exactly one line about it. Silence is the default and by far the
# common case.
#
# WHY IT EXISTS AS A HOOK AND NOT A PAGE. ADR-028 is blunt about the failure it diagnoses: "The
# console is a page you have to visit. A surface the user must navigate to is a PULL surface.
# Advocacy that waits for you to open it is not proactivity — it is a dashboard with better copy."
# The measured cost of that shape was 21 days between a capability becoming dormant and anyone
# being told, with the data sitting there the whole time. A matcher nothing calls repeats that
# mistake exactly; this file is the thing that calls it.
#
# WHY IT IS SO AGGRESSIVELY QUIET. ADR-027: "Advocacy must not become nagging... a nag trains users
# to ignore the real alarm." ADR-028 fixes a hard precision floor of 0.60 (recommendations acted on
# ÷ recommendations fired) and states that frequency is "a feature with a hard ceiling, not a dial
# to turn up". A hook that speaks too often is a hook people disable, and a disabled hook protects
# nothing — so every ambiguous case in this file resolves to SILENCE, never to speech.
#
# THE FOUR SILENCE RULES, each enforced below and each with a test:
#   1. Only state 'off' ever speaks. NEVER 'unknown' — see the learning-hooks detector in
#      capability-registry.mjs, which reported "26 hooks off" from a CLI's cosmetic table column
#      while the learner held 457 trajectories. 'unknown' means we do not know, and a system that
#      renders not-knowing as a fault is lying. 'absent' is silent too: nothing to switch on.
#   2. No evidence, no speech. A match with no `why` string is dropped, same discipline as
#      console-engine.makeRecommendation() throwing on a recommendation with no evidence/undo.
#   3. Cannot remember → must not speak. If the "already said this" state fails to persist, we
#      stay silent rather than risk repeating on the very next prompt. Forgetting is a nag.
#   4. If in doubt, nothing. Missing module, unparseable payload, odd confidence, matcher naming a
#      capability that is not actually dormant — all silent, all exit 0.
#
# PERFORMANCE. This runs on EVERY prompt, inside a 5s hook budget already partly spent by
# ground-ruvnet.sh. Two guards keep it near-free: a no-node fast path (if the matcher module is not
# on disk, this hook costs one stat and exits — which is the state of the world until goal-match.mjs
# lands), and a hard watchdog that SIGKILLs the single node process. Nothing here can block a turn.
#
# NEVER DAEMONIZES. The registry's own comment records the bill for getting this wrong: one call to
# an earlier auditAll() left a live `node cli.js daemon start --foreground` running and wrote four
# files into HOME. auditAll() is now read-only (it LOCATES ruflo, never executes it), and this hook
# adds no execution of its own — it imports three modules (goal-match, capability-registry,
# advocacy-outcomes) and does filesystem reads.
#
# CONTRACT: always exit 0. stdout on exit 0 is injected verbatim into the model's context, so the
# single line printed here is phrased as an instruction to the model, matching ground-ruvnet.sh.
# The only paths this writes to are the state file and the outcomes ledger, both under
# ~/.config/ruvnet-brain/.
#
# CLI (the "silence it" instruction we print must actually work — house rule: never render a
# control without a real executor AND a real undo). SUPPRESSION IS SEVERITY-WEIGHTED (2026-07-23):
# --dismiss is not a single permanent mute at every severity — see advocacy-outcomes.mjs's
# DISMISSAL_BUDGET. A routine finding is silenced by its first --dismiss; a high-severity one needs
# three before it goes fully quiet, because one distracted click must not bury a serious finding.
#   anticipate.sh --dismiss <capability-key>     record a decline; silences it once its budget is spent
#   anticipate.sh --undismiss <capability-key>   reset the budget — it can be raised again    (the undo)
#   anticipate.sh --status                       the dismissal ledger + what was said this session
# Kill switch for the whole hook: RUVNET_ANTICIPATE=0
# ─────────────────────────────────────────────────────────────────────────────────────────────────

set +e

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
[ -n "$SELF_DIR" ] || exit 0

# WHERE THE THREE MODULES LIVE — resolved by PROBE, not by assertion (2026-08-04).
#
# This block used to be one line — `CODE_ROOT=$SELF_DIR/../..` — justified by the claim, repeated in
# the ADVOCACY_MODULE comment below, that a dev checkout and the Stable Spine "both keep `scripts/`
# as a sibling of `plugin/`". MEASURED on a real install, that is FALSE in both shipped layouts, and
# true only in the one layout that never reaches a user:
#
#   <plugin-cache>/ruvnet-brain/4.0.7/scripts/anticipate.sh  → ../.. = <plugin-cache>/ruvnet-brain
#   ~/.cache/ruvnet-brain/versions/<gen>/scripts/anticipate.sh → ../.. = .../versions
#   <src>/plugin/scripts/anticipate.sh                       → ../.. = <src>            ← only this
#
# Both distribution channels FLATTEN the `plugin/` level, so `../..` overshoots by one directory and
# $CODE_ROOT/scripts/goal-match.mjs never existed. The `[ -f "$GOAL_MATCH" ] || exit 0` guard below
# then did exactly what it promises — it stayed silent — so the L4 surface shipped permanently and
# INVISIBLY inert. A hook whose only failure mode is silence cannot report its own breakage; that is
# precisely why this needs a probe and not a comment.
#
# THE FIX IS TO ASK THE FILESYSTEM. Try each candidate directory and take the first that actually
# holds the matcher. That is the same discipline the rest of this file already applies to the
# machine's state: never render an assumption as a fact. Candidates, in order:
#
#   1. $SELF_DIR              — modules shipped as SIBLINGS of this script (the flattened plugin
#                               zip and the Stable Spine, once packaging ships them; see below)
#   2. $SELF_DIR/../../scripts — the source/dev layout <src>/plugin/scripts → <src>/scripts
#   3. $SELF_DIR/../scripts   — a root that keeps scripts/ one level up from this file
#
# PACKAGING IS THE OTHER HALF, and neither half works alone. goal-match.mjs, capability-registry.mjs
# and advocacy-outcomes.mjs currently live ONLY in the repo-root `scripts/`, which the plugin zip
# does not carry; this resolver finds nothing until they are shipped into `plugin/scripts/` beside
# this file. Fixing the path without the packaging leaves it silent, and vice versa.
#
# If NO candidate holds the matcher we deliberately fall through to the historical path, so the
# "missing module" diagnostics below still name the location a maintainer would expect — and the
# no-node fast path keeps this hook free. Silence on doubt, never a guess: rule 4, unchanged.
resolve_module_dir() {
  for _cand in "$SELF_DIR" "$SELF_DIR/../../scripts" "$SELF_DIR/../scripts"; do
    _r=$(CDPATH='' cd -- "$_cand" 2>/dev/null && pwd) || continue
    if [ -n "$_r" ] && [ -f "$_r/goal-match.mjs" ]; then printf '%s' "$_r"; return 0; fi
  done
  _r=$(CDPATH='' cd -- "$SELF_DIR/../.." 2>/dev/null && pwd) || return 1
  [ -n "$_r" ] && printf '%s' "$_r/scripts"
}
MODULE_DIR=$(resolve_module_dir)
[ -n "$MODULE_DIR" ] || exit 0

# All THREE module paths are env-overridable, matching the RUVNET_LESSON_STORE / RUVNET_SETTINGS_FILE
# idiom already used across this repo — so tests never load the real registry or touch a real user's
# state, and a future relocation needs no edit here.
GOAL_MATCH="${RUVNET_GOAL_MATCH:-$MODULE_DIR/goal-match.mjs}"
CAP_REGISTRY="${RUVNET_CAPABILITY_REGISTRY:-$MODULE_DIR/capability-registry.mjs}"
# THE SINGLE SUPPRESSION POLICY (2026-07-23). Until this build this file decided "is X suppressed"
# with its OWN local dismissed-Set in anticipate-state.json — one dismissal muted forever, no
# severity, no budget — while advocacy-outcomes.mjs's shouldStillOffer()/DISMISSAL_BUDGET (a nag dies
# on 1 dismissal, a high-severity finding needs 3, with a state-change reprieve) sat completely
# uncalled. Two thresholds for one decision is the exact hazard named below for the confidence floor;
# the fix is the same shape — wire this module the IDENTICAL env-var-with-a-default way as the two
# above, NOT a hardcoded `../scripts` path, so it resolves wherever this file actually runs from.
# (CORRECTED 2026-08-04: this comment previously asserted that a dev checkout and the Spine "both
# keep `scripts/` as a sibling of `plugin/`". They do not — see the measured table above. The three
# modules now resolve through MODULE_DIR, which probes rather than assumes.)
ADVOCACY_MODULE="${RUVNET_ADVOCACY_OUTCOMES_MODULE:-$MODULE_DIR/advocacy-outcomes.mjs}"

# ── Subcommands (dismiss/undismiss/status) run the same node program in a different mode ─────────
MODE="suggest"
ARG=""
case "${1:-}" in
  --dismiss)   MODE="dismiss";   ARG="${2:-}"; [ -n "$ARG" ] || { echo "usage: anticipate.sh --dismiss <capability-key>" >&2; exit 0; } ;;
  --undismiss) MODE="undismiss"; ARG="${2:-}"; [ -n "$ARG" ] || { echo "usage: anticipate.sh --undismiss <capability-key>" >&2; exit 0; } ;;
  --status)    MODE="status" ;;
  "") ;;
  *) exit 0 ;;
esac

if [ "$MODE" = "suggest" ]; then
  # Kill switch. Checked before anything else so a user who has switched this off pays nothing.
  case "${RUVNET_ANTICIPATE:-1}" in 0|off|false|no|OFF|FALSE|No) exit 0 ;; esac

  # FAST PATH, and the reason this hook is honestly free today: no matcher on disk, no work at all.
  # Degrading silently on a missing module is also the documented contract with goal-match.mjs.
  [ -f "$GOAL_MATCH" ] || exit 0
  [ -f "$CAP_REGISTRY" ] || exit 0

  EVENT=$(cat 2>/dev/null)
  # A payload this small cannot contain a goal-shaped prompt ("ok", "yes", "continue", or nothing at
  # all). Deliberately a LENGTH test and not a vocabulary test: a keyword prefilter here would be a
  # second matcher that silently drifts from goal-match.mjs, suppressing true matches with no way to
  # notice. Length makes no claim about meaning, so it cannot disagree with the matcher.
  [ "${#EVENT}" -ge 30 ] || exit 0
else
  EVENT=""
fi

# advocacy-outcomes.mjs is the single suppression policy for EVERY mode below (suggest AND
# dismiss/undismiss/status), so all four now need it, not suggest alone. Same fast-path discipline as
# GOAL_MATCH/CAP_REGISTRY above — a missing module is not guessed around. `suggest` degrades to the
# existing silent contract; the CLI modes get one honest line on stderr, because a control (--dismiss)
# reporting nothing when it did nothing is the "dead button" failure this file's header warns against.
if [ ! -f "$ADVOCACY_MODULE" ]; then
  if [ "$MODE" = "suggest" ]; then exit 0; fi
  echo "advocacy-outcomes module not found at $ADVOCACY_MODULE — cannot read or write the dismissal ledger" >&2
  exit 0
fi

# ── The one node process ─────────────────────────────────────────────────────────────────────────
# The program is fed to node on stdin by a QUOTED heredoc, and the payload travels in the
# environment — so no temp file is created anywhere and neither the JS nor the user's prompt is ever
# exposed to shell quoting.
#
# The heredoc goes DIRECTLY to node rather than through `PROG=$(cat <<'JS' ... )`. That indirection
# is what the first version did and it does not survive contact with real JavaScript: inside `$( )`
# the shell keeps parsing, so the backticks of a template literal read as nested command
# substitution and the apostrophes in the comments read as quotes. It failed at parse time with
# "unexpected EOF while looking for matching `'" — before a single line of the hook ran. Fed
# straight to a command, a quoted-delimiter heredoc is genuinely literal, which is the property
# being relied on here.
RUVNET_ANTICIPATE_MODE="$MODE" \
RUVNET_ANTICIPATE_ARG="$ARG" \
RUVNET_ANTICIPATE_EVENT="$EVENT" \
RUVNET_ANTICIPATE_SELF="$SELF_DIR/anticipate.sh" \
RUVNET_GOAL_MATCH="$GOAL_MATCH" \
RUVNET_CAPABILITY_REGISTRY="$CAP_REGISTRY" \
RUVNET_ADVOCACY_OUTCOMES_MODULE="$ADVOCACY_MODULE" \
  node --input-type=module 2>/dev/null <<'JS' &
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODE = process.env.RUVNET_ANTICIPATE_MODE || 'suggest';
const ARG = process.env.RUVNET_ANTICIPATE_ARG || '';
const SELF = process.env.RUVNET_ANTICIPATE_SELF || 'anticipate.sh';

// CANDIDATE MODE (ADR-040 / DDD-0004 "the enforcement chokepoint"). Set by unprompted-runtime.mjs on
// every producer child. When on, this hook writes ZERO user-facing prose: it emits ONE advocacy
// candidate as a JSON line and lets the runtime — the SOLE writer of user bytes — enforce the dial,
// the DismissalLedger, and the OFFERED denominator centrally. Unset (every direct/legacy invocation),
// behaviour is byte-for-byte unchanged. Purely additive: it only swaps the shape of the ONE line this
// hook would already have decided to speak, at the very end, after the persist-first write below.
const EMIT_CANDIDATES = process.env.RUVNET_EMIT_CANDIDATES === '1';

// Same directory, and for the same reason, as user-settings.mjs STORE_PATH and lesson-store's
// STORE_PATH: bin/install.mjs rmSync's ~/.cache/ruvnet-brain on --update and --uninstall, and has
// ZERO code paths that touch ~/.config/ruvnet-brain. The argument for this path is not that it
// feels permanent — it is that the only program which deletes things cannot see it. A "don't say
// this again" promise that a release quietly revokes is worse than never having made it.
const STATE_FILE = process.env.RUVNET_ANTICIPATE_STATE
  || path.join(os.homedir(), '.config', 'ruvnet-brain', 'anticipate-state.json');

// v2 (2026-07-23): dropped the local `dismissed` array — see "THE SINGLE SUPPRESSION POLICY" below.
// Any v1 file on disk (which HAD one) simply fails the version check and resets to v2 defaults; no
// suppression history is lost by that, because every dismissal made through --dismiss was ALREADY
// being double-written into the outcomes ledger too (the two-writes-one-decision bug this build
// fixes) — the ledger the new policy reads is already populated with that same history.
const STATE_VERSION = 2;
// Per-capability "once per session" is the ADR-027 rule. This ceiling bounds the WORST case on top
// of it: with eleven capabilities in the registry, "once each" is still eleven interruptions in one
// session, which is a nag by any honest reading of the precision floor.
const MAX_PER_SESSION = 2;
// A matcher that cannot express how sure it is does not get to speak: non-numeric or NaN confidence
// is silence, never a guess dressed as a suggestion.
//
// The NUMBER, though, is the matcher's to own, not this hook's. The first version hardcoded 0.7
// here — and goal-match.mjs publishes `CONFIDENCE_FLOOR = 0.6` and already filters to it, so every
// match it deliberately surfaced between 0.6 and 0.69 was being thrown away by a second, invisible
// threshold that its author could not see or tune. Two thresholds for one decision is how a matcher
// gets "fixed" for a silence it never caused. This reads the matcher's own floor when it exports
// one; the fallback exists only for a module that publishes none.
const FALLBACK_CONFIDENCE_FLOOR = 0.6;
// Nothing the matcher can say should turn one advisory line into a wall of injected context — this
// runs on every prompt and the repo meters that cost for a reason.
const MAX_WHY = 400;
const KEEP_SESSIONS = 20;   // bound the file; sessions are worthless once they end

const out = [];
const quit = () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); process.exit(0); };

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // An unknown or newer on-disk shape degrades to defaults rather than throwing. Worst case we
    // re-offer once; the alternative is a hook that crashes on a file a future version wrote.
    if (j && typeof j === 'object' && j.version === STATE_VERSION) return j;
  } catch { /* absent or unreadable — defaults */ }
  return { version: STATE_VERSION, sessions: {} };
}

/** Atomic write, entirely INSIDE the config dir. Returns false on any failure — never throws. */
function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // The temp file is a sibling, not a /tmp entry: this hook's whole footprint must stay inside
    // one directory a user can inspect and delete, and rename() is only atomic within a filesystem.
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    return true;
  } catch { return false; }
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

// ── THE SINGLE SUPPRESSION POLICY (2026-07-23) ──────────────────────────────────────────────────
// Until this build, this file kept its OWN dismissed-Set in anticipate-state.json as a second,
// disconnected gate: one call to --dismiss muted a capability FOREVER, at every severity, while
// advocacy-outcomes.mjs's shouldStillOffer()/DISMISSAL_BUDGET (a nag dies on 1 dismissal, a
// high-severity finding needs 3, with a state-change reprieve) sat completely uncalled — the exact
// "two thresholds for one decision" hazard the confidence-floor comment above already names for a
// different value. It also hand-rolled its OWN ledger writer (recordOutcome(), removed here) rather
// than call record() — a second, unimported copy of the same validation, which is the write-side
// half of the identical mistake.
//
// From here on, advocacy-outcomes.mjs — loaded ONCE, used in every mode — is the only place "is X
// suppressed" or "record what happened" is decided; nothing else in this file keeps a shadow copy
// of that answer. Wired the SAME env-var-with-a-default way as RUVNET_GOAL_MATCH/
// RUVNET_CAPABILITY_REGISTRY above (see ADVOCACY_MODULE in the bash section), not a hardcoded path.
let advocacy = null;
const ADVOCACY_MODULE_PATH = process.env.RUVNET_ADVOCACY_OUTCOMES_MODULE || '';
if (ADVOCACY_MODULE_PATH) {
  try { advocacy = await import(pathToFileURL(ADVOCACY_MODULE_PATH).href); } catch { advocacy = null; }
}
if (!advocacy || typeof advocacy.shouldStillOffer !== 'function' || typeof advocacy.record !== 'function') {
  // SILENCE RULE 4 for `suggest` — no suppression policy available, no speech, same as a missing
  // matcher/registry. The CLI modes get one honest line instead: a control (--dismiss) that reports
  // nothing when it did nothing is the "dead button" failure this file's header warns against.
  if (MODE === 'suggest') quit();
  out.push(`advocacy-outcomes module unavailable (${ADVOCACY_MODULE_PATH || 'RUVNET_ADVOCACY_OUTCOMES_MODULE unset'}) — cannot record or check the dismissal ledger`);
  quit();
}
const {
  record, shouldStillOffer, outcomesFor, summarize, pendingOffers, reconcileApplied,
  ACTIONS, DISMISSAL_BUDGET, weightClass, stateHashOf,
} = advocacy;
const OUTCOMES_FILE = process.env.RUVNET_ADVOCACY_OUTCOMES
  || path.join(os.homedir(), '.config', 'ruvnet-brain', 'advocacy-outcomes.jsonl');
/** Recording an outcome must never break the hook it measures — same contract recordOutcome() had. */
function safeRecord(spec) {
  try { return record(spec, { file: OUTCOMES_FILE }); } catch (e) { return { ok: false, reason: e.message }; }
}

// ── dismiss / undismiss / status ────────────────────────────────────────────────────────────────
if (MODE === 'dismiss' || MODE === 'undismiss' || MODE === 'status') {
  const st = readState();
  const sessions = st.sessions && typeof st.sessions === 'object' ? st.sessions : {};

  if (MODE === 'status') {
    const said = Object.values(sessions).flatMap((s) => strings(s?.said));
    const rows = summarize({ file: OUTCOMES_FILE }).filter((r) => r.offered > 0);
    const ledger = rows.length
      ? rows.map((r) => `${r.id}: ${r.suppressed ? 'suppressed' : 'active'} (applied ${r.applied}, dismissed ${r.dismissed}, ignored ${r.ignored})`).join(' | ')
      : 'none';
    out.push(`dismissal ledger:               ${ledger}`);
    out.push(`raised in recent sessions:      ${said.length ? [...new Set(said)].join(', ') : 'none'}`);
    out.push(`state file:                     ${STATE_FILE.replace(os.homedir(), '~')}`);
    out.push(`outcomes ledger:                ${OUTCOMES_FILE.replace(os.homedir(), '~')}`);
    quit();
  }

  if (MODE === 'undismiss') {
    // A RESET is the ledger's own undo: a CHECKPOINT, never a deletion (advocacy-outcomes.mjs).
    // Everything before it stays on the record — precision is never laundered — only the suppression
    // arithmetic starts counting again after it.
    const res = safeRecord({ id: ARG, action: ACTIONS.RESET });
    out.push(res.ok
      ? `un-dismissed: "${ARG}" can be raised again`
      : `could not record the reset (${res.reason}) — nothing changed`);
    quit();
  }

  // MODE === 'dismiss'. Severity is whatever the LEDGER already knows about this id — the CLI call
  // has no fresh row to read (--dismiss runs standalone, without re-auditing the capability), and
  // guessing 'normal' when history already says 'high' would let one distracted click silence a
  // high-severity finding in a single shot, the exact failure DISMISSAL_BUDGET exists to prevent.
  //
  // TWO SOURCES, because neither alone covers every dismissal in the sequence. The offer's own
  // severity lives in the PENDING `offered` record, but the moment THIS dismissal resolves it, it is
  // no longer pending — so pendingOffers() only ever sees it before the FIRST dismissal.
  // outcomesFor().lastSeverity only reads resolved records (applied/dismissed/ignored — deliberately
  // NOT `offered`, so a mere show never counts as evidence), so it only ever has an answer from the
  // SECOND dismissal onward. Together they cover every dismissal; genuinely unknown (neither source
  // has ever seen this id) resolves to 'normal' — the quieter class, same direction as weightClass()'s
  // own documented default.
  const pendingSeverity = pendingOffers({ file: OUTCOMES_FILE }).find((p) => p.id === ARG)?.severity;
  const priorSeverity = pendingSeverity || outcomesFor(ARG, { file: OUTCOMES_FILE }).lastSeverity || 'normal';
  const res = safeRecord({ id: ARG, action: ACTIONS.DISMISSED, severity: priorSeverity });
  if (!res.ok) { out.push(`could not record the dismissal (${res.reason}) — nothing changed`); quit(); }

  // HONEST MESSAGE. Whether it "will not be raised again" now genuinely depends on the budget, not
  // on the mere fact that --dismiss was called — saying so unconditionally would repeat the false
  // "never again" promise the old permanent dismissed-Set made regardless of severity.
  const cls = weightClass(priorSeverity);
  const budget = DISMISSAL_BUDGET[cls];
  const spent = outcomesFor(ARG, { file: OUTCOMES_FILE }).dismissed;
  const stillMayReturn = shouldStillOffer(ARG, { severity: priorSeverity, file: OUTCOMES_FILE });
  out.push(stillMayReturn
    ? `acknowledged: "${ARG}" dismissed (${spent}/${budget} for a ${cls}-severity finding) — a single click cannot bury a high-severity finding, so it may still resurface until the budget is spent. Dismiss again to move it toward silence, or ${SELF} --undismiss ${ARG} to restore it now.`
    : `dismissed: "${ARG}" will not be raised again (undo: ${SELF} --undismiss ${ARG})`);
  quit();
}

// ── suggest ─────────────────────────────────────────────────────────────────────────────────────
let ev = null;
try { ev = JSON.parse(process.env.RUVNET_ANTICIPATE_EVENT || ''); } catch { /* not JSON */ }
if (!ev || typeof ev !== 'object') quit();

const prompt = [ev.prompt, ev.user_prompt, ev.input].find((v) => typeof v === 'string' && v.trim()) || '';
if (prompt.trim().length < 12) quit();

// THE DIAL, ENFORCED (ADR-032 / DDD-0004 "The three channels"). This hook is the ADVOCACY channel —
// unsolicited suggestions — so the user's `advocacy` level governs whether it may speak. Alarms live
// in session-start.sh and bypass this by design; nothing here can silence a broken-brain warning.
// Read the settings file DIRECTLY (no ESM import) so a missing module path can never turn the dial
// into a no-op — the exact failure that left it declared-but-dead. Default is 'important-only' (the
// owner's "recommend on, do not force"): on out of the box for important findings, one setting away
// from silent. Unreadable/absent settings resolve to that same default rather than to unbounded speech.
function advocacyLevel() {
  try {
    const f = process.env.RUVNET_SETTINGS_FILE
      || path.join(os.homedir(), '.config', 'ruvnet-brain', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    // user-settings.mjs saveSettings() writes a VERSIONED ENVELOPE: { version, updated, settings:{…} }.
    // Read the nested `.settings.advocacy` FIRST — reading top-level `.advocacy` (which an earlier
    // version did) meant every real save through the console/CLI was invisible here and the dial
    // silently fell back to the default. Keep a top-level fallback for a hand-written/legacy file.
    const v = (parsed && parsed.settings && parsed.settings.advocacy) ?? (parsed && parsed.advocacy);
    return (v === 'off' || v === 'important-only' || v === 'all') ? v : 'important-only';
  } catch { return 'important-only'; }
}
const ADVOCACY = advocacyLevel();
// THE DIAL for this emitter. anticipate produces exactly ONE class of output: a dormant-capability
// nudge that has already cleared a high evidence bar (two independent cues + the matcher's confidence
// floor + once-per-session). Its meaningful dial is therefore off-vs-on: `off` is verifiably silent;
// both `important-only` (the default — the owner's "recommend on") and `all` let the gated nudge
// through. There is NO severity axis to split on here — auditAll()/matchGoal() emit none — so a
// severity gate at this point silences the whole feature at the default (a real regression, caught by
// the dial integration test 2026-07-23 and removed). The `off` gate is the real, honoured control.
if (ADVOCACY === 'off') quit();

// Session identity decides what "once per session" means. Claude Code supplies session_id; when it
// is missing we do NOT fall back to something unbounded (that would make every prompt a fresh
// session and turn this hook into the nag it exists to avoid). A cwd+day key keeps the promise
// bounded — at worst once per capability per project per day — while still being able to fire.
const sid = typeof ev.session_id === 'string' && ev.session_id.trim()
  ? ev.session_id.trim()
  : `fallback:${process.cwd()}:${new Date().toISOString().slice(0, 10)}`;

const st = readState();
const sessions = st.sessions && typeof st.sessions === 'object' ? st.sessions : {};
const said = new Set(strings(sessions[sid]?.said));
if (said.size >= MAX_PER_SESSION) quit();

let auditAll, matchGoal, floor;
try { ({ auditAll } = await import(pathToFileURL(process.env.RUVNET_CAPABILITY_REGISTRY).href)); } catch { quit(); }
try {
  const gm = await import(pathToFileURL(process.env.RUVNET_GOAL_MATCH).href);
  matchGoal = gm.matchGoal;
  floor = gm.CONFIDENCE_FLOOR;
} catch { quit(); }
if (typeof auditAll !== 'function' || typeof matchGoal !== 'function') quit();
const MIN_CONFIDENCE = typeof floor === 'number' && Number.isFinite(floor) ? floor : FALLBACK_CONFIDENCE_FLOOR;

let rows = [];
try { rows = auditAll({ project: process.cwd() }) || []; } catch { quit(); }

// CONTINUOUS RECONCILIATION — the L5 loop must not depend on someone opening the console. This is the
// PUSH surface (it already runs every prompt); reconcileApplied() credits an APPLIED for any capability
// we OFFERED that is now switched on. It is idempotent (a resolved offer stops being pending, so a
// re-run is a no-op), writes only when there is a real observed on-state WITH a pending offer to close,
// and never throws. Wiring it here is what makes precision computable from ordinary use instead of only
// when /api/capabilities is polled — ADR-028's own named failure is a PULL surface guarding an anti-pull
// metric. Guarded on typeof so an older advocacy module that predates this export degrades to prior
// behaviour rather than throwing; a lost credit costs one ledger row, never the hook.
try { if (typeof reconcileApplied === 'function') reconcileApplied(rows, { file: OUTCOMES_FILE }); } catch { /* never break the hook we measure */ }

// SILENCE RULE 1. 'off' is the only state that has earned a sentence: installed, and switched off.
// 'unknown' is a detector saying it could not tell — advocating on it would be fabricating a fault,
// which is precisely the "26 hooks off" incident. 'absent' means there is nothing to turn on.
//
// SUPPRESSION is shouldStillOffer() — the ledger's severity-weighted budget — not a local Set. A row
// carries no `severity` field today (neither auditAll() nor matchGoal() emit one, confirmed live), so
// `null` is passed and shouldStillOffer() falls back to whatever it last recorded for this id (or
// 'normal' if it has never seen one); a `severity` DOES flow through the moment a future registry
// adds it, because record()/shouldStillOffer() already accept it. `stateHash` comes from the row's
// own real, measured `evidence` string — never fabricated — so the high-severity state-change
// reprieve can fire the moment a dismissal is ever recorded WITH a hash (see --dismiss's own comment
// on why it cannot supply one today).
const dormant = rows.filter((r) => {
  if (!r || r.state !== 'off' || said.has(r.key)) return false;
  return shouldStillOffer(r.key, { severity: r.severity || null, stateHash: stateHashOf(r.evidence), file: OUTCOMES_FILE });
});
if (!dormant.length) quit();

let matches = [];
try { matches = matchGoal(prompt, dormant) || []; } catch { quit(); }
if (!Array.isArray(matches) || !matches.length) quit();

// The matcher is trusted to rank, never to assert existence: every match is re-resolved against the
// dormant rows THIS audit produced. A capability the matcher names that is not dormant right now is
// dropped, so a stale or over-eager matcher can only ever cause silence, never a false claim.
const byKey = new Map(dormant.map((r) => [r.key, r]));
const scored = [];
for (const m of matches) {
  if (!m || typeof m !== 'object') continue;
  const key = typeof m.capability === 'string'
    ? m.capability
    : (m.capability && typeof m.capability.key === 'string' ? m.capability.key : '');
  const row = byKey.get(key);
  if (!row) continue;
  const conf = m.confidence;
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < MIN_CONFIDENCE) continue;
  const why = typeof m.why === 'string' ? m.why.trim() : '';
  if (!why) continue;   // SILENCE RULE 2 — no evidence, no speech
  scored.push({ row, why, conf });
}
if (!scored.length) quit();
scored.sort((a, b) => b.conf - a.conf);
const best = scored[0];

// SILENCE RULE 3, and the ordering here is the whole rule: PERSIST FIRST, SPEAK SECOND. Killed
// between the two, we lose one suggestion (silent, harmless). The other order risks speaking
// without recording it, which repeats on the next prompt — and repeating is the failure mode that
// gets hooks switched off for good. Losing a suggestion is cheap; becoming a nag is not.
said.add(best.row.key);
sessions[sid] = { said: [...said], ts: Date.now() };
st.sessions = Object.fromEntries(
  Object.entries(sessions).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)).slice(0, KEEP_SESSIONS),
);
if (!writeState(st)) quit();   // cannot remember having spoken → do not speak

// Only real, derived values reach this line: `label`, `whatItBuysYou` and `turnOn` come straight
// off the audited row, `why` from the matcher. Where the registry has no verified command it says
// so in those words — there is no invented one-liner and no fabricated state anywhere in it.
const cmd = best.row.turnOn && typeof best.row.turnOn.cmd === 'string' && best.row.turnOn.cmd.trim()
  ? `turn on with \`${best.row.turnOn.cmd.trim()}\``
  : 'no verified one-line command exists for it — offer to walk them through it';

// DO NOT REPEAT THE PAYOFF. goal-match.mjs's explain() already folds `whatItBuysYou` into its `why`,
// so appending the row's copy of it printed the same sentence twice in one line — which only showed
// up when the hook was first run against the real matcher instead of a fixture. Add it only when the
// matcher has not already said it.
// Cut at the last word boundary inside the cap rather than mid-word ("nothing it discov…" was the
// real output). Falls back to a hard slice when the text has no space to break on.
let why = best.why;
if (why.length > MAX_WHY) {
  const cut = why.slice(0, MAX_WHY);
  const brk = cut.lastIndexOf(' ');
  why = `${(brk > MAX_WHY * 0.6 ? cut.slice(0, brk) : cut).trimEnd()}…`;
}
const buys = typeof best.row.whatItBuysYou === 'string' ? best.row.whatItBuysYou.trim() : '';
const payoff = buys && !why.includes(buys) ? ` It buys them: ${buys}` : '';

// The one line this hook has decided to speak, built once. In legacy mode it is printed verbatim; in
// candidate mode it becomes the `copy` of the advocacy candidate. Byte-identical either way.
const COPY = `[RuvNet Brain — anticipating] "${best.row.label}" is installed here and switched OFF, and it serves this turn: ${why}${payoff} Offer it ONCE, in one plain sentence (${cmd}), then drop it and get on with the actual work. If they decline: ${SELF} --dismiss ${best.row.key} (each decline moves it toward silence, faster for a routine finding than a serious one)`;

if (EMIT_CANDIDATES) {
  // CANDIDATE MODE: emit ONE advocacy candidate, no prose. The runtime honours the dial + the
  // DismissalLedger on this candidate and records the OFFERED denominator centrally — so this path
  // deliberately does NOT safeRecord(OFFERED) here (doing so would double-count precision's
  // denominator once the runtime records it too). severity + observationHash travel on the candidate
  // so the runtime's shouldStillOffer()/record() see the identical inputs this hook used;
  // observationHash maps to the ledger's stateHash. findingId is REQUIRED (the runtime drops an
  // advocacy candidate without one). The persist-first write above already ran.
  out.push(JSON.stringify({
    channel: 'advocacy',
    effect: 'advisory',
    copy: COPY,
    hookEventName: 'UserPromptSubmit',
    findingId: best.row.key,
    severity: best.row.severity || 'normal',
    observationHash: stateHashOf(best.row.evidence),
  }));
  quit();
}

// RECORD THE DENOMINATOR (legacy/direct path only — see the candidate branch above for why this must
// not also run under the runtime). precision = acted-on / OFFERED, and without this line the
// denominator is always zero.
//
// NOTE what is deliberately absent: `scope: best.row.scope`. An earlier version passed it here, but
// `best.row.scope` is the CAPABILITY's scope (machine/project/user, from capability-registry.mjs) —
// a different field entirely from the ledger's own `scope:'forever'` (a permanent-silence marker,
// valid only on a dismissal). record() validates this strictly and would have THROWN on every single
// offer the moment this file started calling it instead of a hand-rolled, unvalidated writer — caught
// here rather than in production.
safeRecord({
  id: best.row.key, action: ACTIONS.OFFERED,
  severity: best.row.severity || 'normal',
  stateHash: stateHashOf(best.row.evidence),
});

out.push(COPY);
quit();
JS
NODE_PID=$!

# HARD WATCHDOG. Not optional and not a `timeout` binary: macOS ships no `timeout`, and a hook that
# silently depends on coreutils is a hook that hangs on half the machines it runs on. 2s against a
# 5s hook budget that ground-ruvnet.sh has already partly spent. A SIGKILL mid-write can at worst
# truncate one advisory line — it can never fail the turn, and the state file was already committed
# by then (see the persist-first ordering above).
# THE SLEEP MUST BE OURS TO KILL (2026-08-06). This block used to be:
#
#     ( sleep 2; kill -9 "$NODE_PID" 2>/dev/null ) &
#     WATCHDOG_PID=$!
#     wait "$NODE_PID"; kill "$WATCHDOG_PID"
#
# `kill` signals the SUBSHELL. The `sleep` it forked is a separate process this script never had a
# handle on, so it was simply ORPHANED and kept running for the remainder of its 2 seconds.
# selfcheck.mjs measures exactly that (§5 PROCESS-TREE HYGIENE, WATCHDOG_GRACE_MS = 2000) and
# reported it in BOTH the [valid] and [held] regimes as
# "left descendants alive after SIGTERM to its process group".
#
# It is deterministic on Linux rather than flaky because the watchdog's lifetime and the grace
# window are the SAME 2000ms, and the sleep starts marginally after the clock the checker uses — so
# it always outlives the probe by the spawn delta. macOS passes; ubuntu fails every time.
#
# It had never fired before because it was UNREACHABLE. Until the payload boundary was fixed
# (ADR-065) the `[ -f "$GOAL_MATCH" ] || exit 0` guard above returned first on every real install, so
# this line only ever ran in a dev checkout. Making L4 work is what woke it up — the fix did not
# create this leak, it revealed one that had been shipping dormant.
#
# FIX: fork the sleep as OUR OWN child so we hold its pid, and reap both. A `trap` inside the
# subshell was tried first and MEASURED WORSE (it defeats the shell's exec optimisation and leaked
# where the original did not) — hence the explicit two-pid form rather than anything cleverer.
sleep 2 &
SLEEP_PID=$!
( wait "$SLEEP_PID" 2>/dev/null && kill -9 "$NODE_PID" 2>/dev/null ) >/dev/null 2>&1 &
WATCHDOG_PID=$!
wait "$NODE_PID" 2>/dev/null
kill "$SLEEP_PID" "$WATCHDOG_PID" 2>/dev/null
wait "$SLEEP_PID" "$WATCHDOG_PID" 2>/dev/null

# ALWAYS. Every failure above already routed to silence; this makes the guarantee unconditional.
exit 0
