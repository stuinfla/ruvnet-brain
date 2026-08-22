#!/bin/sh
# nightly-gists.sh — keep the brain's view of rUv's thinking current, cheaply.
#
# Run by the launchd agent com.ruvnet.brain-gists (21:47 local). Does NOT publish, deploy, push, or
# touch anything outward-facing. Reads GitHub, writes to kb/ and docs/.
#
# COST DISCIPLINE (the whole point):
#   1. index refresh   — ~5 API calls, no per-gist fetch, no model.          Always.
#   2. content ingest  — incremental; only re-fetches gists whose updated_at moved.
#   3. re-embed        — the expensive step (~18 min, 8 shards). SKIPPED ENTIRELY when step 2
#                        reports "nothing to do". A quiet night costs seconds, not minutes.
#
# PATH is set explicitly because launchd does not inherit a login shell's environment. The retired
# com.ruvnet.brain-nightly source writer previously exposed this exact failure mode: gh lived in
# /opt/homebrew/bin and launchd could not see it.

set -eu

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export KB_MODEL_CACHE="${KB_MODEL_CACHE:-/Users/stuartkerr/Code/PowerPlatePulse/scripts/models-cache}"

mkdir -p logs
LOG="logs/gists-nightly.log"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '[%s] %s\n' "$(ts)" "$1" >>"$LOG"; }

log "start"

command -v gh >/dev/null 2>&1 || { log "FATAL: gh not on PATH"; exit 1; }
gh auth status >/dev/null 2>&1 || { log "FATAL: gh not authenticated"; exit 1; }

# 1 — the tracked index. Cheap enough to do unconditionally.
node scripts/ingest-gists.mjs --index-only >>"$LOG" 2>&1
log "index refreshed"

# 2 — incremental content ingest.
if ! OUT=$(node scripts/ingest-gists.mjs 2>&1); then
  printf '%s\n' "$OUT" >>"$LOG"
  log "FATAL: ingest failed"
  exit 1
fi
printf '%s\n' "$OUT" >>"$LOG"

if printf '%s' "$OUT" | grep -q 'nothing to do'; then
  log "no new gists — skipping embed (cost: 0)"
  exit 0
fi

# 3 — re-embed, only because the corpus actually changed. 8 shards, then one assemble.
# DERIVED, not asserted (F6, 2026-07-18): a bare `wait` with no operands ALWAYS returns 0 under
# POSIX, so a failed shard was structurally invisible — the script would proceed to ingest and log
# "done — rebuilt" over a half-embedded corpus. Now every shard PID is waited on individually and a
# single failure aborts BEFORE ingest, loudly. "done" is only printed over a fully-embedded corpus.
log "corpus changed — re-embedding"
i=0
pids=""
while [ "$i" -lt 8 ]; do
  node kb/forge-big.mjs embed --dir kb --name ruv-gists --shard "$i" --of 8 >>"$LOG" 2>&1 &
  pids="$pids $!"
  i=$((i + 1))
done
FAILED_SHARDS=0
for p in $pids; do
  wait "$p" || FAILED_SHARDS=$((FAILED_SHARDS + 1))
done
if [ "$FAILED_SHARDS" -gt 0 ]; then
  log "EMBED FAILED — $FAILED_SHARDS of 8 shards exited nonzero; refusing to ingest a half-embedded corpus"
  exit 1
fi
node kb/forge-big.mjs ingest --dir kb --name ruv-gists >>"$LOG" 2>&1 || { log "INGEST FAILED — store NOT rebuilt"; exit 1; }
log "done — ruv-gists store rebuilt"
