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
# Heartbeat file: written every 30s to prove the job is still running.
# Must match JOB_HEARTBEAT_DIR convention from job-heartbeat.sh and nightly-watchdog.mjs.
HEARTBEAT_FILE="${JOB_HEARTBEAT_DIR:-$HOME/.cache/ruvnet-brain/heartbeats}/com.ruvnet.brain-gists.heartbeat"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '[%s] %s\n' "$(ts)" "$1" >>"$LOG"; }

# Heartbeat: write a timestamp every 30 seconds to prove the job is still running.
# Runs in background; killed when the main script exits.
start_heartbeat() {
  mkdir -p "$(dirname "$HEARTBEAT_FILE")"
  (
    while true; do
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HEARTBEAT_FILE"
      sleep 30
    done
  ) &
  HEARTBEAT_PID=$!
  trap "kill $HEARTBEAT_PID 2>/dev/null || true" EXIT
}
start_heartbeat

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
#
# 2026-09-11: the manual `&`/`wait` fan-out above (kept in history, replaced below) could not see
# whether a shard was still doing WORK or just still alive — an 8-shard run once sat at 0% CPU for
# six hours with every pid alive and no failure ever detected. `forge-big.mjs shard-all` is the
# supervising "parent embed process": it owns the fan-out itself, reads each shard's per-batch
# progress file, and SIGTERMs+exits non-zero the moment any shard stops advancing for longer than
# its stall budget — so a genuine hang aborts in minutes instead of surviving until a human notices.
log "corpus changed — re-embedding"
if ! node kb/forge-big.mjs shard-all --dir kb --name ruv-gists --shards 8 --stall-minutes 15 >>"$LOG" 2>&1; then
  log "EMBED FAILED — shard-all reported a failure or a stall; refusing to ingest a half-embedded corpus"
  exit 1
fi
node kb/forge-big.mjs ingest --dir kb --name ruv-gists >>"$LOG" 2>&1 || { log "INGEST FAILED — store NOT rebuilt"; exit 1; }
log "done — ruv-gists store rebuilt"
