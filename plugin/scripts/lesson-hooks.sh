#!/bin/bash
# lesson-hooks.sh — THE LAST MILE. Connects lessons to the events that actually fire.
#
# WHY THIS EXISTS, measured 2026-07-22 05:50:
#
#     trigger              enforcing?  wired to a hook that runs?
#     ship                 yes         YES  ← the only real one
#     assert-fact          yes         no
#     report-status        yes         no   ← this is why the model still stopped
#     write-code           yes         no
#     claim-done           yes         no
#     mutate-machine       yes         no
#
# Five lessons the owner had personally ratified reported "enforcing" and NOTHING CALLED THEM. The
# store said armed; the machine said unconnected.
#
# ONE dispatcher, not five hooks. ADR-030's constraint holds: gates scale with decision TYPES, never
# with lesson count. This file maps Claude Code's real events onto the store's triggers and asks the
# store what applies. Adding a lesson requires no change here — that asymmetry is the architecture.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# WHAT CHANGED, 2026-07-22: THIS FILE WAS THE THIRD LAYER OF A BLOCK THAT COULD NOT BLOCK.
#
# The old body ran the gate as `... 2>/dev/null || true`, echoed whatever came back, and then
# `exit 0` unconditionally — with this comment above it, which was true as a promise and fatal as a
# design: "FAILS OPEN, ALWAYS. Exit 0 unconditionally on every path."
#
# Measured, before the fix:
#     $ bash plugin/scripts/lesson-hooks.sh Stop ; echo $?
#       ⛔ BLOCKED — you are about to report progress or state.
#       0                    ← printed BLOCKED, returned ALLOW
#
# Three bugs stacked so neatly that each one alone would have been enough: the gate exited 1 (not the
# harness's blocking code 2), wrote its reason to stdout (which exit-2 ignores), and this file threw
# the code away regardless. `|| true` is what turned "the gate is broken" into "the gate is silent",
# which is why it survived long enough to be documented as working.
#
# FAIL-OPEN IS STILL THE RULE — it was just implemented as "always allow", which is not the same
# thing. Failing open means an ERROR must not refuse the user: a missing node, an unreadable store, a
# timeout. It never meant discarding a DELIBERATE refusal. Those are now distinguished by exit code:
# 2 is a decision and propagates; every other non-zero is a malfunction and allows.
#
# AND THE DEFAULT IS NOW A NUDGE, not a block (the owner, same day: "Nudging somebody is very fair.
# Forcing them through a gate is not."). The gate emits `additionalContext` on exit 0 for nudges —
# the model reads it, nothing is refused. Exit 2 happens only for a lesson the user has personally
# opted into blocking, in a file only they write.

EVENT="${1:-}"
[ -z "$EVENT" ] && exit 0

# Resolve the gate relative to this script so it works from the repo, the marketplace clone, or an
# installed bundle without a hardcoded path (a hardcoded ~/.npm-global path told users ruflo was
# missing when it sat on their PATH — same class of bug).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
GATE=""
for c in "$HERE/../../scripts/lesson-gate.mjs" "$HERE/../scripts/lesson-gate.mjs" "$HOME/.claude/plugins/marketplaces/ruvnet-brain/scripts/lesson-gate.mjs"; do
  [ -f "$c" ] && GATE="$c" && break
