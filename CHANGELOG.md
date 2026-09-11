# Changelog

All notable changes to RuvNet Brain are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Entries below "Unreleased" are facts about
what shipped in a given release; the "Unreleased" section tracks work in progress across the
current campaign and is finalized by the lead session before the next release cut.

## Unreleased

Campaign context: a dual North-Star review (Fable 5.1 + GPT-6 Astra) measured this project at
31/100 against commit `2eef2024` (see `PROGRESS.md`'s 2026-09-11 entry for the full per-pillar
breakdown and provenance). The following lanes are running in parallel worktrees to close the
accepted six recommendations; bullets below are facts about what each lane has done so far, not
a claim that any lane's work is complete or released.

- **docs (this lane)** — in progress. Reviewed all 17 non-reserved `presumed-stale` ADRs against
  exact governed-code drift at `2eef2024`, recording a dated, digest-bound Currency-log row on
  each; found and corrected two real drift defects (ADR-013's duplicated unbuilt `governs:` claim
  naming files that never existed in git history; ADR-072's stale reference to a workflow file
  deleted 2026-09-04). Corrected README's version stamp (4.3.10 → 4.3.21) and coverage badge
  (41% → 42%, re-derived) via `scripts/version.mjs` / `npm run claims:fix`. Added the 2026-09-11
  PROGRESS.md campaign entry. Six ADRs (0058, 0063, 0067, 0073, 0074, 0075) remain reserved for
  the lead to finalize post-integration.
- **continuity** — in progress. Scope per the dual review: build a verified AgentDB continuity
  lifecycle; current measured state is capture (4.4s) and restore (5.1s) both working in
  isolation, but SessionStart's 2.5s deadline against ~3s per `ruflo` CLI call leaves continuity
  structurally UNKNOWN at the point it is meant to fire.
- **advocacy** — in progress. Scope per the dual review: proactive-activation scoping and outcome
  recording; current measured state is Claude mean 2.17/3 vs Codex mean 1.33/3 on a 6-positive/
  2-negative real-host cross-vendor graded test, with Codex never calling `search_ruvnet`.
- **grounding** — in progress. Scope per the dual review: retrieval hang/recall/freshness/
  duplicate fixes; current measured state is strict 41.7 / real-use 55.1 on an 18/25 GPT-6 Astra
  graded sample, 0/8 CLI-repo-KB freshness at `2eef2024`, and an unbounded hang on a
  `@claude-flow/…`-scoped query (>15 min, no timeout).
- **ops** — in progress. Scope per the dual review: corpus maintenance and progress monitoring;
  current measured state includes a 6-hour nightly gists-embed hang (32/394, all 8 shards) that
  the watchdog reported as OK, an unregistered `brain-update` refresh job, and the `ruflo`
  3.40.0 → 3.41.2 upgrade (export path fixed; import still writes `agentdb-memory.db`, tracked
  upstream as Ruflo #3196, open).
- **session-start** — in progress. Scope per the dual review: credential containment and
  source-bound QA/release/diagnostic verdicts at the session-start boundary.

Design drafts ADR-076 and DDD-0021 were written during this campaign and dual-reviewed; the
verdict on both was **changes requested** (Fable 57/100, Astra 46/100). They are being revised
and are not an accepted decision — no lane should treat either as settled.
