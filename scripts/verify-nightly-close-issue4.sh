#!/bin/sh
# verify-nightly-close-issue4.sh — one-shot morning check for issue #4 (runs 07:17, then removes itself).
# Closes the issue ONLY on proof: releases/latest must have ADVANCED past v0.5.0-dev within the last
# 24h (i.e., tonight's 3:15 publish worked). Otherwise it posts the honest failure and stays open.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/stuartkerr/Code/ruvnet-brain || exit 1
LOG=logs/issue4-verify.log
{
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] checking releases/latest"
  TAG=$(gh release view --json tagName -q .tagName 2>/dev/null)
  PUB=$(gh release view --json publishedAt -q .publishedAt 2>/dev/null)
  echo "  latest: $TAG published $PUB"
  FRESH=0
  if [ -n "$PUB" ] && [ "$TAG" != "v0.5.0-dev" ]; then
    AGE=$(( $(date +%s) - $(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$PUB" +%s 2>/dev/null || echo 0) ))
    [ "$AGE" -gt 0 ] && [ "$AGE" -lt 86400 ] && FRESH=1
  fi
  if [ "$FRESH" = "1" ]; then
    NOTE=20 20 12 61 79 80 81 98 701 702 33 100 204 250 395 398 399 400sed -e "s/__TAG__//g" -e "s/__PUB__//g" scripts/issue4-close-note.md); gh issue close 4 --comment ""
    echo "  CLOSED issue #4 with receipt"
  else
    gh issue comment 4 --body "Honest status: the overnight publish did **not** advance releases/latest (still $TAG). The PATH fix is in but something else is failing — investigating; leaving this open. Log: logs/nightly.log"
    echo "  release did NOT advance — commented, left open"
  fi
  launchctl bootout "gui/$(id -u)/com.ruvnet.issue4-verify" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.ruvnet.issue4-verify.plist"
  echo "  one-shot agent removed"
} >> "$LOG" 2>&1
