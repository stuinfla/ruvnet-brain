#!/bin/sh
# RuvNet Brain — SessionStart hook. THE CONFIDENCE SIGNAL.
# The #1 UX failure of a background plugin is the user not knowing it's even on. This fires once when
# a Claude Code session starts (in ANY project / VS Code window) and instructs the model to surface a
# brief, friendly confirmation so the user KNOWS the brain is active and how to use it — answering the
# exact questions a newcomer has ("is it on? do I reinstall per project? how do I use it?").
# stdout is injected into the session context at startup; ALWAYS exit 0 so it can never block a session.
set +e

# ── heartbeat: rate-limited (~once/20h) check against the live GitHub plugin.json ──
# Detects a version gap, then APPLIES it automatically in the background — no manual command for the
# user to remember. `claude plugin marketplace update` + `claude plugin update` only refresh an
# on-disk cache; they don't touch this session's already-loaded state, so running them from a
# background subprocess here is safe (proven empirically: this exact pair ran cleanly from inside a
# live session earlier the same day, no disruption). A restart is still required to LOAD the new
# version — that's a hard Claude Code platform constraint, not something a plugin can bypass — but
# restarts happen naturally and often, so once this runs there is nothing left to remember. Never
# blocks: the update itself is backgrounded (&), and this whole block is best-effort — any failure is
# silently ignored, curl is capped at 3s, so session start is never meaningfully delayed.
STATE_DIR="$HOME/.cache/ruvnet-brain"
STAMP="$STATE_DIR/.last-update-check"
PREF_FILE="$STATE_DIR/.auto-update-pref"
mkdir -p "$STATE_DIR" 2>/dev/null

# One-time consent question (asked at most once ever, per machine) — security-conscious default:
# self-update is powerful (it can change the model's own instructions), so it's opt-in via an explicit
# yes, not silently on. Once answered, never asked again; the answer is a plain yes/no file, not a flag
# the user has to remember to pass.
if [ ! -f "$PREF_FILE" ]; then
  echo "[RuvNet Brain — one-time setup question]"
  echo "Ask the user ONCE, near the top of your first response (not a wall of clarifying questions — just this):"
  echo "  \"🧠 One-time setup: want RuvNet Brain to automatically update itself in the background whenever a new version ships, so you never have to run an update command? (recommended — you can turn it off anytime just by telling me)\""
  echo "Based on their answer, run exactly ONE of these via Bash, then never ask again:"
  echo "  enable:  mkdir -p '$STATE_DIR' && echo yes > '$PREF_FILE'"
  echo "  decline: mkdir -p '$STATE_DIR' && echo no > '$PREF_FILE'"
  echo "If they don't answer this turn, ask again next session (don't block on it, don't repeat within this session)."
  echo ""
fi

