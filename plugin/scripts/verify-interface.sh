#!/bin/bash
# verify-interface.sh — advisory migration notice for legacy raw-shell RuvNet CLI calls.
#
# Issue #48 retires the Bash PreToolUse wall. Reconstructing shell grammar from a raw command string
# accumulated false positives and false negatives across issues #12, #13, #41, and #44. A hook that
# guesses what a shell will execute cannot safely authorize or deny execution.
#
# The enforceable boundary now lives at the MCP protocol layer:
#   1. ruvnet_cli_help accepts a finite executable enum plus a structured subcommand argv.
#   2. ruvnet_cli_run accepts a literal argv array and launches with shell:false.
#   3. unknown executables and missing/stale successful-help stamps fail closed there.
#
# This legacy hook may point callers toward that boundary, but its permanent contract is exit 0.

set -uo pipefail

INPUT=""
while IFS= read -r -t 2 _line; do
  INPUT+="$_line"
  [ ${#INPUT} -ge 65536 ] && break
done
[ -n "${_line:-}" ] && INPUT+="$_line"
INPUT="${INPUT:0:65536}"
[ -n "$INPUT" ] || exit 0

# Preserve the existing explicit opt-in boundary. An assumed subscription profile is not consent to
# add even an advisory message to the user's tool stream.
PROFILE="${MODEL_ROUTER_PROFILE:-$HOME/.claude/model-router/profile.json}"
[ -f "$PROFILE" ] || exit 0
PROFILE_INPUT=""
while IFS= read -r _profile_line; do
  PROFILE_INPUT+="$_profile_line"
  [ ${#PROFILE_INPUT} -ge 65536 ] && break
  true
done < "$PROFILE" 2>/dev/null || exit 0
[ -n "${_profile_line:-}" ] && PROFILE_INPUT+="$_profile_line"
case "$PROFILE_INPUT" in *'"basis"'*'"assumed:'*) exit 0 ;; esac

NODE_BIN=$(command -v node) || exit 0
HOOK_INPUT="$(dirname "${BASH_SOURCE[0]}")/hook-input.mjs"
TOOL_NAME=$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" tool_name 2>/dev/null) || exit 0
[ "$TOOL_NAME" = "Bash" ] || exit 0
CMD=$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" command 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# This deliberately broad substring check controls only whether guidance is shown. It grants or
# denies nothing, records no authority stamp, and cannot change the tool call's exit status.
case "$CMD" in
  *ruflo*|*claude-flow*|*agentic-flow*|*agentic-qe*|*ruvector*|*agent-browser*|*ruv-swarm*) ;;
  *) exit 0 ;;
esac

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Interface check advisory: prefer native Ruflo MCP tools. For CLI-only gaps, use ruvnet_cli_help and then ruvnet_cli_run with literal argv; raw Bash is never blocked by this notice."}}'
exit 0
