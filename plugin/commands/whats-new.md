---
description: "What's new in RuvNet Brain — the big things in the current MAJOR release (4.0), in plain English. Not the point-release churn — the headline changes since 3.x. Ends by offering to open the Console so you can see it live."
updated: 2026-07-25
---

# RuvNet-Brain: what's new

The user wants the headline story of the **major** release they're on — the 4.0-vs-3.0 kind of change,
**not** the "3.9.x → 3.9.y" point-release churn. Deliver it warmly and honestly, then offer the Console.

**First, ground — never recite this from memory (it drifts every release):**
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/whats-new.mjs"`. This reads the running version and curated
   notes from the same immutable installed payload. If it exits nonzero, report that exact failure;
   do not substitute a checkout, download, or another installed version. State the version honestly.
   **Do NOT claim "you're on 4.0"** unless the version literally starts with `4.` — per ADR-042 the
   number stays `3.9.x-dev` until the 4.0 line is field-verified. The honest framing is: *"these are the
   4.0-line enhancements, and you already have them — the version stamps to 4.0 once they're proven in
   real use."*
2. Treat the executable's notes as the source of truth — summarize them, don't invent beside them,
   and carry their honest version framing.

**Then tell them what the 4.0 line is — the honest headline (adapt to the notes file; do NOT overclaim):**

The 4.0 line is where the brain got **honest, legible, fast, and self-measuring** — landing now in the
3.9.x releases. The big things:

- **The Console is the front door.** One live local page (type `/rvbc`) — your whole RuvNet stack on
  one screen: what's installed, what the AI has actually learned from *your* projects (real memories +
  distilled lessons, drill-down to the verbatim cards), which subscription pays for what, and one-click
  **reversible** fixes for anything stale. New in 4.0: a plain-English explainer on every card, each
  suggestion labelled with its blast radius (*just this project* vs *every project*), safe on/off
  checkboxes that only appear where the undo is proven, and a terminal-first install.
- **It will not lie about your machine.** Every number is measured live; "we couldn't check" never
  renders as "off"; one project's state can never leak into another's view.
- **Fast, and it tells you when it's ready.** The console and tips page paint in well under a second;
  on a first scan it shows a countdown and then says *"it's live — take a look at your page,"* so you're
  never staring at nothing.
- **It measures itself now.** The brain records when it offered help and whether you acted on it, so it
  can *prove* it's improving rather than assert it. **Be honest that this has only just started
  collecting** — the proof accrues as you use it; it is not a claim of "proven better" yet.
- **It learns across your projects.** A lesson proven in one project can be promoted to your global
  brain and now survives an update (tested against the real updater, not argued).
- **Runs on your account, cheapest capable model.** The QE suite and routing use your Claude account,
  not an API key, at the least-powerful model that does the job.

**Then offer the Console (the point of the whole thing):**

End by offering to open it: *"Want me to open the Console so you can see all of this live? Just say the
word — or type `/rvbc`."* If they say yes, follow `rvbc.md` in this same directory exactly (including the
warm heads-up about the ~20s scan).

**Honesty rules for this command (same as the product):**
- If the installed executable fails, report its failure and do not fabricate a highlight.
- Never claim a metric ("40% better", "95/100") the release has not independently earned. The self-
  measurement is new and still filling; say so plainly.
- This is the MAJOR story only. If the user wants the point-release detail, point them at the repo's
  release notes / `git log`.
