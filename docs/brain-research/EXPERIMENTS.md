Updated: 2026-11-17 00:42:00 EST | Version 1.0.0
Created: 2026-11-17 00:42:00 EST

# Experiment log: embedding, retrieval and answers

**Rule: entries are only added.** A result is never edited. A later result that changes the reading of an
earlier one is a new entry that names the earlier one. An entry recorded "in progress" or "paused" gets one
added line when it finishes; its original text stays.

Each entry: the question, the rule fixed beforehand (with the pre-registration clause and file hash where one
exists), the result with numbers and n, what it changed, and where the raw files are. "RUN" means
`evals/runs/2026-11-16-knowledge-architecture/`. The pre-registration is `RUN/PREREGISTRATION.md`; its hashes
per version are in `RUN/PREREGISTRATION.sha256` (v1.0.0 `0b256a44…`, v1.1.0 `ced017c9…`, v1.2.0 `13834c57…`,
v1.3.0 `26ab2942…`, v1.4.0 `6c2c5099…`, v1.5.1 `3c77522a…`, v1.6.0 `84faed8e…`, v1.7.0 `36961567…`, v1.8.0
`d15a52cf…`; v1.8.0 re-hashed by me on 2026-11-17 and it matches).

Words: **gold file** = the file the question's author marked as holding the answer. **top 5** = among the
first five distinct files returned. **Blind** = questions written by authors who never saw the system under
test. **McNemar p** = a standard test for paired yes/no results; below 0.05 is the usual bar. **Lexical** =
keyword search (BM25, SQLite FTS5 with rUv's Lucene-style analyzer). **Dense** = search by embedding vectors.

---

## Part 1. Before the run (from `RUN/history/HISTORY.md`, which carries the original citations)

**X1. 2026-06-28. MiniLM-384 against bge-base-768, and the reranker.** Rule beforehand: none. Result: 12
questions, one repository: MiniLM 49.5 / 81.8 (one grader), bge 31.6 / 68.0 (three graders), marked "not
comparable"; reranker +10 points. Changed: bge kept, reranker adopted. Raw: `PROGRESS.md:1176-1205`.

**X2. 2026-07-09. First 120-question gate.** Rule: frozen questions. Result: grounded 100 of 100, routed 63 of
80 (repository level). Raw: `evals/runs/2026-07-09-baseline.md`.

**X3. 2026-07-18/19. Global hybrid search.** Rule: none. Result: named battery 40 of 48 hybrid against 44 of 48
dense; meeting exam 20 of 50 against 16 of 50; transcript keyword lane 3 of 28 to 25 of 28. Changed: global
hybrid reverted, transcript lane kept. Raw: `docs/adr/0025-hybrid-retrieval-and-self-retrieval-gate.md`.

**X4. 2026-07-27. Reranker shortcuts.** Pool cap: -30% time, one answer lost in 24. Cascade: 40.3 s to 16.4 s on
24 questions. Changed: both left off. Raw: `RUN/history/HISTORY.md` (July 27 entry).

**X5. 2026-09-15. Identifier lane A/B.** Recall@10 0.9433 with, 0.9124 without, 194 questions, repository
named. Changed: lane kept.

**X6. 2026-09-15. Owner's criterion C3.** Supporting evidence in top 5 per repository: 680 of 1,152 (59.0%).
Changed: removed as a blocking gate.

**X7. 2026-10-01. First newcomer test (ADR-0099).** 206 questions, one gold file each. Result: gold in top 5
for 4 of 206; abstained 202. Keyword lane on: 10 of 206, recall gate 162 to 165 of 182, +2.1 s median. Deeper
pool (160): 0 gained, median 14.9 s to 25.0 s. Abstain at -4: confident wrong files 5 to 61 of 206. Learned
judge: failed. Generated newcomer questions: gold reaches the pool for 28 of 43 with the new lane. SONA adapter:
harness written, never run. Raw: `docs/adr/0099-self-learning-retrieval.md`, `evals/runs/2026-10-01-retrieval-4.5/`.

**X8. 2026-09-29 to 2026-11-16. Nightly receipts.** 182 questions, repository named: 161 to 163 of 182 every
night across 45 bundles. Raw: each corpus release's recall receipt, as read in `RUN/history/BISECT.md`
section 3.

**X9. 2026-11-15. Audit and pilot.** 64 fresh questions: Brain 65.9 of 100, no Brain 45.2; right repository top
6 84%, right file 11%. Pilot (development questions, not blind): same embedder, chunks of at most 480 tokens
with a path header: 10.5% to 73.7% (n = 19); lexical lane 52.6% (n = 76); summaries with per-question vectors
28.9% to 52.6% (n = 76); answers 82.6 of 100. Chunk size itself not tested. Raw:
`~/RVF-KnowledgeBases/ruvnet-brain-v2-work/RECIPE.md` (outside the repository).

## Part 2. The knowledge-architecture run, 2026-11-16 and 17

**E1. Baseline on development questions.** Rule: none (declared non-blind). Result: 113 questions through the
shipped reader: gold in top 5 for 4 of 113 (novice 0 of 51); 15 refused; gold path present for 110 of 113;
median 5.0 s. Changed: the starting point. Raw: `RUN/baseline-v1/`. (DECISIONS D3.)

**E2. Chunking (rule R2, v1.0.0).** Rule: rebuilt chunks of at most 480 tokens must beat shipped chunks on dense
gold-in-top-6 by at least 20 points, n at least 50. Result: 26 against 3 of 76 (+30.3 points, 24 gained, 1
lost). MET. Changed: rebuilt passages adopted for the target design. Raw: `RUN/candidates/rig/rigA-rules.md`.

**E3. Lexical lane (rule R3, v1.0.0).** Rule: fused must beat dense alone by at least 10 points in top 5. Result:
46 against 25 of 76 (lexical weight 2); lexical alone 40. MET. Raw: same file.

**E4. Summaries with newcomer questions (rule R4, v1.0.0).** Rule: novice +10 points, p below 0.05, no other kind
down more than 3 points. Result: novice 13 to 20 of 35 (p = 0.016) against the weight-2 fused base; "tight" kind
-7.7 points (1 of 13 questions). NOT MET on the side condition. Raw: same file.

**E5. Blind set E, lanes.** Set: 164 questions, four authors, 853 file quotes and 57 history quotes re-verified
by code (`RUN/instrument/E-verified.json`, sha256 `60dd9b5a…`). Result in top 5: shipped 8 of 164 (9 counting
everything it returned); lexical 78 of 164 (71 gained, 1 lost); by asker: amateur 16 of 56, practitioner 40 of
70, expert 22 of 38; paraphrase pairs both found 0 of 8. Dense on the 80 it covers: 24; lexical 45; fused 37.
Glossary expansion 62 of 164 (rejected). Raw: `RUN/candidates/rigE/`. (D7.)

**E6. Cards and history fused into the ranking (rules R5, R6, v1.0.0).** R5: cross-repo and design-rationale
all-gold in top 5 +10 points. Result: cross-repo 0 of 22 for every lane. NOT MET. R6: history gold indexed 1 of
21 to 21 of 21, but no history item reaches the top 20 at fusion weight 1. NOT MET. Post hoc (labelled as such):
sectioned result 123 of 164 against 94. Raw: `RUN/candidates/rigC/rigC-R5.md`, `rigC-posthoc.md`. (D8.)

**E7. Confirmation set F (amendment A2, v1.2.0, hash `13834c57…`).** Set: 80 questions, two new authors, gold
found without keyword search (`RUN/instrument/F/F-verified.json`, sha256 `436ac29b…`). C1 sections against
lexical at 14 slots: 52 against 46 of 80 (+7.5, p = 0.146); amateurs 15 against 11 of 32. NOT MET. C2 history
section: 8 of 12. MET. C3 lexical against dense: 41 against 23 of 68 (p = 0.0005). MET. Fused against lexical:
39 against 41 (weight 2), 33 against 41 (equal). Changed: history adopted; lexical backbone confirmed; card
section not adopted. Raw: `RUN/candidates/rigF/rigF-rules.md`. (D10.)

**E8. Answer level (rules R8, R9, v1.0.0; design `RUN/candidates/ANSWER-SPEC.md`).** Rule: 3 runs per arm;
mechanical citation caps; judge counts only after a 20-answer calibration gate (at least 18 within one point).
Gate: PASSED, 18 of 20. Result on 84 questions of E: no tool 25.4 of 100; files + history + cards 75.7; C minus
A +50.3 (interval 46.5 to 54.0), R9 threshold 15: MET. Shipped product arm: no complete run. Raw:
`RUN/candidates/answers/answers.table.md`, `answers-R9.md`. (D12.)

**E9. Cards ablation (rule fixed in D12 before the result).** Rule: cards stay only if C minus D is at least +5
with an interval excluding zero. Result: 75.7 against 73.1, +2.6 (interval -0.4 to 5.7). NOT MET. Where a card
covers the gold: +5.3 (0.4 to 10.3), a subgroup only. False claims 15 with cards, 29 without (a count, not
tested). Changed: served result = files + history. Raw: same files. (D13.)

**E10. Found against answered (no threshold).** Gold reached the answering session in 72.5% of answers (amateurs
54.0%, experts 91.7%); with gold served 125 of 174 answers reached 8 of 10 (72%), without 22 of 66 (33%). 17 of
84 questions cross the bar between runs. Raw: `RUN/candidates/answers/answers-gold-served.md`. (D14.)

**E11. Gold-narrowness audit (gate fixed in advance).** Rule: calibration gate on 20 positive and 20 negative
controls. Gate: PASSED. Result: of 110 sampled misses, 6 sufficient, 26 partial, 78 insufficient; corrected
top-5 rates lexical 57.5% to 60.3%, dense 30.5% to 32.8%, shipped 5.3% to 10.0%. Raw:
`RUN/candidates/gold-audit/gold-audit.md`. (D16.)

**E12. Embedder screen (rule R1, amendments A1, A3, A5; v1.1.0, v1.3.0, v1.5.1).** Rule: a candidate must raise
dense top-5 by 10 points and fused by 5 points, p below 0.05, on pooled and blind questions with the same
weighting; small rUv-default models judged by non-inferiority (A5.2). Result so far, development pilot only
(n = 76): arctic-embed-m-v1.5 dense 36 against 25 (p = 0.019), fused 48 against 42 / 46 against 45;
gte-modernbert-base dense 42 against 25 (p = 0.0001), fused 51 against 42 / 49 against 45. **INCOMPLETE and
PAUSED** (owner order, 12:00 a.m. 2026-11-17): no blind pass finished; nomic stopped at 13,504 of 17,502
passages; all-MiniLM-L6-v2, bge-small, jina-code, bge-large and embeddinggemma not started. No verdict. Raw:
`RUN/candidates/rig/rigB-R1-final.md`, `RUN/candidates/rig/PAUSE-STATE.md`.

**E13. Re-ranker, reduced form U6-lite (amendment A5.L1, v1.5.1).** Rule: `mxbai-rerank-xsmall-v1` against the
ms-marco control as a rank contribution, never a cut-off; +5 points overall, +10 on amateurs, p below 0.05,
median added latency at most 1.5 s. **IN PROGRESS** as of 12:35 a.m. 2026-11-17: resumed by the parent
session at 12:06 a.m.; both models downloaded; scripts written; no stage-0 check or score yet. Raw:
`RUN/candidates/rerank/`.

**E14. Slice build: need index, graph walk, hierarchy, typed abstention (amendments A6, A7, A8; v1.6.0 to
v1.8.0).** Rule: two looks fixed in A8.3; rules judged on look 2 only. **IN PROGRESS** as of 12:35 a.m.: the
extraction pass is running (9,029 units listed); no frozen settings file and no look yet. Raw:
`RUN/candidates/slice/`.

**E15. Set G, 120 amateur problem-only questions (clause G3).** Verified: all 251 quotes re-verified, none
dropped (`RUN/instrument/G/G-verified.json`, sha256 `48919a09…`); 65 lie wholly in the slice. Lanes on G
started (`RUN/candidates/rigG/`); no table yet as of 12:35 a.m.
Added 12:43 a.m.: first lane table on G (no adoption rule attached), right file in top 5 of 120 amateur
questions: lexical 15 (12.5%), dense 12 (10.0%), fused 17 or 18; no difference distinguishable (p 0.51 to
0.63). Raw: `RUN/candidates/rigG/rigG-rules.md`, `rigG.table.md`.

**E16. Informed-query ladder and blind rewriting (amendment A4, v1.4.0).** **PAUSED** with partial data (80
informed query sets; lexical lane on 240 ladder queries; 191 of 210 blind rewrites). No result. Raw:
`RUN/candidates/ladder/PAUSE-STATE.md`.

**E17. Answer level on set F.** **PAUSED**: 480 answers written and mechanically checked, not judged. Raw:
`RUN/candidates/answers-F/`.

**E18. Bisect of old releases (no pre-registered rule; reproduction).** 80 fixed questions through each
release's own code and corpus. Result so far: 4.0.36 (2026-08-08): right file in top 5 for 0 of 60, "Searched
0 RuvNet repos" for 45 of 80, a card answer for 18 of 80; 4.7.28 code with the 2026-11-16 corpus (54 of 80
asked): 3 of 54. **IN PROGRESS**: the June and July releases (before the route-or-refuse change) not yet
measured. Raw: `RUN/history/BISECT.md`, `RUN/history/bisect/`.
Added 12:43 a.m.: BISECT.md v1.0.0 records the July 27 and June 29 arms as NOT FINISHED (timeouts under load).

