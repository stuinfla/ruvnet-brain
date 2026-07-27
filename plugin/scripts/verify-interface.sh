#!/bin/bash
# verify-interface.sh — PreToolUse gate on Bash. YOU MAY NOT CALL A TOOL YOU HAVE NOT READ THE HELP FOR.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# WHY (2026-07-13). Stuart, furious: "There's zero reason you should be making incorrect calls. You
# have all of the code, all the pointers, all the knowledge. Why are you still so fascinated with
# efficiency that you won't take the split second to check you're making the call the right way?
# EFFECTIVE WINS OVER EFFICIENCY EVERY SINGLE TIME. Stop skipping steps. You are destroying your
# credibility."
#
# He is describing a real, mechanical defect. I reported AgentDB broken THREE TIMES. It was NEVER
# broken:
#   1. I called `ruflo memory search "query"` POSITIONALLY. The CLI wants `-q`. Empty result → I
#      declared the product broken.
#   2. My canary test then "failed" because MY OWN grep filtered the rows out.
#   3. My broken-state test printed nothing because I set the test up wrong.
# Every one was my defect, reported to him as a product defect. Cost: hours of his time and his trust.
#
# THE PRECISE GAP: the brain holds 2GB of rUv's SOURCE. It does NOT hold the runtime interface of a
# compiled npm CLI — `-q` lives in a binary's --help output, not in the indexed corpus. So when I went
# to INVOKE the tool, I typed the interface I ASSUMED existed. I ground FACTS in the brain and never
# ground INTERFACES in the tool.
#
# A rule would not fix this; I ignored rules all night. So: A WALL. You cannot invoke an ecosystem
# CLI's subcommand until you have actually read its --help in the last 24h. Five seconds, enforced.
#
# CONTRACT: exit 0 = allow · exit 2 + stderr = BLOCK (stderr returns to the model as the reason).
# FAILS OPEN on anything it cannot parse — a gate that breaks your shell is worse than the bug.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
#
# FIX (2026-07-16, issues #12 and #13 — reported by github.com/sparkling, a real user this gate
# blocked mid-session, including a git commit).
#
# #13 — the payload was parsed with a bash regex: field() { local re="\"$1\"[[:space:]]*:[[:space:]]*
# \"([^\"]*)\""; ... }. `([^"]*)` cannot cross a `"`, and a JSON-escaped quote (`\"`) still contains a
# literal `"` byte in the raw text — so any command with an embedded quote was silently truncated at
# the first one. That cuts both ways: real invocations wrapped in an outer quote became invisible to
# the gate (false negative — the exact call this gate exists to catch sailed through unchecked), and
# a truncated fragment happening not to match made a broken check look like a passing one. Fixed by
# parsing with an actual JSON parser (node -e, piped stdin) instead of a regex — JSON string escaping
# is not a regular language, no regex fixes this. Fails open (exit 0) if node is missing or the parse
# throws.
#
# #12 — two further defects, now fixed:
#   1. `[@a-z0-9.-]*` after the tool name (meant only to absorb `@latest`) also absorbed an arbitrary
#      hyphenated suffix, so a DIFFERENT binary — `ruflo-source-patch`, `ruflo-adr-reindex.sh` — was
#      misread as `ruflo` with a bogus subcommand, and demanded `--help` for a command that doesn't
#      exist. And because the match was unanchored, it fired on ordinary prose that happened to
#      contain a tool's name (a git commit message body). Fixed: the version suffix now requires an
#      explicit `@`, and matching is anchored to actual command position (start of the command, or
#      right after a shell separator — `;`, `&`, `|`, `(`, newline — optionally through an `npx `
#      wrapper) instead of anywhere a substring happens to appear. Prose that merely *mentions* a
#      tool's name — inside a quoted string, a commit message, an echo argument — is not at command
#      position and no longer matches.
#   2. The documented override, `RUVNET_SKIP_INTERFACE_CHECK=1`, was read from the HOOK PROCESS's own
#      environment. A PreToolUse hook receives the proposed command as JSON on stdin and never
#      executes it, so setting the variable the way the message instructed — on the command itself —
#      had no effect on this process at all. The escape hatch was unreachable from the side told to
#      use it. Fixed: the command STRING is now checked for a `RUVNET_SKIP_INTERFACE_CHECK=1` token,
#      which is what a caller can actually do. (The old env-var check is kept too, for a genuinely
#      different, valid use: a persistent opt-out set in the shell that launches Claude Code itself —
#      but that is a session-wide switch, not the documented per-command override.)
# ─────────────────────────────────────────────────────────────────────────────────────────────────
#
# FIX (2026-07-24, issue #41, residual of #12 — reported by github.com/sparkling, design + reference
# implementation supplied verbatim in the issue).
#
# #12's "command position" anchor — `(^|[;&|(${NL}])` — was matched against the RAW command with no
# awareness of shell quoting: a `|`, `;`, `&`, `(`, or newline INSIDE a quoted string (a grep pattern's
# regex alternation, an awk program, a `git commit -m` message) reads as a real shell separator, so
# whatever follows is misread as command position. `grep -E "foo|ruflo init" file.txt` blocked on an
# ordinary read-only search. That was fixed by matching a quote-masked SKELETON of the command rather
# than the raw string — and the skeleton is now gone too, replaced by the classifier described below.
# The invariant it won survives verbatim: a separator inside quotes is CONTENT, and the tool name
# after it is an ARGUMENT, not command position.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
#
# FIX (2026-07-27, issue #44 — github.com/sparkling's FOURTH report on this one file (#12, #13, #41,
# #44), and the mirror image of #41: that was a false POSITIVE, this is a false NEGATIVE in the very
# same matcher. Four reports on one gate is the signal ADR-055/#48 acts on, so the count is kept
# accurate deliberately rather than rounded down.)
#
# #41's skeleton was right, and it opened a hole. A DEFINITE invocation nested inside a literal shell
# payload, a backtick substitution, or a `$( … )` inside double quotes is *inside quotes* — so the
# skeleton masked it away and the gate never saw it. All three of these were ALLOWED while the
# identical bare command BLOCKED:
#     bash -lc 'ruflo memory search -q x'
#     x=`ruflo memory search -q x`
#     printf '%s\n' "$(ruflo memory search -q x)"
# (`x=$(ruflo …)` unquoted blocked only by luck: `$(`'s paren happens to be in the command-position
# anchor class. Wrap it in double quotes and the same call walked straight through.) A nested
# invocation is an invocation — `bash -lc 'ruflo memory search -q x'` guesses at exactly the flags
# this wall exists to stop me guessing at.
#
# WHAT ACTUALLY CHANGED, AND WHY IT IS NOT A FIFTH PATCH. Masking-then-matching was still a STRING
# question asked about a STRUCTURAL fact, and every previous fix was another turn of that screw: a
# better anchor (#12), a real JSON parse (#13), a better mask (#41). The mask is deleted. This gate no
# longer looks at the command string to decide what is being invoked at all. hook-input.mjs
# (ADR-0021's one shared module) now parses the command into EXECUTABLE COMMAND NODES —
# `commandNodes()` returning `{ exe, argv, assigns, dynamic }` per node — and this gate asks it one
# question through the `invocations` verb: is any managed tool in EXECUTABLE POSITION anywhere in
# here? Everything below operates on already-split argv tokens; no pattern is ever applied to $CMD
# again (the single remaining `=~` is the fail-OPEN opt-out token, and it is labelled where it sits).
#
# WHAT THE PARSER TREATS AS A COMMAND, AND WHAT AS DATA — this is the whole discipline, and it is what
# keeps the fix from re-creating #41:
#   • Pipelines, `;`, `&&`, `||`, `&`, newlines and group boundaries split simple commands.
#   • `$( … )` and backticks are commands at top level AND inside double quotes — recursed into.
#   • …and are inert inside SINGLE quotes and inside heredoc bodies — DATA, never inspected.
#   • `sh -c` / `bash -lc` / `bash -ic` / `/bin/bash -c` payloads are commands by definition —
#     recursed into, and recursively so, bounded by MAX_DEPTH/MAX_NODES.
#   • Process substitutions `<( … )` are commands; herestrings, `#` comments and every quoted
#     ARGUMENT are DATA.
#   • A DYNAMIC executable (`$TOOL memory search`, `eval "$cmd"`, `bash -c "$cmd"`) is reported with
#     `dynamic: true` and an empty `exe`: the name is not in the text, so there is nothing to
#     classify and this gate never sees it — fail open, #12's lesson kept.
# Heredoc bodies being DATA also retires a pre-existing false positive that #44's recursion would
# otherwise have made worse, and which bit the maintainer live on 2026-07-27: a doc heredoc whose
# line begins with a tool name ("agentic-qe integration plan"), or that quotes a `$(ruflo …)`
# example, blocked an ordinary `cat <<'EOF'`.
#
# Both branches below — help-recording and blocking — read the SAME classifier output. "Two regexes
# for one concept is how you get a gate that never opens" was written into this file's tests in blood;
# there is now one answer and no second path to it, by construction.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

