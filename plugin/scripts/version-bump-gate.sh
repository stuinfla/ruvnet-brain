#!/bin/bash
# version-bump-gate.sh — PreToolUse gate on Bash. EVERY PUSH CARRIES A VERSION INCREMENT.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY (2026-07-13). Stuart, after a push with no bump served him stale code: "Every single
# commit to GitHub should come with a version increment: major.minor.bugfix. It's the only way
# we're gonna know beyond a shadow of a doubt what's going on. When other things are looking to
# read a change in version to know that there's something they need to be aware of, that's not
# negotiable."
#
# THE INCIDENT: gates/fleet-doctor//savings were pushed under an unchanged 2.5.2. The plugin
# cache compared 2.5.2 == 2.5.2, correctly served the STALE copy, and a restarted session
# loaded without /savings. THE VERSION NUMBER IS THE UPDATE SIGNAL — a push without a bump is
# an update nothing can see.
#
# Prior art is rUv's own: agent-harness-generator preflight.mjs refuses to greenlight a release
# when package versions drift, and version-bump.mjs bumps every manifest in lockstep — the gate
# is the product. This is that discipline applied at the push boundary.
#
# CONTRACT: exit 0 = allow · exit 2 + stderr = BLOCK. FAILS OPEN on anything unparseable.
# Opt-in (router profile.json), bash builtins + git only — same hardening as its four siblings.
# ─────────────────────────────────────────────────────────────────────────────────────────────

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

PROFILE="${MODEL_ROUTER_PROFILE:-$HOME/.claude/model-router/profile.json}"
[ -f "$PROFILE" ] || exit 0
[ "${RUVNET_SKIP_VERSION_GATE:-0}" = "1" ] && exit 0

# BOUNDED, escape-aware (2026-09-02, enforcement-integrity night). `[^"]*` cannot cross a `"`, and a
# JSON-escaped `\"` inside the value is still a literal `"` byte in this raw text — so a `command`
# containing ANY quote before the part being searched for got silently TRUNCATED there. `command` is
# the one field this gate reads that routinely carries quotes (`-m "…"`, `echo "…"`), so a compound
# command like `git commit -m "wip" && git push origin main` truncated CMD at `\"wip` and the later
# `*"git push"*` check never saw the push — the gate opened a push it exists to block. This is the
# exact class issue #13 and design-wall.sh's rewrite already fixed once (see hook-input.mjs's header);
# this file kept its own inline field() rather than adopting that shared parser because it is
# deliberately dependency-free (see the file header: "bash builtins + git only"), so the fix stays
# in-pattern: the capture now walks `(\\.[^"\\]*)*`, one escaped-pair-or-plain-run at a time, so an
# embedded `\"` is consumed as part of the value instead of ending the match early.
field() { local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]*(\\\\.[^\"\\\\]*)*)\""; [[ $INPUT =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"; }
[ "$(field tool_name)" = "Bash" ] || exit 0
CMD=$(field command)
[[ $CMD == *"git push"* ]] || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# The version source of truth, in precedence order. A repo with neither is not version-managed
# by this convention — pass untouched.
SRC=""
for c in plugin/.claude-plugin/plugin.json package.json; do
  [ -f "$ROOT/$c" ] && { SRC="$c"; break; }
done
[ -n "$SRC" ] || exit 0

UP=$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || UP=origin/main
git -C "$ROOT" rev-parse --verify "$UP" >/dev/null 2>&1 || exit 0

AHEAD=$(git -C "$ROOT" rev-list --count "$UP..HEAD" 2>/dev/null) || exit 0
[ "$AHEAD" -gt 0 ] || exit 0   # nothing outgoing → nothing to gate

ver_at() { # ver_at <rev> — version string in $SRC at that rev, empty on any failure
  local j re='"version"[[:space:]]*:[[:space:]]*"([^"]*)"'
  j=$(git -C "$ROOT" show "$1:$SRC" 2>/dev/null) || return 0
  [[ $j =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"
}
V_HEAD=$(ver_at HEAD); V_UP=$(ver_at "$UP")
[ -n "$V_HEAD" ] && [ -n "$V_UP" ] || exit 0   # can't read either side → fail open
[ "$V_HEAD" != "$V_UP" ] && exit 0             # bumped → pass

# ── LESSON STORE CONSULTATION (ADR-030 L3, wired 2026-07-22) ────────────────────────────────────
# This gate hardcoded its own message for months while lesson L05 — the identical rule, recorded 52
# times across 4 projects — sat in a store that nothing read. A grep for `lessonsFor` across every
# gate returned zero: lessons were mined, weighted, trust-boundaried, and consumed by nobody.
#
# Now the store speaks here. Today every lesson is an unratified candidate, so this ADDS the lesson's
# own words and evidence to the refusal below rather than changing whether it fires. The day the
# owner ratifies L05, the same wire starts refusing on the lesson's authority instead of on this
# script's hardcoded copy — with no change to this file. Enforcement is data, not a rewrite.
#
# Fails open by construction: any error, missing store, or absent node exits this block silently. A
# gate that blocks a push because it could not read a config file is a gate people switch off.
LESSON_GATE="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)/scripts/lesson-gate.mjs"
if [ -f "$LESSON_GATE" ] && command -v node >/dev/null 2>&1; then
  LESSON_OUT="$(node "$LESSON_GATE" --trigger ship 2>/dev/null || true)"
fi

read -r -d '' MSG <<EOF || true
⛔ BLOCKED — this push carries $AHEAD commit(s) but NO version increment ($SRC still $V_UP).

THE VERSION NUMBER IS THE UPDATE SIGNAL. Plugin caches, update checks, and other sessions decide
whether to pull fresh code by comparing versions — a push without a bump is an update nothing can
see. This exact miss served a restarted session stale 2.5.2 without /savings on 2026-07-13.

Before pushing:
    1. bump "version" in $SRC (major.minor.bugfix)
    2. node scripts/sync-version.mjs      # syncs every surface, --check must pass
    3. include the bump in the outgoing commits, then push

(Stuart, 2026-07-13: "that's not negotiable." Deliberate override, say why out loud:
RUVNET_SKIP_VERSION_GATE=1)
${LESSON_OUT:+
── from your own lesson store ─────────────────────────────────────────────
$LESSON_OUT}
EOF
bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" version-bump-gate "push" "commits carried no version bump — an update nothing can see" 2>/dev/null || true
printf '%s\n' "$MSG" >&2
exit 2
