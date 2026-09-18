#!/bin/bash
# ground-before-write.sh — PreToolUse gate on Write|Edit.
# YOU MAY NOT WRITE RUV-DOMAIN CODE THE BRAIN HAS NOT SEEN FIRST.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY (2026-07-13). Stuart, after losing a full day: "The 100% entire reason we built RuvNet
# Brain was to prevent exactly this scenario... come up with a way to keep Claude Code from
# stepping in and overriding RuvNet-Brain."
#
# What happened, twice in one week: Claude hand-wrote agentdb-autocapture.mjs (prompt-echo
# snapshots) while rUv's ADR-174 `memory distill` pipeline shipped the real design; Claude
# hand-wrote a 216-line "MetaHarness router" while @metaharness/router sat on npm. Both times
# the brain HELD the answer and was never asked. The write path had no wall.
#
# rUv names the disease and the cure himself (@claude-flow/guidance, ADR-G007):
#   "prompts are advisory. Agents can and do ignore them, especially in long sessions."
#   "The model can forget a rule; the gate does not."
# And his own hooks doc wires exactly this shape: PreToolUse on ^(Write|Edit|MultiEdit)$
# (ruflo/.claude/commands/hooks/overview.md).
#
# THE RULE: writing/editing a CODE file that touches a RuvNet ecosystem product requires a
# fresh (<24h) grounding stamp for that product — written only by grounding-stamp.sh when
# search_ruvnet is genuinely called with that product in the query.
#
# Deliberate scope choices (so this never becomes a tax that gets switched off):
#   • CODE files only (.mjs/.js/.ts/.sh/...). Docs/README claims are enforced by the CI gates
#     (claims-verify, no-silent-substitution), not per-keystroke.
#   • Product terms only (agentdb, metaharness, ...). Generic words like "memory"/"hook"
#     would fire on half of all software.
#   • Block only the UNGROUNDED terms — grounding agentdb unlocks agentdb, not metaharness.
#     Each grounding stamp authorizes only its named product.
#
# CONTRACT: exit 0 = allow · exit 2 + stderr = BLOCK (stderr returns to the model as reason).
# FAILS OPEN on anything unparseable. Opt-in (router profile), like every gate here.
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

# ── BRAIN OFF — THE FIRST CHECK IN THE FILE (ADR-054 §3). ───────────────────────────────────────
# This gate demands a fresh grounding stamp, and a stamp can only be minted by a successful
# search_ruvnet. With the brain switched off there IS no search_ruvnet, so an unmodified gate would
# block every rUv-domain write forever with an instruction the user has deliberately made
# impossible to follow. That is the "something bad happened because it can be turned off" failure
# the owner's build mandate rules out, and it is why this check comes before the opt-in check,
# before the tool check and before the file-type check: nothing this gate does downstream is
# meaningful while its evidence source is switched off.
#
# It degrades to ONE advisory line on stdout and exit 0 — never a block. PreToolUse stdout on exit 0
# is transcript-only (it does not enter the model's context), so this is legibility for the person
# reading their own session, not another channel of unsolicited speech.
#
# Both duel reviewers independently caught that this hook is wired in the USER's settings.json,
# OUTSIDE plugin/hooks/hooks.json and therefore outside the shim's dispatch table — so the shim's
# per-hook offBehavior cannot reach it and the check has to live here, in the body. It is a pure
# `[ -f ]` on a path built from bash parameter expansion only: this gate's standing contract
# (ADR-0021, enforced by ground-before-write.test.mjs) is that it depends on no node, no jq, no
# python, so it can never fail-open because a tool went missing.
#
# The `! -r` clause is the bash half of a polarity bug gate test 5 found in the node half: an
# unreadable state directory makes `[ -f ]` (like fs.existsSync) answer "no sentinel", which would
# re-arm this gate for a user who had switched the brain off — the two readers disagreeing about the
# same machine. "The directory is there and we cannot read it" is not evidence of ON.
BRAIN_STATE_DIR="${RUVNET_BRAIN_STATE_DIR:-$HOME/.config/ruvnet-brain}"
BRAIN_OFF_FILE="$BRAIN_STATE_DIR/brain-off"
if [ -f "$BRAIN_OFF_FILE" ] || { [ -d "$BRAIN_STATE_DIR" ] && [ ! -r "$BRAIN_STATE_DIR" ]; }; then
  echo "[RuvNet Brain is off by your setting — the grounding gate is advisory only, nothing is blocked.]"
  exit 0
