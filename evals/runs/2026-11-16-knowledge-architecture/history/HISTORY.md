Updated: 2026-11-17 12:21:10 a.m. EST | Version 1.0.0
Created: 2026-11-17 12:21:10 a.m. EST

# How the Brain's embedding and search strategy was decided: a dated record

Scope: every decision that shaped how knowledge is cut up, turned into vectors, indexed, searched, re-ordered
and judged, from before the first commit to 2026-11-16. For the whole-project story see STORY.md; for the
"when did it get worse" question see BISECT.md; for the recipe as shipped see CURRENT-EMBEDDING-STRATEGY.md.

How to read an entry:
- **Kind of basis**: MEASURED (numbers on a named question set and corpus), ASSERTED (a stated reason with no
  measurement), INHERITED (came with a tool, a template or a library default and was not chosen here).
- **Citation marks**: **[L]** = I read the cited item myself. **[G:A-12]** = quoted by a gathering agent in
  `history/evidence/` file A, item 12, and not re-read by me (files: A = project memory store, B = second
  store + global + owner memory, C = repository documents, D = git history, E = project story, F = owner
  voice). Times are Eastern.
- "Never tested" means I found no record of a test; it does not prove none was run.

Plain-word glossary: *embedder* = the model that turns text into numbers so similar meanings sit close;
*chunk* = the piece of a file that gets one such vector; *reranker* (cross-encoder) = a second model that
reads question and candidate together and scores the match; *keyword search* (BM25, "lexical") = matching on
the words themselves; *hybrid* = keyword and meaning search combined; *held-out set* = questions kept aside
to test with; *gate* = a check that must pass before a release.

---

## Before the repository existed

### 2026-05-30 to 2026-06-12. rUv records his own embedding measurements (not known to the Brain until November)
- **What rUv measured.** On the public benchmark BEIR NFCorpus (323 questions, 3,633 medical documents),
  bge-base-en-v1.5 (768 numbers, 8-bit weights, CLS pooling) scored nDCG@10 0.352 and ranked 2 of 11
  published systems; his own keyword search scored 0.289. He later found that fusing a *weak* keyword search
  with vectors made results worse (two-benchmark mean 0.489 to 0.449), that a proper Lucene-style keyword
  search fixed that (0.505 alone), that bge-large gave no lift over bge-base in the 8-bit build (0.350 vs
  0.352), and concluded "no single pipeline wins everywhere ... A/B your corpus".
  **[L]** `ruflo/v3/docs/adr/ADR-085-beir-public-benchmark.md:1-70` (clone under
  `~/RVF-KnowledgeBases/ruvnet-brain-v2-work/src`); the rest **[G]** via the run's deep dive,
  `ruvector-deepdive/raw/F-ruflo-agentdb.md:47-68` (which I read) citing ADR-086 to ADR-091.
- **RuVector ADR-210 (2026-06-12, decider: ruv).** Makes all-MiniLM-L6-v2 (384 numbers) the default embedder of
  RuVector's intelligence layer, as "not a model upgrade ... a contract upgrade" away from a character-hash
  placeholder, and records "#524 measured BGE-base at +0.08 nDCG@10 over MiniLM on BEIR NFCorpus (rank 10/11 to
  2/11)". **[L]** `RuVector/docs/adr/ADR-210-default-on-semantic-embeddings-minilm.md:1-60`.
- **Why it matters here.** Both of the Brain's embedders are models rUv himself measured, and his measurement
  agrees with the Brain's later choice of bge-base over MiniLM. But the Brain's own decision record never cited
  these; the first citation in project memory is 2026-11-15 (`ruv-measured-retrieval-recipe`, **[L]**). The
  deep dive also found no embedding model trained by rUv for text search in RuVector or ruvllm
  (`ruvector-deepdive/raw/E-embedders-learning.md:7-12`, **[L]**).

### 2026-06-13/14. The build recipe is written as a reusable skill. INHERITED
- **What.** `~/.claude/skills/rvf-kb-forge/SKILL.md` v2.0.0: cut every file at "~4000 chars
  (paragraph-aligned, 400-char overlap)", embed with MiniLM (384) as the default "small" build, optionally a
  "big" bge-base-en-v1.5 (768, CLS pooling, question prefix) build from the same pieces, return whole
  documents capped at about 12,000 characters, and grade to "avg ≥98 AND min ≥95" on a tuned and a held-out
  set. **[L]** lines 73-92, 160-175.
