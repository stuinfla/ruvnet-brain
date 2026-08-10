#!/bin/bash
# nightly-wrapper.sh — the ONLY thing launchd invokes for the nightly. Per Stuart's standing order
# (2026-07-12): no noise for success or no-op — only ACTIVE alerts for real failure, and the system
# must attempt to self-heal before escalating, then make failure impossible to miss next session.
#
# Flow: run once -> if it fails, wait and retry ONCE (catches transient network/API blips, the only
# class a blind retry can fix) -> if it fails AGAIN, loud phone alert + a durable marker file that
# ground-ruvnet.sh surfaces at the top of the very next session, unprompted. Success or a legitimate
# "nothing was due tonight" no-op: log only, phone stays silent.
set -u
# kb/models-cache (the fallback) starts cold every time -> every nightly re-downloads the ONNX
# embedder from HuggingFace. Point at the already-warm cache instead (verified present).
export KB_MODEL_CACHE="/Users/stuartkerr/Code/PowerPlatePulse/scripts/models-cache"
cd /Users/stuartkerr/Code/ruvnet-brain 2>/dev/null || {
  curl -sS --max-time 10 -H "Title: 🔴 Nightly CRASHED before it could even start" \
    -H "Priority: urgent" -H "Tags: rotating_light" \
    -d "cd into the repo failed — filesystem or mount problem. Investigate the machine directly." \
    "https://ntfy.sh/$(grep -m1 '^NTFY_TOPIC=' /Users/stuartkerr/Code/ruvnet-brain/.env 2>/dev/null | cut -d= -f2)" >/dev/null 2>&1
  exit 1
}
mkdir -p logs .ruvnet-brain
LOG=logs/nightly.log
MARKER=.ruvnet-brain/nightly-failure.json
LOCK=.ruvnet-brain/nightly.lock

# Single-instance guard (2026-07-12): the plist has no built-in one. The updater is incremental now,
# but a very large upstream change, a slow model, or a stalled gate can still outlive the window and
# overlap the NEXT scheduled 3:15am fire. A stale lock from a crashed run (PID no longer alive) is
# treated as no lock.
if [ -f "$LOCK" ]; then
  OLD_PID=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "===== $(date -u +%FT%TZ) — SKIPPED: previous run (pid $OLD_PID) still in progress =====" >> "$LOG"
    # 75 = the reserved skip code: job-heartbeat.sh restores the live run's receipt instead of
    # stamping ok/0s over it (F3). launchd still sees success — a skip is not a failure.
    exit 75
  fi
  echo "===== $(date -u +%FT%TZ) — stale lock from pid $OLD_PID (not running) — clearing =====" >> "$LOG"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# NIGHTLY_SMOKE=1 — prove this whole chain (launchd -> heartbeat wrapper -> here -> node -> the repo
# scan -> the log) WITHOUT a multi-hour rebuild. self-update.mjs is dry-run by default, so dropping
# --apply exercises every link except the build itself. Publication is never part of this job.
# WHY IT EXISTS (2026-07-13): the 03:15 fire on 07-12 died before it could even write its own log
# ("/bin/bash: logs/nightly.log: No such file or directory" — relative path, no working directory) and
# NOBODY KNEW, because the only way to test this chain was to wait until 03:15 and hope. A scheduled job
# you can only test by waiting for it is a job you are not testing. Now: `NIGHTLY_SMOKE=1 <the exact
# plist command>` proves it on demand, any time, in seconds.
SMOKE="${NIGHTLY_SMOKE:-0}"

run_once() {
  local rc
  { echo "===== nightly-wrapper rebuild attempt $1 — $(date -u +%FT%TZ) ====="
    if [ "$SMOKE" = "1" ]; then
      echo "[SMOKE] dry-run: exercising the full chain, NOT building"
      /usr/local/bin/node scripts/self-update.mjs --fresh-window 60
    else
      /usr/local/bin/node scripts/self-update.mjs --apply --fresh-window 60
    fi
  } >> "$LOG" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "===== attempt $1: FAILED exit $rc — rebuild/candidate preparation did not complete =====" >> "$LOG"
    return 1
  fi
  if [ "$SMOKE" = "1" ]; then
    # A smoke run must never claim a real outcome, touch the failure marker, or alter the tag story.
    echo "===== attempt $1: SMOKE OK — chain intact (no build, no publish) =====" >> "$LOG"
    return 0
  fi
  echo "===== attempt $1: REBUILD COMPLETE — candidate bytes prepared; no release channel was promoted =====" >> "$LOG"
  rm -f "$MARKER"
  return 0
}

# Memory distillation (ADR-174) had gone stale 3 days — same silent-death pattern as everything
# else tonight. Independent of rebuild success/failure: mine raw memory_entries into structured
# episodes/reasoning_patterns on every nightly run. Best-effort, never blocks the real job.
RUFLO_DAEMON_AUTOSTART=0 ~/.npm-global/bin/ruflo memory distill run --path .swarm/memory.db >> "$LOG" 2>&1 || true
# Durability: was a one-off manual snapshot before tonight. Now recurring — WAL-safe, rotates
# automatically (keeps last 14), zero risk to the live DB (reads only).
RUFLO_DAEMON_AUTOSTART=0 ~/.npm-global/bin/ruflo memory backup --db .swarm/memory.db --keep 14 >> "$LOG" 2>&1 || true

