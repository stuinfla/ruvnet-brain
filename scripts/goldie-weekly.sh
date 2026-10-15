#!/bin/bash
# Existing Goldie launchd label/calendar stays unchanged. Run installed, guarded native cycle;
# policy promotion is a separate evidence-qualified boundary. No legacy model/API proposer.
set -eu
# launchd hands this job PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin, which has neither native CLI:
# the semantic stage spawns bare `codex` / `claude` and failed with "Private native hook metadata transport failed".
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:${PATH:-/usr/bin:/bin}"
export PATH
CYCLE="$HOME/.claude/model-router/bin/model-weekly-cycle.mjs"
NODE_BINARY="${RUVNET_NODE_BINARY:-/opt/homebrew/opt/node@24/bin/node}"
if [ ! -f "$CYCLE" ] || [ ! -x "$NODE_BINARY" ]; then
  echo 'Weekly model cycle is not installed; prior policy retained.' >&2
  exit 1
fi
exec "$NODE_BINARY" "$CYCLE" --router-dir "$HOME/.claude/model-router"