**E19. Full-precision against 8-bit weights (amendment A8.5, v1.8.0).** Registered; runs only after look 1 of
E14. Not started.

**E20. Set G, lane table (added 2026-11-17, 12:50 a.m.; no adoption rule attached on G).** 120 amateur
problem-only questions, gold found without keyword search (`RUN/instrument/G/G-verified.json`, sha256
`48919a09…`). Right file in top 5: lexical 15 of 120 (12.5%), current vectors 12 (10.0%), fused 17 (weight 2)
or 18 (equal); no difference distinguishable (p 0.51 to 0.63). Right file anywhere in the first 100: lexical
37, vectors 35, fused 45 or 47. Reading: for amateurs the right file is mostly not even among the candidates.
Raw: `RUN/candidates/rigG/rigG.table.md`, `rigG-rules.md`.

**E21. Dated survey of 2025-2026 retrieval methods and amendment A9 (2026-11-17, 12:36 a.m.; v1.9.0, hash
`6891800a…`).** The survey (`RUN/SURVEY-2026.md`, every source read 2026-11-17) found that on the public BRIGHT
test of vague questions keyword search scores 14.5 to 14.8 nDCG@10, the best retriever with no language model on
the query about 37, and every disclosed result above 50 uses a language model on the query. A9 registers, before
any score: a caller-side reasoning rewrite (A9.1, rule: +10 points on amateurs over E, F and G, p below 0.05);
`MongoDB/mdbr-leaf-ir` as a need-sentence embedder candidate (A9.2); four methods for the next programme (A9.3).
No result yet.