- **By whom.** An agent, generalising scripts from an earlier project ("a faithful port of `kb/ask-kb.mjs`
  ... proven on the Cognitum KBs") **[L]** lines 224-256.
- **Evidence offered.** None for chunk size or model. The skill rates itself 68/100 and says: "NOT executed
  end-to-end ... I changed the scripts by reading, not by running", and under "What I did NOT test": "whether
  bge-base-en-v1.5 is available ..."; "the generalizations here are unproven". **[L]** same lines.
- **Never tested.** Chunk size; overlap; whether the source-code rule (opening comment only) loses answers.
- **This is the origin of the 4,000-character chunk, the 400-character overlap, the two embedders, the
  12,000-character document window and the "98 / 95" gate numbers.**

---

## June 2026: the choice is made on twelve questions

### 2026-06-27. ADR-0004 "Effectiveness first". ASSERTED (owner directive)
- **Decided.** "Effectiveness is the only first-class metric ... use the sharpest retrieval regardless of
  size — a strong code-aware embedder and/or a larger prose model, with multiple vectors per chunk (prose +
  code, kind-routed) if it raises answer quality, in f32." Rejected: "384-dim MiniLM — smaller but weaker on
  code lookups; rejected for the shipping build" and a compressed-vector default.
  **[L]** `git show 1bcc60b8:docs/adr/0004-effectiveness-first.md`.
- **By whom.** The owner's directive, in his words: "every time we try to be efficient, we give up massive
  chunks of effectiveness... maximize for effectiveness."
- **Evidence.** None in the ADR. The promised test, "benchmark a strong code-aware embedder (and bge-large)
  at P1 ... P1 picks by measured effectiveness on implementation-lookups, not by size", is in the spec
  **[G:C-15]** `SPEC.md:144-149`.
- **Never done.** The code-aware embedder benchmark; multiple vectors per chunk; the bge-large comparison. No
  different embedder was run against the incumbent on this corpus until 2026-11-16.
- **Detail that mattered later.** "f32" in the ADR is about stored vectors. The model itself has been loaded
  with `quantized: true` (8-bit weights) since the first commit (**[L]** `git show 1bcc60b8:kb/forge-big.mjs`
  line 57). That is the library example's default; no record compares it with full-precision weights here.

### 2026-06-27. ADR-0002 (the gate), ADR-0003 (point deeper), ADR-0006 (one index per repository). ASSERTED
- ADR-0002: the gate of record is checking cited sources against the real files, plus a panel of models from
  different vendors; "held-out/adversarial sets are independently sourced, hashed, burn-after-one-use".
  **[L]** first-commit text.
- ADR-0003: the knowledge base should resolve a question to the exact code location through a symbol index
  and serve the implementation with its neighbours. **[L]**. State today: symbol indexes exist for 63 of 218
  stores (run decision D4).
- ADR-0006: one index per repository because merging search graphs is expensive; "adds a cross-segment
  normalization + routing step that must be eval'd (P2 routing eval: no cross-repo confusion)". **[L]**. The
  alternative, one global index, was rejected on rebuild cost, not on quality. Never tested: whether
  per-repository indexes plus a router find files as well as one global index. (On 2026-11-15 a single global
  keyword index over rebuilt chunks found the gold file for 52.6% of 76 questions where the shipped
  per-repository design found 3.5% of 113; many things differ between those two, so this is a pointer, not an
  A/B.)

### 2026-06-28. The only head-to-head of the two embedders. MEASURED, on 12 questions and one repository
- **Numbers** (ruflo only, 9,648 chunks, 12 questions written by the building agent, graded by LLM panels):
  MiniLM-384 "avg STRICT 49.5 · avg REAL-USE 81.8" with one lenient grader; bge-768 with three graders
  "31.6 / 68.0"; after hand tuning 35.0 / 67.2; after a symbol index 34.7 / 67.2; after adding the
  cross-encoder reranker 49.9 / 77.1; after "selective rerank" 55.9 / 76.7. The table itself says the MiniLM
  row is "not comparable (1 lenient vendor)". **[L]** `PROGRESS.md:1176-1205`.
- **Decisions taken from it.** (1) Keep bge-768 as the "sharp" build. (2) Adopt the cross-encoder reranker
  (+10 points on 12 questions). (3) "DECISION TAKEN: REAL-USE is the gate of record ...; STRICT is a
  diagnostic", made on the day STRICT was failing. (4) "heuristic retrieval tuning = whack-a-mole".
- **What it did not show.** That bge-768 beats MiniLM-384 on this corpus: the one like-for-like pair of
  numbers is lower for bge, and the document says the pair is not comparable. The belief "MiniLM is weaker on
  code lookups" was never measured here.
- **Same day.** A model panel gave 98 to an article with zero citations: "LLM graders pass
  ungrounded-but-fluent text" (**[L]** `PROGRESS.md:1228-1233`). And a "capability gate" of 45 questions went
  from 38 to 45 of 45 after a small hand-written "concepts" store (11 articles and 5 primers) was added
  **[G:C-28, C-30]**: the first time a hand-written layer, not retrieval, closed a test.

### 2026-06-29, 10:36 p.m. First commit (1bcc60b8). The whole recipe is already in place. INHERITED + MEASURED (small)
- 19 repositories, "75,509 chunks", two embedders, capability cards, cross-encoder. Reported proof:
  "by-description 27/28 (96%, was 33%) · named 47/48 (98%)". **[L]** commit message.
- **What those numbers measured.** "Named" questions name the repository. "By-description" questions were
  answered by hand-written capability cards: "all resolved to CARD" **[G:C-121]** `DESCRIBED-PROOF.md`. Both
  score the right *repository or card*, not the right file.
- **A difference between the two builds that nobody recorded.** The small build embeds a header
  (`title — path`, then the chunk) and the big build embeds the bare chunk. **[L]**
  `git show 1bcc60b8:kb/forge-build.mjs` lines 336, 379 versus `kb/forge-big.mjs` line 85. I found no document
  that mentions this difference before 2026-11-16.

---

## July 2026: speed problems, a keyword-search attempt, and the switch to cards and routing

### 2026-07-07. Model files pinned to exact revisions (0a90a380). ASSERTED (reproducibility) **[G:D-4]**

### 2026-07-09. The 120-question gate. MEASURED, at repository level
- The held-out set grows from 12 to 120 questions "Frozen; do not tune", because 10 of 12 had a 95% interval
  of 55% to 95% **[G:D-5]**. First baseline: grounded 100/100, routed 63/80, abstain 18/20 (**[L]**
  `evals/runs/2026-07-09-baseline.md`).
- **What "routed" checks.** That the cited source is from an expected repository: every question carries
  `expectRepo`, often with the catch-all `concepts` store as an accepted answer (**[L]**
  `evals/held-out.json`, `scripts/eval-brain.mjs:83-88`). No question in this gate has a gold file.
- Same day: the reranker is "97% of query time" (248 candidates, 12-15 s); cutting the reranker's input by
  vector distance was "5.3× faster and wrong" because it dropped the capability cards, so it was rejected
  **[G:C-54, C-58]**.

### 2026-07-10. Two build defects are found; one is still there
- "scripts/ingest-repo.mjs never passed --full ... every store it touched silently lost full bodies", and
  "SKIP_DIRS has 'v2' since first commit — RuView + open-claude-code source lives in v2/" **[G:A-9]**. The
  `v2` skip is still in 4.7.28 (**[L]** `kb/forge-corpus.mjs:16`), and source files still contribute only
  their opening comment unless `--full` names their folder (**[L]** `kb/forge-corpus.mjs:245-271`).

### 2026-07-18 to 07-19. Hybrid (keyword + meaning) search is tried and reverted. MEASURED, but see the regime note
- **Trigger.** A 50-question exam on a meeting transcript scored 19/50. Diagnosis: "the reader retrieved by
  dense cosine similarity only"; "the content EXISTS verbatim in the store ... but was NOT SURFACED".
  **[L]** `docs/BRAIN-WRITE-READ-ARCHITECTURE.md:1-122`; `docs/adr/0025-…:56-71`.
- **What was built.** A port of rUv's simple BM25 and linear fusion with his tuned weights (α = 0.5). A grid
  search on this corpus then found α = 0.3 (more keyword weight) best: self-retrieval score 0.635 against
  0.495 at rUv's default. **[L]** project memory `grid-search-alpha03-optimal-2026-07-18`.
- **Result.** On the 48-question *named* battery: dense 44/48, global hybrid 40/48. On the meeting exam: dense
  16/50, hybrid 20/50. "No config is a repo-safe meeting-recall gain." The global hybrid was reverted; a
  keyword lane was kept for transcript stores only (meeting questions 3/28 to 25/28). An earlier "32/50" and
  "49/50" were "grader leniency". **[L]** `docs/adr/0025-…:13-52`.
- **What was written down and not built.** "The real fix is UPSTREAM chunking ... re-chunk transcripts into
  fact-dense / QA-shaped passages, or synthesize a per-segment fact-summary layer." **[L]** same file, 47-49.
  Also pending since that week: content-aware store routing and finer passages
  (`docs/BRAIN-WRITE-READ-ARCHITECTURE.md:126-145`).
- **Regime note (the "rUv is right" rule).** The conclusion "global hybrid does not help" was reached with
  (a) a simple BM25 without a stemmer or Lucene-style analyzer, the exact condition under which rUv's own
  ADR-087 found fusion gets worse, (b) weights partly un-tuned for this corpus, and (c) a judge of 48
  questions that name their repository, where keyword search has little to add. It was not tested in its
  designed regime. With rUv's Lucene analyzer over rebuilt chunks on 2026-11-15/16 the keyword lane became the
  strongest lane on every question set (run decisions D6, D7, D10).
- **A first "it got worse".** Project memory `REGRESSION-truth-44of48-not-49to32-2026-07-19` (**[L]**): the
  named battery had gone 47/48 to 44/48 in two weeks; "3 of 4 fails are ruv-gists ... ruv-gists grew to 527
  docs this week and now DILUTES cross-repo routing". The first recorded case of corpus growth lowering a
  score.

### 2026-07-20. Results the reranker scores below zero are withheld; an "evidence grade" is added (2906422f). MEASURED on a handful of examples
- The thresholds (strong ≥ 6.0, ok ≥ 4.0) were "DERIVED from measured runs on this corpus": six example
  queries. **[G:D-17]**; code **[L]** `kb/forge-ask-all.mjs:3050-3086`.
- **Never tested then.** Whether the reranker's zero line means "irrelevant" for questions written in a
  newcomer's words. On 2026-10-01 it was measured: for 32 of 35 newcomer questions whose gold file was in the
  pool, the reranker scored "even the verbatim gold span below 0" (**[L]** `docs/adr/0099-…:26-31`).

### 2026-07-22. Search takes one and a half to two and a half minutes
- 69 repositories, 160,238 passages, 136 vector stores; three sample searches took 91 s, 122 s and 151 s
  **[G:C-91, C-92]** `docs/ARCHITECTURE-MAP.md:101-165`. This is the pressure behind the next three decisions.

### 2026-07-27. Speed work: two reranker shortcuts measured and left off; the card lane switched on
- Pool cap (score at most 408 of about 607 pairs): −30% time, one answer lost in 24: left off. Two-stage
  cascade: 40.3 s to 16.4 s on 24 questions: left off pending a 120-question test that I found no record of.
  **[G:C-107, C-116]**; `kb/forge-ask-all.mjs:2703-2788` **[L]**.
- Measured on the way: the reranker's scores change by up to 0.26 when the same passages are batched
  differently **[G:C-109]**; the meaning-vector ranking can be nearly opposite to the reranker's (one winning
  document was rank 593 of 608 by vector distance and rank 1 by the reranker) **[G:C-112]**.