done
[ -z "$GATE" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# Read the hook's JSON payload off stdin ONCE, via the same shared Node parser the other PreToolUse
# gates on Bash already use for this — never a hand-rolled bash regex, which is how a JSON-escaped
# quote once silently truncated a command in this exact codebase. Safe for every event this script
# handles: the harness always pipes a payload, and a caller with no stdin (a manual test) gets EOF
# immediately, not a hang — an empty result just means no command text was found.
INPUT=""
# BOUNDED READ (2026-07-27, ADR-055 F20): an unqualified `read` never returns on a stdin that is
# opened and never closed — measured across the mesh, 18 of 37 registered commands sat until the
# harness killed them. Real Claude Code writes and closes, so this costs no normal turn; that is
# exactly why a hook that CAN hang forever survives unnoticed. -t bounds the wait, and the string
# is truncated AFTER the loop because a hook payload is one line with no newline, so `read` hands
# the whole thing back at once and a per-iteration cap never fires.
while IFS= read -r -t 2 _l; do
  INPUT+="$_l"$'\n'
  [ ${#INPUT} -ge 65536 ] && break
done
[ -n "$_l" ] && INPUT+="$_l"$'\n'
INPUT="${INPUT:0:65536}"
HOOK_INPUT_JS="$HERE/hook-input.mjs"

# Map a real Claude Code event onto the store's decision points, and onto the event name the harness
# will accept back. An event may carry more than one decision point: ending a turn is simultaneously
# "reporting status" and "claiming done", and both have lessons.
#
# CLAUDE_EVENT is what goes into hookSpecificOutput.hookEventName, and it MUST be the harness's real
# event name — "PreToolUse", never our internal "PreToolUse-write" — or the envelope is discarded and
# the nudge silently reaches nobody. That is this project's signature failure; it is not repeating here.
TRIGGERS=""
CLAUDE_EVENT=""
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# WHY `Stop` IS NO LONGER HERE (2026-07-22, and this is the fix for a live, machine-wide defect).
#
# `additionalContext` at Stop does not merely inform — it CONTINUES THE TURN, and counts against the
# 8-consecutive-continuation cap. The doc is explicit: "It keeps the conversation going through the
# same loop protections as decision: 'block'... Claude Code overrides the hook and ends the turn
# after 8 consecutive blocks."
#
# This dispatcher fired on Stop with triggers `report-status claim-done`, which match lessons that
# match ALWAYS. So EVERY turn-end was continued, in every project, until the harness killed it on the
# ninth. Observed live on 2026-07-22 in three separate projects; the harness's own error text named
# the missing guard.
#
# The deeper error was not the missing guard, it was the DESIGN: this gate fires on the ACT of
# stopping with no state check, so it cannot tell "stopped early" from "genuinely finished". A guard
# that fires unconditionally carries no information, and paying a forced model turn to deliver a
# reminder is the ham-fisted behaviour that gets a tool switched off.
#
# So Stop is now owned by ONE hook — continuation-gate.mjs — which reads a real work ledger, speaks
# only when committed work is actually outstanding, honours stop_hook_active, and nudges at most once
# per session. The `report-status` and `claim-done` lessons moved to UserPromptSubmit, where they
# reach the model BEFORE the work rather than after it, and cost nothing to deliver.
TRIGGERS=""
CLAUDE_EVENT=""
case "$EVENT" in
  Stop)             exit 0 ;;   # deliberately inert — see above. continuation-gate.mjs owns Stop.
  PreToolUse-write) TRIGGERS="write-code";                      CLAUDE_EVENT="PreToolUse" ;;
  PreToolUse-bash)  TRIGGERS="mutate-machine";                  CLAUDE_EVENT="PreToolUse" ;;
  PreToolUse-push)  TRIGGERS="ship";                            CLAUDE_EVENT="PreToolUse" ;;
  # `choose-work` ADDED 2026-07-24 — the omission that made the Learning pillar look broken.
  #
  # THE FAILURE, in the owner's words: "why aren't you spinning up parallel swarms... isn't that a
  # definition of a huge failure of the learning?" He was right, and the cause was one missing word on
  # this line. L16-parallel-by-default ("when given multiple independent pieces of work, FAN OUT
  # IMMEDIATELY... serial execution of independent work is a defect, not a style") is RATIFIED, taught
  # FOUR times — and had never been delivered once, in any session, because nothing ever requested its
  # trigger. The lesson was not ignored; it was never spoken.
  #
  # WHY IT WAS MISSED, and the trap worth naming: `choose-work`'s surface is `plan`, and lesson-store
  # correctly refuses to let a `plan` lesson claim `block` enforcement — no hook can observe the
  # instant a model forms an intention. That true statement was silently over-read as "plan lessons
  # cannot be delivered at all," so the trigger was left off every event. But UserPromptSubmit IS the
  # work-choice moment: a request arrives and the very next act is deciding how to attack it. The
  # lesson cannot BLOCK there — it stays advisory, exactly as its enforcement says — but advisory
  # delivered beats enforcing never. "Cannot be a gate" and "cannot be heard" are different claims,
  # and conflating them cost four repetitions of the same correction.
  #
  # This is the same defect the header table already recorded for `report-status` ("enforcing? yes /
  # wired to a hook that runs? no ← this is why the model still stopped"). Fixed there, missed here.
  # One bug, found once, fixed once, left everywhere else.
  # `relay-number` ADDED 2026-07-24 — the SECOND inert lesson found the same day, and this one is
  # about the failure it was itself unable to prevent.
  #
  # L04-never-relay-a-number ("never repeat a score, benchmark, or subagent result without re-checking
  # the underlying artifact yourself") is RATIFIED and taught 5 times, and no event has ever requested
  # its trigger — so it had never fired, in any session, ever. Found by the new lesson-trigger audit in
  # wired-check.mjs, which exists because L16 had exactly this defect hours earlier. The audit's first
  # real run immediately found a second instance: evidence the class was systemic, not a one-off.
  #
  # The irony is the useful part, not the joke: on the day this was found, three subagents reported
  # results and TWO of them contained a confident claim the artifact contradicted (a "1,266 = 14"
  # equality that a single query disproves, and an upgrade-notice fix reported missing because the grep
  # demanded `function` on a `const` arrow). The lesson that would have flagged both was in force,
  # weighted, and mute.
  #
  # UserPromptSubmit is the right event: relaying happens while composing a reply, and this is the last
  # observable moment before that. It cannot BLOCK there (surface `text`), which matches its
  # `checklist` enforcement exactly — advisory delivered beats enforcing never.
  UserPromptSubmit) TRIGGERS="assert-fact recommend-architecture report-status claim-done choose-work relay-number"; CLAUDE_EVENT="UserPromptSubmit" ;;
  *) exit 0 ;;
