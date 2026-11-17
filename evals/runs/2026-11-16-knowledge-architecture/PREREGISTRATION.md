Updated: 2026-11-17 03:36:00 EST | Version 1.18.0
Created: 2026-11-16 18:40:00 EST

# Knowledge-architecture run: pre-registered decision rules

Written by the lead before any candidate retrieval of this run. The SHA-256 of this file is recorded in
`PREREGISTRATION.sha256` and in project memory. Any later change bumps the version and is listed under
"Amendments" with the time and the reason; the original hash stays on record.

## What is already known and therefore NOT blind

- The exam2 dev set (113 questions, 76 with gold inside the 10 pilot stores) was used on 2026-11-15 to choose
  lane weights and the documentation-tier rule (RECIPE.md v1.0.0). Dev numbers are development evidence only.
- A re-run of the shipped-brain baseline on dev was started about ten minutes before this file was hashed. Its
  2026-11-15 value (gold file in top 6 for 3.5% of 113) was already known.
- The exam2 sealed set (237 questions, sha dd105cf9b025) has not been opened and is NOT used in this run. It is
  reserved for the final qualification of whatever architecture is promoted.
- Blind evidence for this run comes from the extension set E (below), authored after this file was hashed, by
  agents that never see chunk text, retrieval output or the brain.

## Instrument

- D = exam2 dev (113). E = extension set, about 150 new questions written from source clones under an outside
  taxonomy: cross-repo (answer needs two or more repos), which-tool (problem only, no product words),
  design-rationale (why it is built this way; gold in an ADR or design doc), troubleshooting, history (gold in
  a commit message, issue or PR), paraphrase pairs (two wordings of one need, same gold), not-in-corpus
  adversarial. Gold = repo + path (+ lines + verbatim quote), found by reading or grep before any retrieval.
  D (113) + sealed (237) + E (about 150) = about 500.
- Unit of retrieval scoring: the FILE (store + path). A question is a hit at k when a gold file is among the
  first k distinct files returned.
- Layer attribution, per question, in this order: gold indexed (gold path present in the corpus under test);
  gold in pool (top 100 of the lane); any-gold@5; all-gold@5 (multi-file golds); abstain correct (not-in-corpus).
- Paired comparisons use the exact McNemar test on per-question hit/miss. Every result states n. A difference
  of fewer than 5 questions is reported as "not distinguishable" whatever its sign.

## Decision rules

R1. Embedding model. A different embedder replaces Xenova/bge-base-en-v1.5 only if, on the SAME chunks and the
    SAME questions (n >= 100), it raises dense-only any-gold@5 by >= 10 points AND the fused system (lexical +
    dense, reciprocal-rank fusion) any-gold@5 by >= 5 points, paired p < 0.05. If the dense lane gains but the
    fused system gains < 5 points, the finding is "the embedding is not the bottleneck" and nothing is
    re-embedded. Footprint (ADR-0098) and re-embed hours are reported beside any winner.
R2. Chunking. "Chunking is the bottleneck" is accepted if, with the embedder held fixed, structural chunks of
    at most 480 tokens beat the shipped ~4,000-character chunks on dense any-gold@6 by >= 20 points, n >= 50.
R3. Lexical lane. A global lexical lane is adopted if fused any-gold@5 exceeds dense-only by >= 10 points.
R4. Derived need layer (summaries + newcomer questions per file section). Adopted if novice-kind any-gold@5
    rises by >= 10 points, paired p < 0.05, with no other kind falling by more than 3 points.
R5. Relationship graph / design-rationale layer. Adopted if all-gold@5 on the cross-repo and design-rationale
    strata of E rises by >= 10 points over the best configuration without it, no other stratum falling by more
    than 3 points.
R6. New sources (commit history, issues/PRs, posts, meetings, videos, articles). A source type is adopted if
    on the stratum it serves gold-indexed moves from below 20% to at least 80% and any-gold@5 rises by >= 20
    points, and the other strata do not fall by more than 3 points (pollution check).
R7. Abstention. On the not-in-corpus stratum the correct-abstain or correct-"does not exist" rate is reported
    for every configuration; a configuration that lowers it by more than 10 points is flagged, not promoted.
R8. Answer level. No answer-level claim on fewer than 3 runs per arm (measured 2026-11-15: the same system run
    twice changed the score of 39 of 76 questions). Mechanical caps apply before any model grade: an answer
    whose cited sources do not resolve to real files in the clones is capped at 3 of 10; an answer stating a
    must_not_claim item is capped at 3 (1 if it is the main recommendation). A grader counts only after it
    passes a seeded calibration set: 20 answers with known scores, including zero-citation and planted-false
    answers, at least 18 within +/-1 of the key and every planted answer capped.
R9. "Builds the way rUv builds". Tool-choice and build tasks are scored against what rUv's own repositories do
    (the gold is the tool, pattern and reason found in source). Every arm has a no-Brain baseline (same model,
    same prompt, no search tool). A claim needs brain minus no-brain >= 15 points over >= 3 runs per arm.
R10. Score out of 100. Any score given for the architecture lists each deduction with its evidence; a known
    architectural flaw caps the dimension at 70; the builder (lead) does not assign it. Independent agents and
    mechanical oracles do.

## Stop conditions

- Any step that needs API-billed spend, writes to shipped stores under ~/.cache/ruvnet-brain, or a commit,
  push, release or publish: stop and report.
- Any source whose robots file or terms forbid automated collection: not collected; reported as an owner
  decision with the lawful routes.
- One-minute load at or above 60: heavy compute waits.
- A gate above failing is a result to report, not a reason to retune the rule.

## Amendments

### A1, 2026-11-16 6:36 p.m. ET (before any candidate retrieval; v1.0.0 hash 0b256a44c40304bf73d8ead600088331761f5b38c0810dc77c1664362d1e2f9b stays on record)

Reason: the lead session that wrote v1.0.0 ended at 6:24 p.m. (stopped by the platform, not by a result). A new
lead session continues the same run under the same rules in worktree agent-a605de6750254d5d5. No candidate
retrieval had run. Only the shipped-brain baseline on dev (already declared non-blind) was in flight. The v1.0.0
header time (18:40) was wrong; the file was hashed at 6:23 p.m.

A1.1 Extension set E is authored by four agents (E1 which-tool + paraphrase pairs; E2 cross-repo +
     design-rationale; E3 troubleshooting + history; E4 frontier concepts + not-in-corpus + build tasks), about
     164 questions, each also tagged knowledge_type (concept, capability, how-it-works, integration,
     storage-retrieval-technique, agentic-learning, tool-choice, troubleshooting, rationale, history, absence).
     Results are reported per stratum and per knowledge_type. A question whose gold fails mechanical
     re-verification by the lead (quote not found at the cited place) is dropped before any retrieval is scored,
     and the drop is listed.