- **Card lane as first responder (2f9726d0, 8:26 p.m.).** A keyword match against 32 hand-written cards
  answers before any search. Evidence: "19/19 (100%) answered correctly by repo" on the plugin's own
  capability questions, and 0.07 ms against 19.6 s. **[L]** commit message. MEASURED for speed; for
  correctness measured at repository level on 19 questions the cards were written for.

### 2026-07-28. Three things in one day
- **1:59 a.m. to 5:09 a.m. The Top-100 benchmark goes from 69 to 100 of 100 in three hours.** First live
  run: "grounded 92/100, routed 79/100, sufficient evidence 66/100"; semantic check 69/100; then "after
  targeted rescue repairs: all 100/100". **[G:A-32 to A-36]**.
- **2:56 p.m. rUv reports that the Brain "manufactured things he had not built".** Root cause recorded: "the
  capability-card fast lane treated curated summaries as grounding proof ... retrieval success was conflated
  with implementation proof". **[L]** project memory `incident-hallucinated-built-state-1785264815627`.
- **10:43 a.m. The MiniLM-384 store is retired (3760c32d, "feat: make nightly RVF refresh incremental", no
  message body).** ADR-0004 gains: "The former duplicate MiniLM-384 store is retired from the Brain build ...
  BGE-768 remains subject to a controlled quality-per-byte bake-off against code-aware candidates."
  **[L]** `docs/adr/0004-effectiveness-first.md:28-33`; commit **[L]**. Basis: ASSERTED (non-duplication,
  footprint). The bundle fell from 806 MB to 469 MB the next day (**[L]** release asset sizes). The retired
  build was the only one that embedded the title-and-path header (the reader had been using the bare-text
  bge build whenever one existed, so this removed an unused advantage and did not change results by itself).
  The bake-off was not run.
