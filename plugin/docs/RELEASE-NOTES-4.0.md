# RuvNet-Brain 4.0 line — what's new (the major-release highlights)

Updated: 2026-08-01

> **Source of truth** for the `/whats-new` command and the first-run upgrade message. Curated, honest,
> major-only — not the point-release churn. If a claim here isn't true of the shipping build, it does not
> belong here. The self-measurement claims are deliberately hedged: they are *new and filling*, not
> *proven*.
>
> **VERSION STATUS:** the public release line is now 4.x. Publication does not erase the remaining
> acceptance obligations: the exact public artifact must still pass the fail-closed release contract
> through fresh Claude Code and Codex hosts. Anything not proven through that boundary is listed as a
> limitation, never converted into a capability claim.

**One line:** the 4.0 line is where the brain got **honest, legible, fast, and self-measuring** — and
it's landing now.

## The big things

### Release proof is fail-closed
The 4.0 release path now separates a clean candidate seal from a post-publication seal. Dirty
lineage, zero/skipped/todo tests, open issues, red or pending exact-SHA workflows, a missing
`ruvnet-brain` self-RVF store, weak query-deadline margin, missing independent graders,
host/artifact mismatches, and public-byte drift are release failures rather than warnings.
`npm run release:proof -- --status --quick` shows the current live blockers.

### 1. The Console is the front door
Type `/rvbc` and your whole RuvNet stack is on one live local page: what's installed, what the AI has
actually learned from *your* projects (real memories + distilled lessons, drill-down to the verbatim
cards), which subscription pays for what, and one-click **reversible** fixes for anything stale. New in
4.0:
- a plain-English **explainer on every card** (no more guessing what "trust & provenance" means),
- every suggestion carries its **blast radius** — *just this project* vs *every project · this machine*,
- **safe on/off checkboxes** that appear *only* where the undo is proven,
- a **terminal-first install** — the granular "here's exactly what I'll do, uncheck any of it" flow runs
  in your terminal, where an `npx` user expects it.

### 2. It will not lie about your machine
Every number is measured live from your setup. **"We couldn't check" never renders as "off."** One
project's state can never leak into another project's view (a real bug 4.0 fixed in the console itself).
Empty-first, honest-always.

### 3. Fast — and it tells you when it's ready
The console and tips page paint in **well under a second** (measured, with a QE suite that runs every
time). On a first scan it shows a **countdown** and then says *"it's live — take a look at your page,"*
so you're never staring at a blank screen wondering if it hung.

### 4. It measures itself now
The brain records when it offered help and whether you acted on it — so over time it can **prove** it's
improving instead of asserting it. **Honest caveat:** this instrumentation is *new* and has only just
started collecting. 4.0 is not a claim of "proven better in the field" — it is the release that makes
that proof *possible*, and the evidence accrues as you use it.

### 5. It learns across your projects
A lesson proven in one project can be **promoted to your global brain** and applied everywhere — and it
now **survives an update** (tested against the real updater, not argued).

### 6. Runs on your account, cheapest capable model
The QE suite and model routing use **your Claude account, not an API key**, at the least-powerful model
that does the job. Nothing bills silently.

### 7. Claude Code and Codex share one active runtime
Both hosts are wired to the same Stable Spine generation: the MCP search shell, lifecycle hooks,
skills and update behavior advance as one versioned runtime instead of being installed as unrelated
copies.

### 8. Source grounding is an RVF-native product surface
The Brain searches per-repository RuVector RVF stores, joins hits to their source passages, and
returns cited repository paths. Model memory is not accepted as evidence for rUv-stack claims.

### 9. Quality and harness workflows are explicit
Agentic-QE is the testing fleet. Harness scoring evaluates the orchestration layer, and cost-aware
routing can select cheaper capable models when the required provider access is configured. These are
named workflows a user can request, not silent substitutes.

## What 4.0 deliberately does NOT claim
Stated up front because overclaiming is the one thing this product cannot do:
- **Not** "proven X% better" — the outcome ledger is still filling (see #4).
- **Not** "fully proactive / anticipatory" — the brain still mostly speaks when you open the console or
  ask; the in-session, unprompted surface is the next frontier, not a shipped 4.0 guarantee.
- **Not** independently graded ≥95 on the exact public artifact. A score is not a release substitute.
- **Not** fully accepted while any critical exact-artifact, host, retrieval, version-convergence or
  recovery invariant is FAIL, UNKNOWN, skipped or mocked-only.

## For upgraders
On the first real major-version transition, the installer/session experience presents the concise
highlights once. Run `npx ruvnet-brain --whats-new` at any time to read this full list again, or
`npx ruvnet-brain --what-changed` to inspect the exact machine footprint and undo path for each piece.