fi

PROFILE="${MODEL_ROUTER_PROFILE:-$HOME/.claude/model-router/profile.json}"
[ -f "$PROFILE" ] || exit 0

# The blanket override, NARROWED (ADR-055 §3.5, verbatim: "the blanket RUVNET_SKIP_GROUNDING_CHECK=1
# regime is retired for the fourth wall"). It still disarms the RECENCY wall below, exactly as
# documented since ADR-0012 — but it no longer disarms the SUBSTANCE stage, which has its own
# in-band, reasoned, receipted token. The reason is the whole point of issue #46: recency is a
# ceremony you can reasonably choose to skip, while "you are writing the opposite of the source you
# were just shown" is not a ceremony, and a variable exported once at the top of a session must not
# buy a day of contradicting writes. Note the substance stage never blocks on ABSENCE of evidence,
# so with the recency wall skipped and nothing stamped, it permits — as it should.
SKIP_RECENCY=0
[ "${RUVNET_SKIP_GROUNDING_CHECK:-0}" = "1" ] && SKIP_RECENCY=1

# This gate is a BLOCKING wall (the #1-failure preventer), so by deliberate design (ADR-0021, and
# enforced by ground-before-write.test.mjs) it depends on NOTHING fragile — pure bash builtins, no
# node/jq/python — and therefore cannot fail-open because a tool went missing. The #13 quote-truncation
# that justified hook-input.mjs for design-wall does NOT bite here: the product-term scan below runs
# over the RAW payload (untouched by field()), and the only parsed values are tool_name (Write/Edit —
# no quotes) and file_path (a truncated path merely fails the extension check → exit 0, harmless).
field() { local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""; [[ $INPUT =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"; }

case "$(field tool_name)" in Write|Edit|MultiEdit) ;; *) exit 0 ;; esac

FILE_PATH=$(field file_path)
[ -n "$FILE_PATH" ] || exit 0
case "$FILE_PATH" in
  *.mjs|*.cjs|*.js|*.ts|*.tsx|*.jsx|*.sh|*.bash|*.zsh|*.rs|*.py|*.go) ;;
  *) exit 0 ;;
esac
# The grounding-guidance hooks ENUMERATE every rUv product by design — that IS their job: telling the
# model which rUv primitive replaces which classical default. They don't hand-roll or call any rUv
# tool, so demanding a fresh stamp per listed term just to EDIT the guidance is a false positive — the
# gate firing on its own source material (it blocked a trim of ground-ruvnet.sh on 2026-07-18). Exempt
# these two by basename; the repo-wide CI gates (claims-verify, no-silent-substitution) still cover them.
case "$FILE_PATH" in
  */ground-ruvnet.sh|*/session-start.sh) exit 0 ;;
esac

shopt -s nocasematch 2>/dev/null || true

STAMP_DIR="$HOME/.cache/ruvnet-brain/grounded"
NOW=$(date +%s 2>/dev/null) || exit 0