esac

# ONE invocation carrying every trigger for this event — not one per trigger. Two reasons, both hard:
# a nudge must be a SINGLE JSON document (two concatenated objects on stdout parse as neither), and
# this runs on every matching event, so one node spawn instead of two is latency the user feels.
ARGS=()
for t in $TRIGGERS; do ARGS+=(--trigger "$t"); done

# Session identity for the gate's per-session frequency cap (scripts/lesson-gate.mjs) — extracted from
# the same payload via the shared parser, never a hand-rolled regex. A missing/empty id just means the
# gate falls back to a cwd+day key, so the cap stays bounded either way; it is never a hard requirement.
if [ -f "$HOOK_INPUT_JS" ]; then
  SID=$(printf '%s' "$INPUT" | node "$HOOK_INPUT_JS" field session_id 2>/dev/null) || SID=""
  [ -n "$SID" ] && ARGS+=(--session "$SID")
fi

# THE FIX for the mutate-machine false-positive nag: `mutate-machine` fired on EVERY Bash call — `ls`,
# `grep`, `git status` included — because this dispatcher requested the trigger unconditionally, with
# no inspection of the command at all (there was nothing here to inspect it WITH). The gate now takes
# `--command <text>` and narrows `mutate-machine` to commands that plausibly mutate something OUTSIDE
# this repo (scripts/lesson-gate.mjs, looksLikeOutsideRepoMutation) — so extract the real command text
# for exactly the one event that carries it, and hand it to the gate to decide.
if [ "$EVENT" = "PreToolUse-bash" ] && [ -f "$HOOK_INPUT_JS" ]; then
  CMD=$(printf '%s' "$INPUT" | node "$HOOK_INPUT_JS" command 2>/dev/null) || CMD=""
  ARGS+=(--command "$CMD")

  # SHIP RIDES ON THE BASH PAYLOAD, BECAUSE NOTHING EVER SENDS "PreToolUse-push".
  #
  # The `PreToolUse-push) TRIGGERS="ship"` branch above has never executed. hooks.json emits only
  # `unprompted-speech UserPromptSubmit`, and decision-gate.mjs maps EVERY PreToolUse to exactly
  # `PreToolUse-bash` or `PreToolUse-write` — so `git push` has always arrived here as
  # `mutate-machine`, never as `ship`. Measured 2026-08-13: FIVE ratified ship lessons in the live
  # store had therefore never fired once, among them `G-remote-ci-gates-shipping` and
  # `G-test-the-artifact-not-the-checkout` — the two that would have spoken up before I shipped a
  # test that broke windows-unit and red-lit someone else's dependabot PR.
  #
  # Worse, wired-check's Check C greps THIS FILE's case labels to decide which triggers are wired, so
  # it read "ship" off the dead branch and reported it green — an audit that cannot fail on the exact
  # defect class it was written for. The dispatcher is the truth-maker for what fires; a case label
  # nobody sends is not a wire.
  # THE SAME PATTERNS AS degradation-watch.mjs DEPENDENT_COMMANDS, and a test asserts they agree.
  # Two audits noted these two definitions of "is this a ship?" shipped already disagreeing on day
  # one — one fact restated in two files, which is the defect this repo keeps paying for. They also
  # caught both directions of the original glob being wrong: `git -C <abs> push` (the form an agent
  # with absolute paths writes) matched NOTHING, while `grep -n "npm publish" docs/` matched, so
  # reading ABOUT shipping counted as shipping. Quoted regions are stripped first because the
  # truth-maker is what will EXECUTE — a commit message is not a command.
  CMD_EXEC=$(printf '%s' "$CMD" | sed -e 's/"[^"]*"/ /g' -e "s/'[^']*'/ /g")
  if printf '%s' "$CMD_EXEC" | grep -qE '\bgit\b[^|;&]*\bpush\b|\b(npm|yarn|pnpm) publish\b|\bgh release create\b|release\.mjs'; then
    ARGS+=(--trigger ship)
  fi
