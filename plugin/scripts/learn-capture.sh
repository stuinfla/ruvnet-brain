#!/bin/bash
# learn-capture.sh — PostToolUse (Write|Edit|Bash). Appends ONE compact step to this session's learning
# queue. A session is a trajectory (task -> steps -> outcome); learn-flush.mjs feeds the queue to the
# GLOBAL SONA learner at SessionEnd, so "how you work" accumulates per-user across ALL projects — while
# project FACTS stay in each project's .swarm/memory.db, never here. We record the workflow ACTION (a
# command verb, a file's basename), never file CONTENT or secrets. ADR-0017.
#
# CONTRACT: PostToolUse is non-blocking — always exit 0, swallow every failure, no process spawn (fast).

set -uo pipefail

# One policy source for both capture and flush. `off` means zero bytes written. `project` keeps the
# trajectory queue under this project's .swarm directory; `user` preserves the cross-project learner
# introduced by ADR-0017. Tests and managed hosts may pass an already-resolved snapshot in
# RUVNET_LEARNING_SCOPE so the two halves cannot disagree during one hook invocation.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
SCOPE="${RUVNET_LEARNING_SCOPE:-}"
# CONFIGURED vs DEFAULTED, and this must be captured BEFORE the preferences fallback below.
#
# `project` is the DEFAULT scope, and `runtime-preferences.mjs --learning-scope` RESOLVES it —
# measured 2026-08-19 against an empty config root, it returns "project", not "". So after the
# fallback runs, an explicit opt-in and a bare default are indistinguishable. The first version of
# this guard read SCOPE afterwards and was therefore always "configured", which let the
# stranger-project mutation straight back in.
#
# The env var is the one signal that is unambiguously explicit: nothing sets it by default. A
# project that opted in through the console instead is still covered by the `.swarm` clause below,
# because adopting Ruflo's convention is itself the opt-in.
SCOPE_CONFIGURED=0
[ -n "$SCOPE" ] && SCOPE_CONFIGURED=1
if [ -z "$SCOPE" ] && [ -f "$HERE/runtime-preferences.mjs" ] && command -v node >/dev/null 2>&1; then
  SCOPE=$(node "$HERE/runtime-preferences.mjs" --learning-scope 2>/dev/null) || SCOPE=""
fi
case "$SCOPE" in
  off) exit 0 ;;
  user|project) ;;
  *) SCOPE="project" ;;
esac

# BOUNDED READ. An unqualified `read` waits forever on a stdin that is opened and never closed, and
# an unbounded accumulator turns a large payload into an unbounded regex scan. Claude Code always
# writes the payload and closes, so neither costs a normal turn — which is exactly why a hook that
# CAN hang survives: the only thing ending it is a timeout owned by someone else. -t 2 is ~40x a real
# payload's delivery time; the size cap is ~30x the largest real payload. The trailing `[ -n "$_l" ]`
# keeps the final unterminated line, which is what the original `||` clause was for.
INPUT=""
while IFS= read -r -t 2 _l; do
  INPUT+="$_l"
  [ ${#INPUT} -ge 65536 ] && break
done
# Truncate the ASSEMBLED string, not just each iteration: a hook payload is one line with no trailing
# newline, so `read` hands back the whole thing at once in $_l and the in-loop cap never fires.
[ -n "$_l" ] && INPUT+="$_l"
INPUT="${INPUT:0:65536}"
[ -n "$INPUT" ] || exit 0

TOOL=""
re_t='"tool_name"[[:space:]]*:[[:space:]]*"([^"]*)"'
[[ $INPUT =~ $re_t ]] && TOOL="${BASH_REMATCH[1]}"
[ -n "$TOOL" ] || exit 0

ACTION=""
case "$TOOL" in
  Bash)
    # Capture the VERB CHAIN ONLY — "git push", "npm test", "npx vercel" — never the arguments.
    #
    # This previously took the first 120 chars up to an embedded quote and called that "verb, not
    # facts". It wasn't. Unquoted inline secrets were captured in full and written to disk, proven
    # by test: `export AWS_SECRET_ACCESS_KEY=wJalr... && psql postgres://admin:Hunter2Pass@db/prod`
    # landed verbatim in session-*.jsonl, and from there fed the global learner. Real command lines
    # routinely carry API keys, DB URLs with inline passwords, and internal hostnames — on a
    # corporate laptop the hostnames alone are a DLP finding.
    #
    # Now: keep at most the first two tokens, and stop at the first token that carries DATA rather
    # than INTENT (contains = / @ : , is a flag, or is improbably long). "export FOO=secret" records
    # "export"; "cd /Users/me/ClientProject" records "cd". The learner only ever needed the verb.
    # THE CAPTURE WAS MANGLED, and the mangling was invisible (fixed 2026-07-27).
    #
    # `"command"…"([^"]*)"` cannot cross a JSON-escaped quote — the exact bug hook-input.mjs exists to
    # end — so `cd "/tmp/some dir"` captured the two bytes `cd \`, and that trailing backslash then
    # broke the JSON line it was printed into. Measured on the owner's live queue:
    #
    #     {"tool":"Bash","action":"cd \"}      ← JSON.parse: Unterminated string at position 31
    #
    # learn-flush drops every unparseable line with a bare `continue`, so the capture reported success,
    # the queue grew, and the learner received nothing. A pipe severed in the middle while both ends
    # report health is this project's signature failure mode.
    #
    # The fix is to stop at the first quote OR backslash and take a PREFIX — no closing-quote anchor,
    # because the first two tokens are all this hook ever wanted. A command that opens with a quoted
    # path yields an empty prefix and is simply not captured, which is strictly better than writing a
    # line that cannot be read back.
    re_c='"command"[[:space:]]*:[[:space:]]*"([^"\]*)'
    if [[ $INPUT =~ $re_c ]]; then
      set -f                      # no globbing while we word-split untrusted text
      _n=0
      for _tok in ${BASH_REMATCH[1]}; do
        case "$_tok" in
          *=*|*/*|*@*|*:*|-*) break ;;
        esac
        [ ${#_tok} -gt 24 ] && break
        ACTION="${ACTION:+$ACTION }$_tok"
        _n=$((_n + 1))
        [ "$_n" -ge 2 ] && break
      done
      set +f
    fi
    ;;
  Write|Edit|MultiEdit)
    re_f='"file_path"[[:space:]]*:[[:space:]]*"([^"]*)"'
    [[ $INPUT =~ $re_f ]] && ACTION="edit ${BASH_REMATCH[1]##*/}"   # basename only — no full path
    ;;