# Scan the WHOLE tool input (path + content + new_string) — where the code mentions the
# product is where the hand-roll hides.
MISSING=""
SEEN=""
for t in agentdb metaharness ruvector aidefence agentic-flow agentic-qe ruv-swarm rvf ruflo; do
  [[ $INPUT == *"$t"* ]] || continue
  SEEN="$SEEN$t "
  STAMP="$STAMP_DIR/$t"
  if [ -f "$STAMP" ]; then
    # GNU date reads a file's mtime with -r; BSD/macOS needs stat -f %m. Either failing → allow
    # (fail open — a gate that bricks a session is worse than the bug it prevents).
    THEN=$(date -r "$STAMP" +%s 2>/dev/null) || THEN=$(stat -f %m "$STAMP" 2>/dev/null) || exit 0
    [ $((NOW - THEN)) -lt 86400 ] && continue
  fi
  MISSING="$MISSING$t "
done

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# STAGE 2 — THE SUBSTANCE WALL (ADR-055 §3, issue #46). Runs only once the recency wall above has
# PASSED: a term the model has never grounded is stopped by stage 1 and never reaches here.
#
# ── THE DEPENDENCY CONTRACT, AND WHY THIS DOES NOT BREAK IT ────────────────────────────────────
# Everything above this line is pure bash builtins, by standing contract (ADR-0021, enforced by
# ground-before-write.test.mjs): the recency wall is THE blocking wall, so it can never fail open
# because a tool went missing. That contract is unchanged and still tested — the assertion now
# reads the file UP TO THIS MARKER.
#
# The substance stage is different in kind and is allowed one dependency, node, because deciding
# "does this write contradict the source the brain returned?" requires a real JSON parse of the
# payload (this repo has paid twice for pretending otherwise — issue #13's quote truncation) plus a
# read of the evidence ledger. It is therefore built to FAIL OPEN, loudly and by construction: no
# node, no checker file, no ledger, any non-2 exit → the write proceeds. The only thing that can
# produce a refusal here is a detector that found a contradiction, which is ADR-055 §1.2's
# "malfunction ≠ decision" applied to the one stage that has something to malfunction.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
if [ -z "$MISSING" ] || [ "$SKIP_RECENCY" = "1" ]; then
  [ -n "$SEEN" ] || exit 0
  SUBSTANCE="$(dirname "${BASH_SOURCE[0]}")/grounding-substance.mjs"
  [ -f "$SUBSTANCE" ] || exit 0
  command -v node >/dev/null 2>&1 || exit 0
  SUB_OUT=$(printf '%s' "$INPUT" | node "$SUBSTANCE" 2>&1)
  SUB_RC=$?
  if [ "$SUB_RC" = "2" ]; then
    printf '%s\n' "$SUB_OUT" >&2
    exit 2
  fi
  # Anything else — clean pass, a crash, a timeout, an unknown code — permits the write. An override
  # acceptance line (exit 0 with stderr) is surfaced so the record is visible in the transcript.
  [ -n "$SUB_OUT" ] && printf '%s\n' "$SUB_OUT" >&2
  exit 0
fi

read -r -d '' MSG <<EOF || true
⛔ BLOCKED — you are writing rUv-domain code the brain has not seen: ${MISSING% }

This exact move has already cost a full day TWICE: a hand-rolled agentdb capture hook while
rUv's ADR-174 distill pipeline shipped the real design, and a fake "MetaHarness router" while
@metaharness/router sat on npm. Both times the brain held the answer and was never asked.

Before writing this file, ground each blocked term in the RuvNet Brain — call the
search_ruvnet MCP tool with the product in the query, e.g.:

    search_ruvnet({ query: "${MISSING%% *}: how does rUv implement / recommend this?" })

Reading real source stamps the term for 24h and this gate opens. rUv's own rule (ADR-G007):
prompts are advisory; the gate is not. EFFECTIVE BEATS EFFICIENT.
(Deliberate override, say why out loud: RUVNET_SKIP_GROUNDING_CHECK=1)
EOF
bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" ground-before-write "${MISSING%% *}" "rUv-product code without a fresh search_ruvnet stamp" 2>/dev/null || true
printf '%s\n' "$MSG" >&2
exit 2