fi

# A hard timeout, because this runs on every matching event and must never add perceptible latency.
# BUT `timeout` is GNU coreutils and STOCK macOS DOES NOT SHIP IT — on this dev machine it exists
# only because Homebrew put it there, which is exactly how a bug like this hides. Unguarded,
# `timeout 5 node ...` on a clean Mac exits 127 (command not found), so the gate would never run at
# all: no nudge, no block, and — worst of all — silence indistinguishable from "no lessons applied".
# So the timeout is used when present and skipped when not. A missing convenience must degrade the
# latency guarantee, never the gate. (Same lesson as the CI runner that went red because a test
# assumed macOS-only paths.)
TIMEOUT=""
command -v timeout  >/dev/null 2>&1 && TIMEOUT="timeout 5"
[ -z "$TIMEOUT" ] && command -v gtimeout >/dev/null 2>&1 && TIMEOUT="gtimeout 5"

# Streams pass straight through, UNREDIRECTED and UNCAPTURED. This is deliberate and it is the fix:
#   • stdout carries the nudge JSON — capturing it into a shell variable and re-echoing it risks
#     mangling (trailing-newline stripping, glob expansion) the harness's parse depends on.
#   • stderr carries a block's reason and must arrive as stderr, because exit 2 ignores stdout.
# The old `2>/dev/null` discarded precisely the stream a refusal needs.
$TIMEOUT node "$GATE" --event "$CLAUDE_EVENT" "${ARGS[@]}"
CODE=$?

# THE PROPAGATION. Exit 2 is the gate's considered decision that the user asked to be refused here —
# it is the only code that means anything to the harness, and it is passed through untouched.
# Everything else — 0, a crash, a 124 from timeout, node dying — allows the action. An error must
# never masquerade as a refusal, and a refusal must never be downgraded to an error.
[ "$CODE" -eq 2 ] && exit 2
exit 0