set -uo pipefail

INPUT=""
while IFS= read -r _l || [ -n "$_l" ]; do INPUT+="$_l"; done
[ -n "$INPUT" ] || exit 0

# Opt-in, like every other gate here: no router profile = this user never asked for our discipline.
PROFILE="${MODEL_ROUTER_PROFILE:-$HOME/.claude/model-router/profile.json}"
[ -f "$PROFILE" ] || exit 0
# Session-wide opt-out: the hook PROCESS's own environment (e.g. exported in the shell that launches
# Claude Code). Different from — and not a substitute for — the per-command override checked below.
[ "${RUVNET_SKIP_INTERFACE_CHECK:-0}" = "1" ] && exit 0

# Real JSON parsing via the shared parser (hook-input.mjs), not a regex (issue #13, now ADR-0021):
# `([^"]*)`-style bash regexes cannot cross a `"`, and a JSON-escaped `\"` is still a literal `"`
# byte — any command with an embedded quote used to be silently truncated. ONE tested parser, shared
# by every gate. node is guaranteed present in Claude Code's environment; fail open if it isn't.
NODE_BIN=$(command -v node) || exit 0
HOOK_INPUT="$(dirname "${BASH_SOURCE[0]}")/hook-input.mjs"
TOOL_NAME=$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" tool_name 2>/dev/null) || exit 0
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" command 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# EVERY invocation of a managed CLI in this command, from the shared CLASSIFIER (hook-input.mjs).
#
# This is the whole fix for the four-issue streak. The gate no longer asks a STRING question about a
# structural fact. It asks the parser one question — "is any of these tools in EXECUTABLE position
# anywhere in this command?" — and the parser answers it from real shell structure: pipelines, `$( )`
# and backticks (live at top level and inside double quotes), literal `sh -c`/`bash -lc`/`-ic`
# payloads recursively, process substitutions, leading assignments. Quoted arguments, heredoc bodies,
# herestrings, `#` comments and single-quoted `$( )` are DATA and never appear. A dynamic executable
# (`$TOOL …`, `eval "$cmd"`, `bash -c "$cmd"`) is UNKNOWN and never appears either — fail open.
#
# There is deliberately NO regex fallback. MATCH_RE is gone, not demoted: a second path is precisely
# how this defect class survived #12, #13, #41 and #44.
#
# Output: one TAB-separated line per invocation — `tool<TAB>arg<TAB>arg…`. Empty = nothing to check.
# The tool LIST is policy and stays here; the STRUCTURE is the parser's. Only the ecosystem CLIs whose
# interfaces I keep guessing at — NOT git/ls/grep. This must not become a tax on ordinary work, or it
# gets switched off and protects nothing.
TOOLS='ruflo,claude-flow,agentic-flow,agentic-qe,ruvector,agent-browser,ruv-swarm'
INV=$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" invocations "$TOOLS" 2>/dev/null) || exit 0
[ -n "$INV" ] || exit 0

