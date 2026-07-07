#!/bin/zsh
# build-big-all.sh — build bge-768 ("big") variants for the 4 non-ruflo T0/T1 repos.
# Phase A: rulake + agentdb + ruview as single-process `both`, in parallel.
# Phase B: ruvector sharded across 4 embed processes, then one ingest.
# Honest: these are LOCAL embedding processes (no Ruflo agents involved). Progress in kb/big-*.log
set -u
cd "${0:a:h}" || exit 1   # run from this script's own dir (the kb/ folder), wherever the repo lives
export KB_MODEL_CACHE="${KB_MODEL_CACHE:-$HOME/.cache/ruvnet-brain/models-cache}"   # honor an existing KB_MODEL_CACHE; else a home-relative default
export OMP_NUM_THREADS=4   # cap per-process threads so 7 concurrent procs share 16 cores without thrash
ts() { date "+%H:%M:%S"; }
echo "[$(ts)] BIG-BUILD-ALL start (cache=$KB_MODEL_CACHE)"

# Phase A — 3 small repos, single-process both, in parallel
for r in rulake agentdb ruview; do
  ( echo "[$(ts)] START $r (both)"; node forge-big.mjs both --dir . --name "$r"; echo "[$(ts)] DONE $r (exit $?)" ) > "big-$r.log" 2>&1 &
done

# Phase B — ruvector sharded embed (4 processes), in parallel with Phase A
for i in 0 1 2 3; do
  ( echo "[$(ts)] START ruvector embed shard $i/4"; node forge-big.mjs embed --dir . --name ruvector --shard "$i" --of 4; echo "[$(ts)] DONE ruvector shard $i (exit $?)" ) > "big-ruvector-embed-$i.log" 2>&1 &
done

wait
echo "[$(ts)] all embeds + small builds finished; assembling ruvector.big.rvf from shards"
node forge-big.mjs ingest --dir . --name ruvector > big-ruvector-ingest.log 2>&1
echo "[$(ts)] ruvector ingest exit $?"
echo "[$(ts)] BIG-BUILD-ALL complete"
# final reconcile snapshot
for r in rulake agentdb ruview ruvector; do
  if [ -f "$r.big.rvf" ]; then
    printf "  %-10s big.rvf=%s big.passages=%s\n" "$r" "$(du -h "$r.big.rvf" | cut -f1)" "$(wc -l < "$r.big.passages.jsonl" 2>/dev/null | tr -d ' ')"
  else
    printf "  %-10s big.rvf MISSING\n" "$r"
  fi
done
