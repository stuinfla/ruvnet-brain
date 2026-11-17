Updated: 2026-11-17 00:42:00 EST | Version 1.0.0
Created: 2026-11-17 00:42:00 EST

# Decision log: embedding, retrieval and search

**Rule: entries are only added.** An entry is never edited or deleted. When a later entry replaces an earlier
one, the earlier one gets one added line, "superseded by <entry>", and nothing else changes. Any change to a
constant in `EMBEDDING-RECIPE.md` section (g) adds an entry here that names the new recipe version as
`recipe-version: Rn` (ADR-109; the test checks for it).

How to read an entry: date (Eastern), decision, the number that drove it, kind of basis, and where the raw
evidence is. Basis: **MEASURED** (numbers on a named set), **ASSERTED** (a stated reason, no measurement),
**INHERITED** (came with a template, library or default). "RUN" means the folder
`evals/runs/2026-11-16-knowledge-architecture/`. Entries H1 to H16 come from `RUN/history/HISTORY.md`, which
carries their original citations. Entries D0 to D19 come from `RUN/DECISIONS.md`.

---

## Part 1. Before the run (from the project history)

**H1. 2026-06-13. The build template.** 4,000-character chunks, 400 overlap, two embedders, 12,000-character
documents, a "98 average, 95 minimum" grade. INHERITED (an agent's port of earlier scripts). No evidence; the
template says it was not executed end to end. `RUN/history/HISTORY.md`.

**H2. 2026-06-27. ADR-0004 "Effectiveness first".** Use the sharpest retrieval regardless of size; reject
MiniLM-384 as "weaker on code lookups". ASSERTED (owner directive). The promised benchmark of a code-aware
embedder and bge-large was never run. `docs/adr/0004-effectiveness-first.md`.

**H3. 2026-06-27. One index per repository (ADR-0006).** Chosen on rebuild cost, not quality. ASSERTED. Never
compared with one global index. `docs/adr/0006-segment-per-repo.md`.

**H4. 2026-06-28. Keep bge-base-768 and add the ms-marco reranker.** 12 questions, one repository: MiniLM
49.5 / 81.8 against bge 31.6 / 68.0, marked "not comparable"; reranker +10 points. MEASURED (small). The
like-for-like pair favoured MiniLM and was never re-run.

**H5. 2026-06-29. First commit `1bcc60b8`.** The whole recipe already in place; 8-bit weights. INHERITED.
"Named 47/48, by-description 27/28" measured which repository or card answered, not which file.

**H6. 2026-07-07. Model revisions pinned (`0a90a380`).** ASSERTED (reproducibility).

**H7. 2026-07-09. The 120-question gate.** Scores the repository of the answer, not the file. MEASURED at
repository level: routed 63 of 80.

**H8. 2026-07-19. Global keyword-plus-meaning search reverted; kept for transcripts only (ADR-0025).** Named
battery 40 of 48 hybrid against 44 of 48 meaning only. MEASURED, in the wrong regime (a weak keyword search, on
questions that name the repository). Superseded in effect by D6 and D10 below.

**H9. 2026-07-20. Below-zero reranker results withheld; confidence label.** MEASURED on six example queries.

**H10. 2026-07-27. Card lane answers first.** 19 of 19 capability questions at repository level; 0.07 ms
against 19.6 s. MEASURED for speed.

**H11. 2026-07-28. MiniLM build retired (`3760c32d`).** ASSERTED (non-duplication, download size 806 MB to
469 MB). The retired build was the only one that embedded a title and path header. This fixed the shipped
recipe that is still current. recipe-version: R3.

**H12. 2026-07-30. Route or refuse (`453ae584`).** No reason recorded, no measurement.

**H13. 2026-09-07. Pool 8 to 64 (`c5eb2abc`).** No reason recorded.

**H14. 2026-09-11. Identifier lane.** Recall@10 0.9433 with, 0.9124 without (194 questions, repository
named). MEASURED.

**H15. 2026-09-15. The 95%-per-repository criterion (59.0%, 680 of 1,152) removed as a blocking gate,** replaced
by 194 questions with the repository named. The record calls it "a declared REDUCTION in release requirements".

**H16. 2026-10-01. Keyword lane and learned judge shipped switched off; abstain threshold not moved (ADR-0099).**
Newcomer gold in top 5: 4 of 206; with the keyword lane 10 of 206 at +2.1 s. MEASURED. A different embedder or
reranker was dismissed as "Not a rUv tool" with no measurement (ASSERTED).

## Part 2. The knowledge-architecture run, 2026-11-16 and 17 (from `RUN/DECISIONS.md`)

**D0. 6:33 p.m. Continue the run; do not restart.** The first lead's pre-registration hash matched project
memory. Starting point from the 2026-11-15 pilot: shipped Brain gold in top 6 for 3.5% of 113. `RUN/DECISIONS.md`.

**D1. 6:36 p.m. Two-stage embedder test, candidates fixed before any score (amendment A1).** A full embed costs
9 to 49 hours per model; the pool screen costs about an hour and can only flatter a candidate.
`RUN/PREREGISTRATION.md` A1.2.

**D2. 6:34 p.m. Blind questions written by four separate authors from source only.** Set E, 164 questions;
every quote re-verified by code. `RUN/instrument/E-verified.json`.

**D3. 6:42 p.m. Baseline reproduced: 4 of 113.** Gold file in top 5 for 4 of 113 development questions; 15
refused; the gold path is present in the stores for 110 of 113. MEASURED. `RUN/baseline-v1/`.

**D4. 6:45 p.m. What the corpus holds.** 73.7% of passages longer than the model's window; 50.0% of tokens never
embedded; no commits, issues, relationships or reasons stored. MEASURED.
`RUN/inventory/knowledge-type-census.json`.

**D5. 6:50 p.m. Search tool down in the session (stale node path after a Homebrew update); grounding from source
clones instead.** A product defect, listed in `RUN/architecture/ARCHITECTURE.md` section 7.

**D6. 6:57 p.m. Rebuilt chunks and a keyword lane adopted (rules R2, R3).** Same embedder, old against new
chunks: 3 against 26 of 76. Keyword plus meaning against meaning alone: 46 against 25 of 76. MEASURED, not
blind. `RUN/candidates/rig/rigA-rules.md`.

**D7. 9:00 p.m. The keyword lane is the backbone; the current vectors add nothing on blind questions.** Set E:
shipped 8 of 164; keyword 78 of 164; on the 80 vector-covered questions keyword 45, fused 37. MEASURED, blind.
`RUN/candidates/rigE/`.

**D8. 9:05 p.m. Cards and history as separate sections (post hoc).** Rules R5 and R6 not met as written; a
sectioned result held gold for 123 of 164 against 94. Cards part superseded by D10 and D13.

**D9. 9:10 p.m. Answer-level test design.** 84 questions, three arms, three runs each, blind judge that must
pass a 20-answer calibration gate. `RUN/candidates/ANSWER-SPEC.md`.

**D10. 9:52 p.m. Confirmation on fresh set F (80 questions, gold found without keyword search).** History
adopted (8 of 12, rule C2 met); keyword backbone confirmed (41 against 23 of 68, rule C3 met); card section not
adopted (52 against 46 of 80, p = 0.146, rule C1 not met). MEASURED, blind. `RUN/candidates/rigF/rigF-rules.md`.

**D11. 9:57 p.m. Nine shipped sidecar files were rewritten with identical bytes by a "read-only" open.** 9 of 9
match the release manifest; rule added: no tool opens a shipped store again.

**D12. 10:35 p.m. Answer level.** Candidate 75.7 of 100 against 25.4 with no tool (+50.3, interval 46.5 to
54.0). MEASURED, 3 runs. `RUN/candidates/answers/answers-R9.md`.

**D13. 11:12 p.m. Cards do not earn a place in the served result.** With cards 75.7, without 73.1: +2.6
(interval -0.4 to 5.7); rule (+5 and interval excluding zero) not met. Served result = files + history.

**D14. 11:25 p.m. Two gaps.** Gold reached the answer in 72.5% of answers (amateurs 54.0%); when it did, 72%
of answers reached 8 of 10. 98% is not reachable or measurable with today's layers and 84 questions.
`RUN/candidates/answers/answers-gold-served.md`.

**D15. 11:24 p.m. Owner direction: no embedder verdict until rUv's own retrieval stack is examined.** Stage 2
re-embed not started.

**D16. 11:55 p.m. Gold-narrowness audit.** Of 110 sampled misses, 6 were in fact sufficient; file recall
under-counts by about 3 points. MEASURED. `RUN/candidates/gold-audit/gold-audit.md`.

**D17. 11:48 p.m. Informed-query ladder and blind query rewriting registered (amendment A4).** Not run to a
result.

**D18. 12:05 a.m., 2026-11-17. Research first; jobs paused; plan redrawn around rUv's memory design.** No
RuVector-native retrieval embedder exists; the proposal is short cue sentences with a small model and a graph
walk. `RUN/REPLAN.md`, `RUN/PAUSED.md`.

**D19. 12:20 a.m., 2026-11-17. Overnight plan.** Slice build in tiers with two fixed looks; set G (120 amateur
questions) verified; a dated survey delegated. Amendments A7, A8.

## Part 3. This record

**R-1. 2026-11-17. The research record and the recipe page become part of the product (ADR-109, Proposed).**
The current shipped recipe is recorded as recipe-version: R3, last changed 2026-07-28, digest 622e012e1dc0.
Enforced by `tests/unit/embedding-recipe-record.test.mjs`.

**R-2. 2026-11-17, 12:43 a.m. Set G verified and scored at lane level.** 120 amateur problem-only questions
(sha256 `48919a09…`). Right file in top 5: keyword 15, current vectors 12, fused 17 to 18 of 120; in the first
100: 37 to 47. Decision: the amateur gap is a candidate-reach problem, not only an ordering problem; the cue and
graph designs of section (f) are the ones aimed at it. MEASURED. `RUN/candidates/rigG/rigG.table.md`.

**R-3. 2026-11-17, 12:36 a.m. Amendment A9 after the dated survey.** Methods released in 2025 and 2026 registered
before any score (caller-side reasoning rewrite, a 23-million-parameter need-sentence embedder, four for the next
programme). Basis: published numbers, recorded as context, not targets. `RUN/SURVEY-2026.md`,
`RUN/PREREGISTRATION.md` A9 (hash `6891800a…`).

**R-4. 2026-11-17, 12:44 a.m. Amendment A10: guiding is measured separately from finding and answering.**
Owner clarification that the Brain must guide a novice from goal to working plan. Set H and the guidance-success
rule registered before set H exists. `RUN/PREREGISTRATION.md` A10 (hash `8bde58a6…`).

**R-5. 2026-11-17, 12:30 to 12:40 a.m. Load incident.** This run's jobs pushed machine load above 200 (BISECT
records 200 to 320) and broke other runs: the June and July bisect arms timed out and are unfinished
(`RUN/history/BISECT.md` header and section 5). Rule since, as relayed by the run's lead: one heavy local job
at a time, started only below load 60; model-call jobs throttled by load. This rule is not yet written in
`RUN/DECISIONS.md`.

