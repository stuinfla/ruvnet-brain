#!/bin/bash
# design-wall.sh — PreToolUse gate on Bash. NOTHING VISUAL SHIPS, COMMITS, OR OPENS UNGRADED.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# WHY (2026-07-16). Stuart, after a carelessly-composed public band shipped twice: "You are always,
# and I mean always, supposed to look at a page as an end user would: take pictures of it, review it,
# analyze it, grade it, see if it gets a 95 or better, and if it doesn't, tweak it until it does —
# before you ever tell me something is ready." And when that landed as a memory note instead of a
# mechanism: "Suggestions mean bullshit to you. RuvNet Brain needs to be smart enough to make sure
# those suggestions become law and the law becomes followed."
#
# This opt-in gate retains its visual review contract. Managed CLI help validation belongs to
# the structured MCP boundary; the former verify-interface shell advisory is retired.
# So the 95-gate is a WALL: deploying the explainer, committing visual surfaces, or opening a page
# for the user REQUIRES a fresh passing design-grade stamp for that surface. The only key is
# scripts/design-grade.mjs, which itself refuses to stamp without >=2 fresh screenshots at distinct
# widths and written deductions. The grade stays judgment; the ritual is enforced; the receipt is
# auditable.
#
# CONTRACT: exit 0 = allow · exit 2 + stderr = BLOCK (stderr returns to the model as the reason).
# FAILS OPEN on anything it cannot parse — a gate that breaks the shell protects nothing.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