- **9:52 p.m.** The card-based router (859a16de) **[L]** date.

### 2026-07-30, 8:57 p.m. Search becomes "route or refuse" (453ae584). No stated reason, no measurement found
- One commit, "fix(release): wire Brain 4.0 controls and release gates", 119 files, 12,200 added lines, no
  body. It changes the product's search call to `allowFullCorpus: false`: if the router cannot place a
  question, "Refuse quickly instead of fanning out to every store". The comment in the same change says:
  "Offline evaluators and explicit library callers retain the historical full-corpus fallback". **[L]** diff.
- So from this commit the product and its evaluation took different paths (until 2026-09-09).
- Three hours later (40456752, 14f654e2) two questions of the "frozen" 120 were edited and the frozen-set
  hash was re-pinned, with no message body **[G:D-33, D-34]**.
- This is the main candidate in BISECT.md.

---

## August and September 2026: gates are loosened or replaced while quality numbers stay flat

### 2026-08-06. The nightly self-retrieval check is relaxed (ADR-0064)
- After six failed nightly builds on the same row, a passage now passes if it is found anywhere in a wide
  window (up to 500), not in the top 10. The ADR is explicit: "A passing round trip is not evidence that real
  user questions retrieve the right answer." **[L]** `docs/adr/0064-…:21-45`.