A1.2 R1 is applied in two stages, to keep the embedder question affordable without biasing it toward "keep".
     Stage 1, pool screen: for each question the candidate pool is the union of the incumbent's dense top 100
     passages, the lexical top 100 passages, and every passage of the gold files, all v2 chunks. The candidate
     embedder embeds the pool and the query and ranks the pool. This is exact for the incumbent's top 5 and can
     only OVERSTATE a candidate (distractors outside the pool are never seen by it). So a candidate that misses
     either R1 threshold at stage 1 is rejected for good; a candidate that clears both goes to stage 2, a full
     embed of enough stores to cover n >= 100 questions, where R1 is applied as written.
     Candidates, fixed now: Snowflake/snowflake-arctic-embed-m-v1.5 (same size class), nomic-ai/nomic-embed-text-v1.5
     (long window), Xenova/bge-large-en-v1.5 (larger sibling; the size rUv's cognitum-learn pipeline names),
     jinaai/jina-embeddings-v2-base-code (code-trained), Alibaba-NLP/gte-modernbert-base (2025 generation), plus
     at most one model released in 2026 chosen by a mechanical rule before any score is seen (most-downloaded
     English retrieval feature-extraction model with ONNX weights under 1 GB on the Hugging Face hub, excluding
     the Qwen3 family, which the owner ruled out on 2026-11-15). A listed model with no usable local ONNX build
     is recorded as "not run", not silently replaced. Each model is used with its documented query/passage
     prefixes and pooling.
A1.3 R2 is measured on the 76 pilot dev questions (v1 shipped chunks vs v2 chunks, same embedder, dense only).
A1.4 R5 candidate = concept cards plus typed relation edges, each claim carrying a source path, built by agents
     that never see D, E or any retrieval output. R6 candidate = a history store (commit messages and
     owner-authored issue / PR text). E authors and layer builders share no files. Before scoring, any derived
     text sharing 8 or more consecutive words with an E question is listed as possible leakage and the question
     is reported both ways.
A1.5 The shipped baseline on E is run through the real consumer path (plugin/mcp/server.mjs, search_ruvnet), not
     an internal function.

### A2, 2026-11-16 9:14 p.m. ET (before confirmation set F exists; v1.1.0 hash ced017c911ea9e07c4f88065bc4fc914bb3181d1b67138ec544a380f3b783188 stays on record)

Reason: rules R5 and R6 failed as written on E. A post hoc analysis of the same data suggests that showing
unlike kinds of knowledge in separate sections works where rank fusion does not. A post hoc result is not
adopted on its own, so the sectioned design is fixed here and tested on questions that do not exist yet.

A2.1 Confirmation set F: about 80 new questions by two new Opus authors who see no cards, no retrieval output and
     no earlier question set. Strata: which-tool (at least half asked by an amateur), troubleshooting,
     design-rationale, cross-repo, build-task, history. Gold lies in the ten stores that have dense vectors (and
     the six repositories of the history store), so every lane can be scored on every question.
     Gold must be found WITHOUT keyword search: by walking directory listings, tables of contents, indexes and by
     reading; the question is then written without re-using the wording of the gold passage. Each question
     records how its gold was found. The lead re-verifies every quote before scoring.
A2.2 The design under test, frozen: S(q) = the first 5 files of the lexical lane (24-store index, as in rigE
     lane v2-bm25) + the source files of the first 3 cards of lane cards-rrf (index, vectors and code exactly as
     built in candidates/rigC on 2026-11-16, no rebuild) + the first 3 items of lane history-bm25. Control =
     the lexical lane truncated to N files, N = the median size of S on F.
     C1 (sections): adopted if any-gold in S exceeds the control by at least 10 points over all of F, exact
        McNemar p < 0.05, AND by at least 10 points on amateur askers. Every stratum is reported; a stratum
        that falls by 5 or more questions is named as a cost of the design.
     C2 (history): adopted if the history section holds the gold item for at least 60% of history-stratum
        questions.
     C3 (lexical bias): on F, lexical any-gold@5 versus dense any-gold@5 and versus the fused lane (weights as
        on E). If the lexical lane does not beat the dense lane by at least 10 points on F, the conclusion
        "lexical is the backbone" is withdrawn as an artefact of how gold was found on D and E.
     A rule that fails is reported as failed; the design is not re-tuned on F.
A2.3 The exam2 sealed set (237) stays sealed in this run. It tests file finding for named products; the
     sections exist for problem-first, cross-system, reasons and history questions, which it does not contain,
     and opening it now would spend the only untouched set before an architecture has been built to qualify.
A2.4 Also reported, without a threshold: on E, each lane split by word overlap between the question and its
     gold quotes (lowest third against highest third), as a second view of the lexical-bias question.

### A3, 2026-11-16 10:03 p.m. ET (before any embedder result on E or F exists; v1.2.0 hash 13834c578aecf164d64e9b638c0b3d051f455875902df9313d6dc5b9fb9b3374 stays on record)

Reason: each embedder costs about one hour on the dev-pilot pool and more than one hour on the E and F pools on
this machine. Known when this was written: dev-pilot results for two candidates (arctic-embed-m-v1.5: dense
+14.5 points, fused +7.9 / +1.3; gte-modernbert-base: dense +22.4, fused +11.8 / +5.3). No E or F embedder
result exists.

A3.1 Futility stop: a candidate whose dev-pilot dense any@5 gain over the incumbent is below +10 points is not
     run on E and F and is recorded as "rejected at stage 1 (dev pilot)". This can only spare weak candidates
     the longer pass; it cannot admit one.
A3.2 R1 at stage 1 is judged on dev pilot + E (dense-covered, 80) + F (file gold, 68) pooled, n = 224, with the
     blind part (E + F, n = 148) reported beside it. Because the pilot's fusion weights were chosen on dev and
     lost on E, both weightings are reported and a candidate passes the fused threshold only if it passes it
     with the SAME weighting on the blind part alone as well (at least +5 points there).
A3.3 One added comparison, since fusing the incumbent did not beat the lexical lane on blind questions: fused
     (candidate) against lexical alone on E + F. A candidate that passes R1 but whose fused lane does not beat
     lexical alone by at least 5 points on E + F is reported as "better than the incumbent, still not worth a
     dense lane", and no stage 2 is run for it.
A3.4 Stage 2, if any candidate survives A3.2 and A3.3: full embed of the stores ruflo, RuVector and metaharness
     (the smallest set holding all file gold of at least 100 questions: 109 of 286), compared with the
     incumbent's existing full vectors for the same stores.

### A4, 2026-11-16 11:48 p.m. ET (before any ladder query is written or run; v1.3.0 hash 26ab29428a707e2fdc741088effaeb23c3d53072da2d60be0a771871030168b4 stays on record)

Reason: owner direction. Two questions the runs so far cannot answer: (1) is the shipped index unable to surface
the right file even for a well-informed query, or does it only fail to bridge naive wording to the author's
vocabulary; (2) how much could a query-rewriting step recover, for the shipped product and for the candidate.

A4.1 Expert-query ladder. Population: questions with file or history gold on which the shipped product had no
     gold in its returned files (E, F, dev). Sample, seeded (20261116, ids sorted first): 60 from E, 40 from F,
     20 from dev; within E and F amateurs are taken first until they are half of that set's sample.
     An informed writer (Opus) sees the question, gold_answer, key_facts and product names, but NOT the gold
     sources, paths, shas or issue numbers, and writes three queries per question:
       rung 1: the need restated in the author's own vocabulary for the concept, no repository or package name;
       rung 2: rung 1 plus the repository or package name;
       rung 3: names a concrete artifact (a command, an ADR topic, a named module, a config key) from the key
               facts, as the product's own "insufficient evidence" text asks for. No file paths.
     A check before running: any query containing a gold path, a gold file's base name, a sha or an issue
     number is rewritten by the writer and the count is reported.
     Runs: the shipped product through its real server, one query at a time; and the candidate lanes (24-store
     lexical, first 5 files; history, first 3 items) on the same queries. Rung 0 = the original question
     (already measured). All three rungs are run for every sampled question.
     Reported per system, per rung, cumulative and non-cumulative, by stratum and asker: gold among returned
     files; number of files returned; refusals; insufficient-evidence flags.
     Reading fixed now, for the shipped product at rung 3 (cumulative): below 50% of sampled questions =
     "the index does not surface the answer even for an informed query"; 80% or more = "the index holds and
     can surface it; the gap is the bridge from naive wording"; between = both.
A4.2 Blind rewriting (the deployable version). A rewriter that sees ONLY the question (no gold, no product
     list) writes three short search queries in general technical vocabulary. Rewriter model: Sonnet if its
     quota allows, otherwise Opus (recorded). Candidate lexical lane: the three result lists are interleaved
     round-robin, duplicates removed, first 5 files kept. Run on ALL of E and F (file-gold questions).
     Rule: query rewriting is admitted to the recipe if any-gold@5 rises by at least 10 points on amateur
     askers of E and F pooled, exact McNemar p < 0.05, and no asker group falls by more than 3 points.
     Also reported: the same interleaving with the informed rung-1 queries, as the upper bound a perfect
     rewriter could reach without naming the product.
A4.3 Nothing is tuned on these results; lane settings are those of rigE.

### A5, 2026-11-16 11:58 p.m. ET (before any item below is built or scored; v1.4.0 hash 6c2c509982f6831763ef0a09ce253423ab3f873f18d00f2bf81e88f6980f071e stays on record)

Reason: owner direction (decision D15). The embedder screen so far tested general public models with ordinary
vector-search thinking. A separate researcher traversed RuVector's own capability space and proposed candidates
and rules (`ruvector-deepdive/AMENDMENT-A4-PROPOSED.md`, sha256 fc05524cedf866b46c4a6835e1467f668a50aaea4103c36b52034c6cd7307bf3, written by an agent
that has read no E or F question or gold). The lead adopts that text below without changing a threshold; its
rule numbers A4.n are renumbered A5.n because A4 was already in use. Strategy labels U1 to U9 refer to
`ruvector-deepdive/03-NOVEL-STRATEGIES.md`. A first attempt to write this section at 11:58 p.m. lost every
back-quoted name to shell substitution (hash 87f0c53c..., recorded in PREREGISTRATION.sha256 as void); nothing
had been built or scored in between.

**General clauses**
- G1. Staging. Every candidate has a stage-0 check in its designed regime with a known right answer
  (`03-NOVEL-STRATEGIES.md`). A candidate that fails stage 0 is recorded as "build not sound", never as "does
  not help". Tuning uses dev (113) and generated questions only; the tuned setting is frozen and written down
  before E, F or G is scored, and is scored once.
- G2. A negative verdict on a candidate requires: stage 0 passed; the frozen tuned setting was used; the
  component is rUv's (not a re-implementation); the harness reproduced a known-answer case.
- G3. Set G: about 120 amateur, problem-only questions by new authors under protocol A2.1 (gold found without
  keyword search), written before any candidate below is built. Amateur rules are judged on E + F + G amateurs
  pooled (about 208), with each set reported alone.
- G4. Derived text (problem statements, summaries, questions) is generated from source alone; any 8-word run
  shared with a D, E, F or G question is listed and the question reported both ways (as A1.4).
- G5. Coverage gate: a derived layer is scored only when it covers every store that holds file gold for the
  set being scored.
- G6. Unlike units are served in their own sections with equal total slots in the control; no rank fusion
  across unlike units.
- G7. The rules below are one family; p-values are Holm-adjusted across the rules actually run. Exam2 sealed
  stays sealed.

**Rules**
- A5.1 Screen additions (stage-1 pool screen, same pools and control): `Xenova/all-MiniLM-L6-v2` (mean pooling,
  no prefix) and `Xenova/bge-small-en-v1.5` (CLS pooling, BGE query prefix).
- A5.2 R1b, non-inferiority for a candidate whose stored vector is at most half the incumbent's bytes: adopted
  in place of the incumbent if, on pooled n = 224 and on the blind n = 148 separately, fused any-gold@5 (both
  weightings) is not lower by more than 3 points and dense any-gold@5 not lower by more than 5.
- A5.3 R4b, node and need embedder screen: on short texts (problem statements, summaries, questions) mapped to
  files; candidates = A5.1 models, the incumbent, and the best passage model of A3 if any. Adopt the smallest
  model within 3 points of the best on amateurs.
- A5.4 R4c, need index (U3): result = 5 lexical files + 5 need-index files; control = lexical at equal slots.
  Adopted at +10 points on amateurs, exact McNemar p < 0.05, no stratum down 5 or more questions.
- A5.5 R11, re-rank (U6): union of first 60 lexical and first 60 need / graph-hop passages; contribution
  `8 / (60 + rank)`, never a threshold. Candidates: `mixedbread-ai/mxbai-rerank-xsmall-v1`,
  `Alibaba-NLP/gte-reranker-modernbert-base`, RuVector MaxSim with `answerdotai/answerai-colbert-small-v1`,
  Sinkhorn transport over the same token vectors; control `Xenova/ms-marco-MiniLM-L-6-v2`. Adopted at +5 points
  overall and +10 on amateurs, p < 0.05, median added latency at most 1.5 s at load below 60.
- A5.6 R13, graph hop (U1): result = 5 lexical files + 5 files reached by `search_then_traverse` from `Problem`
  and `Capability` nodes; control = lexical at equal slots. Adopted at +10 points on amateurs, p < 0.05, and
  +10 points on "both repositories present" for the cross-repo stratum, no stratum down 5 or more questions.
  If both R4c and R13 pass, the one with the higher amateur any-gold is the default and the other is kept only
  if it adds at least 5 points on top.
- A5.7 R14, hyperbolic hierarchy (U2, U2b): added to the R13 lane; adopted at +5 points on amateurs and +5 on
  which-tool, p < 0.05 on the two pooled. Stage 0: held-out parent links, hyperbolic Hits@10 at 32 dimensions
  at least equal to Euclidean at 64.
- A5.8 R15, link prediction (U4): stage 0 filtered Hits@10 at least 0.5 on held-out `implemented_in` and
  `solved_by` edges; adopted at +5 points on which-tool, p < 0.05, no stratum down 5 questions.
- A5.9 R16, learning from use on a branch (U5): admitted as "off by default, safe" if no blind stratum falls by
  more than 3 points with the branch attached and dev held-out rises by 5 points. Adapter variant (U5b): stage 0
  in Rust with a supplied gradient, +5 points recall@5 on held-out generated pairs, before any blind score.
- A5.10 R17, typed decision with abstain (U7): correct "does not exist" not lower than the current candidate's,
  false claims down at least 30% at answer level over 3 runs, no in-corpus stratum down 5 questions.
- A5.11 R18, one result per system (U8): cross-repo "both repositories in the first 10" up at least 15 points;
  no other stratum down 5 questions.
- A5.12 R1c, tuned embedder: training pairs from source alone, clause G4 applies, one repository per stratum
  held out of training and reported; judged by R1 against its own base model.
- A5.13 R12, stability: three runs in three separate processes return the same first five files for at least
  99% of questions; a lane that fails is not shipped whatever its score.
- A5.14 Answer level: the layer or layers that pass are run in the answer test (R8, R9; 3 runs per arm, blind
  calibrated judge), amateurs and experts reported separately, on at least 200 questions so that 93% and 98%
  can be told apart (at n = 84 they cannot, D14).

**Lead's additions (fixed now)**
- A5.L1 What can run in this run without breaking clause G5 (coverage): A5.1 and A5.2 (the two small models
  rUv's own code defaults to, on the existing pools); A5.13 (stability) for the lexical lane; set G (clause G3)
  is authored now, before anything below is built; and a reduced form of A5.5, called U6-lite: candidates =
  union of the first 60 lexical passages and the first 60 passages of the incumbent dense lane (there is no
  need index or graph hop yet), re-ordered by `mixedbread-ai/mxbai-rerank-xsmall-v1` and by the control
  `Xenova/ms-marco-MiniLM-L-6-v2`; final file order = sum over lanes of contributions, lexical 2 / (60 + rank),
  re-ranker 8 / (60 + rank), no threshold; scored once on E (dense-covered), F and G with A5.5's thresholds
  (+5 points overall, +10 on amateurs, p < 0.05, added latency at most 1.5 s). Because it lacks the need and
  graph lanes it is reported as U6-lite; a pass admits the re-ranker to the build plan, a fail does not close
  A5.5 (clause G2).
- A5.L2 Everything else in A5 (U1 graph hop, U2 hyperbolic hierarchy, U3 need index, U4 link prediction, U5
  learning on a branch, U7 typed decision, U8 one result per system, the tuned embedder) needs an extraction
  pass over every store first. Those rules stand as written and are not scored in this run; the final report
  lists them as the next programme with their gates.
- A5.L3 A3.4 (stage 2, the full re-embed) is suspended by owner direction until A5.2 to A5.4 are decided: the
  recommended design embeds short need sentences, for which the passage-model question may be moot.

### A6, 2026-11-17 12:01 a.m. ET (before the extraction pass starts; previous hash 3c77522a51b0042732496198f8df8f5c4988ee4fd108c3a695c10057ab5908d1 stays on record)

Reason: owner direction. A5.L2 deferred the graph, need-index, hierarchy and typed-decision candidates until an
extraction pass covered every store. The owner ruled that deferring the unconventional candidates repeats the
failure he is criticising. They are built and scored now on a bounded slice, and every table says "slice".
A5.L2 is replaced by this amendment; A5's thresholds are unchanged.

A6.1 Slice. Stores S = ruflo, RuVector, metaharness, agentic-flow, agentdb, agenticow, RuLake. Slice questions
     = the questions of E, F and G whose file gold lies wholly inside S (history-only and not-in-corpus
     questions excluded). Tuning questions = dev (113) questions whose gold lies wholly inside S, plus generated
     questions held out of the index (below). Nothing is tuned on E, F or G; each frozen setting is written to
     `candidates/slice/FROZEN.md` with its time before the first blind score, and each blind set is scored once.
A6.2 Units. One unit = one section of at most 20,000 characters of a documentation-tier file in S (kinds doc,
     adr, cli and skill as labelled by the v2 chunker; copied agent-definition folders under dot-directories
     excluded as on 2026-11-15), plus one unit per package or crate manifest (its README, or the first 200 lines
     of its entry source file when it has no README). If the count exceeds 7,000, kinds are dropped in this
     order until it does not: changelog and release files; RuVector docs/research; example READMEs. What was
     dropped is listed. A gold file with no unit counts as "not covered"; results are reported on all slice
     questions and on the covered ones, never only on the covered ones.
A6.3 Extraction (Sonnet on the subscription, one fixed prompt, source text of the unit only): a two-sentence
     summary; six newcomer questions in everyday words with no product names; and up to four capabilities, each
     with the author's name for it, a plain definition, three problem statements in everyday words, a standing
     (implemented, measured, decided, corrected, claimed, planned, speculative) and a verbatim quote from the unit
     that supports it; and links (from, type, to, verbatim quote). Code drops any capability or link whose quote
     is not verbatim in the unit. Clause G4 (8-word overlap with any D, E, F or G question) is run and listed.
     One generated question in ten (by seeded hash of the unit id) is held out of every index as tuning data.
A6.4 Need index (U3), built in RVF: one vector per kept newcomer question and per summary, mapped to its file.
     Node / need embedder chosen as A5.3 says, on tuning questions only: all-MiniLM-L6-v2, bge-small-en-v1.5,
     the incumbent; the smallest within 3 points of the best. Stage 0: each stored question retrieves its own
     file at rank 1 for at least 99%; held-out generated questions retrieve their file within 5 for at least
     90%. Blind rule = A5.4 on slice questions: result = 5 lexical files + 5 need-index files against the
     lexical lane at 10 files; +10 points on amateurs, exact McNemar p < 0.05, no stratum down 5 or more
     questions.
A6.5 Graph with vectors on nodes (U1): nodes Problem, Capability, Package, File, Decision; edges solved_by,
     implemented_in, documented_in, part_of, depends_on (the manifest edges), explains. Vectors on Problem and
     Capability nodes with the embedder of A6.4. The query operation is rUv's own
     `TypedGraph::search_then_traverse` (RuVector `crates/ruvector-graph/src/typed_graph.rs`), run from a small
     Rust harness built in scratch; if that crate cannot be built here within two hours of trying, the harness
     falls back to a faithful port of that one function, and the result is labelled "port, not rUv's operator"
     and cannot support a negative verdict (clause G2). Stage 0: for RuVector crates with a manifest
     description, the description as a query reaches that crate's capability node and its README at rank 1 for
     at least 95%. Tuning knobs and values as listed for U1, tuning questions only. Blind rule = A5.6 on slice
     questions: 5 lexical + 5 graph-hop files against lexical at 10; +10 points on amateurs, p < 0.05; "both
     repositories present" +10 points on cross-repo slice questions; no stratum down 5 or more questions.
     If A6.4 and A6.5 both pass, A5.6's tie rule applies.
A6.6 Hierarchy, cheap form first (U2b, on `@ruvector/rvf` as shipped): hierarchy-composed node vectors with a
     depth filter, added to the graph lane; rule A5.7 on slice questions. The Riemannian form (U2) is built only
     if U2b's stage 0 passes and time allows.
A6.7 Typed decision with abstain (U7), answer level: arm = the best passing retrieval result plus the capability
     nodes' standing and an explicit "nothing matched" signal; rule A5.10 on slice questions, 3 runs, the same
     blind calibrated judge.
A6.8 Order if compute or quota is short: A6.3, A6.4 and A6.5 first (the amateur path), then A6.7, then A6.6,
     then the tuned embedder (A5.12), which needs a new pair loader and is not started before the others report.
     Anything not reached is reported as not run.
A6.9 Every table carries: slice stores, number of slice questions, number covered, and the sentence "slice
     result, not a whole-corpus result".

### A7, 2026-11-17 12:06 a.m. ET (before any item below is built or scored; previous hash 84faed8e6ca630174b69bff788a72624828ade64929cb04d21b5861a8f734271 stays on record)

Reason: after A5 was hashed the deep-dive researcher extended the proposal
(`ruvector-deepdive/AMENDMENT-A4-PROPOSED.md`, now sha256 d5d75817bbc1d035009e656d65d63465f54d1fb4f62354593ea2be5d2069dbff) with the rules for the design in
`ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md` (reconstruction by cue, tag and content; risk-adjusted utility;
evolved settings). The lead adopts every rule not already in A5, verbatim, renumbered A7.n with the proposal's
own number n. Where the proposal changed a rule already adopted in A5, the changed text is listed below and
replaces the A5 text. No threshold was edited by the lead. On the 7-store slice (A6) these rules are scored
on slice questions and labelled as slice results (A6.9). All measurement jobs were paused when this was
written; nothing below had been built.

**Rules new since A5 (6)**
- A7.15 R19, reconstruction lane (the design of `04-DESIGN-THE-RUV-WAY.md`, recipe 1): cues, tags, content and
  edges built from source alone under G4 and G5; the walk implemented as a port of rUv's MRAgent store
  interface with his harness and twelve settings. Stage 0: (a) the MRAgent benchmark reproduces on the ported
  code path (accuracy 50.0% baseline, 70.0% evolved; hallucination 0.17, 0.03 on its 60 tasks); (b) a
  capability's own definition, used as a question, lands on that capability and reaches its README for at least
  95% of capabilities. Result = CAPABILITIES section + 5 lexical files + 5 reconstructed files; control =
  lexical at equal file slots. Adopted at +10 points any-gold on amateurs (E + F + G), exact McNemar p < 0.05,
  +10 points "both repositories present" on cross-repo, no stratum down 5 or more questions.
- A7.16 R20, risk-adjusted utility, reported for every candidate beside any-gold: answerable question: gold
  served +1, abstained 0, served without gold -1; not-in-corpus question: abstained +1, anything served as an
  answer -1; score = (mean + 1) / 2. The abstain threshold is set on the training split only. A candidate is
  preferred over another with equal any-gold if its risk score is higher by at least 0.10.
- A7.17 R21, evolved harness: settings evolved on dev + generated questions by rUv's loop (3-fold
  cross-validation, mean minus half the range), frozen and recorded with a hash before any blind score.
  Adopted over the default settings if the blind any-gold on amateurs is higher by at least 5 points;
  otherwise defaults ship. A "dead setting" check (each setting shown to change the training score) is
  reported.
- A7.18 R22, consolidation: shortcut edges only for paths whose answer passed the mechanical citation check.
  Simulated on half of dev; adopted as "safe, off by default" if the other half of dev rises by at least 5
  points and no blind stratum falls by more than 3.
- A7.19 R23, concept layer on cues: stage 0, generated paraphrase pairs with no shared content word meet at
  rank 1 for at least 90%; adopted at +5 points on amateurs over R19 without it.
- A7.20 R16b, query adapter in its designed regime: rUv's micro-LoRA driven from Rust with a supplied
  contrastive gradient, ranks 1 and 2, learning rates 0.001 to 0.1; stage-0 pass = +5 points recall@5 on
  held-out generated pairs. No blind score before that.

**Rules whose text changed since A5 (0)**

### A8, 2026-11-17 12:17 a.m. ET (before any slice score exists; previous hash 36961567020128f87ed5b8500b782d91558ea29652621f6b6ef6b1c7636f0e6c stays on record)

Reason: the extraction pass of A6 lists 9,029 units after its cap rule and runs at 15 to 25 units a minute, so
it cannot finish before the owner's 6:00 a.m. deadline. 65 units (agenticow, part of RuLake) were extracted when
this was written; nothing was built or scored.

A8.1 Order. Extraction proceeds in three tiers across all seven slice stores: tier 1 = one unit per package or
     crate manifest plus every README file; tier 2 = decision records (ADR files); tier 3 = all other
     documentation-tier units. Within a tier the store order of A6 is kept. The 7,000 cap of A6.2 is lifted:
     nothing further is dropped, the pass simply runs in this order for as long as it runs.
A8.2 Parallelism. Extraction calls are requests to a hosted model and use little CPU; they run at parallelism 6
     whatever the machine load, and back off only on a quota or rate-limit message. The load rule (below 60)
     still governs local compute: embedding, index builds, compiling, re-ranking, shipped-server searches.
A8.3 Two looks, fixed now. Look 1 (interim): when tier 1 is complete for all seven stores, or at 3:30 a.m. ET
     if it is not, the need index and the graph are built from the units that exist, frozen as A6 requires
     (tuning questions only), and scored once on the slice questions of E, F and G. Look 1 is reported as
     "interim, coverage N units of 9,029" with every rule line shown as a number, and no rule is declared met
     or not met on it. Look 2 (final): when tiers 1 and 2 are complete (or the whole pass, if it finishes),
     rebuilt with the SAME frozen settings and scored once; the rules of A6.4, A6.5 and A7 are judged on look 2
     only. If look 2 cannot happen before the report is written, the report says the rules are not yet judged.
     Every table states the units covered and how many slice questions have a unit for their gold.
A8.4 Set G is added to the blind sets as soon as the lead has re-verified its quotes; the slice questions of G
     are those whose file gold lies wholly in the seven stores.
A8.5 Full-precision test (from the project history: 8-bit model weights were used from the first commit and
     never compared). On the existing pools of the embedder screen, for the incumbent and for
     bge-small-en-v1.5: full-precision weights against 8-bit, dense any-gold@5 and the three-process
     stability measure of A5.13. Reported as a difference with exact McNemar counts; no adoption rule, because
     it informs the build setting, not a lane. It runs only after the slice build has reported look 1.

### A9, 2026-11-17 12:36 a.m. ET (before any item below is scored; previous hash d15a52cff0e8f3d2872030ede243dda87a226f14e7f892d529d542600dce8744 stays on record)

Reason: owner requirement that the recipe use capabilities that exist in late 2026. A dated survey from live
sources (`SURVEY-2026.md`, read 2026-11-17) found items released in 2025 and 2026 that the run had not
considered. Its central finding on vague questions: on the public BRIGHT benchmark keyword search scores 14.5,
the best confirmed retriever with no language model on the query side about 37 (4 to 8 billion parameters), and
every result above 50 has a language model rewriting or reasoning about the query; a reasoning rewrite adds 12
points to keyword search. In this product the caller is already such a model.

A9.1 Caller-side reasoning query, added to the blind-rewriting test of A4.2 as a second arm with the same
     scoring and the same rule (+10 points on amateurs pooled over E, F and G, exact McNemar p < 0.05, no asker
     group down more than 3 points): the rewriter, seeing only the question, writes (a) one sentence naming what
     kind of thing would solve the problem, (b) three short search queries in technical vocabulary, and
     (c) six to ten likely technical terms; the lexical lane is run on (b) and on (a)+(c) as a fourth query;
     lists interleaved round-robin with the original question's list, first 5 files. This is what a tool
     description can ask the calling model to do, at no local cost.
A9.2 Need-sentence embedder: `MongoDB/mdbr-leaf-ir` (23 million parameters, released 2025-09-16, 8-bit ONNX
     23 MB) is added to the candidates of A5.3 / A6.4, chosen on tuning questions only like the others.
A9.3 Registered for the next programme, each needing its own stage-0 check and a rule of the A5.4 form
     (+10 points on amateurs at equal slots, p < 0.05) before it is scored; none is run in this run unless
     stated in the report: (i) inference-free learned-sparse expansion of documents
     (`opensearch-project/opensearch-neural-sparse-encoding-doc-v3-gte`, 2025-06-18), which adds related
     vocabulary to the lexical index at build time and costs nothing at query time; (ii) small late-interaction
     models (`mixedbread-ai/mxbai-edge-colbert-v0-17m` and `-32m`, 2025-10-13; SmallReason-ColBERT, 2026-08-29)
     scored through RuVector's MaxSim crate, as a second-stage ordering of found candidates; (iii) a learned
     vector added to the frozen query embedding from logged outcomes (TTT-Embed, 2026-08-12), the published
     form of what rUv's micro-adapter is meant to do, tested in the adapter's designed regime first (A7.20);
     (iv) a navigable segment tree without generated summaries (NavTree, 2026-09-30) as the cheap baseline for
     any generated-summary layer.
A9.4 The public numbers are recorded as context, not as targets: no public system opened in the survey reports
     anything near 98% first-page success on problem-only questions, and the measures are not the same as this
     run's. The report says so.

### A10, 2026-11-17 12:44 a.m. ET (before set H exists; previous hash 6891800ae860e0dbde16cb5556af11279f9ce514f808728868611fe71ce71c20 stays on record)

Reason: owner clarification. The product's purpose is not only to find and to answer; it must GUIDE: take a
novice who states a goal and give the right workflow, the right combination of tools, the order of steps, the
pitfalls, the way the author himself builds. That is a third thing to measure, beside finding and answering.

A10.1 Set H, "build-guidance": about 40 questions by two new Opus authors under the A2.1 protocol (gold found
      by browsing and reading, no keyword search; authors see no cards, no retrieval output, no other question
      set). Each question is a goal stated by a novice with no product names ("I want my helper to remember
      what we did yesterday and get better at my codebase over time"). Gold = what the author's own
      repositories do for that goal, as an ordered plan: the capabilities to use (2 to 5), the order of the
      steps with the key command, call or setting for each, at least one pitfall or limit the sources state,
      and the reason for the choice, each element with a verbatim quote from a quick-start, guide, example or
      implementation file. Each gold step is an atomic, checkable fact.
A10.2 Scoring, answer level, the same blind judge and mechanical checks as R8 (citations must resolve; a
      must-not-claim hit caps the score), 3 runs per arm, with three added judge fields decided against the
      gold: capabilities_named (how many of the gold capabilities the answer names), order_workable (would the
      steps work in the order given, judged against the gold order), pitfall_given (does it state a pitfall or
      limit the sources state). Guidance success for one answer = score at 8 or above AND at least two thirds
      of the gold capabilities named AND order_workable. Reported for every arm: no tool; the shipped Brain;
      files + history; and any layer that claims to guide.
A10.3 Rule for a guidance layer (playbooks, how-the-author-decides notes, anti-patterns): admitted if guidance
      success rises by at least 10 points over files + history on H, with a 95% bootstrap interval excluding
      zero, and false claims do not rise. The owner's bar applies to this stratum as to the others: the share
      of questions with guidance success in at least 2 of 3 runs is the number reported against 93% and 98%.
A10.4 The judge's calibration gate is repeated for H with a seeded set that includes answers with the right
      tools in an unworkable order and answers with a workable order built on a wrong tool; both kinds must be
      scored as failures of guidance.

### A11, 2026-11-17 12:47 a.m. ET (before the slice is frozen or scored; previous hash 8bde58a66e479a6f3b06e4a70a633803184e906894d3d0315221c088f5c8f6ef stays on record)

Reason: a separate researcher (`MISSING-PIECES.md`) found that rUv has already written guidance in newcomer
wording, and the corpus holds it only as ordinary passages: for example the "I need to..." decision guide and
the 32-plugin "when to use" catalog in ruflo `plugins/ruflo-core/skills/discover-plugins/SKILL.md`, and the
ordered recipes in ruflo `.claude-plugin/docs/QUICKSTART.md`. The lead verified the decision guide in the clone
(line 91 onward: "Build a feature", "Fix a bug", "Search past decisions", each mapped to named plugins).

A11.1 Author-written cues. A mechanical pass over the seven slice stores collects rows the author himself wrote
      that map a need to a tool or a goal to ordered steps: tables and lists under headings such as "I need to",
      "when to use", "use when", "decision guide", "which should I use", "quick start", "common workflows".
      Each row becomes a cue (the need, in the author's words) linked to the capabilities or packages it names,
      or a playbook (ordered steps, each with its command), with the source path, line range and a verbatim
      quote checked by code, and the file's last-commit date where the clone has it. No model writes the need
      text; a model may only split a row into fields, and the fields must be found verbatim in the row.
A11.2 These cues and playbooks enter the graph of A6.5 as cue nodes of kind "authored" and playbook nodes, from
      look 1 on. On tuning questions only, the builder reports the lane with and without them. On blind sets
      they are part of the one frozen design; no separate blind comparison is run.
A11.3 Playbooks are also the first guidance layer for rule A10.3 on set H (answer level), served as their own
      section; that test is run only after H exists and is verified, and is reported as not run otherwise.
A11.4 A row taken from a file that names a superseded package or command (for example the old package name
      with an alpha tag) is kept but marked "possibly stale", and is ranked below an unmarked row.

### A12, 2026-11-17 12:49 a.m. ET (before the slice is frozen or scored; previous hash 93901c3c4ebc4d8f1c0be83cc96246d4371e7fbfaf89352c6831ca30fb95cb50 stays on record)

Reason: the deep-dive researcher added to the proposal after A7 (`ruvector-deepdive/AMENDMENT-A4-PROPOSED.md`,
now sha256 d8aae69aed9d15e1e76f3ccb7bf031da88e9db23da795ca6480d722bfd8a701e). Its reason for the new rule, as it reports reading in ruflo ADR-527 (Accepted
2026-11-10): on a frozen, blind-labelled set of 197 plain prompts (113 held out) routed to a label with
all-MiniLM-L6-v2, the shipped default scored 25.7%, nearest stored pattern 36.3%, a trained small network
57.8%, and the nearest centroid (one mean vector per label) 62.8%. Adopted verbatim, renumbered A12.n with
the proposal's own number n. On the slice the builder adds "landing by capability centroid" (each
capability carries the mean of its cue vectors) as a tuning option chosen on tuning questions only.

**Rules new since A7 (1)**
- A12.21 R24, landing by centroid (ruflo ADR-527, 2026-11-10: nearest centroid 62.8% against nearest stored
  pattern 36.3% on 113 held-out prompts): each capability carries the mean of its cue vectors; landing =
  nearest centroids, then cues. Stage 0: on held-out generated cues, the right capability is first for a
  higher share by centroid than by nearest cue. Adopted as the default landing if any-gold on amateurs is not
  lower than nearest-cue landing and the "does not exist" rate is higher or equal; a tuned embedder (R1c) is
  judged against this baseline.

### A13, 2026-11-17 1:01 a.m. ET (before the slice is frozen or scored; previous hash d5281697392e6491b3c7ac50e0540800d3a97755e84672da083ba0a45d6ece2e stays on record)

Reason: the deep-dive researcher added rules after A12 (`ruvector-deepdive/AMENDMENT-A4-PROPOSED.md`,
now sha256 a00cb313de5febe64cde20985e232d1cba03240ea013afaa6fc91978f3e8110c), after a second reading of the source. The one that changes the slice build: in
rUv's MRAgent example every content item is scored by the question's own similarity to that content, and
abstention uses the same number (examples/mragent/agent/memory.mjs:253-320, as the researcher read it). For
an amateur that similarity is exactly what is missing, so the walk as shipped would prune the right file.
rUv's typed-graph operator already returns the seed score with what it reached. So the walk gets a setting
"evidence" = content | cue | max, chosen on tuning questions only, with a stage-0 check that must pass
before the reconstruction rule is scored. The other new rules (navigation operations at answer level, a
learned projection from question logs, preconditions) are registered and not run in this run unless the
report says so. Adopted verbatim, renumbered A13.n with the proposal's own number n.

**Rules new since A12 (4)**
- A13.22 R19a, evidence source (required before R19 is scored): the walk's content evidence is set to
  `content`, `cue` or `max` on the training split only. Stage 0: on generated problem-only questions whose
  gold file shares no content word with the question, the gold file survives pruning for at least 90% with
  `cue` or `max`; the same check with `content` is reported, to show the difference. R19 is scored with the
  frozen choice.
- A13.23 R25, learned projection from logs (agentdb `ContrastiveTrainer`, seeded and saved): trained on
  confirmed (question, capability) pairs from half of dev plus generated pairs, applied to question vectors
  only. Stage 0: held-out generated pairs, right capability first, +5 points over no projection. Adopted as
  "off by default, safe" if no blind stratum falls by more than 3 points and dev held-out rises by 5.
- A13.24 R26, navigation at answer level: arm N = the R19 result plus the operations `expand`, `siblings`
  and `why`, same question set, 3 runs, same blind judge, searches and navigation calls counted together under
  one cap. Adopted if answers at 8 of 10 or better rise by at least 5 points on amateurs with a 95% interval
  excluding zero, and false claims do not rise.
- A13.25 Stage 0 for every store: the retrieval-contract invariants (filtered top-k returns exactly
  min(k, eligible); no duplicate ids; reported scores agree with returned vectors; nothing deleted is
  returned) and an embedding-space identity check (a query embedded by another model or precision is
  refused).

### A14, 2026-11-17 1:30 a.m. ET (before any blind slice score exists; previous hash 16c75cc5120823a820e927ade8d997e7924d010a0a468f1e00c5ce6c074383a0 stays on record)

Reason: the slice builder's pre-trial on tuning questions (no blind question touched) shows that a generic
newcomer question does not single out one file: held-out generated questions return their own file within 5
for 36%. Many files answer the same everyday need. For an amateur the right thing to land on is the right
capability or package; which of its files is returned matters less. The file-level measure stays as it is;
two things are added so the design is judged on what an amateur needs.

A14.1 Package-level hit, reported beside the file-level measure for EVERY system on the same questions
      (shipped Brain, keyword lane, keyword + history, need index, graph walk): a question is a package-level
      hit at k when one of the first k returned files belongs to the same package (the manifest node that owns
      the file's path, from the dependency graph of 1,148 packages; a file under no package counts by
      repository plus top-level folder) as one of its gold files. Descriptive only: no rule is judged on it.
A14.2 The arbiter for "works for amateurs" is the answer, not the file list. Answer-level test on the slice
      questions of set G (all amateurs): arms A (no tool), D (FILES + HISTORY), Q (D plus a CAPABILITIES
      section placed first: the top 3 capabilities the frozen graph lane lands on, each with its name, plain
      definition, standing, supporting quote, package, and the top files reached; at most 6,000 characters).
      Sonnet answers, 3 runs per arm, the same blind calibrated judge and mechanical caps as R8. Rule: the cue
      design is admitted to the v5 recipe as a served section if the share of questions graded 8 or above in at
      least 2 of 3 runs is at least 10 points higher for Q than for D, with a 95% bootstrap interval excluding
      zero, and false claims are not higher. The owner's gate (93%) is read from the same table.
A14.3 This test uses the look-1 build if look 2 does not exist when it starts, and is then labelled "interim
      build, N of 9,029 units"; it is repeated on the final build before any claim about the whole design.

### A15, 2026-11-17 1:52 a.m. ET (after look 1, before look 2 is built or scored; previous hash b71b57aeef22e3878140d8dac1f7544ad9337d7f750e243cc68007e5c776e278 stays on record)

Reason: look 1 (interim, no rule declared) showed the graph walk returns the same first five files in separate
processes for 52.6% (default settings) and 87.5% (evolved) of questions against the 99% stability gate. Cause
found by the builder: the graph store returns a node's outgoing edges in a different order in each process and
the walk's fan-out limit cuts that list. Look-1 numbers stay on record as scored and are not re-scored.

A15.1 Look 2 is built with adjacency lists and score ties sorted by node id, and with nothing else changed: the
      frozen embedder, landing, both frozen settings sets and every rule threshold stay as hashed in
      `candidates/slice/FROZEN.md` (sha256 e51b20d9...). The stability gate (99% identical in three processes)
      is re-measured on that build and must pass for any walk rule line to be read as met.
A15.2 Every look-2 table also reports amateurs split three ways: every gold file has an extraction unit, some
      have, none has. A lane that reads only extracted units cannot gain on the third group; a gain there is
      investigated as a defect before any rule line is read.

### A16, 2026-11-17 2:50 a.m. ET (after the A10.3 result on set H; before any capability section for H exists; previous hash 057363b90aa4069e075a7695667a157cb170fc7d405fcf914c4bb07319b6a565 stays on record)

Reason: rule A10.3 was not met (+1.7 [-2.5, 6.7]): a GUIDE section chosen by keyword match carried two thirds
of the gold tools in 0 of 120 answers. That result stands. This amendment registers a DIFFERENT layer on the
same questions, so set H is now used a second time; a pass here is therefore reported as "second use of H" and
needs confirmation on a new guidance set before it is called admitted.

A16.1 Arm QH on set H (40 questions, 3 runs, same answer prompts, mechanical checks, judge, calibration and
      caps as A10): keyword + history (arm D of A10, reused as run) plus a CAPABILITIES section placed first,
      produced by the slice builder's frozen look-1 graph lane exactly as for A14.2 (top 3 capabilities landed
      on, each with name, definition, standing, quote, package, files reached; at most 6,000 characters;
      computed once from the original question). No setting is tuned on H.
A16.2 Rule: QH minus D on guidance success (A10.2) at least +10 points, 95% bootstrap interval excluding zero,
      false claims not higher. Reported beside it: share of gold tools present in the section; tools named;
      workable order; the owner's measure (success in at least 2 of 3 runs).
A16.3 Not met is reported as not met. Either way, the next guidance instrument has plans written by two
      independent authors, and "workable order" is judged against both.

### A17, 2026-11-17 3:08 a.m. ET (after the A14.2 result; before any arm-N answer exists; previous hash e9f505b25f145f4c34a70c6063f12b8de6a40a7acb8b19d0868cc83f6bbfb6e1 stays on record)

Reason: rule A14.2 was NOT MET (-1.5 [-12.3, 7.7]): a section that DESCRIBES the capabilities landed on did
not raise amateur answers, and it did not raise how often a gold file reached the answering session (45.6%
against 47.2%). That result stands. The same table shows where the answer score comes from: with a gold file
served, 68 of 89 answers reach 8 or above; without, 39 of 106. Look 1 showed the need index puts a gold file
among ten served files for 28 of 65 of these questions where the keyword lane does for 5. What has not been
tested is serving those FILES. This amendment registers that test. Set G's slice questions are used a second
time, so a pass is reported as "second use of G" and needs confirmation on new questions.

A17.1 Arm N on the 65 slice questions of set G (3 runs, same prompts, mechanical checks, judge and caps as
      A14.2): on EVERY search call the FILES section holds the keyword lane's first 5 distinct files plus the
      next 5 distinct files from the frozen look-1 need index queried with that call's own query text
      (embedder, index and settings exactly as frozen in `candidates/slice/FROZEN.md`); a need-index file is
      shown with the sentence that matched, its unit summary, and up to 4,000 characters of the file's text
      from the passage store; HISTORY as in arm D; the whole result at most 60,000 characters.
      Comparison: the existing arm D answers and grades (5 keyword files + history). Reported limitation: arm
      N serves 10 files against 5; an equal-slot control (10 keyword files) is run if time allows and is
      otherwise owed.
A17.2 Rule: N minus D on the owner's measure (question at 8 or above in at least 2 of 3 runs) at least +10
      points, 95% bootstrap interval excluding zero, false claims not higher. Reported beside it: gold served
      in any search and in the first search, per arm, with the 2x2 against 8 or above.

### A18, 2026-11-17 3:36 a.m. ET (after the A17 result; before any arm-M answer exists; previous hash 59c3fdf303261bde8bf1cac943d8aca561f0a5e417d1b446058514bddfdbf0d5 stays on record)

Reason: rule A17 was NOT MET and the arm was WORSE: owner's measure 23.1% against 55.4% (-32.3 [-44.6, -20.0]),
harness validated (keyword excerpts and history identical to arm D, no timeouts). A gold file reached the
session far more often (86.2% against 47.2% of answers), yet with gold served only 28% of answers reached 8 or
above against 77% in arm D. That result stands: adding five more files to every result hurt. Two features of
arm N as the lead specified it are confounded with the lane: the result was larger (51,000 to 60,000 characters
against 31,000 to 47,000), and each need-index file was shown from its first passage, cut to 2,000 to 5,000
characters, not at the part that answers the query. This amendment registers ONE arm that removes both, at the
same size as arm D. It is the third use of the G slice questions; a pass is labelled so and needs new questions.

A18.1 Arm M on the 65 slice questions of set G (3 runs, same prompts, checks, judge and caps): on every search
      call the FILES section holds exactly 5 files: the keyword lane's first 3 distinct files, then the first 2
      distinct files from the frozen look-1 need index (queried with that call's query text) that are not
      among those 3; if the need index returns fewer, the next keyword files fill the 5. Each file, of either
      kind, gets up to 8,000 characters centred on its passage with the best keyword score for the query
      within that file (for a need file with no keyword match: the passages of the extraction unit that
      matched, from its start); a need file carries one extra line with the matched sentence. HISTORY as arm D.
A18.2 Rule: M minus D on the owner's measure at least +10 points, 95% bootstrap interval excluding zero, false
      claims not higher. Reported beside it: gold served (any / first search) and the share at 8 or above when
      gold is served. If M is not better than D, the need index is not admitted as a served-file lane in the
      v5 recipe on this evidence; its file-level gain is recorded as a finding gain that did not reach answers.