# LESSON BRIDGE (ADR-066, 2026-08-10) — carry newly-tagged machine-wide lessons into the store the
# hooks actually read. Without this the bridge is a command someone has to remember, and a learning
# system that depends on being remembered is the thing ADR-066 was written to fix: knowledge sat in
# AgentDB for 18 days while the repo re-made the mistake it described.
#
# Safe to run unattended and to run when nothing changed: it is idempotent (bridged rows are replaced
# wholesale, native rows are never touched), it writes through the store's locked atomic writer, and
# it REFUSES to apply when it reads zero rows while bridged lessons are installed — so a transient
# read failure can never strip the store. Best-effort, never blocks the rebuild.
echo "===== lesson-bridge — $(date -u +%FT%TZ) =====" >> "$LOG"
/usr/local/bin/node plugin/scripts/lesson-bridge.mjs --apply >> "$LOG" 2>&1 \
  || echo "===== lesson-bridge: SKIPPED (see line above) =====" >> "$LOG"

# AgentDB drift canary (2026-07-23, P7 wiring sweep) — scripts/memdb-health.sh existed unwired since
# 2026-07-09/10, the exact nights idx_bridge_key/idx_bridge_ns corruption recurred 3x on this very DB
# while in WAL mode. Best-effort, same shape as its brain-health/key-health siblings below: never
# blocks the real rebuild, just makes a WAL-mode/integrity regression loud instead of silent.
echo "===== memdb-health canary — $(date -u +%FT%TZ) =====" >> "$LOG"
sh scripts/memdb-health.sh .swarm/memory.db >> "$LOG" 2>&1 \
  && echo "===== memdb-health canary: OK =====" >> "$LOG" \
  || echo "===== memdb-health canary: UNHEALTHY (see line above) =====" >> "$LOG"

# ── LEARNING-REPLAY: the D4 counterfactual trap (ADR-058 §D4). THE ONE STANDING TOKEN SPEND, priced
# in the open: N=3 replay, two model arms per run, ~$0.09 and ~55s measured 2026-07-27 on haiku.
#
# It runs HERE, and not on a GitHub runner, because the trap needs credentials a bare runner does not
# have — a real model session AND the real global `ruflo` binary (it records into a fixture project's
# .swarm/memory.db and refreshes it with `ruflo memory distill`). .github/workflows/learning-replay.yml
# is the currency gate on the artifact this writes; if this step stops running, that workflow goes red
# on staleness rather than everything staying quietly green.
#
# Best-effort, same shape as the canaries below: it never blocks the rebuild. Its exit code is not
# thrown away though — it is written to the log by name, because 0/1/3/4 are four different facts
# (PASS / the lesson stopped transferring / the trap was invalidated / it could not be measured) and
# collapsing them into "failed" is how the seven prior silent-death bugs in this file happened.
# ── RELEASE CONVERGENCE (issue #77, added 2026-08-06). Runs every night, does nothing almost every
# night, and finishes the release on the one night it can.
#
# Context: the published surfaces named different generations (npm 4.0.12, GitHub v4.0.7). The rail
# that fixes that was itself dead three independent ways; all three are repaired. The only remaining
# blocker was a GitHub Actions MAJOR OUTAGE — and the publisher IS an Actions workflow — with the
# maintainer away for a month. So the last step is handed to the nightly, which is already the thing
# that runs unattended.
#
# It does NOT publish. self-update.mjs:56 refuses --publish and only protected-release.yml may ship;
# this DISPATCHES that workflow, so every gate (exact-SHA evidence, clean worktree, release-proof,
# host verification, post-publication seal) still runs exactly as designed. It stands down on any
# unexpected state — dirty tree, open PRs, no green exact-SHA evidence, a -dev version, a stalled
# Actions plane — because a watchdog acting on a partial picture is worse than no watchdog.
# ── GITHUB HEALTH (2026-08-08). Stuart: "You should never ever let it be in a situation where
# it's got failed pushes. Your job is to always be looking out for GitHub." Every prior signal
# watched exactly ONE thing — signal-watch CI verdicts, issue-watch the SLA, published-surface
# npm-vs-GitHub — and nothing watched the states that actually stall work: a red main, a PR that
# silently went CONFLICTING, a stalled Actions queue, branches left behind after a merge.
#
# REPORTS ONLY. It cannot push, merge, close or publish (asserted by test). Exit 1 means a human
# needs to look, and the reasons print in full rather than as a count.
echo "===== GITHUB-HEALTH watch — $(date -u +%FT%TZ) =====" >> "$LOG"
/usr/local/bin/node scripts/github-health-watch.mjs >> "$LOG" 2>&1 \
  || echo "[github-health] findings above need attention" >> "$LOG"

