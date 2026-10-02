#!/bin/bash
# grounding-stamp.sh — PostToolUse hook on the brain's search_ruvnet tool.
#
# The other half of ground-before-write.sh. When the model ACTUALLY consults the RuvNet Brain and
# the brain ACTUALLY answers, this records WHICH ecosystem products that answer grounded — one stamp
# file per product term, read later by the write-path gate. No stamp, no write.
#
# ── WHICH TERMS: the QUERY. WHETHER TO STAMP AT ALL: the RESULT. ────────────────────────────────
#
# Those are two different questions and the original version answered both with the query, which is
# how the gate quietly stopped meaning anything. Found by the 2026-07-26 F5×GPT-5.6 duel and fixed
# as part of ADR-054 §3 ("stamps mint ONLY on a successful grounded result"):
#
#   • WHICH TERMS still comes from the query, and must. The tool RESULT lists every repo in the
#     corpus in its "Searched 37 repos" banner — stamping the terms found in the result would mark
#     EVERYTHING grounded on every call and the gate would never fire again. (A check that cannot
#     fail protects nothing.) That original reasoning was right and is unchanged.
#
#   • WHETHER TO STAMP could never have come from the query, and did. A refusal, an outage, a thrown
#     module error, an empty result — and, since ADR-054, a "the brain is switched off" soft answer —
#     each minted a full 24-hour stamp for every product named in the question that was ASKED. So
#     the way to open the write gate was to ask the brain something while it was broken or disabled.
#     Measured on the pre-fix tree, in tests/unit/brain-off.test.mjs's recorded red run: five
#     distinct non-answers, five valid stamps.
#
# The success signal is the header the brain prints at the START of a genuine answer and nowhere
# else — `Searched <n> RuvNet repos (...)` or the fast-lane card header. Since 4.4.0 it is decided by
# grounding-answer.mjs on the PARSED answer text (substring matching over the raw payload was forged
# twice: first by the query in tool_input, then by the same query echoed in retrieval.query).
#
# CONTRACT: PostToolUse is non-blocking — always exit 0, swallow every failure.

set -uo pipefail

