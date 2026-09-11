#!/bin/sh
# job-heartbeat.sh — wrap a scheduled job so it CANNOT run without leaving proof, and CANNOT fail quietly.
#
# WHY (2026-07-13): every scheduled job on this machine was trusted to report on itself, and they
# didn't. launchd's own exit status is useless as proof — a job that has NEVER RUN reports exit 0,
# identical to one that ran and succeeded. That ambiguity let com.ruvnet.brain-nightly sit unfired
# and look healthy. Per-job good intentions rot; a wrapper cannot forget.
#
# WHY THE WRAPPER, NOT THE CHILD, WRITES THE TERMINAL RECORD (2026-09-11 review correction): a
# SIGKILLed child cannot write its own outcome — no handler runs, by definition. So this script never
# asks the wrapped command to self-report; the WRAPPER is the supervisor. It writes "running" before
# the child starts, watches it via `wait`, and derives the terminal record (ok / failed / killed)
# from the child's OWN wait status — the one piece of truth a dying child cannot fake or withhold.
#
# Usage (from a LaunchAgent's ProgramArguments):
#   /bin/sh /path/to/job-heartbeat.sh <label> -- <command> [args...]
#
# Guarantees:
#   1. A "start" receipt is written BEFORE the command runs, carrying a `run_id` unique to THIS
#      invocation (pid + start-epoch). A second, concurrent invocation for the same label gets its
#      own run_id and overwrites the "running" record with its own — see the STALE WRITER GUARD
#      below for what that means for the terminal write.
#   2. A terminal receipt is written even if the command dies, is killed, or the machine yanks it
#      away — the trap fires on EXIT/INT/TERM. Its `state` is one of:
#        ok      — exited zero.
#        failed  — exited non-zero, NOT via a signal (POSIX: an exit code in 1..128).
#        killed  — died to a signal (POSIX: `wait` reports 128+signal for a signal-killed child, and
#                  the two in-wrapper traps below reuse that exact convention for TERM/INT delivered
#                  to the WRAPPER itself). The signal number is carried as `"signal"`.
#      SIGKILL (-9) of the WRAPPER itself is the one death nothing here can catch — no handler runs,
#      the receipt is left stuck at "running" with its run_id, and that is deliberately NOT
#      "fixed" here: scripts/nightly-watchdog.mjs already derives FAILING from a stale receipt whose
#      pid no longer exists (see its `judge()` — this is the "started and never finished" case,
#      because a run_id can never reach a terminal state if nothing survived to write one).
#   3. STALE WRITER GUARD: before writing the terminal record, the wrapper re-reads the on-disk
#      receipt's run_id. If some OTHER, newer invocation has since overwritten it (a different
#      run_id — meaning a fresh "running" record was written after this one), this process's
#      terminal write is REFUSED. An old, dying writer must never clobber a newer run's evidence
#      with its own stale outcome; the newer run owns the receipt and will write its own terminal
#      record when it finishes.
#   4. A non-zero exit pushes an URGENT ntfy alert immediately (topic: $NTFY_TOPIC, or the file
#      ~/.cache/ruvnet-brain/ntfy-topic). No topic = no push, but the receipt is still written.
#   5. The wrapper's own exit code is the job's exit code — launchd still sees the truth.

set -u

LABEL="${1:?usage: job-heartbeat.sh <label> -- <command...>}"
shift
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "job-heartbeat: no command given for $LABEL" >&2; exit 2; }

HB_DIR="${JOB_HEARTBEAT_DIR:-$HOME/.cache/ruvnet-brain/heartbeats}"
mkdir -p "$HB_DIR"
HB="$HB_DIR/$LABEL.json"

# Atomic write: tmp file (same filesystem) + rename. `cat > "$HB"` directly would let a concurrent
# reader (nightly-watchdog.mjs, or another job-heartbeat.sh instance's stale-writer check) observe a
# half-written file mid-write and fail to parse it — a real, if rare, race under load. `mv` on the
# same filesystem is a single rename() syscall: readers see either the old content or the new, never
# a partial file.
write_receipt() { # write_receipt <content>
  tmp="$HB.tmp-$$"
  printf '%s' "$1" > "$tmp" && mv -f "$tmp" "$HB"
}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
STARTED="$(ts)"
START_EPOCH="$(date +%s)"
# RUN_ID: pid + start-epoch-second. Unique enough to tell "this invocation" apart from any other
# invocation of the SAME label that might be alive at the same time — a second's collision would
# also require a recycled pid inside that same second, which the OS does not do.
RUN_ID="$$-$START_EPOCH"

# F3 (2026-07-18): remember the receipt as it was BEFORE this fire. A skip-fire (exit 75, the
# reserved "another instance is already running" code) must not destroy the live run's evidence —
# its finish() RESTORES this snapshot instead of overwriting the receipt with a meaningless "ok/0s".
# Without this, a skip stamped state:"ok" over a real run's "running", and if that real run was then
# SIGKILLed, the watchdog's started-and-never-finished detection had nothing left to see.
PREV_HB=""
[ -f "$HB" ] && PREV_HB="$(cat "$HB" 2>/dev/null)"

# Start receipt. If the job vanishes without ever writing an end receipt, THIS is the evidence that
# it started and never finished — a state the watchdog reports as FAILING, not as silence.
write_receipt "{\"label\":\"$LABEL\",\"started_at\":\"$STARTED\",\"state\":\"running\",\"pid\":$$,\"run_id\":\"$RUN_ID\",\"command\":\"$(echo "$@" | sed 's/"/\\"/g')\"}"