### 2026-09-07. Per-repository pool 8 to 64 (c5eb2abc). No message body **[G:D-40]**

### 2026-09-09. The evaluation is moved onto the bounded path and re-recorded at 100% (ccaea57a). No message body
- `scripts/eval-brain.mjs` now passes `--bounded`; a repository alias now counts as correct; the baseline is
  re-recorded: routed 66/80 to 80/80. **[L]** `scripts/eval-brain.mjs:178-196`, `evals/baseline.json`;
  **[G:D-41]**.

### 2026-09-11. An independent review scores the product 31/100; the identifier lane is added
- Two outside models measured "31/100" where the self-score had been 44; grounding "strict 41.7, real-use
  55.1" on 18 of 25 questions; "0/8" answered from current source **[G:C-148, C-152]**.
- "on a fixed 9-question set: the top-1 cited document was wrong for the question asked in 8 of 9 cases";
  fix: an exact-token lane (`kb/identifier-lane.mjs`) **[G:D-42]**. On 2026-09-15 it was A/B tested:
  recall@10 0.9433 with it, 0.9124 without (194 questions, repository given) (**[L]** project CLAUDE.md,
  **[G:A-43]**). MEASURED.

### 2026-09-15. The first file-level number, and the gate that replaced it
- The owner's criterion "C3" (at least 95% of questions find supporting evidence in the top 5, per
  repository) was measured for the first time: "680/1152 = 59.0%" (61.1% with the repository given, 56.9%
  across the corpus) **[G:A-39]**.
