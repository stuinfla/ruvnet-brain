#!/bin/sh
# RuvNet Brain — SessionStart hook. THE CONFIDENCE SIGNAL.
# The #1 UX failure of a background plugin is the user not knowing it's even on. This fires once when
# a Claude Code session starts (in ANY project / VS Code window) and instructs the model to surface a
# brief, friendly confirmation so the user KNOWS the brain is active and how to use it — answering the
# exact questions a newcomer has ("is it on? do I reinstall per project? how do I use it?").
# stdout is injected into the session context at startup; ALWAYS exit 0 so it can never block a session.
set +e

# ── heartbeat: rate-limited (~once/20h) check against the live GitHub plugin.json ──
# Read-only HTTPS GET only — no claude-CLI recursion from inside a live session's own hook (untested,
# risky territory), and an update needs a restart to apply either way, so a background silent-apply
# buys nothing over a clear, prominent notice. Best-effort: any failure here is silently ignored, and
# curl has a hard 3s cap, so this can never meaningfully delay or block session start.
STATE_DIR="$HOME/.cache/ruvnet-brain"
STAMP="$STATE_DIR/.last-update-check"
mkdir -p "$STATE_DIR" 2>/dev/null
NOW=$(date +%s 2>/dev/null || echo 0)
LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ "$NOW" -gt 0 ] && [ $((NOW - LAST)) -gt 72000 ]; then
  echo "$NOW" > "$STAMP" 2>/dev/null
  LOCAL_V=""
  [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ] && \
    LOCAL_V=$(grep -m1 '"version"' "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  REMOTE_V=$(curl -fsS --max-time 3 \
    "https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/plugin/.claude-plugin/plugin.json" 2>/dev/null \
    | grep -m1 '"version"' | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  if [ -n "$LOCAL_V" ] && [ -n "$REMOTE_V" ] && [ "$LOCAL_V" != "$REMOTE_V" ]; then
    echo "[RuvNet Brain — I just got smarter! v$REMOTE_V is available (you're on v$LOCAL_V)]"
    echo "Tell the user this PLAINLY and UNMISSABLY, near the top of your first response — this is a required action, not a footnote:"
    echo "  \"🧠 RuvNet Brain got an update (v$LOCAL_V → v$REMOTE_V available). Run this, then QUIT AND REOPEN Claude Code to load it:"
    echo "  claude plugin marketplace update ruvnet-brain && claude plugin update ruvnet-brain@ruvnet-brain\""
    echo "Restarting is REQUIRED — Claude Code's own plugin system cannot hot-swap a running session, in any window. Don't repeat this notice later in the same session."
    echo ""
  fi
fi

# ── read the ACTUAL installed version + its stamped update date, live, never hardcoded ──
BANNER_V="unknown"; BANNER_D=""
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  BANNER_V=$(grep -m1 '"version"'  "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  BANNER_D=$(grep -m1 '"updated"'  "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null | sed -E 's/.*"updated": *"([^"]+)".*/\1/')
fi
[ -z "$BANNER_V" ] && BANNER_V="unknown"

cat <<EOF
[RuvNet Brain v$BANNER_V — active this session${BANNER_D:+ · last updated $BANNER_D}]
When you give the user the confidence line below, ALWAYS include the version in parentheses exactly like this: "🧠 RuvNet Brain active (v$BANNER_V)". If they ask when it was last updated, the answer is: $BANNER_D
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