notify() { # notify <title> <body> <priority>
  # NTFY_TOPIC set-but-EMPTY is an explicit opt-out (2026-07-18): unit tests wrap this script around
  # deliberately-failing fixture commands (t-fail, t.bad, exit 7), and the topic-file fallback below
  # meant every test run PAGED Stuart's real phone — 16+ fixture pages in one morning, indistinguishable
  # from real job failures. Tests set NTFY_TOPIC="" and stay silent; production (unset) still falls
  # through to the topic file.
  if [ "${NTFY_TOPIC+set}" = "set" ] && [ -z "$NTFY_TOPIC" ]; then return 0; fi
  topic="${NTFY_TOPIC:-}"
  [ -z "$topic" ] && [ -f "$HOME/.cache/ruvnet-brain/ntfy-topic" ] && topic="$(cat "$HOME/.cache/ruvnet-brain/ntfy-topic")"
  [ -z "$topic" ] && return 0
  curl -sS -m 10 -H "Title: $1" -H "Priority: $3" -H "Tags: rotating_light" -d "$2" "https://ntfy.sh/$topic" >/dev/null 2>&1 || true
}

# The run_id currently on disk for this label, or empty if the receipt is missing/unreadable/has
# none (an old receipt written before this field existed). No jq dependency — one anchored sed.
current_run_id() {
  sed -n 's/.*"run_id":"\([^"]*\)".*/\1/p' "$HB" 2>/dev/null | head -1
}

finish() {
  code=${FORCED_CODE:-$?}
  ended="$(ts)"
  dur=$(( $(date +%s) - START_EPOCH ))
  # Exit 75 = SKIP (lock held by a live run). Restore the pre-fire receipt so the live run's evidence
  # survives; report 0 to launchd (a skip is not a failure). If no receipt ever existed, record an
  # honest "skipped" — which the watchdog treats as NOT proof of a real run.
  if [ "$code" -eq 75 ]; then
    if [ -n "$PREV_HB" ]; then write_receipt "$PREV_HB"; else
      write_receipt "$(printf '{"label":"%s","started_at":"%s","ended_at":"%s","state":"skipped","duration_sec":%s,"run_id":"%s"}' "$LABEL" "$STARTED" "$ended" "$dur" "$RUN_ID")"
    fi
    exit 0
  fi
  # STALE WRITER GUARD: a newer invocation for this same label may have already taken the receipt
  # over (its own "running" record carries a DIFFERENT run_id). If so, this process's outcome is
  # stale — it must not overwrite evidence that belongs to a run that is still, or already, ahead of
  # it. Say so on stderr (so it is not a silent no-op) and exit with the real code regardless.
  ON_DISK_RUN_ID="$(current_run_id)"
  if [ -n "$ON_DISK_RUN_ID" ] && [ "$ON_DISK_RUN_ID" != "$RUN_ID" ]; then
    echo "job-heartbeat: $LABEL receipt now belongs to run $ON_DISK_RUN_ID — not overwriting it with stale run $RUN_ID (exit $code)" >&2
    exit "$code"
  fi
  # Derive ok / failed / killed from the CHILD'S OWN wait status, never from anything the child said
  # about itself. POSIX: a process terminated by signal N is reported by `wait`/`$?` as 128+N — the
  # same convention this wrapper's own TERM/INT traps below use when THEY are what killed the child.
  if [ "$code" -eq 0 ]; then
    state="ok"; extra=""
  elif [ "$code" -gt 128 ]; then
    sig=$((code - 128))
    state="killed"; extra=",\"signal\":$sig"
  else
    state="failed"; extra=""
  fi
  write_receipt "{\"label\":\"$LABEL\",\"started_at\":\"$STARTED\",\"ended_at\":\"$ended\",\"state\":\"$state\",\"exit_code\":$code,\"duration_sec\":$dur,\"run_id\":\"$RUN_ID\"$extra}"
  # Gong on failure, immediately — not at the next watchdog sweep. A failing nightly should reach the
  # phone while it is still tonight's problem.
  if [ "$code" -ne 0 ]; then
    notify "🔴 SCHEDULED JOB FAILED: $LABEL" "exit $code after ${dur}s — see the job's log. Receipt: $HB" "urgent"
  fi
  exit "$code"
}
trap finish EXIT
# A signal handler must KILL THE CHILD, then exit — letting the EXIT trap write the receipt once.
# The exit codes (143 = 128+15 TERM, 130 = 128+2 INT) intentionally reuse the same 128+signal
# convention `wait` uses for a directly-signalled child, so finish() classifies BOTH as "killed"
# with the right signal number, whether the signal reached the child directly or via this wrapper.
trap 'FORCED_CODE=143; kill -TERM "$CHILD" 2>/dev/null; exit 143' TERM
trap 'FORCED_CODE=130; kill -TERM "$CHILD" 2>/dev/null; exit 130' INT

# Run the job in the BACKGROUND and `wait` for it — do NOT run it in the foreground.
# Break-test finding (2026-07-13): a POSIX shell blocked on a FOREGROUND child does not run its trap
# when signalled — it dies with the receipt still saying "running", which is precisely the silent
# death this wrapper exists to prevent. `wait` is interruptible, so the trap fires immediately.
# The one death nothing can catch is SIGKILL (-9) / power loss, by definition: no handler runs. That
# case is caught one level up — nightly-watchdog.mjs reports a receipt stuck in "running" as FAILING
# ("started and never finished"). Trap for catchable deaths, watchdog for uncatchable ones.
"$@" &
CHILD=$!
wait "$CHILD"