- It was removed as a blocking gate and replaced by a fixed set of 194 human questions, one per repository,
  asked with the repository given: 176/194 in the top 5. The record calls this "a declared REDUCTION in
  release requirements. It is not a demonstration ..." and admits "a pre-existing fixture can still be
  cherry-picked after the scores are known" **[G:C-175, C-177]**.

### 2026-09-19. The grader stops passing answers the product itself judged irrelevant (850570c6)
- "The answerable grading path ... treated a resolving citation and expected repository as a pass" even with
  a negative reranker score **[G:C-185]**. With the stricter rule the same system scores 48/80, not 80/80.
  Project memory: "routed-to-correct-repo = 80/80 ...; the 32 'failures' are routed-right BUT the brain
  abstained ... REAL DEFECT: right repo, weak passage" (**[L]** `finding-eval-routed-misread-correction-20260930`).

### 2026-09-29. The owner sets 98% and 95%; the measurements are 89% and 56%
- "OWNER TARGETS (2026-09-29): recall >= 98% (100% ideal); quality >= 95% ... These must become BLOCKING
  gates." Measured that day: 162/182 = 89.0% (repository given) and 89/160 = 55.6%. **[G:A-45, A-46]**; the
  same two numbers are in every nightly receipt since (**[L]**, see BISECT.md).
- The release "canary" (recall@10 ≥ 0.98 on about 19 stores) "is a coin flip: same 19 questions → 18/19 ...
  17/19 ... earlier releases passed by sample luck" (**[L]** `finding-canary-gate-unsound-…-20260930`).

---

## October 2026: the newcomer problem is measured, four fixes are designed, one ships switched off

### 2026-09-30 to 2026-10-01. The first test written in a newcomer's words
- 206 "need" questions, "each written from one gold file" (**[L]** `docs/adr/0099-…:22`). Result: gold file in
  the top 5 for 4 of 206; the product abstained on 202. The gold file was in the 64-deep meaning-search pool
  for 13 of 87 searched questions, 35 of 87 with a keyword lane added; a deeper pool (160) gained 0 and
  raised median time 14.9 s to 25.0 s. **[L]** `docs/adr/0099-…:20-35, 193-202`.
- Traced cases: the right passage ranked 575th, 631st and 171st by meaning; "a plain keyword search ranked
  the answer 1st in 3 of 5" **[G:B-5]**.
- **Keyword lane for repositories ("E2").** MEASURED: recall gate 162 to 165 of 182, held-out 48 to 51 of 80,
  newcomer gold-in-5 from 4 to 10 of 206; cost +2.1 s median because its index is built at question time.
  Decision: ship **off** (**[L]** `kb/keyword-lane.mjs:1-36`). The stated next step, "build the BM25 keyword
  index with the corpus" (**[L]** `docs/adr/0099-…:180-187`), is not in 4.7.28.
- **Moving the abstain threshold.** MEASURED and rejected by the owner: at −4, "confident wrong-file answers
  rise 5 → 61/206". **[L]** same ADR, 32-35.
- **Learned judge ("arm C").** MEASURED: failed; "the eight trace features cannot separate the gold file from
  its neighbours". **[L]** 164-169.
- **Newcomer questions generated per document ("doc2query", arm A).** MEASURED for reach only: 15,357
  generated questions over 5,259 markdown files; gold file reaches the pool for 17 of 43, then 28 of 43 with
  the new lane. "Measured, not productized." **[L]** 170-175.
- **Learned query adapter (SONA MicroLoRA, arm B).** "The harness is committed ... but has not been run."
  **[L]** 176-177. Still not run on 2026-11-16 (run decision D15).
- **A different embedder or reranker.** Dismissed in one table row: "Not a rUv tool. Large model downloads on
  every install. No measurement yet that a different off-the-shelf model separates novice needs better."
  **[L]** line 198. ASSERTED. (bge-base is itself an off-the-shelf model that rUv wraps; see the first
  entry.)