esac
[ -n "$ACTION" ] || exit 0

# THE SESSION ID IS IN THE PAYLOAD WE ALREADY READ — and it was being thrown away.
#
# This read `${CLAUDE_SESSION_ID:-default}`, an env var Claude Code does not set, so EVERY session on
# a machine appended to one shared `session-default.jsonl`. Measured on the owner's machine
# 2026-07-27: one file, 147 lines deep, written concurrently by several live sessions — the same
# many-writers-one-path shape as ADR-050, and it makes "this session's trajectory" a fiction, because
# the queue is a blend of every session that happened to be open.
#
# `session_id` is a field on the very payload this hook already parsed. Prefer it; fall back to the
# env var; then to 'default'. SANITISED before it becomes a filename component: the payload is
# untrusted input, and `session_id` reaching an unfiltered path join is a traversal waiting to happen.
SID=""
re_s='"session_id"[[:space:]]*:[[:space:]]*"([^"\]*)"'
[[ $INPUT =~ $re_s ]] && SID="${BASH_REMATCH[1]}"
[ -n "$SID" ] || SID="${CLAUDE_SESSION_ID:-}"
# Dots are dropped along with everything else outside this set: real session ids are uuids, and
# keeping `.` would let a crafted id survive as `..`-shaped debris in a filename for no benefit.
SID="${SID//[^A-Za-z0-9_-]/}"           # a filename COMPONENT, never a path
[ -n "$SID" ] || SID="default"
if [ "$SCOPE" = "user" ]; then
  DIR="$HOME/.cache/ruvnet-brain/learn"
else
  # ISSUE #134 — THE SAME PROJECT ROOT THE READER COMPUTES, BY THE SAME RULE.
  #
  # This was bare `$PWD` while learn-flush.mjs:26 and health-repair.mjs:32 both resolve
  # `RUVNET_BRAIN_PROJECT_DIR || cwd`. This hook is wired on PostToolUse, so it runs after EVERY tool
  # call — and any command that leaves the shell below the project root (a test run, a build, any
  # tooling that cd's) made the WRITER create a queue in a directory the READER never looks in. Those
  # events are not misfiled, they are orphaned: nothing ever drains them.
  #
  # This is issue #104's residual. #104 fixed the two halves of the FLUSH to agree about which project
  # they mean; the component that actually creates the queue was not brought along, so the invariant
  # held for two of three participants and was violated by the one doing the writing. Same shape as
  # ADR-066: a writer and a reader that disagree about the store make the recording theatre.
  DIR="${RUVNET_BRAIN_PROJECT_DIR:-$PWD}/.swarm/ruvnet-brain-learn"
