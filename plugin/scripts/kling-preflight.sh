#!/bin/bash
# kling-preflight.sh — PreToolUse gate on Bash. NO PAID KLING GENERATION WITHOUT THE TECHNIQUE.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY (2026-07-13). Stuart asked me to become a Kling black belt BEFORE building his explainer.
# I researched the docs, wrote a complete operator guide… then generated six clips with my ORIGINAL
# prompts: no soundscape (Kling returned near-silent room-tone, -31dB), no film-language camera.
# He paid ~$4.20 for footage that ignored everything I had just learned.
#   "You spent the time and the credits to learn how to do it, and then you never bothered to
#    follow your own instructions?"
# LATENT KNOWLEDGE IS NOT KNOWLEDGE. A guide is advisory; a gate is not.
#
# WHY IT JUDGES INSTEAD OF PATTERN-MATCHING (Stuart, same day):
#   "Regex is stupidly brittle and rarely works the right way. You need a qualitative pass on it."
# He was right, and v1 proved it within minutes: my audio word-list contained `rain`, which matched
# inside "b-RAIN orb" — the gate declared a prompt with zero sound design to be a soundscape. A word
# list cannot answer "did you DIRECT this shot?". So the verdict comes from a cheap model reading the
# prompt (haiku, ~$0.001, on the subscription), and the hook merely ENFORCES that verdict.
#
# ARCHITECTURE (this is the reusable shape for any semantic gate):
#   • the WALL is deterministic — exit 2 blocks, exit 0 allows, always fails OPEN
#   • the JUDGMENT is qualitative — a model answers two structured questions, no keyword guessing
#   • keywords appear ONCE, as a cheap fast-path ALLOW (skip the model call when direction is
#     unmistakable). They may never cause a BLOCK — that's what made v1 wrong.
#   • judge unreachable / slow / weird output ⇒ ALLOW. A gate that strands you offline gets
#     switched off, and then it protects nothing.
#
# CONTRACT: exit 0 = allow · exit 2 + stderr = BLOCK (stderr returns to the model as the reason).
# Opt-in via the router profile, like its siblings.
# ─────────────────────────────────────────────────────────────────────────────────────────────

set -uo pipefail

INPUT=""
_l=""   # set -u: a read that times out before any byte leaves _l unset ("unbound variable" on stderr)
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
[ "${RUVNET_SKIP_KLING_PREFLIGHT:-0}" = "1" ] && exit 0

name_re='"tool_name"[[:space:]]*:[[:space:]]*"([^"]*)"'
[[ $INPUT =~ $name_re ]] || exit 0
[ "${BASH_REMATCH[1]}" = "Bash" ] || exit 0

# The command CONTAINS quotes (the prompt is quoted), which arrive JSON-escaped as \". A naive
# [^"]* stops at the first one and never sees the prompt — v1's other bug: it blocked everything,
# including perfect prompts, because it only ever read the flags.
cmd_re='"command"[[:space:]]*:[[:space:]]*"((\\.|[^"\\])*)"'
[[ $INPUT =~ $cmd_re ]] || exit 0
CMD="${BASH_REMATCH[1]}"
[ -n "$CMD" ] || exit 0

# Only the two BILLABLE VIDEO verbs. Stills, who_am_i, query_tasks, account, uploads, --help: free.
[[ $CMD =~ (image_to_video|text_to_video) ]] || exit 0
[[ $CMD =~ (--help|-h)([[:space:]]|$) ]] && exit 0

# A silent-by-design model (v2_5/v2_1/2.x master) has NO audio track and costs half — choosing one is
# legitimate, so only the camera question applies there.
SILENT_MODEL=0
[[ $CMD =~ (v2_5|v2-5|v2_1|v2-1|2_0.master|2_1.master) ]] && SILENT_MODEL=1