**E22. Amendment A10, build guidance (2026-11-17, 12:44 a.m.; v1.10.0, hash `8bde58a6…`).** Set H of about 40
novice goal questions, gold = the author's own ordered plan with quotes. Success = score at 8 or above, at least
two thirds of gold capabilities named, workable order (A10.2). A guidance layer is admitted at +10 points over
files + history with a 95% interval excluding zero and no rise in false claims (A10.3). Set H not yet written.
Raw: `RUN/PREREGISTRATION.md` A10.

**E23. Set F at answer level (added 2026-11-17, 1:40 a.m.).** 80 blind questions, 3 runs, blind judge (re-judge
of 30: 28 identical, 30 within one point). No tool 23.8 of 100; keyword + history 77.8; difference +54.0
[49.6, 58.1]. Questions at 8 of 10 or better in at least 2 of 3 runs: experts 16 of 17, practitioners 24 of 31,
amateurs 17 of 32. The right source reached the answering session in 81.3% of answers (amateurs 75.0%).
Raw: `RUN/candidates/answers-F/answers.table.md`, `answers-gold-served.md`.

**E24. Blind query rewriting, rules A4.2 and A9.1 (added 2026-11-17, 1:45 a.m.): NOT MET.** 330 questions.
Replacing the question with three model rewrites: E 78 to 53 of 142; F 41 to 30 of 68; experts -27.1 points.
Second arm (original list plus four lists from a kind label, queries and terms): E 54.9% to 53.5%, F 60.3% to
61.8%, G 12.5% to 34.2%, all amateurs 21.4% to 35.4%, practitioners -5.6 points (fails the "no group down by
more than 3" condition). A query written with the answer in view (upper bound) finds 41 of 51 against 17.
Reading: the query is a large lever for people who state only a problem, and rewrites must be added to the
user's words, never replace them. Raw: `RUN/candidates/ladder/a42.md`.

**E25. Slice look 1 (added 2026-11-17, 2:55 a.m.): INTERIM, no rule declared, build failed its soundness
checks.** Seven stores, 178 blind slice questions, 1,617 of 9,029 units extracted, settings frozen and hashed
before any blind score, ten files against ten. Right file served, amateurs (n = 101): shipped 4.7.28 1; keyword
lane 18; keyword + history 17; keyword 5 + need index 5: 46; keyword 5 + graph walk 5: 50 (33 gained, 1 lost).
Problem-only questions of set G (n = 65): 0, 5, 5, 28, 28. Practitioners and experts: no meaningful change.
Failed checks: a held-out generated question returns its own file within 5 for 42.9% (gate 90); the walk gives
the same first five in separate processes for 52.6% to 87.5% (gate 99; cause found: edge order; amendment A15
registers a sort for look 2); the evolutionary loop did not generalise on the tuning half (0.536 against 0.562
for rUv's default settings); capability centroids landed worse than the nearest cue (199 against 337 of 920).
Leak checks clean. Cue-sentence embedder chosen by the registered screen: `MongoDB/mdbr-leaf-ir`; four
candidates within 5 points. Raw: `RUN/candidates/slice/look1-tables.md`, `FROZEN.md`, `look1-checks.md`.

**E26. Guidance, set H, rule A10.3 (added 2026-11-17, 2:55 a.m.): NOT MET.** 40 novice goal questions, 3 runs;
the judge's calibration passed at exactly its bar (21 of 25). Mean score of 100: no tool 18.2; keyword + history
45.8; plus a GUIDE section of rUv's playbooks and need rows chosen by keyword match 46.8 (+1.7 [-2.5, 6.7] on
guidance success). Guidance success in at least 2 of 3 runs: 0, 4 and 4 of 40. Tools named 66% to 70% of gold;
workable order 48%. The GUIDE section carried two thirds of the gold tools in 0 of 120 answers. Guiding is the
largest gap measured. Amendment A16 registers guidance through the capability landing on the same set (second
use of H). Raw: `RUN/candidates/answers-H/answers.table.md`, `answers-A10.md`.

**E27. Slice look 2, rules judged (added 2026-11-17, 4:10 a.m.).** 3,264 of 9,029 units, frozen settings,
edge order sorted (A15), stability 192 of 192. Right file served, amateurs (n = 101): shipped 1; keyword 18;
keyword + need index 43; keyword + graph walk 43 (tuned settings) or 46 (rUv's defaults). Numeric thresholds of
A6.4 and A6.5 met (+24.8 points, 26 gained, 1 lost); soundness checks failed again (held-out generated question
to its own file within 5: 29.9%, gate 90), so the build is recorded "not sound" and neither rule is declared
met. Tuned settings not adopted (R21). More extraction did not raise the amateur figure (46 at 1,617 units).
Raw: `RUN/candidates/slice/look2-tables.md`, `LOOK2-SUMMARY.md`.

**E28. Answer-level tests of the cue design (added 2026-11-17, 4:10 a.m.).** Owner's measure = a question
graded 8 of 10 or better in at least 2 of 3 runs. A14.2 (65 problem-only amateur questions; a section that
describes the capabilities landed on): 53.8% against 55.4% for keyword + history, -1.5 [-12.3, 7.7]: NOT MET.
A16 (40 guidance goals, same kind of section, second use of the set): guidance success 3 of 40 against 4 of 40:
NOT MET. A18 (3 keyword + 2 need-index files at the same size as 5 keyword files; third use of the questions):
60.0% against 55.4%, +4.6 [-6.2, 16.9]: NOT MET; mean score +4.6 [1.2, 8.5], false claims 17 against 22: a
positive signal too small for 65 questions. Raw: `RUN/candidates/answers-G/answers-A14.md`, `answers-A18.md`,
`RUN/candidates/answers-H/answers-A16.md`.

**E29. The host's delivery limit, and a void test (added 2026-11-17, 4:10 a.m.).** A17 (ten files per result)
scored 23.1% against 55.4%, and its equal-slot control (ten keyword files) 21.5%. Cause: the host rejects a
tool result above its token limit ("exceeds maximum allowed tokens" or "Output too large, saved to file"); 95%
to 97% of the 51,000 to 60,000-character results never reached the model. A17 is VOID as a test of the lane.
The lead first recorded it as "more files make answers worse" and corrected the record about 20 minutes later.
Audit of every answer run: 0 undelivered results in every 5-file arm and every arm with an added section; the
concept-card arm on E 8.8% (its rule unchanged on clean questions); the shipped 4.7.28 arm 27.8%, touching 41
of 49 answers. Boundary near 50,000 to 52,000 characters. Decision: the result cap is 44,000 characters and
20,000 estimated tokens, enforced by the server. Raw: `RUN/candidates/answers/HOST-DELIVERY.md`.

**E30. Shipped 4.7.28 on amateur questions, and two old releases (added 2026-11-17, 5:20 a.m.).** Answer level,
65 problem-only amateur questions, ONE run, information only: shipped 56.5 of 100 against 69.2 for keyword +
history in the same run, -12.8 [-18.9, -6.9]; answers at 8 or better 20 of 65 against 35 of 65; 86 of its 312
results rejected by the host for size, touching 49 answers, so this is the product as delivered, not a clean
reading of its retrieval. Old releases on the same 40 questions (30 with file gold): v3.9.85-dev (2026-07-27)
right file in the first five 0 of 30, right repository 7 of 30; v4.0.36 0 and 0 of 30; 4.7.28 0 of 26 and 8 of
26; v0.4.0-dev (2026-06-29) 0 of 6 (only 6 questions before the time limit; 542 s per answer). No past release
found the right file on these questions. Raw: `RUN/candidates/answers-G/answers-B.md`, `RUN/history/BISECT.md`.