NOW=$(date +%s 2>/dev/null || echo 0)
LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ "$NOW" -gt 0 ] && [ $((NOW - LAST)) -gt 72000 ]; then
  echo "$NOW" > "$STAMP" 2>/dev/null

  # ── KB (brain bundle) freshness — a SEPARATE store from the plugin, at ~/.cache/ruvnet-brain/kb.
  # `claude plugin update` never touches it; its own evergreen updater (forge-update.mjs, shipped
  # inside the bundle: provenance check vs releases/latest, backup, extract, re-verify, fail-loud
  # with no partial clobber) does — but only if something calls it. This is that something.
  # Same consent gate as the plugin auto-update; check is cheap, --apply only fires when BEHIND.
  KB_DIR="$HOME/.cache/ruvnet-brain/kb"
  if [ "$(cat "$PREF_FILE" 2>/dev/null)" = "yes" ] && [ -f "$KB_DIR/forge-update.mjs" ] && command -v node >/dev/null 2>&1; then
    ( cd "$KB_DIR" && node forge-update.mjs --check > "$STATE_DIR/.last-kb-check.log" 2>&1
      if grep -q "BEHIND" "$STATE_DIR/.last-kb-check.log" 2>/dev/null; then
        node forge-update.mjs --apply >> "$STATE_DIR/.last-kb-check.log" 2>&1
      fi
    ) &
  fi
  LOCAL_V=""
  [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ] && \
    LOCAL_V=$(grep -m1 '"version"' "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  REMOTE_V=$(curl -fsS --max-time 3 \
    "https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/plugin/.claude-plugin/plugin.json" 2>/dev/null \
    | grep -m1 '"version"' | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  if [ -n "$LOCAL_V" ] && [ -n "$REMOTE_V" ] && [ "$LOCAL_V" != "$REMOTE_V" ]; then
    AUTO_PREF=$(cat "$PREF_FILE" 2>/dev/null || echo "")
    if [ "$AUTO_PREF" = "yes" ] && command -v claude >/dev/null 2>&1; then
      ( claude plugin marketplace update ruvnet-brain >"$STATE_DIR/.last-auto-update.log" 2>&1
        claude plugin update ruvnet-brain@ruvnet-brain >>"$STATE_DIR/.last-auto-update.log" 2>&1
      ) &
      echo "[RuvNet Brain — downloading v$REMOTE_V in the background; THIS SESSION STILL RUNS v$LOCAL_V]"
      echo "Tell the user this PLAINLY, near the top of your first response — be exact about running vs staged, never imply the new version is active:"
      echo "  \"🧠 You're running RuvNet Brain v$LOCAL_V. I found v$REMOTE_V and I'm downloading it in the background now — when it finishes it will be STAGED, not active. To actually run it, exit and reopen Claude Code (I can't restart the app for you). If now's a clean moment, that's the move; otherwise it loads at your next natural restart.\""
      echo "If the user asks which version they're on at any point, the answer is v$LOCAL_V until they restart. Don't repeat this notice later in the same session."
      echo ""
    else
      echo "[RuvNet Brain — update available, auto-update not enabled]"
      echo "Tell the user this PLAINLY, near the top of your first response:"
      echo "  \"🧠 RuvNet Brain found v$REMOTE_V (you're on v$LOCAL_V). Run this, then restart Claude Code to load it:"
      echo "  claude plugin marketplace update ruvnet-brain && claude plugin update ruvnet-brain@ruvnet-brain\""
      echo "  (Or say the word and I'll turn on auto-update so this never comes up again.)\""
      echo "Don't repeat this notice later in the same session."
      echo ""
    fi
  fi
fi

# ── read the ACTUAL installed versions (plugin AND brain bundle), live, never hardcoded ──
BANNER_V="unknown"; BANNER_D=""; BANNER_KB=""
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  BANNER_V=$(grep -m1 '"version"'  "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  BANNER_D=$(grep -m1 '"updated"'  "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null | sed -E 's/.*"updated": *"([^"]+)".*/\1/')
fi
[ -z "$BANNER_V" ] && BANNER_V="unknown"
# Record what THIS session actually loaded. The statusline (and anything else) must report the
# RUNNING version from this file — never the on-disk marketplace copy, which the background
# auto-updater refreshes ahead of the restart. Showing a staged version as if it were running
# is a trust-destroying lie ("user thinks they have the 6.2 fix; they're on 6.1").
[ "$BANNER_V" != "unknown" ] && echo "$BANNER_V" > "$STATE_DIR/.running-version" 2>/dev/null
# The brain bundle stamps its own provenance (SOURCE.json releaseTag) at build time.
[ -f "$HOME/.cache/ruvnet-brain/kb/SOURCE.json" ] && \
  BANNER_KB=$(grep -m1 '"releaseTag"' "$HOME/.cache/ruvnet-brain/kb/SOURCE.json" 2>/dev/null | sed -E 's/.*"releaseTag": *"([^"]+)".*/\1/')

cat <<EOF
[RuvNet Brain v$BANNER_V — active this session${BANNER_D:+ · last updated $BANNER_D}${BANNER_KB:+ · knowledge bundle $BANNER_KB}]
When you give the user the confidence line below, ALWAYS include the version in parentheses exactly like this: "🧠 RuvNet Brain active (v$BANNER_V${BANNER_KB:+, brain $BANNER_KB})". If they ask when it was last updated, the answer is: $BANNER_D
EOF

cat <<'EOF'
[RuvNet Brain — active this session]
The RuvNet Brain plugin is installed and ACTIVE for this session. It is USER-LEVEL: it works in every
project and every VS Code / Claude Code window on this machine — there is nothing to reinstall, nothing
to download again, and nothing to initialize per project. One brain (~/.cache/ruvnet-brain/kb), shared
everywhere. The `search_ruvnet` tool and the grounding hooks are live right now.

At the very START of your first response in this session, give the user ONE short, warm confirmation so
they have confidence it's on and know how to use it. Use roughly this (adapt naturally, keep it to 1–2 lines):

  "🧠 RuvNet Brain active — across all your projects. Ask me anything about rUv's stack (RuVector/RVF,
   Ruflo, AgentDB, SPARC, agentic-flow…) and I'll ground my answers in his real source instead of
   guessing. Not sure it's working? Run `npx github:stuinfla/ruvnet-brain --doctor` any time."

Then proceed with whatever they asked. Do NOT repeat this confirmation on later turns in the same session.
EOF
exit 0