- 2026-10-02: the 4.5 exit criterion "206-need top-5 materially above baseline" is recorded "Not met" and
  the arms move to 4.6 **[G:B-8]**. I found no later work on them in the shipped line.

### 2026-10-16. A cleanup on a branch that did not ship shows how much of the score was fitted
- "the installed ruvnet-brain store held 233 passages from evals/, including held-out.json, so out-of-corpus
  eval questions retrieved their own answer key" **[G:D-83]**.
- "Every removed predicate and rewrite matched only frozen eval questions ... and none of the 100 unseen
  questions"; removing them: "routed 60/80" to "50/80" **[G:D-93]**. Those predicates are still in 4.7.28
  (**[L]** `kb/forge-ask-all.mjs:309-467, 3281-3443`).
- Vector-based store routing was tried and reverted the same day **[G:D-94, D-95]**.

---

## November 2026: measurement with gold files

### 2026-11-01. A second, separate recipe reaches 96 to 98% on a different kind of corpus
- `~/.claude/skills/rvf-expert-kb/SKILL.md`: "About 140 words per chunk, stride about 110"; bge-base **fp32**;
  judged answer-recall on 86 videos and 1,198 questions: "k=8 96.2% ... k=12 97.9%"; and "Quantised q8 vs
  fp32, titles in passage text, bge-large, BM25 fusion, a claims/propositions lane did NOT raise recall on 5
  videos." **[L]** lines 17-33. MEASURED, on spoken transcripts of one expert, with questions written by a
  model from the same passages. It shows small chunks inside the model's window can reach the target on
  single-topic prose; it does not show the same for 218 code repositories.

### 2026-11-15. The audit and the pilot
- A fresh 64-question exam with gold from source: "brain 65.9/100 ... no-brain control 45.2 ... right repo
  top-6 84%, exact gold file top-6 11%". Causes named: opening-comment-only source indexing, "4000-char chunks
  vs 512-token bge => 44% tokens never embedded", the 3,000-character reranker window, the card lane, the
  router, "held-out eval contaminated by ~40 phrase rewrites". **[L]** project memory
  `brain-quality-audit-2026-11-15`.
- History check the same night: "we solved this before on paper and never shipped it" (**[L]**
  `brain-retrieval-history-2026-11-15`).
- Pilot recipe (**[L]** `~/RVF-KnowledgeBases/ruvnet-brain-v2-work/RECIPE.md`): same embedder, chunks of at
  most 480 tokens with a path header: gold file in top 6 from 10.5% to 73.7% (19 questions); a real keyword
  index 52.6% (76 questions); summaries plus newcomer questions as their own vectors 28.9% to 52.6%; the
  embedder itself "unchanged by decision"; chunk size "NOT tested"; "SONA / MicroLoRA query adaptation ...
  MMR" not tested. Reranker over the top 100: "flat, ~7 s per query".

### 2026-11-16. The knowledge-architecture run (**[L]** `DECISIONS.md` D0 to D15, `PREREGISTRATION.md`)
- Shipped 4.7.28 through its real tool: gold file in the top 5 for 4 of 113 development questions and 8 of 164
  blind questions; 73.7% of passages longer than the model's window; 50.0% of tokens never embedded.
- Same embedder, old chunks against new: 3 against 26 of 76. Keyword lane over new chunks: 78 of 164 blind.
  The current vectors added nothing to the keyword lane on two blind sets. A history store (commits, issues)
  passed its test. Concept cards failed their confirmation.
- Embedder screen, first two candidates on the development pilot only: gte-modernbert-base 42 against the
  incumbent's 25 of 76; snowflake-arctic-embed-m-v1.5 36 against 25. Blind passes unfinished
  (`candidates/rig/rigB-R1-final.md`, **[L]**). No verdict.
- 11:24 p.m.: the owner's direction: no embedder verdict until rUv's own retrieval stack has been examined
  (D15).

---

## Where a later measurement contradicted an earlier belief