INPUT=""
# BOUNDED READ (2026-07-27, ADR-055 F20): an unqualified `read` never returns on a stdin that is
# opened and never closed — measured across the mesh, 18 of 37 registered commands sat until the
# harness killed them. Real Claude Code writes and closes, so this costs no normal turn; that is
# exactly why a hook that CAN hang forever survives unnoticed. -t bounds the wait, and the string
# is truncated AFTER the loop because a hook payload is one line with no newline, so `read` hands
# the whole thing back at once and a per-iteration cap never fires.
_l=""   # set -u: a read that times out before any byte leaves _l unset ("unbound variable" on stderr)
while IFS= read -r -t 2 _l; do
  INPUT+="$_l"
  [ ${#INPUT} -ge 2097152 ] && break
done
[ -n "$_l" ] && INPUT+="$_l"
# 2 MiB, not 64 KiB (4.4.0): the verdict below PARSES the payload, and a payload cut mid-JSON parses as
# nothing — too small a cap would silently mint nothing for a large genuine answer.
INPUT="${INPUT:0:2097152}"
[ -n "$INPUT" ] || exit 0

# ── 0-2. DID THE BRAIN ANSWER? ONE predicate, plugin/scripts/grounding-answer.mjs, shared with Stop. ──
# 4.4.0 adversarial review, BLOCKER B1: matching markers anywhere in tool_response still minted from
# the MODEL's query, because every lane echoes it back at structuredContent.retrieval.query — the
# router-decline lane ("NO SEARCH WAS RUN") and source discovery included. The predicate now PARSES
# the response and reads the ANSWER TEXT only (answer / content[].text), which must BEGIN with the
# brain's own header; an oversize notice counts only as the host's whole response, pointing at the
# host's own saved file, written during this call. No node, an unparseable payload, or any other
# shape ⇒ nothing mints: a stamp that cannot be proven is not minted.
HERE="$(cd "${BASH_SOURCE[0]%/*}" 2>/dev/null && pwd)" || exit 0   # builtin expansion: no dirname on a bare PATH
# hook-shim.mjs passes the node that is running it (RUVNET_NODE_BIN); PATH is only the fallback, since a
# host may hand its hooks a PATH with no node on it.
NODE_BIN="${RUVNET_NODE_BIN:-}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null)" || NODE_BIN=""
[ -n "$NODE_BIN" ] && [ -f "$HERE/grounding-answer.mjs" ] || exit 0
VERDICT="$(printf '%s' "$INPUT" | "$NODE_BIN" "$HERE/grounding-answer.mjs" 2>/dev/null)" || VERDICT=""
[ "$VERDICT" = "answered" ] || exit 0

# No HOME, no stamp dir to write — and under `set -u` a bare $HOME is an "unbound variable" on stderr
# (found by hook-qualify's home-unset case on an ANSWERED search, 4.5). Exit quietly instead.
[ -n "${HOME:-}" ] || exit 0
DIR="$HOME/.cache/ruvnet-brain/grounded"
mkdir -p "$DIR" 2>/dev/null || exit 0

# ── 2.5. THE ANY-SEARCH MARKER (H1 / GitHub #316). ──────────────────────────────────────────────
# grounding-turn-gate.mjs's Stop-time check must treat ANY successful search_ruvnet this turn as
# satisfying "a search happened" — independent of whether the query text below happens to contain
# one of the recognised product terms. A query like "how should agent handoffs stay consistent"
# grounds just as genuinely as one that names a product by name, and nothing should require the
# model to re-word a real search just to satisfy a keyword scan. This mints into the SAME
# directory grounding-turn-gate.mjs already scans for the newest mtime (newestGroundingStampMs),
# so no change is needed on that side. Written unconditionally now that the success banner (step 2)
# is confirmed, before the QUERY parse below — a search can succeed with a query this regex cannot
# extract, and that must not cost it this signal.
: > "$DIR/.any-search" 2>/dev/null || true

# ── 3. WHICH terms — from the QUERY only, as it always was. The first raw "query" key in the JSON is
# tool_input's; inside tool_response text the quotes are escaped (\"query\") so they cannot match.
# Read from the tool_input segment only, so a raw "query" key inside an object-shaped response
# (Codex passes the MCP result as an object, and the result carries retrieval.query) cannot decide
# which products are stamped. Product terms match case-insensitively (a query says "RuVector").
QUERY=""
TI="${INPUT#*\"tool_input\"}"
TI="${TI%%\"tool_response\"*}"
re='"query"[[:space:]]*:[[:space:]]*"([^"]*)"'
[[ $TI =~ $re ]] && QUERY="${BASH_REMATCH[1]}"
shopt -s nocasematch 2>/dev/null || true
[ -n "$QUERY" ] || exit 0

# WRITE_GATE terms — same product-term list as ground-before-write.sh's own copy, mirrored in both
# files on purpose (a shared sourced file would add a dependency a blocking hook must not have).
# Do not change this list without mirroring ground-before-write.sh's copy — H1 keeps that gate's
# per-product WRITE semantics untouched (see decision-gate.mjs / ground-before-write.sh for why
# these 9 are scoped to code hand-rolling risk, not general rUv-ecosystem conversation).
WRITE_GATE_TERMS="agentdb metaharness ruvector aidefence agentic-flow agentic-qe ruv-swarm rvf ruflo"

# GATE-1-ONLY additions (H1 / GitHub #316): ruvnet-gate1-pattern.mjs's RUVNET_GATE1_PATTERN is the
# ONE owner of this vocabulary — grounding-turn-mark.mjs already arms the Stop-time turn gate from
# it. Before this fix, grounding-stamp.sh only recognised the 9 WRITE_GATE_TERMS above, so a search
# literally about "ruvnet" (or "sparc", "qudag", "claude-flow", ...) minted no per-term stamp, and
# combined with the missing any-search marker above, grounding-turn-gate.mjs wrongly reported "no
# successful search_ruvnet call this turn" even though one had just happened. Terms already covered
# by WRITE_GATE_TERMS are not repeated here. tests/unit/grounding-stamp-terms.test.mjs asserts
# WRITE_GATE_TERMS plus GATE1_ONLY_TERMS together cover every RUVNET_GATE1_PATTERN alternative, so a
# future addition to that pattern left unmirrored here goes red immediately (same idiom as
# tests/unit/ruvnet-gate1-pattern.test.mjs's byte-identity check against ground-ruvnet.sh).
GATE1_ONLY_TERMS="ruvnet agenticow rulake ruview rupixel ruv-fann synthlang dspy qudag safla cve-bench sparc swarm claude-flow ruv"

for t in $WRITE_GATE_TERMS $GATE1_ONLY_TERMS; do
  [[ $QUERY == *"$t"* ]] && { : > "$DIR/$t" 2>/dev/null || true; }
done

# ── 4. THE SUBSTANCE PROBE (ADR-055 §3.7.10, issue #46). ────────────────────────────────────────
#
# ADR-055 refuses, by name, the claim of "rUv over your shoulder" while the fourth wall is inert,
# and requires the product to report one of SUBSTANCE-BOUND | SEARCH-ONLY | OFF. This writes that
# state as a DERIVED fact rather than an asserted one — the house rule is that status must come
# from a verifiable artifact, and the artifact here is the evidence ledger's own mtime.
#
# The substance writer (kb/forge-evidence.mjs) appends a line DURING the tool call this hook is the
# PostToolUse of, so on a substance-bound machine the ledger was touched seconds ago. An installed
# bundle that predates the writer answers normally and never touches the ledger — the machine is
# then SEARCH-ONLY, and the only dishonest thing it could do is not say so.
#
# Everything here is best-effort and swallowed; PostToolUse must always exit 0.
EVID="${RUVNET_EVIDENCE_FILE:-$HOME/.cache/ruvnet-brain/evidence.jsonl}"
MODE="search-only"
if [ -f "$EVID" ]; then
  NOW=$(date +%s 2>/dev/null) || NOW=""
  THEN=$(date -r "$EVID" +%s 2>/dev/null) || THEN=$(stat -f %m "$EVID" 2>/dev/null) || THEN=""
  if [ -n "$NOW" ] && [ -n "$THEN" ] && [ $((NOW - THEN)) -lt 120 ]; then MODE="substance-bound"; fi
fi
printf '%s\n' "$MODE" > "$DIR/../grounding-mode" 2>/dev/null || true

exit 0
