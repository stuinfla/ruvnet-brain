---
name: whats-new
description: Explain what is new in the installed RuvNet Brain release from live version metadata and the curated release notes. Use for "/whats-new", "what's new", "what changed", "new release", or "show me the latest Brain improvements". Never claim a 4.0 version unless the installed version actually starts with 4.
updated: 2026-07-28
---

# What is new

Ground the answer in files that exist now; do not recite release claims from memory.

1. Run the installed plugin's `scripts/whats-new.mjs` executable. It reads the version manifest and
   curated notes from the same immutable plugin payload and exits nonzero if either asset is missing.
   Do not substitute a checkout, download, or another installed version when it fails.
2. Read that command's output before summarizing it.
3. State the installed version exactly. Do not say the user is on 4.0 unless it starts with `4.`.
   For a 3.9 development version, describe verified items as "4.0-line enhancements landing in
   3.9.x", using the release note's own status language.
4. Summarize only the curated highlights and their evidence status. Never invent metrics or turn
   newly collecting measurement into proof of improvement.
5. End by offering to open the Console through the native `brain-console` workflow.

If the release notes are missing, say they are unavailable and do not fabricate a highlight.