# Per-command override (issue #12, defect 2). The block message tells the caller to set this ON THE
# COMMAND — so check the command STRING, not this process's environment (which the caller never
# touches: a PreToolUse hook only ever sees the proposed command as text on stdin).
#
# This one flat-string test is deliberate and is NOT the pattern the classifier replaced. It is an
# opt-OUT: its worst failure is that the token appearing in prose lets a command through, which is
# fail-open — the contract this gate already grants on every parse it cannot make. The banned pattern
# is deciding an INVOCATION from a flat string, where the failures are a missed block and a blocked
# innocent. Keeping it flat also preserves the `export RUVNET_SKIP_INTERFACE_CHECK=1; …` form.
[[ $CMD =~ (^|[[:space:]])RUVNET_SKIP_INTERFACE_CHECK=1([[:space:]]|$) ]] && exit 0

# Granularity is policy, and it has to match the mistake it prevents: TWO levels (`memory search`,
# not just `memory`), because `ruflo memory --help` lists subcommands but never shows `search`'s
# `-q` — and `-q` is the exact flag I guessed wrong. Pure bash builtins over already-parsed argv
# tokens: no pattern is ever applied to the command STRING again.
#   $1 = the invocation's TAB-separated arg list, already split by the caller into $F
# Sets: SUB1 SUB2 (subcommand levels, possibly empty) and IS_HELP.
subcommand_of() {
  SUB1=""; SUB2=""; IS_HELP=0
  local k w
  for ((k = 1; k < ${#F[@]}; k++)); do
    w="${F[k]}"
    [ "$w" = "--help" ] || [ "$w" = "-h" ] && IS_HELP=1
  done
  for ((k = 1; k < ${#F[@]}; k++)); do
    w="${F[k]}"
    [ -n "$w" ] || break                       # a dynamic arg: its value is unknown, so stop here
    case "$w" in
      [a-z]*) ;;                               # a subcommand looks like a lowercase word …
      *) break ;;
    esac
    case "$w" in *[!a-z-]*) break ;; esac      # … of [a-z-] only (this also rejects -flags)
    if [ -z "$SUB1" ]; then SUB1="$w"; else SUB2="$w"; break; fi
  done
}

# PASS 1 — record every help read FIRST. Reading help is always allowed, and doing this before any
# blocking decision means `ruflo x --help && ruflo x -q y` works in one command: the read satisfies
# the call. (The old flat test asked whether `--help` appeared ANYWHERE in the command string, which
# both missed `bash -lc 'ruflo … --help'` — the quote after `--help` is not whitespace — and let an
# unrelated `grep -h` unlock a completely different tool's unread invocation.)
SAW_HELP=0
while IFS=$'\t' read -r -a F; do
  [ ${#F[@]} -gt 0 ] || continue
  subcommand_of
  [ "$IS_HELP" = "1" ] || continue
  [ -n "$SUB1" ] || continue
  SAW_HELP=1
  mkdir -p "$HOME/.cache/ruvnet-brain/help-read" 2>/dev/null || true
  : > "$HOME/.cache/ruvnet-brain/help-read/${F[0]}.$SUB1${SUB2:+.$SUB2}" 2>/dev/null || true
  # `ruflo memory search --help` also satisfies the parent `ruflo memory` — the child is strictly more.
  : > "$HOME/.cache/ruvnet-brain/help-read/${F[0]}.$SUB1" 2>/dev/null || true
done <<< "$INV"

# PASS 2 — block the first invocation whose interface has not been read in the last 24h.
TOOL=""; SUB=""; KEY=""
while IFS=$'\t' read -r -a F; do
  [ ${#F[@]} -gt 0 ] || continue
  subcommand_of
  [ "$IS_HELP" = "1" ] && continue
  [ -n "$SUB1" ] || continue                   # `ruflo` with no subcommand: nothing to ground
  K="${F[0]}.$SUB1${SUB2:+.$SUB2}"
  S="$HOME/.cache/ruvnet-brain/help-read/$K"
  if [ -f "$S" ]; then
    NOW=$(date +%s 2>/dev/null) || exit 0
    THEN=$(date -r "$S" +%s 2>/dev/null) || exit 0
    [ $((NOW - THEN)) -lt 86400 ] && continue  # read within the last 24h (these are @latest packages)
  fi
  TOOL="${F[0]}"; SUB="$SUB1${SUB2:+ $SUB2}"; KEY="$K"
  break
done <<< "$INV"

[ -n "$TOOL" ] || exit 0

read -r -d '' MSG <<EOF || true
⛔ BLOCKED — you have not read the interface for: ${TOOL} ${SUB}

You are about to invoke a tool whose flags you are GUESSING at. That guess has already cost real
trust: \`ruflo memory search "query"\` was called positionally when the CLI wants \`-q\`, it returned
nothing, and AgentDB was reported BROKEN three times when it was never broken at all.

The brain holds rUv's SOURCE. It does NOT hold a compiled CLI's runtime flags. Ground the INTERFACE
in the TOOL, not in your assumptions. Run this first — it takes five seconds:

    ${TOOL} ${SUB} --help

Then re-issue your command with the flags it actually documents.

EFFECTIVE BEATS EFFICIENT. Skipping this step has never once saved time.
(Deliberate override, say why out loud — prefix the COMMAND ITSELF, this is text a hook reads on
stdin and never executes, so exporting the variable in your shell first does nothing:
    RUVNET_SKIP_INTERFACE_CHECK=1 ${TOOL} ${SUB} ...)
EOF
bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" verify-interface "${TOOL:-} ${SUB:-}" "CLI interface not verified before use" 2>/dev/null || true
printf '%s\n' "$MSG" >&2
exit 2