echo "===== RELEASE-CONVERGENCE watchdog — $(date -u +%FT%TZ) =====" >> "$LOG"
/usr/local/bin/node scripts/release-convergence-watchdog.mjs --dispatch >> "$LOG" 2>&1 \
  || echo "[release-watchdog] exited non-zero — see above; nightly continues" >> "$LOG"

echo "===== LEARNING-REPLAY counterfactual trap — $(date -u +%FT%TZ) =====" >> "$LOG"
/usr/local/bin/node scripts/learning-replay.mjs --n 3 --model haiku >> "$LOG" 2>&1
LR_RC=$?
case "$LR_RC" in
  0) echo "===== LEARNING-REPLAY: PASS =====" >> "$LOG" ;;
  1) echo "===== LEARNING-REPLAY: FAIL — a lesson recorded in project A stopped changing behaviour in project B =====" >> "$LOG" ;;
  3) echo "===== LEARNING-REPLAY: INCONCLUSIVE — the control arm also produced the token; the trap measured nothing tonight =====" >> "$LOG" ;;
  *) echo "===== LEARNING-REPLAY: UNKNOWN (exit $LR_RC) — never a pass; see the lines above =====" >> "$LOG" ;;
esac

# ── GONG LAYER 3: brain-health canary (Stuart, 2026-07-12 — the brain must NEVER be dark silently).
# One real query against the LIVE cache brain every night. forge-ask-all.mjs exits non-zero on a
# total retrieval failure (all repos erroring) and rings kb/brain-alarm.mjs itself; this adds the
# guaranteed-nightly cadence plus its own urgent push, independent of the rebuild job's outcome.
BRAIN_KB="$HOME/.cache/ruvnet-brain/kb"
if [ -f "$BRAIN_KB/forge-ask-all.mjs" ]; then
  echo "===== brain-health canary — $(date -u +%FT%TZ) =====" >> "$LOG"
  if (cd "$BRAIN_KB" && /usr/local/bin/node forge-ask-all.mjs --dir . --q "HNSW vector index" --k 1) >> "$LOG" 2>&1; then
    echo "===== brain-health canary: OK =====" >> "$LOG"
  else
    echo "===== brain-health canary: DOWN — escalating =====" >> "$LOG"
    sh scripts/notify.sh "🚨 RuvNet Brain DOWN (nightly canary)" \
      "The live brain at $BRAIN_KB failed a real query — retrieval is broken for every session on this machine. Fix: cd $BRAIN_KB && npm i, then npx github:stuinfla/ruvnet-brain --doctor. See logs/nightly.log." \
      urgent "rotating_light" || true
  fi
fi

# ── Key-health canary (Stuart, 2026-07-12: two provider keys found dead by accident, months late).
# Runs through `zsh -lc` ON PURPOSE: a login shell sources ~/.zshrc -> env.global + the openclaw
# SOPS secrets, so this probes the EXACT env every real shell inherits — the real door, not a copy.
# The canary itself handles urgent pushes on alive->DEAD transitions (and recovery notices), so a
# known-dead key doesn't re-alarm every night; here we only log.
echo "===== key-health canary — $(date -u +%FT%TZ) =====" >> "$LOG"
zsh -lc 'cd /Users/stuartkerr/Code/ruvnet-brain && /usr/local/bin/node scripts/key-canary.mjs --notify' >> "$LOG" 2>&1 \
  && echo "===== key-health canary: all present keys alive =====" >> "$LOG" \
  || echo "===== key-health canary: at least one key DEAD (push sent on new deaths) =====" >> "$LOG"

if run_once 1; then
  exit 0
fi

echo "===== first attempt failed — waiting 3 min, retrying once (self-heal for transient issues) =====" >> "$LOG"
sleep 180

if run_once 2; then
  echo "===== SELF-HEALED on retry — no escalation needed =====" >> "$LOG"
  exit 0
fi

# Both attempts genuinely failed. Escalate loudly AND leave a marker the next session cannot miss.
AFTER=$(gh release view --json tagName -q .tagName 2>/dev/null || echo "unknown")
# Was `tail -8 | cut -c1-600`. self-update's [FATAL] block is 4+ lines on its own and now carries a
# 'reason:' line per failed repo, so 8 lines / 600 chars truncated the alert mid-argv — every one of
# the six identical 2026-08-03..08-06 failures escalated with no reason in it. Widen enough that the
# whole [FATAL] block, reasons included, reaches the marker file and the push.
TAIL=$(tail -25 "$LOG" | tr '\n' ' ' | cut -c1-2000)
mkdir -p .ruvnet-brain
python3 -c "
import json, datetime
json.dump({
  'at': datetime.datetime.utcnow().isoformat() + 'Z',
  'last_release_tag_observed': '$AFTER',
  'tail': '''$TAIL''',
  'note': 'Nightly failed twice (immediate + 3min retry). Needs a live session to diagnose — see logs/nightly.log.'
}, open('$MARKER', 'w'), indent=2)
"
sh scripts/notify.sh "🔴 Nightly FAILED twice — needs you" "candidate rebuild failed; last release remains $AFTER. Last: $TAIL" urgent "rotating_light"
echo "===== ESCALATED: marker written at $MARKER =====" >> "$LOG"
exit 1