fi
# PROJECT SCOPE MEANS THE PROJECT MUST HAVE OPTED IN. In project scope $DIR sits under `.swarm`,
# which is Ruflo's own convention and is created by `ruflo init` — so its PRESENCE is the project's
# opt-in and its ABSENCE is a project that has not adopted the brain. This hook runs machine-wide on
# every PostToolUse, so an unconditional mkdir planted `.swarm/` in EVERY repository the user opened.
# Measured 2026-08-14 by the both-hosts conformance gate in a temp project with no git and no brain
# artifacts; ADR-058 D5 — never touch what we do not own. User scope is unaffected: that queue lives
# under the brain's OWN cache directory, which we do own and may create.
# CREATE THE QUEUE ONLY WHERE THE PROJECT ACTUALLY OPTED IN.
#
# First attempt required an existing `.swarm`, which stopped the stranger-project mutation but ALSO
# broke a legitimate first run: a project that explicitly sets RUVNET_LEARNING_SCOPE=project before
# it has ever captured anything got nothing, and `learning-scope-policy` went red. Presence of
# `.swarm` was the wrong discriminator — it answers "has Ruflo run here", not "did this project ask
# for learning".
#
# The right one is whether the scope was CONFIGURED (env or runtime-preferences) rather than
# inherited from the default. A stranger's repo sets neither, so nothing is created there; a project
# that opted in gets its queue on the very first capture, `.swarm` or not. An existing `.swarm` is
# still honoured on its own, because a repo already carrying Ruflo's convention has plainly adopted it.
case "$DIR" in
  */.swarm/*)
    if [ "$SCOPE_CONFIGURED" != "1" ] && [ ! -d "$(dirname "$DIR")" ]; then exit 0; fi
    ;;
esac
# Owner-only (0700 dir / 0600 file). This queue was 0644 inside a 0755 dir: on macOS every local
# account is normally in `staff`, so any other user on a shared or corporate machine could read it.
( umask 077 && mkdir -p "$DIR" ) 2>/dev/null || exit 0
QUEUE="$DIR/session-$SID.jsonl"
[ -e "$QUEUE" ] || { : > "$QUEUE" 2>/dev/null && chmod 600 "$QUEUE" 2>/dev/null; } || true
printf '{"tool":"%s","action":"%s"}\n' "$TOOL" "${ACTION//\"/\\\"}" >> "$QUEUE" 2>/dev/null || true

# ── HEARTBEAT FLUSH (ADR-027) ────────────────────────────────────────────────────────────────────
# The flush used to fire ONLY on a clean SessionEnd. Sessions compact, crash, get resumed, or are
# killed — none of those reach SessionEnd — so the queue silently grew to 1,884 undelivered events
# over days while the learner sat at 5 trajectories, last trained six days earlier. Draining it took
# the learner to 412/412 in one command. A queue that only empties on a graceful exit will always
# leak; activity itself must be the trigger.
#
# So: every HEARTBEAT_EVERY captures, drain in the BACKGROUND. Detached and fully silent — this runs
# inside a PostToolUse hook and must never add latency to the user's turn or fail one. Cheap check
# (a line count) on the common path; real work only at the threshold.
# LEVEL-TRIGGERED, NOT EDGE-TRIGGERED. This is the whole fix, and the bug it replaces was severe.
#
# The condition used to be `LINES >= 200 && LINES % 200 == 0` — it fired ONLY when the count landed
# exactly on a multiple of 200. Two captures arriving between checks, or any concurrent write,
# steps the counter over the window and the flush NEVER fires again. Measured on the owner's machine
# 2026-07-22: the queue was at 491. It had sailed past both 200 and 400 without draining once, and
# would have grown forever.
#
# The failure mode is the nastiest kind: capture works, the learner works, and the PIPE BETWEEN THEM
# is severed — while every surface honestly reports both ends as healthy. "Is learning on?" had no
# true answer, because learning is not a switch; it is a chain, and one link was open.
#
# `-ge` cannot skip a window. It fires on every capture past the threshold until the queue is
# actually drained, which is the definition of level-triggered: the condition is the QUEUE'S DEPTH,
# not the instant it crossed a line.
HEARTBEAT_EVERY=200
LINES=$(wc -l < "$DIR/session-$SID.jsonl" 2>/dev/null || echo 0)
if [ "$LINES" -ge "$HEARTBEAT_EVERY" ]; then
  # Debounce so a deep queue doesn't spawn a flush on EVERY subsequent capture: at most one drain
  # per minute. Without this, level-triggering trades a stuck queue for a fork storm.
  STAMP="$DIR/.last-flush"
  NOW=$(date +%s)
  LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -ge 60 ]; then
    echo "$NOW" > "$STAMP" 2>/dev/null || true
    FLUSH="$HERE/learn-flush.mjs"
    [ -f "$FLUSH" ] && (RUVNET_LEARNING_SCOPE="$SCOPE" nohup node "$FLUSH" >/dev/null 2>&1 &) || true
  fi
fi
exit 0
