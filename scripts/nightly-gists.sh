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
# The owner's macOS-approved node (~/.local/share/ruvnet-brain/job-bin) and Apple's tools come first: this repo and
# the model cache live on an external volume, and launchd-started Homebrew node is held at its first read there
# (2026-10-25: every embedding shard "stalled" for 15 min, then the run failed after 1 h 49 min).
export PATH="$HOME/.local/share/ruvnet-brain/job-bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"
export KB_MODEL_CACHE="${KB_MODEL_CACHE:-/Users/stuartkerr/Code/PowerPlatePulse/scripts/models-cache}"

mkdir -p logs
LOG="logs/gists-nightly.log"
# Liveness proof is the job-heartbeat.sh wrapper's <label>.json receipt (read by nightly-watchdog.mjs).
# A 30-second <label>.heartbeat writer used to live here; nothing ever read that file, so it was removed.
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '[%s] %s\n' "$(ts)" "$1" >>"$LOG"; }

log "start"

# The plist must NOT say ProcessType=Background. launchd then runs every process in the job under
# macOS's background policy (efficiency cores only, throttled I/O): measured 2026-10-25 under launchd,
# one 32-passage bge batch took 111-176 s as Background, 18 s as Standard, 10 s Interactive, 7-13 s
# from a shell. Eight shards at once pushed a batch past the 15-minute stall budget, so every changed
# night from 2026-10-08 on aborted as "stalled". Nice 5 plus forge-big's below-normal priority already
# keep the job polite. Warn loudly if the installed plist regresses.
PLIST="$HOME/Library/LaunchAgents/com.ruvnet.brain-gists.plist"
if [ -x /usr/libexec/PlistBuddy ] && [ -f "$PLIST" ] \
  && [ "$(/usr/libexec/PlistBuddy -c 'Print :ProcessType' "$PLIST" 2>/dev/null)" = "Background" ]; then
  log "WARN: $PLIST has ProcessType=Background — the re-embed will crawl on efficiency cores and trip the stall budget; set it to Standard"
fi

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

# A night whose embed FAILED has already rewritten the passages and the sources receipt, so the next
# night's ingest says "nothing to do" while the store is still the old one. Without this check that
# night skipped the embed and exited 0 over a stale store (2026-10-25 20:18: "0 new", store dated
# 2026-10-07). The store must be at least as new as the passages it is built from.
PASSAGES="kb/ruv-gists.passages.jsonl"
STORE="kb/ruv-gists.big.rvf"
if printf '%s' "$OUT" | grep -q 'nothing to do'; then
  if [ -f "$PASSAGES" ] && ! [ "$STORE" -nt "$PASSAGES" ]; then
    log "no new gists, but $STORE is older than $PASSAGES (an earlier embed did not finish) — re-embedding"
  else
    log "no new gists — skipping embed (cost: 0)"
    exit 0
  fi
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
