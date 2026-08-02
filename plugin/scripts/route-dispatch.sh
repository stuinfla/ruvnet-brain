#!/bin/bash
# route-dispatch.sh — bounded PreToolUse audit of subagent model selection.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# THE LEAK (2026-07-13). Stuart: "What happens when I'm right here in Opus 4.8 and it has 10 things
# to run? Is it going to just run them as Opus 4.8?" — YES:
#
#     A SUBAGENT INHERITS THE MAIN-LOOP MODEL UNLESS `model` IS EXPLICITLY PASSED.
#
# Ten agents on a Fable session = ten agents at $10/$50 per Mtok, ~10x Haiku for identical mechanical
# work. This hook records declared and inherited dispatches so the leak remains measurable.
#
# HOST LIMITATION (#84): Claude Code 2.1.220 registers Agent/Task PreToolUse hooks asynchronously,
# completes the subagent dispatch, and only then consumes the hook result. An exit-2 refusal is
# therefore too late to block and must not be represented as enforcement. The hook is intentionally
# silent and advisory until the host provides a synchronous pre-dispatch decision boundary.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# THREE DEFECTS IN MY OWN FIRST VERSION, caught by asking the questions Stuart would have asked
# (2026-07-13, minutes after shipping it — the whole point of the adversarial pass):
#
#   1. IT BLOCKED EVERY USER. This hook ships to everyone who installs RuvNet Brain. Hard-blocking
#      the Task tool for people who never asked for cost routing is hostile — I would have broken
#      strangers' workflows to save Stuart money. Now it ENFORCES ONLY FOR USERS WHO OPTED IN
#      (a model-router profile.json exists = they answered the two subscription questions). Everyone
#      else gets NOTHING — not even a warning. Consent is the default.
#   2. IT REQUIRED python3. The other three plugin hooks are pure bash. A hard dependency inside a
#      hook is how you brick someone's session. Now pure bash — no interpreters.
#   3. IT COULD FAIL CLOSED. Every unparseable/ambiguous case fails open (exit 0).
#
# CONTRACT: always exit 0 and emit no user-facing bytes. Audit receipts are best-effort only.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

set -uo pipefail

# Read stdin with a BASH BUILTIN, not `cat`. Break-testing on a bare PATH caught this: `INPUT=$(cat)`
# made the hook depend on an external binary, and when it was missing the gate silently allowed
# everything. Second hole found the same way as the first (the grep|sed parse). The rule this file
# now obeys absolutely: A HOOK THAT CAN BLOCK MUST DEPEND ON NOTHING IT CANNOT GUARANTEE.
INPUT=""
# BOUNDED READ (2026-07-27, ADR-055 F20): an unqualified `read` never returns on a stdin that is
# opened and never closed — measured across the mesh, 18 of 37 registered commands sat until the
# harness killed them. Real Claude Code writes and closes, so this costs no normal turn; that is
# exactly why a hook that CAN hang forever survives unnoticed. -t bounds the wait, and the string
# is truncated AFTER the loop because a hook payload is one line with no newline, so `read` hands
# the whole thing back at once and a per-iteration cap never fires.
while IFS= read -r -t 2 _line; do
  INPUT+="$_line"
  [ ${#INPUT} -ge 65536 ] && break
done
[ -n "$_line" ] && INPUT+="$_line"
INPUT="${INPUT:0:65536}"
[ -n "$INPUT" ] || exit 0                      # nothing to inspect → never block

# ── OPT-IN GATE. No profile = this user never asked for cost routing = we do not touch their tools. ──
PROFILE="${MODEL_ROUTER_PROFILE:-$HOME/.claude/model-router/profile.json}"
[ -f "$PROFILE" ] || exit 0
# A non-interactive install records useful detection data with an explicit `assumed:` basis, but it
# never asked the consent questions. Treat that provenance as inert. Existing confirmed profiles
# that predate the basis field remain compatible; malformed/unreadable profiles fail open.
PROFILE_INPUT=""
while IFS= read -r _profile_line; do
  PROFILE_INPUT+="$_profile_line"
  [ ${#PROFILE_INPUT} -ge 65536 ] && break
  true
done < "$PROFILE" 2>/dev/null || exit 0
[ -n "$_profile_line" ] && PROFILE_INPUT+="$_profile_line"
case "$PROFILE_INPUT" in *'"basis"'*'"assumed:'*) exit 0 ;; esac

# ── Deliberate escape hatch (must be used ON PURPOSE, never reached by omission). ──
[ "${RUVNET_ALLOW_INHERITED_MODEL:-0}" = "1" ] && exit 0

# ── JSON field reads via BASH'S OWN REGEX — no subprocess, no PATH, no locale, no interpreter.
#    v1 used a `grep | head | sed` pipeline. Break-testing it on a bare environment (env -i, only
#    coreutils on PATH) exposed the hole: the pipeline produced an EMPTY string, so the gate silently
#    FAILED OPEN and blocked nothing. A wall with a hole is not a wall — and I would only have learned
#    that from a user whose routing quietly never enforced. `[[ =~ ]]` is a bash builtin: it cannot be
#    missing, cannot be shadowed by PATH, and cannot fail on a locale.
field() {
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""
  [[ $INPUT =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"
}

TOOL=$(field tool_name)
case "$TOOL" in Task|Agent) ;; *) exit 0 ;; esac   # only subagent dispatches

SUBTYPE=$(field subagent_type)
[ "$SUBTYPE" = "fork" ] && exit 0                  # a fork inherits the parent model BY DESIGN

MODEL=$(field model)
DESC=$(field description)
TOOL_USE_ID=$(field tool_use_id)
SESSION_ID=$(field session_id)
DESC="${DESC// /_}"; DESC="${DESC:0:40}"   # builtin substitution — no `tr`, no `cut`

log_dispatch() {
  local selected_model="$1"
  local enforcement="$2"
  # Log so routing is AUDITABLE, not merely claimed — a growing ledger is evidence; a promise is not.
  # `date` is the ONE external command left, and only on the ALLOW path — so its absence must be
  # silent, not a stderr spew from a hook that just said "yes". (bash's printf %()T would avoid it
  # entirely, but macOS still ships bash 3.2, which does not support it.)
  # The ENTIRE logging block is stderr-silenced as one unit: if the mkdir fails, the append redirect
  # fails too, and BASH ITSELF writes that error — a `2>/dev/null` on the printf does not catch it.
  # A hook that just said "yes" must say nothing at all.
  {
    TS=$(date -u +%FT%TZ) || TS="unknown"   # the one external command, and only on the allow path
    mkdir -p "$HOME/.claude/metaharness"
    printf '{"ts":"%s","event":"dispatch","model":"%s","enforcement":"%s","agent":"%s","task":"%s","toolUseId":"%s","sessionId":"%s"}\n' \
      "$TS" "$selected_model" "$enforcement" "${SUBTYPE:-unknown}" "${DESC:-unlabeled}" "${TOOL_USE_ID:-}" "${SESSION_ID:-}" \
      >> "$HOME/.claude/metaharness/dispatch-log.jsonl"
  } 2>/dev/null || true
}

if [ -n "$MODEL" ]; then
  log_dispatch "$MODEL" "declared"
  exit 0
fi

# Missing model: record the inheritance leak, but do not emit a late refusal the host cannot enforce.
log_dispatch "inherited" "advisory-host-timing"
exit 0
