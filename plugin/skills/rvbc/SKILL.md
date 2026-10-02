---
name: rvbc
description: Open the RuvNet Brain Console in Claude Code and Codex when the user says "Configure RuvNet Brain", mentions "rvbc" or "rnbc", asks for the Brain Console, or wants to configure or inspect RuvNet Brain. Claude Code supports /rnbc and /rvbc; Codex invokes the native $ruvnet-brain:rvbc skill (or $ruvnet-brain:rnbc).
updated: 2026-10-01
---

# RuvNet Brain Console

“Configure RuvNet Brain” opens this Console in Claude Code and Codex. Claude Code also supports
`/rvbc`; Codex invokes this skill as `$ruvnet-brain:rvbc` because custom plugin slash commands are
not part of the Codex CLI slash-command surface.

1. Say one short sentence: "Opening it now; it scans live while you watch."
2. Resolve the installed runtime at
   `${RUVNET_BRAIN_KB:-$HOME/.cache/ruvnet-brain/kb}/.console-runtime/scripts/onboarding-console.mjs`.
   A current-repository `scripts/onboarding-console.mjs` is allowed only for an explicit developer
   checkout. Never fall back to a guessed `~/Code` path.
3. Run `node <resolved-script> --serve --open` in the background.
4. Give the URL immediately. Do not promise a duration; the page reports its own scan progress.

An already-running server is success. The Console is read-only until the user chooses an action;
every change must be explained and reversible. If the script cannot be located or the server fails,
report the exact failure plainly instead of claiming the Console opened.
