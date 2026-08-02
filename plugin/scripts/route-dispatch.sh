#!/bin/bash
# route-dispatch.sh — PreToolUse gate on subagent dispatch. Ends model-inheritance-by-omission.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# THE LEAK (2026-07-13). Stuart: "What happens when I'm right here in Opus 4.8 and it has 10 things
# to run? Is it going to just run them as Opus 4.8?" — YES:
#
#     A SUBAGENT INHERITS THE MAIN-LOOP MODEL UNLESS `model` IS EXPLICITLY PASSED.
#
# Ten agents on a Fable session = ten agents at $10/$50 per Mtok, ~10x Haiku for identical mechanical
# work. The router existed; the rule to use it existed; the router's ENTIRE LIFETIME OUTPUT was 3 test
# pings and $0.018 saved — because the rule was ADVISORY. So this is a wall, not advice.
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
#      BLOCKING hook is how you brick someone's session. Now pure bash — no interpreters.
#   3. IT COULD FAIL CLOSED. A blocking hook that errors must never take the session with it. Every
#      unparseable/ambiguous case now FAILS OPEN (exit 0). A gate that breaks your tools is worse
#      than the leak it prevents.
#
# CONTRACT (verified against this machine's live hook config):
#   exit 0          → allow
#   exit 2 + stderr → BLOCK, and stderr comes back to the model as the reason (so it retries correctly)
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

if [ -n "$MODEL" ]; then
  # Declared. Log it so routing is AUDITABLE, not merely claimed — a growing ledger is evidence;
  # a promise is not. (This log is how the $0.018-lifetime failure became visible in the first place.)
  # `date` is the ONE external command left, and only on the ALLOW path — so its absence must be
  # silent, not a stderr spew from a hook that just said "yes". (bash's printf %()T would avoid it
  # entirely, but macOS still ships bash 3.2, which does not support it.)
  # The ENTIRE logging block is stderr-silenced as one unit: if the mkdir fails, the append redirect
  # fails too, and BASH ITSELF writes that error — a `2>/dev/null` on the printf does not catch it.
  # A hook that just said "yes" must say nothing at all.
  {
    TS=$(date -u +%FT%TZ) || TS="unknown"   # the one external command, and only on the allow path
    mkdir -p "$HOME/.claude/metaharness"
    printf '{"ts":"%s","event":"dispatch","model":"%s","agent":"%s","task":"%s","toolUseId":"%s","sessionId":"%s"}\n' \
      "$TS" "$MODEL" "${SUBTYPE:-unknown}" "${DESC:-unlabeled}" "${TOOL_USE_ID:-}" "${SESSION_ID:-}" \
      >> "$HOME/.claude/metaharness/dispatch-log.jsonl"
  } 2>/dev/null || true
  exit 0
fi

# ── BLOCKED: no model declared → it would silently inherit the session model. ──
# `read` + `printf` are BUILTINS. The original used `cat >&2 <<EOF`, which made the BLOCK path itself
# depend on an external binary — the third dependency hole found in my own hook in ten minutes.
read -r -d '' BLOCK_MSG <<'EOF' || true
⛔ SUBAGENT DISPATCH BLOCKED — you did not declare a `model`.

An agent with no `model` INHERITS this session's model. On an Opus session that is an Opus agent;
on a Fable session it is $10/$50 per Mtok — up to 10x what the same work costs on Haiku.
Inheritance-by-omission is the biggest cost leak in this harness, and an advisory rule did not fix
it (the router's entire first life saved $0.018). Hence a wall.

Re-issue the SAME Agent call with an explicit `model`, chosen by what the task actually IS:

  model: "haiku"   mechanical — greps, file sweeps, log triage, mechanical edits, fixture rewrites
  model: "sonnet"  analytical — trace a bug across files, summarize a subsystem, draft tests
  model: "opus"    judgment   — architecture, root cause, security, anything user-facing
                   (if it truly needs the main model's judgment, ask whether it should be a
                    subagent at all, or work you should do inline)

Not sure? Ask rUv's real router — it predicts each model's quality on THIS task and returns the
cheapest one that clears the bar, with your subscriptions priced at $0:

  node ~/.claude/model-router/bin/model-router-engine.mjs --harness claude-code --prompt "<task>" --json

Then log the receipt when it returns, so the saving is visible instead of asserted:

  node scripts/dispatch-receipt.mjs --model <m> --inherited <this session's model> \
       --task "<what it did>" --total-tokens <the agent's reported total>

Deliberate exception (rare — and say WHY out loud): RUVNET_ALLOW_INHERITED_MODEL=1
EOF
bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" route-dispatch "subagent" "would inherit the session model instead of routing to a cheaper one" 2>/dev/null || true
printf '%s\n' "$BLOCK_MSG" >&2
exit 2