| Earlier belief | Date held | What later measurement showed | Date |
|---|---|---|---|
| "384-dim MiniLM — weaker on code lookups" (ADR-0004) | 2026-06-27 | The only comparison on this corpus had MiniLM higher (49.5/81.8 vs 31.6/68.0), flagged not comparable; never re-run | 2026-06-28 |
| "The hard 15-month core is solved in architecture + proof" (`PROGRESS.md:1238`) | 2026-06-28 | Gold file in the top 5 for 4 of 206 newcomer questions; 4 of 113; 8 of 164 | 2026-10-01, 11-15, 11-16 |
| By-description routing "96%" | 2026-06-29 | It measured which card or repository answered; rUv reported the cards "manufactured things he had not built" | 2026-07-28 |
| "Writing the brain works ... The fix is retrieval-layer, not re-encoding" (`BRAIN-WRITE-READ-ARCHITECTURE.md:14-19`) | 2026-07-18 | Half of all tokens are never embedded; same embedder with new chunks 3 to 26 of 76 | 2026-11-16 |
| "Global hybrid: no repo-safe gain" | 2026-07-19 | A Lucene-grade keyword lane is the strongest lane on development and two blind sets | 2026-11-15/16 |
| Distances from different stores "are not comparable" | before 2026-07-27 | "asserted, never measured ... one scale, not 69" (`kb/forge-ask-all.mjs:2743-2748`) | 2026-07-27 |
| "53,350 ms of model load" | 2026-07-27 | 1,670 ms; two different workloads had been subtracted **[G:C-111]** | 2026-07-27 |
| The reranker's zero line separates relevant from irrelevant | 2026-07-20 | It scores the verbatim gold span below zero for 32 of 35 newcomer questions | 2026-10-01 |
| Held-out "routed 100%" | 2026-09-09 | 48/80 under a rule that counts the product's own abstention; 50/80 with question-specific code removed | 2026-09-30, 10-16 |
| The retrieval canary proves ≥ 98% | to 2026-09-29 | "a coin flip ... earlier releases passed by sample luck" | 2026-09-30 |
| identifier lane caused a regression | 2026-09-15 | It improved recall (0.9433 vs 0.9124) | 2026-09-15 |

## Things considered and rejected, with the reason given at the time

| Alternative | When | Reason recorded | Basis |
|---|---|---|---|
| One merged index for all repositories | 2026-06-27 | rebuild cost | ASSERTED |
| Compressed vectors by default | 2026-06-27 | effectiveness first | ASSERTED |
| Code-aware embedder, bge-large, several vectors per chunk | 2026-06-27 | "benchmark at P1" | never run |
| Cutting the reranker's input by vector distance | 2026-07-09 | drops capability cards | MEASURED (one case) |
| Global hybrid search | 2026-07-19 | 40/48 vs 44/48 on the named battery | MEASURED, wrong regime |
| RuLake as the vector layer | 2026-07-17 | replaces only the search step, not text recall **[G:C-68]** | ASSERTED |
| Reranker pool cap; cascade | 2026-07-27 | one lost answer in 24; awaiting larger test | MEASURED (24) |
| Smaller reranker | 2026-07-27 | rUv's ADR-080 calls the current one the sweet spot **[G:C-114]** | INHERITED |
| Moving the abstain threshold | 2026-10-01 | wrong answers grow 14 times faster than hits | MEASURED |
| Deeper meaning-search pool | 2026-10-01 | 0 gained, +10 s | MEASURED |
| Different embedder or reranker | 2026-10-01 | "Not a rUv tool"; no measurement | ASSERTED |
| rUv's GNN rerank | 2026-10-01 | research branch; works inside the pool only | ASSERTED |
| Learned judge | 2026-10-01 | failed on train | MEASURED |
| Facts table as a lane; rank fusion across unlike units; glossary expansion; graph expansion | 2026-11-15/16 | each lowered or did not move the measure | MEASURED |

## What I could not read

- Evidence file C notes that many ADRs outside the retrieval set were grepped, not read. I read ADR-0004,
  0025, 0099 in full and 0064, 0098 in part.
- Issue threads #27 to #33 (outside users' search reports) were seen only as quoted in code comments.
- `PROGRESS.md` between lines 81 and 940 was not read by me.
- The installed product under `~/.cache/ruvnet-brain` was not opened.
