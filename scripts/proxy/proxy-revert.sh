#!/usr/bin/env bash
# proxy-revert.sh — remove the Meta LLM Proxy trial completely.
#
# This is the safety net for the whole trial, so it is deliberately boring and
# total: stop the process, uninstall via rUv's own lifecycle command, then
# PROVE nothing is left rather than claiming it.
#
# It does not touch ~/.claude/settings.json — the trial never wrote there (see
# proxy-verify.mjs check 3), so there is nothing to undo.
set -uo pipefail

# Every `ruflo` invocation auto-starts a project background daemon unless this is set (verified
# live: ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/
# daemon-autostart.js:85). A teardown script has no business leaving one running.
export RUFLO_DAEMON_AUTOSTART=0

echo "Reverting the Meta LLM Proxy trial..."
echo

echo "--- stopping (if running) ---"
ruflo proxy stop 2>&1 | sed 's/^/  /' || true
echo

echo "--- uninstalling binary, token, consent receipt (ruflo proxy uninstall) ---"
ruflo proxy uninstall 2>&1 | sed 's/^/  /' || true
echo

echo "--- PROOF it is gone (derived, not asserted) ---"
FAIL=0

STATUS=$(ruflo proxy status --json 2>/dev/null || echo '{}')
echo "  ruflo proxy status: $STATUS"
case "$STATUS" in
  *'"installed":true'*) echo "    ^ still installed" ; FAIL=1 ;;
esac
case "$STATUS" in
  *'"running":true'*)   echo "    ^ still running"   ; FAIL=1 ;;
esac

if lsof -iTCP:11435 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "  port 11435: STILL LISTENING  <-- revert incomplete"; FAIL=1
else
  echo "  port 11435: clear"
fi

if [ -f "$HOME/.ruflo/proxy-token" ]; then
  echo "  proxy-token: STILL PRESENT  <-- revert incomplete"; FAIL=1
else
  echo "  proxy-token: removed"
fi

if grep -q 'ANTHROPIC_BASE_URL' "$HOME/.claude/settings.json" 2>/dev/null; then
  echo "  ~/.claude/settings.json: contains ANTHROPIC_BASE_URL  <-- unexpected"; FAIL=1
else
  echo "  ~/.claude/settings.json: clean (never modified by this trial)"
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "Reverted. The machine is back to its pre-trial state."
  exit 0
fi
echo "REVERT INCOMPLETE — see the lines marked above."
exit 1