INPUT=""
# BOUNDED READ (2026-07-27, ADR-055 F20): an unqualified `read` never returns on a stdin that is
# opened and never closed — measured across the mesh, 18 of 37 registered commands sat until the
# harness killed them. Real Claude Code writes and closes, so this costs no normal turn; that is
# exactly why a hook that CAN hang forever survives unnoticed. -t bounds the wait, and the string
# is truncated AFTER the loop because a hook payload is one line with no newline, so `read` hands
# the whole thing back at once and a per-iteration cap never fires.
while IFS= read -r -t 2 _l; do
  INPUT+="$_l"
  [ ${#INPUT} -ge 65536 ] && break
done
[ -n "$_l" ] && INPUT+="$_l"
INPUT="${INPUT:0:65536}"
[ -n "$INPUT" ] || exit 0

# Parse the payload with the shared JSON parser (hook-input.mjs), NOT a bash regex. The old
# field() { …"([^"]*)"… } truncated any command containing a quote at the first one — the exact
# #13 fail-open verify-interface.sh already fixed, silently reintroduced here (design-wall.sh was
# written after). node is present in Claude Code's environment; fail open (exit 0) if it isn't. ADR-0021.
NODE_BIN=$(command -v node) || exit 0
HOOK_INPUT="$(dirname "${BASH_SOURCE[0]}")/hook-input.mjs"
[ "$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" tool_name 2>/dev/null)" = "Bash" ] || exit 0
CMD=$(printf '%s' "$INPUT" | "$NODE_BIN" "$HOOK_INPUT" command 2>/dev/null)
[ -n "$CMD" ] || exit 0

# ── Repo identity gate (2026-07-17, issue #17) ───────────────────────────────────────────────────
# BUG: this hook never checked WHICH repo it was running in, so a plain `git commit` touching a
# README.md in ANY unrelated project on this machine (any repo where the plugin happens to be
# installed) got blocked demanding a ruvnet-brain design-grade ritual for someone else's CLI tool.
# The whole point of this wall is to guard ruvnet-brain's OWN surfaces — its stamp path lives under
# ~/.cache/ruvnet-brain, and explainer/ + console/ only exist in ruvnet-brain's own checkout — so it
# has no business firing anywhere else. Identify the repo via the plugin manifest's own name field
# first (authoritative — a renamed clone/fork can't fake it just by matching a directory name), and
# fall back to the console/+explainer/+design-grade.mjs trio only if the manifest is missing.
ROOT=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null)
[ -n "$ROOT" ] || exit 0
IS_RUVNET_BRAIN=0
if [ -f "$ROOT/plugin/.claude-plugin/plugin.json" ]; then
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"ruvnet-brain"' "$ROOT/plugin/.claude-plugin/plugin.json" 2>/dev/null && IS_RUVNET_BRAIN=1
elif [ -d "$ROOT/console" ] && [ -d "$ROOT/explainer" ] && [ -f "$ROOT/scripts/design-grade.mjs" ]; then
  IS_RUVNET_BRAIN=1
fi
[ "$IS_RUVNET_BRAIN" = "1" ] || exit 0

# ── The escape hatch, made reachable (2026-07-17) ────────────────────────────────────────────────
# BUG: this check read RUVNET_SKIP_DESIGN_WALL from the HOOK's own environment. But a PreToolUse
# hook runs in its own process, spawned BEFORE the command exists — so `RUVNET_SKIP_DESIGN_WALL=1
# git commit …` set the variable for git and the wall never saw it. The wall advertised an override
# that nobody on the agent side could actually use. It deadlocked a commit whose only visual diff
# was two version strings written by sync-version.mjs (zero pixels changed), leaving exactly two
# exits: fake a >=95 self-grade to open the gate, or don't ship. That first exit is the precise
# failure this repo learned the hard way on 2026-07-17 — a self-assigned grade of my own taste,
# laundered into a timestamped receipt (Stuart looked at a page I had graded 96 and scored it 55).
# An UNREACHABLE escape hatch is worse than none: it turns "this gate is wrong in this case" into
# "this gate cannot be wrong", and a gate that cannot be wrong is not a gate, it is a wish.
# So: still honored from the env, and now also from the command string — but LOUD. Every override
# writes a receipt, so skipping the wall leaves the same auditable trail as being caught by it.
# The wall still holds for anything that actually changed pixels; it just can no longer force a lie.
if [ "${RUVNET_SKIP_DESIGN_WALL:-0}" = "1" ] || [[ $CMD == *"RUVNET_SKIP_DESIGN_WALL=1"* ]]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" design-wall override \
    "deliberate override — wall skipped, reason stated in the turn" 2>/dev/null || true
  exit 0
fi

STAMPDIR="$HOME/.cache/ruvnet-brain"
need=()

# 1) Production deploys of the public explainer.
if [[ $CMD == *vercel* && $CMD == *--prod* ]]; then need+=("explainer"); fi

# 2) Commits that stage visual surfaces.
if [[ $CMD == *"git commit"* ]]; then
  STAGED=$(git -C "${CLAUDE_PROJECT_DIR:-.}" diff --cached --name-only 2>/dev/null || true)
  [[ $STAGED == *"explainer/"* ]] && need+=("explainer")
  [[ $STAGED == *"console/"*   ]] && need+=("console")
  [[ $STAGED == *"README.md"*  ]] && need+=("readme")
fi

# 3) Opening a page for the user — presenting IS shipping.
if [[ $CMD =~ open[^\|\;]*https?:// ]]; then
  [[ $CMD == *"isovision.ai/ruvnet-brain"* || $CMD == *"ruvnet-brain.vercel.app"* ]] && need+=("explainer")
  [[ $CMD == *"localhost:7411"* || $CMD == *"127.0.0.1:7411"* ]] && need+=("console")
fi

[ ${#need[@]} -eq 0 ] && exit 0

for s in "${need[@]}"; do
  ST="$STAMPDIR/design-stamp-$s.json"
  ok=0
  if [ -f "$ST" ] && grep -Eq '"passing":[[:space:]]*true' "$ST" 2>/dev/null; then
    agemin=$(( ( $(date +%s) - $(stat -f %m "$ST" 2>/dev/null || echo 0) ) / 60 ))
    [ "$agemin" -le 45 ] && ok=1
  fi
  if [ "$ok" != "1" ]; then
    # Record the catch BEFORE refusing. The block is the evidence — without this line the ledger
    # shows only the passing grade that came after the fix, and the wall cannot prove it ever held.
    bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" design-wall "$s" "ungraded visual surface, no fresh passing grade" 2>/dev/null || true
    cat >&2 <<EOF
⛔ DESIGN WALL — no fresh passing grade for surface '$s'.
Nothing visual ships, commits, or opens for the user until it has been LOOKED AT as an end user
would and graded 95 or better. The ritual (minutes, enforced):
  1. Screenshot the REAL surface at TWO widths (1440 and ~1920).
  2. LOOK at both. Actively: does it look great? typography right? does every block earn its place?
     Write the deductions down.
  3. node scripts/design-grade.mjs --surface $s --grade <n> --shot <p1> --shot <p2> --deductions "…"
     Below 95 it records the grade and STAYS CLOSED — fix, re-shoot, re-grade until it opens.
Stamp: $ST (valid 45 min — pages change, grades expire).
Deliberate override (rare, say why out loud): RUVNET_SKIP_DESIGN_WALL=1
EOF
    exit 2
  fi
done
exit 0