# Extract the prompt = the last double-quoted run in the command (JSON-escaped \" in our input).
PROMPT="$CMD"
p_re='\\"([^\\]*)\\"[^\\"]*$'
[[ $CMD =~ $p_re ]] && PROMPT="${BASH_REMATCH[1]}"
[ ${#PROMPT} -ge 12 ] || exit 0   # nothing meaningful to judge → don't get in the way

# ── FAST-PATH ALLOW ONLY (never a block) ──────────────────────────────────────────────────────
# If the direction is unmistakable, skip the model call. These words can only ALLOW, so a false
# match here costs a judgment call, not a wrongly-approved spend. (The v1 sin was letting a word
# list decide the negative — "b-RAIN" reading as rain-sounds.)
shopt -s nocasematch 2>/dev/null || true
CAM_FAST='(dolly[- ]?in|dolly[- ]?out|tracking shot|crane up|crane down|rack focus|whip[- ]?pan|crash zoom|steadicam|locked[- ]?off|push[- ]?in|pull[- ]?back)'
AUD_FAST='(soundscape|ambient (sound|audio|hum)|sound design|score swells|synth swell|foley)'
if [[ $PROMPT =~ $CAM_FAST ]]; then
  if [ "$SILENT_MODEL" = "1" ] || [[ $PROMPT =~ $AUD_FAST ]]; then exit 0; fi
fi

# ── THE QUALITATIVE PASS ──────────────────────────────────────────────────────────────────────
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.npm-global/bin/claude}"
[ -x "$CLAUDE_BIN" ] || exit 0   # no judge available → fail OPEN

ASK="You are a film-production gate for a PAID AI video generation. Judge ONLY this prompt:

<prompt>$PROMPT</prompt>

Answer two questions about the PROMPT ITSELF (not about what the video might look like):
1. CAMERA — does it direct the camera with real cinematographic intent (a move, framing, or a
   deliberate static hold: dolly, tracking, pan, tilt, crane, orbit, zoom, push-in, rack focus,
   wide/close framing, locked-off)? Vague phrases like 'gentle motion', 'the scene moves', or no
   camera language at all = NO.
2. AUDIO — does it describe a SOUNDSCAPE the model should generate (ambience, SFX, music, or
   dialogue)? Merely naming objects that could make noise does NOT count; it must direct sound.
   $([ "$SILENT_MODEL" = "1" ] && echo 'This model is silent-by-design; answer AUDIO=YES automatically.')

Reply with EXACTLY two lines, nothing else:
CAMERA=YES or CAMERA=NO
AUDIO=YES or AUDIO=NO"

VERDICT=$("$CLAUDE_BIN" -p --model haiku "$ASK" 2>/dev/null) || exit 0   # judge failed → fail OPEN
[ -n "$VERDICT" ] || exit 0

MISSING=""
[[ $VERDICT =~ CAMERA=NO ]] && MISSING="CAMERA"
if [ "$SILENT_MODEL" = "0" ] && [[ $VERDICT =~ AUDIO=NO ]]; then MISSING="${MISSING:+$MISSING + }AUDIO"; fi
# Unparseable verdict (neither YES nor NO present) → fail OPEN rather than block on confusion.
[[ $VERDICT =~ (CAMERA=(YES|NO)) ]] || exit 0
[ -n "$MISSING" ] || exit 0

read -r -d '' MSG <<EOF || true
⛔ BLOCKED — this paid Kling generation is missing: ${MISSING}
   (judged by reading your prompt, not by keyword matching)

You are about to spend real money (3.0-Turbo 1080p = \$0.14/sec) on a prompt that ignores the
technique. This EXACT miss already happened on 2026-07-13: six clips with no soundscape came back
as near-silent room-tone (-31dB). "You spent the time and the credits to learn how to do it, and
then you never bothered to follow your own instructions?"

YOUR PROMPT: "${PROMPT:0:160}"

FIX IT BEFORE RESUBMITTING:
  • CAMERA — direct the shot in film language: "slow dolly-in", "tracking shot", "crane up",
    "rack focus to…", "static locked-off hold". Not "gentle motion".
  • AUDIO — 3.0/Turbo returns a real audio track ONLY if you describe the soundscape:
    "a low synth swell, distant keyboard clicks, a warm chime as it connects."
    (Deliberately silent? Use kling-video-v2_5 — half price, no audio — and this clears.)

Full technique: ~/.claude/docs/KLING-OPERATOR-GUIDE.md (§0 pre-flight · §4 formula · §5 audio)
LATENT KNOWLEDGE IS NOT KNOWLEDGE. Research is not a deliverable — an applied result is.
(Deliberate override, say why out loud: RUVNET_SKIP_KLING_PREFLIGHT=1)
EOF
bash "$(dirname "${BASH_SOURCE[0]}")/gate-receipt.sh" kling-preflight "paid generation" "no applied pre-flight — latent knowledge is not knowledge" 2>/dev/null || true
printf '%s\n' "$MSG" >&2
exit 2
