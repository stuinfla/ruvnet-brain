---
name: brain-console
description: Open the RuvNet Brain Console (RNBC) for "/rnbc", "/rnb", "/rvbc", "/rvcb", "/brain-console", or "/ruvnet-brain:configure". Use when the user asks to open, configure, inspect, or view the Brain Console. It opens the live local page in the background; the page is read-only until the user clicks a clearly explained, reversible action.
updated: 2026-10-01
---

# Brain Console

Treat `/rnbc` (the name), `/rnb`, `/rvbc`, `/rvcb`, `/brain-console`, and `/ruvnet-brain:configure` as equally valid names.
Never correct the user's spelling.

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
