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
# The failing streak and the last page time ride in EVERY receipt, including "running" (4.7.21): a run that is
# SIGKILLed mid-streak must not erase them, or the next failure would page as a brand-new streak.
field_str() { printf '%s' "$PREV_HB" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
field_num() { printf '%s' "$PREV_HB" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -1; }
prev_state="$(field_str state)"
prev_since="$(field_str failing_since)"
prev_page_epoch="$(field_num last_page_epoch)"
prev_page_at="$(field_str last_page_at)"
prev_paged="$(printf '%s' "$PREV_HB" | sed -nE 's/.*"paged":("[a-z]*"|true|false).*/\1/p' | head -1)"
CARRY=""
[ -n "$prev_page_epoch" ] && CARRY="$CARRY,\"last_page_epoch\":$prev_page_epoch"
[ -n "$prev_page_at" ] && CARRY="$CARRY,\"last_page_at\":\"$prev_page_at\""
case "$prev_state" in failed|killed|running)
  [ -n "$prev_since" ] && CARRY="$CARRY,\"failing_since\":\"$prev_since\""
  [ -n "$prev_since" ] && [ -n "$prev_paged" ] && CARRY="$CARRY,\"paged\":$prev_paged" ;;
esac

# Start receipt. If the job vanishes without ever writing an end receipt, THIS is the evidence that
# it started and never finished — a state the watchdog reports as FAILING, not as silence.
write_receipt "{\"label\":\"$LABEL\",\"started_at\":\"$STARTED\",\"state\":\"running\",\"pid\":$$,\"run_id\":\"$RUN_ID\",\"command\":\"$(printf '%s %s' "$1" "${2:-}" | tr -d '"\\\n\r' | cut -c1-200)\"$CARRY}"

notify() { # notify <title> <body> <priority> — 0 delivered · 1 not delivered · 2 paging disabled (opt-out)
  # NTFY_TOPIC set-but-EMPTY is an explicit opt-out (2026-07-18): unit tests wrap this script around
  # deliberately-failing fixture commands (t-fail, t.bad, exit 7), and the topic-file fallback below
  # meant every test run PAGED Stuart's real phone — 16+ fixture pages in one morning, indistinguishable
  # from real job failures. Tests set NTFY_TOPIC="" and stay silent; production (unset) still falls
  # through to the topic file. An opt-out is NOT a delivered page: it returns 2 and the receipt records
  # "paged":"disabled", never true (4.7.21).
  if [ "${NTFY_TOPIC+set}" = "set" ] && [ -z "$NTFY_TOPIC" ]; then return 2; fi
  topic="${NTFY_TOPIC:-}"
  [ -z "$topic" ] && [ -f "$HOME/.cache/ruvnet-brain/ntfy-topic" ] && topic="$(cat "$HOME/.cache/ruvnet-brain/ntfy-topic")"
  [ -z "$topic" ] && return 1
  # --fail: an HTTP error is a failed delivery. The caller records whether the page landed, so a page that
  # never arrived is retried on the next run instead of muting the whole failing streak (review 2026-10-25).
  curl -sS --fail -m 10 -H "Title: $1" -H "Priority: $3" -H "Tags: ${4:-rotating_light}" -d "$2" "${NTFY_URL:-https://ntfy.sh}/$topic" >/dev/null 2>&1
}

# The run_id currently on disk for this label, or empty if the receipt is missing/unreadable/has
# none (an old receipt written before this field existed). No jq dependency — one anchored sed.
current_run_id() {
  sed -n 's/.*"run_id":"\([^"]*\)".*/\1/p' "$HB" 2>/dev/null | head -1
}

