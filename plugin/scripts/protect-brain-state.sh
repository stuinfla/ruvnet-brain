#!/bin/bash
# protect-brain-state.sh — PreToolUse gate on Write|Edit|MultiEdit.
# AN AGENT MAY NOT EDIT THE USER'S OWN CONSENT RECORD.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# WHY (ADR-054 §3, Fable 5's single most pointed duel finding). The moment the brain can be switched
# off, the switch becomes a thing an agent can switch back on. Every plane of the off contract is
# built to keep the model from noticing the lever — search_ruvnet's soft answer deliberately omits
# the re-enable mechanism, the session-start line is one dim sentence with no instruction attached —
# but a prompt is advisory and this repo has learned twice over what advisory means. rUv states the
# rule himself (@claude-flow/guidance, ADR-G007): "The model can forget a rule; the gate does not."
#
# So the paths that record the user's choice are walled off from the tools an agent writes with:
#   • the sentinel        ~/.config/ruvnet-brain/brain-off   — the switch itself
#   • the settings mirror ~/.config/ruvnet-brain/settings.json, and its .bak-*/.lock/.tmp-* siblings
#     (a restore-from-backup or a lock-file trick is the same edit by another route)
#
# WHAT THIS DOES NOT CLAIM. It guards Write/Edit/MultiEdit, which is where an agent writes files. It
# does NOT guard `rm` or `>` through Bash — that is a different matcher with a different parse and a
# much larger false-positive surface, and pretending otherwise would be a bigger lie than the gap.
# Stated plainly here rather than discovered later: this raises the cost of an accidental flip and
# of a careless one; it is not a sandbox.
#
# The refusal deliberately names no MODEL-EXECUTABLE remedy. Every other blocking gate in this repo
# teaches the way through, because there the way through is something the model should do. Here it
# is something only the user may do, so a helpful "run this to undo it" line would be the
# vulnerability rather than the fix. It says who owns the change, not how to perform it.
#
# CONTRACT: exit 0 = allow · exit 2 + stderr = BLOCK (stderr returns to the model as the reason).
# FAILS OPEN on anything unparseable — a blocking hook must never brick a session. Pure bash
# builtins, no node/jq/python, for the same reason as ground-before-write.sh: a wall that can
# fail-open because a tool went missing is not a wall.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

set -uo pipefail

INPUT=""
# BOUNDED READ (2026-07-27, ADR-055 F20): an unqualified `read` never returns on a stdin that is
# opened and never closed — measured across the mesh, 18 of 37 registered commands sat until the
# harness killed them. Real Claude Code writes and closes, so this costs no normal turn; that is
# exactly why a hook that CAN hang forever survives unnoticed. -t bounds the wait, and the string
# is truncated AFTER the loop because a hook payload is one line with no newline, so `read` hands
# the whole thing back at once and a per-iteration cap never fires.
while IFS= read -r -t 2 _l; do
  INPUT+="$_l"
  [ ${#INPUT} -ge 65536 ] && break
done
[ -n "$_l" ] && INPUT+="$_l"
INPUT="${INPUT:0:65536}"
[ -n "$INPUT" ] || exit 0

field() { local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""; [[ $INPUT =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"; }

case "$(field tool_name)" in Write|Edit|MultiEdit|NotebookEdit) ;; *) exit 0 ;; esac

FILE_PATH=$(field file_path)
[ -n "$FILE_PATH" ] || exit 0

# Windows sends `C:\Users\me\.config\ruvnet-brain\settings.json`, and because the payload is JSON,
# field() — which does no unescaping — hands us DOUBLED backslashes. Every pattern below is written
# with `/`, so without this the case block matched nothing and the guard exited 0: the consent
# boundary failed OPEN for every Windows user, silently. Measured on windows-unit 2026-08-10
# (`expected +0 to be 2`), and reproduced on macOS — it is the payload's shape, not the host.
# Normalization is for MATCHING ONLY; nothing here opens the file.
FILE_PATH=${FILE_PATH//\\\\/\\}   # JSON-doubled backslash → one
FILE_PATH=${FILE_PATH//\\//}      # separator → the one every pattern below is written in

# The same two paths brain-state.mjs and user-settings.mjs compute, resolved the same way. The env
# overrides exist so this suite (and a second machine profile) can point them elsewhere; the literal
# defaults are matched TOO, so the guard protects a real user even when no override is set — a gate
# that only fires under its own test harness protects nobody.
STATE_DIR="${RUVNET_BRAIN_STATE_DIR:-$HOME/.config/ruvnet-brain}"
SETTINGS_FILE="${RUVNET_SETTINGS_FILE:-$HOME/.config/ruvnet-brain/settings.json}"

PROTECTED=""
case "$FILE_PATH" in
  "$STATE_DIR"/brain-off|"$STATE_DIR"/brain-off.*)         PROTECTED="the on/off switch" ;;
  "$SETTINGS_FILE"|"$SETTINGS_FILE".*)                     PROTECTED="your saved settings" ;;
  # Literal defaults, for any HOME/override combination that did not match above. The trailing `*`
  # covers .bak-<stamp>, .lock and .tmp-<pid> — the same file by another name.
  */.config/ruvnet-brain/brain-off|*/.config/ruvnet-brain/brain-off.*)         PROTECTED="the on/off switch" ;;
  */.config/ruvnet-brain/settings.json|*/.config/ruvnet-brain/settings.json.*) PROTECTED="your saved settings" ;;
esac
[ -n "$PROTECTED" ] || exit 0

cat >&2 <<EOF
⛔ BLOCKED — that file is the user's own record of how they want this machine to behave ($PROTECTED).

It is changed by the person, from the RuvNet Brain console, and never by an agent editing the file.
Do not attempt this another way, and do not offer to. If the user's intent was to change one of
these settings, say so in plain words and let them make the change themselves.
EOF
exit 2
