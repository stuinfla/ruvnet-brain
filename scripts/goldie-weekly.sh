#!/bin/bash
# Existing Goldie launchd label/calendar stays unchanged. Run installed, guarded native cycle
# plus model-auto-refresh.mjs so newly discovered subscription models across all 4 hosts stay current.
set -eu
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:${PATH:-/usr/bin:/bin}"
export PATH
CYCLE="$HOME/.claude/model-router/bin/model-weekly-cycle.mjs"
AUTO_REFRESH="$HOME/.claude/model-router/bin/model-auto-refresh.mjs"
NODE_BINARY="${RUVNET_NODE_BINARY:-/opt/homebrew/opt/node@24/bin/node}"
if [ ! -f "$CYCLE" ] || [ ! -x "$NODE_BINARY" ]; then
  echo 'Weekly model cycle is not installed; prior policy retained.' >&2
  exit 1
fi
if [ -f "$AUTO_REFRESH" ]; then
  "$NODE_BINARY" "$AUTO_REFRESH" || true
fi
exec "$NODE_BINARY" "$CYCLE" --router-dir "$HOME/.claude/model-router"