finish() {
  code=${FORCED_CODE:-$?}
  # Stop the run-time timer FIRST, on every exit path (skip, stale writer, normal), so it can never outlive
  # this wrapper (Opus review 2026-10-25).
  [ -n "${TIMER:-}" ] && kill "$TIMER" 2>/dev/null
  timed_out=0
  if [ -f "$HB.timeout-$RUN_ID" ]; then
    # Anything the overrunning job left behind (started during its TERM handling, say) goes now.
    timed_out=1; stop_job
  fi
  # Always, on every exit path: the timer may have written the marker after the check above (4.7.21).
  rm -f "$HB.timeout-$RUN_ID"
  # An overrun is a failure however the job chose to exit on TERM, including 0 and 75 (the skip code), so this
  # comes before the skip branch (GPT-6.1 review round 2).
  [ "$timed_out" -eq 1 ] && [ "$code" -le 128 ] && code=143
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
    [ "$timed_out" -eq 1 ] && extra="$extra,\"timed_out_after_sec\":$MAX_SECONDS"
  else
    state="failed"; extra=""
  fi
  # PAGE ON THE TRANSITION, NOT ON EVERY RUN (owner, 2026-10-25: 10,747 notifications on one topic). A job that
  # starts failing pages once, urgently, while it is still tonight's problem; while it KEEPS failing it stays
  # quiet (failing_since carries the first failure; the nightly watchdog's digest still lists it); the run
  # that passes again sends one low-priority "recovered" note — only if that streak was actually paged.
  # FLAP DAMPING (4.7.21): a NEW streak within 6 h of the last delivered page is recorded "paged":"suppressed"
  # instead of paging (4 fail/ok cycles were 8 notifications). A suppressed streak still failing after 6 h pages.
  # A prior "running" receipt that carries failing_since (a SIGKILLed run) continues its streak.
  was_failing=0
  case "$prev_state" in failed|killed) was_failing=1 ;; running) [ -n "$prev_since" ] && was_failing=1 ;; esac
  # A failing streak counts as already paged only if that page was PROVEN delivered ("paged":true). false (retry),
  # "suppressed", "disabled", or a receipt from before this field existed are paged (again) when allowed.
  prev_unpaged=1; [ "$prev_paged" = "true" ] && prev_unpaged=0
  QUIET_SECONDS=21600
  now_epoch="$(date +%s)"
  page_epoch="$prev_page_epoch"; page_at="$prev_page_at"
  since=""
  if [ "$code" -ne 0 ]; then
    if [ "$was_failing" -eq 1 ] && [ -n "$prev_since" ]; then since="$prev_since"; else since="$STARTED"; fi
    extra="$extra,\"failing_since\":\"$since\""
  fi
  if [ "$code" -ne 0 ] && { [ "$was_failing" -eq 0 ] || [ "$prev_unpaged" -eq 1 ]; }; then
    if [ -n "$prev_page_epoch" ] && [ $((now_epoch - prev_page_epoch)) -lt "$QUIET_SECONDS" ] \
       && ! { [ "$was_failing" -eq 1 ] && [ "$prev_paged" = "false" ]; }; then
      # Inside the quiet window. (A streak whose own page simply failed to deliver is retried, not damped.)
      extra="$extra,\"paged\":\"suppressed\""
    else
      reason="exit $code after ${dur}s"; [ "$timed_out" -eq 1 ] && reason="stopped after running past its ${MAX_SECONDS}s limit"
      notify "SCHEDULED JOB FAILED: $LABEL" "$reason — see the job's log. Receipt: $HB. Further failures stay quiet until it recovers." "urgent"
      rc=$?
      if [ "$rc" -eq 0 ]; then
        extra="$extra,\"paged\":true"; page_epoch="$now_epoch"; page_at="$(ts)"
      elif [ "$rc" -eq 2 ]; then extra="$extra,\"paged\":\"disabled\""
      else extra="$extra,\"paged\":false"; fi
    fi
  elif [ "$code" -ne 0 ]; then
    extra="$extra,\"paged\":true"
  elif [ "$was_failing" -eq 1 ] && [ "$prev_paged" = "true" ]; then
    notify "Recovered: $LABEL" "passed again after failing since ${prev_since:-an earlier run}" "low" "white_check_mark" || true
  fi
  [ -n "$page_epoch" ] && extra="$extra,\"last_page_epoch\":$page_epoch"
  [ -n "$page_at" ] && extra="$extra,\"last_page_at\":\"$page_at\""
  write_receipt "{\"label\":\"$LABEL\",\"started_at\":\"$STARTED\",\"ended_at\":\"$ended\",\"state\":\"$state\",\"exit_code\":$code,\"duration_sec\":$dur,\"run_id\":\"$RUN_ID\"$extra}"
  exit "$code"
}
trap finish EXIT
# A signal handler must KILL THE CHILD, then exit — letting the EXIT trap write the receipt once.
# The exit codes (143 = 128+15 TERM, 130 = 128+2 INT) intentionally reuse the same 128+signal
# convention `wait` uses for a directly-signalled child, so finish() classifies BOTH as "killed"
# with the right signal number, whether the signal reached the child directly or via this wrapper.
# The job stays in this wrapper's process group, so launchd's own cleanup of a dead job (it kills the job's whole
# group) still covers everything, even if this wrapper is SIGKILLed (Opus review round 3: a separate group escaped it).
# job_pids: every process the job owns. Under launchd this wrapper leads its group, so that is every group member
# except this wrapper, its timer, and this wrapper's own helper processes (ps/awk/command substitutions) — which
# catches processes the job started late or that were reparented. Run any other way (a terminal, a test harness),
# it falls back to the job's current process tree.
OWN_GROUP=0; [ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$$" ] && OWN_GROUP=1
job_pids() {
  if [ "$OWN_GROUP" = 1 ]; then
    ps -A -o pid= -o ppid= -o pgid= 2>/dev/null | awk -v me=$$ -v t="${TIMER:-0}" -v c="${CHILD:-0}" '
      { pid[NR]=$1; pp[NR]=$2; pg[NR]=$3 }
      END { helper[t]=1
            for (i=1;i<=NR;i++) if (pp[i]==me && pid[i]!=c) helper[pid[i]]=1
            for (i=1;i<=NR;i++) if (pg[i]==me && pid[i]!=me && !(pid[i] in helper) && !(pp[i] in helper)) print pid[i] }'
  else
    tree_of "$CHILD"
  fi
}
tree_of() { kill -0 "$1" 2>/dev/null && printf '%s ' "$1"
  for k in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$1" '$2==p {print $1}'); do tree_of "$k"; done; }
# stop_job: TERM everything the job owns, give it up to 10 s (inside launchd's 20 s exit allowance), then KILL.
# Every pid seen during the stop is remembered, so a descendant that outlives its parent (and so drops out of the
# process tree in the fallback mode) still gets the final KILL. The full guarantee, including processes started
# later, holds when this wrapper leads its group, as under launchd.
stop_job() {
  seen="$(job_pids)"; [ -n "$seen" ] && kill -TERM $seen 2>/dev/null
  i=0; while [ "$i" -lt 10 ]; do
    now_pids="$(job_pids)"; seen="$seen $now_pids"
    alive=""; for p in $seen; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && return 0
    sleep 1; i=$((i + 1))
  done
  for p in $seen $(job_pids); do kill -KILL "$p" 2>/dev/null; done
  return 0
}
trap 'FORCED_CODE=143; [ -n "${TIMER:-}" ] && kill "$TIMER" 2>/dev/null; stop_job; exit 143' TERM
trap 'FORCED_CODE=130; [ -n "${TIMER:-}" ] && kill "$TIMER" 2>/dev/null; stop_job; exit 130' INT
# The timer never kills anything itself: it marks the overrun and signals this wrapper, which stops the job.
OVERRUN=0
trap 'OVERRUN=1' USR1

# Run the job in the BACKGROUND and `wait` for it — do NOT run it in the foreground.
# Break-test finding (2026-07-13): a POSIX shell blocked on a FOREGROUND child does not run its trap
# when signalled — it dies with the receipt still saying "running", which is precisely the silent
# death this wrapper exists to prevent. `wait` is interruptible, so the trap fires immediately.
# The one death nothing can catch is SIGKILL (-9) / power loss, by definition: no handler runs. That
# case is caught one level up — nightly-watchdog.mjs reports a receipt stuck in "running" as FAILING
# ("started and never finished"). Trap for catchable deaths, watchdog for uncatchable ones.
"$@" &
CHILD=$!
# RUN-TIME LIMIT (2026-10-25: five jobs finished their work and then never exited, each holding its own
# next run off for 7-9 hours). After JOB_MAX_SECONDS (default 2 h; a plist may set less) the job is
# stopped: TERM, then KILL 10 s later. It is recorded as killed and pages once like any other failure.
MAX_SECONDS="${JOB_MAX_SECONDS:-7200}"
WRAPPER_PID=$$
case "$MAX_SECONDS" in ''|*[!0-9]*) MAX_SECONDS=7200 ;; esac
[ "$MAX_SECONDS" -lt 2 ] && MAX_SECONDS=2
(
  # Short sleeps, not one long one: killing this shell then leaves at most a 2 s sleep behind, never a 2 h one
  # holding the job's output open (review round 2).
  # A wrapper that is gone (SIGKILLed: launchd then cleans the group itself) ends the timer at the next tick.
  n=0; while [ "$n" -lt "$MAX_SECONDS" ]; do sleep 2; n=$((n + 2)); kill -0 "$WRAPPER_PID" 2>/dev/null || exit 0; done
  # Only for OUR child: still alive and still parented by this wrapper. If the PID was reused, do nothing.
  [ "$(ps -o ppid= -p "$CHILD" 2>/dev/null | tr -d ' ')" = "$WRAPPER_PID" ] || exit 0
  : > "$HB.timeout-$RUN_ID"
  kill -USR1 "$WRAPPER_PID" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
TIMER=$!
# `wait` returns early when USR1 arrives; stop the job, then wait again for its real exit status.
while :; do
  if [ "$OVERRUN" = 1 ]; then OVERRUN=0; stop_job; fi
  wait "$CHILD"; RC=$?
  if [ "$OVERRUN" = 1 ]; then OVERRUN=0; stop_job; continue; fi
  break
done
exit "$RC"
