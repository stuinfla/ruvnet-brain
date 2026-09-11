#!/usr/bin/env bash
# claude-proxied.sh — launch ONE Claude Code session routed through the proxy.
#
# THIS IS THE ISOLATION BOUNDARY OF THE WHOLE TRIAL.
#
# ANTHROPIC_BASE_URL is exported for this process only. Nothing is written to
# ~/.claude/settings.json, so every other Claude Code window on this machine —
# including the one you are reading this in — keeps talking directly to
# Anthropic, exactly as before. Close this session and the wiring is gone.
#
# What happens inside this session (ADR-313 addendum): setting
# ANTHROPIC_BASE_URL makes Claude Code stop managing its own Max/Pro OAuth
# session. That is fine here and ONLY because the proxy defaults to the
# Passthrough plane, which reads ~/.claude/.credentials.json (read-only) and
# forwards to the real api.anthropic.com with your actual subscription token.
# Your subscription is still what pays and still what answers.
#
# If the plane were ever anything other than passthrough, this script refuses
# to launch — a silent flip to a cheap tier while you believe you are on your
# subscription is the single worst failure mode here, so it is checked, not
# assumed.
set -euo pipefail

# Every `ruflo` invocation auto-starts a project background daemon unless this is set (verified
# live: ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/
# daemon-autostart.js:85). This script only checks/starts the proxy — it has no business leaving a
# swarm daemon running as a side effect.
export RUFLO_DAEMON_AUTOSTART=0

TOKEN_FILE="$HOME/.ruflo/proxy-token"

if ! ruflo proxy status --json 2>/dev/null | grep -q '"running":true'; then
  echo "Proxy is not running. Start it first:"
  echo "  ./scripts/proxy/proxy-up.sh"
  exit 1
fi

if [ ! -r "$TOKEN_FILE" ]; then
  echo "Missing proxy token at $TOKEN_FILE — reinstall with ./scripts/proxy/proxy-up.sh"
  exit 1
fi

PLANE=$(ruflo proxy config 2>/dev/null | head -1)
if ! echo "$PLANE" | grep -qi 'passthrough'; then
  echo "REFUSING TO LAUNCH — data plane is not passthrough:"
  echo "  $PLANE"
  echo
  echo "This trial only sanctions the passthrough plane (your own subscription)."
  echo "Revert to it with: ruflo proxy config --local-only   (or re-read ADR-0026)"
  exit 1
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:11435"
export ANTHROPIC_AUTH_TOKEN="$(cat "$TOKEN_FILE")"

echo "Launching a proxied Claude Code session."
echo "  ANTHROPIC_BASE_URL = $ANTHROPIC_BASE_URL   (this process only)"
echo "  data plane         = passthrough (your own Anthropic subscription)"
echo "  other windows      = unaffected"
echo "  watch traffic with = ruflo proxy logs -f"
echo

exec claude "$@"
