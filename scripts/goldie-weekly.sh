#!/bin/bash
# Existing Goldie launchd label/calendar stays unchanged. Run installed, guarded native cycle;
# policy promotion is a separate evidence-qualified boundary. No legacy model/API proposer.
set -eu
CYCLE="$HOME/.claude/model-router/bin/model-weekly-cycle.mjs"
NODE_BINARY="${RUVNET_NODE_BINARY:-/opt/homebrew/opt/node@24/bin/node}"
if [ ! -f "$CYCLE" ] || [ ! -x "$NODE_BINARY" ]; then
  echo 'Weekly model cycle is not installed; prior policy retained.' >&2
  exit 1
fi
exec "$NODE_BINARY" "$CYCLE" --router-dir "$HOME/.claude/model-router"
