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
# PATH is set explicitly: launchd does not inherit a login shell's environment, which is why the
# sibling agent com.ruvnet.brain-nightly has been dying on `spawnSync gh ENOENT` — gh lives in
# /opt/homebrew/bin and launchd never saw it.

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
log "corpus changed — re-embedding"
i=0
while [ "$i" -lt 8 ]; do
  node kb/forge-big.mjs embed --dir kb --name ruv-gists --shard "$i" --of 8 >>"$LOG" 2>&1 &
  i=$((i + 1))
done
wait
node kb/forge-big.mjs ingest --dir kb --name ruv-gists >>"$LOG" 2>&1
log "done — ruv-gists store rebuilt"
