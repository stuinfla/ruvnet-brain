#!/bin/sh
# POSIX compatibility launcher. SessionStart has one behavioral authority on every host:
# session-start-core.mjs. Fail open because SessionStart is advisory and must never block a session.
set +e
HOOK_DIR="${0%/*}"
if [ "$HOOK_DIR" = "$0" ]; then
  case "$0" in
    *\\*) HOOK_DIR="${0%\\*}" ;;
    *) HOOK_DIR="." ;;
  esac
fi
node "$HOOK_DIR/session-start-core.mjs" || true
exit 0
