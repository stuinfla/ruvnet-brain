Updated: 2026-11-17 12:21:10 a.m. EST | Version 1.0.0
Created: 2026-11-17 12:21:10 a.m. EST

# What the history changes about the plan to reach about 98% for amateurs and experts

Read with HISTORY.md (what was decided and on what evidence), PATTERNS.md (how it went wrong), BISECT.md
(when it got worse) and the run's own `DECISIONS.md` and `architecture/ARCHITECTURE.md`. This file does not
replace the run's architecture; it lists what the history adds to it. Nothing here is a result. Every
experiment has a rule fixed before it runs.

Words used: *amateur* = someone who knows the problem and not the product names; *stratum* = one kind of
question (which-tool, troubleshooting, why-was-it-built-this-way, cross-repository, build task, history);
*blind* = questions the builder of a layer has never seen; *lane* = one way of finding candidates.

## 1. What "98%" has meant so far, and what it has to mean now

| When | The number | What it measured |
|---|---|---|
| 2026-06-13 | "avg ≥98 AND min ≥95" (forge skill) | an LLM's grade of answers to questions the builder wrote |
| 2026-06-27 | "≥98" (ADR-0002) | citations that resolve, plus a multi-vendor panel |
| 2026-07-07 | "everything at a 98 or better" (owner) | audit scores |
| 2026-08-21 | "Recall@10 ≥ 98%" (ADR-0072) | a sample of about 19 stores, repository given |
| 2026-09-29 | "recall ≥ 98%, quality ≥ 95%" (owner) | 182 questions with the repository given; 160 machine-written questions |
| 2026-11-01 | "≥98% judged recall" (expert-KB skill) | questions a model wrote from the stored passages of one expert's videos |
| 2026-11-15/16 | "98% for amateurs and experts" (owner) | **an answer a blind, calibrated judge grades 8 of 10 or better, in at least 2 of 3 runs, reported for amateurs and experts separately** (run decision D14) |

Only the last one describes what the owner is asking for. The earlier 98s were reached or approached on
tests that named the repository or were written from the answer.

**Consequence 1: the instrument has to grow before the target can be claimed.** With 84 questions an observed
98% has a 95% interval of 91.7% to 99.3%; with 300 it is 95.7% to 99.1%; with 500 it is 96.4% to 98.9%. A
claim of "about 98% for amateurs" needs roughly 300 amateur questions and 300 expert questions with gold
confirmed by a second author, three runs each. The run's own count: about one question in eight has gold its
author was least sure of, and 17 of 84 questions cross the pass line between runs of the same system
(D14). Until that is fixed, 98 and 93 cannot be told apart.

**Consequence 2: perfect search is not enough.** When the gold reached the answering model, 72% of answers
reached 8 of 10 (D14). So two gaps have to close: finding (amateurs 54% found, experts 92%) and answering from
what was found.

## 2. Assumptions carried from the past that must be re-tested, in order of how much rests on them

| # | Assumption | Where it came from | Why it is in doubt | Test |
|---|---|---|---|---|
| A1 | bge-base-en-v1.5 is the right embedder | 12 questions on one repository, 2026-06-28, where it scored below MiniLM in a comparison the record calls not comparable; rUv's NFCorpus result (medical abstracts) | first two challengers beat it by 11 and 17 questions of 76 on the development pilot; blind passes unfinished | finish the pre-registered screen (R1, A3); experiment N3 |
| A2 | 8-bit model weights cost nothing | library default | the 8-bit model's output changes with batch composition (same passages re-embedded gave the same five files for 28 of 76 questions); rUv's ADR-089 suspected the 8-bit build for bge-large's missing lift; the expert-KB recipe uses fp32 | N3 arm |
| A3 | Chunk size (now 4,000 characters; pilot 480 tokens) | forge skill; pilot kept 480 by decision | "Chunk size (480 vs ~200 tokens vs ~140 words). No re-chunked corpus was embedded" (RECIPE §6); the expert-KB recipe reached 96-98% with about 140 words | N6 |
| A4 | A header in front of the embedded text helps | rUv ADR-076 (+41.8% MRR on 30 questions); the retired MiniLM build had one, the shipped bge build never did | measured only inside the pilot's bundle of changes | N6 arm |
| A5 | One index per repository plus a router | ADR-0006, for rebuild cost | the router refuses or mis-routes amateur questions; a global keyword index does not need a router | already adopted by the run (no router); keep measuring per-store vs global for the vector lane |
| A6 | The MS-MARCO reranker's score is a relevance judgment | forge skill; six example queries | it scores the gold passage below zero for 32 of 35 newcomer questions; "flat" on the pilot | N8 |
| A7 | Cards can answer in place of search | 19 questions, 2026-07-27 | rUv's 2026-07-28 report; 134 of 185 cards are placeholders; cards failed confirmation as a search section | keep the run's rule: no card answers in place of a search |
| A8 | Source files can be represented by their opening comment | forge skill | 51% of source files comment-only, 15% dropped (audit) | adopted fix: index bodies; verify coverage mechanically (gold-indexed rate) |
| A9 | Meaning vectors "do not add" to keyword search | 2026-11-16, D7/D10 | tested with one embedder, 8-bit, no query adaptation, passage vectors only; amateurs are the one group where vectors tie keywords | N1, N2, N3 before any verdict (owner direction D15) |
| A10 | Global hybrid search hurts | 2026-07-19 | wrong regime (see PATTERNS §13) | already reversed by the run |

## 3. What was lost or never tried and is worth trying

Each line says where the idea came from and what stopped it.

1. **Newcomer questions and summaries written per file section, each as its own vector** ("doc2query",
   ADR-0099 arm A, 2026-10-01; pilot 2026-11-15). Stopped twice: in October for want of a build step, in
   November because it covered 9 of 24 stores. The only single change in the pilot that cleared the noise
   (28.9% to 52.6%), and strongest for novices (34% to 51%).
2. **Learned query adaptation with rUv's SONA / MicroLoRA** (ADR-0099 arm B). A harness was committed on
   2026-10-01 and never run. The deep dive found that the Node binding cannot be fed question-passage pairs
   and cannot save the learned weights, while the Rust API can (`LearningSignal::with_gradient`), and that
   there is no measured text-retrieval gain anywhere in rUv's code (`ruvector-deepdive/raw/E-…:70-80`). So
   this is untested in any regime, by anyone. It deserves one honest test in its designed form (a small global
   shift from "newcomer wording" towards "documentation wording"), with a simple baseline beside it so that a
   failure of the adapter is not read as a failure of the idea.
3. **Query rewriting by the calling model.** Never tried here. rUv's ADR-079/080 rejected query-time rewriting
   only on the cost of an extra LLM call; the Brain's caller *is* an LLM that is already running, so that cost
   does not apply.
4. **Answer verification before the answer is shown.** ADR-0002 asked for it in June ("an answer whose
   citations don't hold up fails"); the write-path gate checks that a search happened, not that the answer
   matches it (issue #46 **[G:E-145]**). The run measured that a mechanical citation check changes grades by
   two points on partial answers.
5. **Learning from use.** ADR-0099 arm B/D: every search already leaves a receipt of which source was cited.
   Never used as a training signal. rUv's ADR-176 "flywheel" tunes retrieval settings from self-made queries
   and holds a human-labelled anchor flat.
6. **Graph or relationship retrieval.** One-hop expansion over hand-built edges added nothing (75.6% vs
   75.0%). Not tried: answering cross-repository questions by retrieving *one file per named system* (a
   coverage rule, not a ranking rule). Cross-repository is 0 of 22 for every lane under "all gold in the top
   5".
7. **The keyword index built with the corpus** (ADR-0099 next step 1). Now the backbone of the run's design.
8. **rUv's own pieces that were never wired in**: MMR diversity (never ported), reciprocal-rank fusion with
   his Lucene analyzer (first used 2026-11-15), labels and paths first (ADR-076), the 1-bit query path for
   memory (RaBitQ), a reranker that did not hurt on indirect wording in his own tests (mxbai-rerank-xsmall,
   agentdb ADR-016).
9. **A code-aware embedder and more than one vector per chunk** (ADR-0004, 2026-06-27). Never run.
   jina-embeddings-v2-base-code is on the run's candidate list.
10. **An authority order** (code over docs, newer over older, corrected over claimed). Identified in the pilot
    (contradictory documents about `doctor --fix`) and in the run's architecture; not yet measured.
11. **A facts table with an authority label.** The unlabelled form lowered answers; "the idea is not dead, the
    unlabelled form is" (RECIPE §8).
12. **Ideas earlier leads proposed and dropped**: content-aware store routing and MMR ("Fix A", July);
    per-segment fact summaries for transcripts (July); vector-based store routing (tried and reverted in one
    day, 2026-10-16, on a repository-level judge); the learned judge (failed with eight features; never
    retried with the passage text itself).

## 4. Rules for every experiment below (taken from what went wrong before)

1. The pass rule, the question set and the comparison are written down and hashed before the first run
   (as in `PREREGISTRATION.md`).
2. Questions are blind to whoever builds the layer; gold is found from source and verified mechanically;
   amateurs are reported first and separately.
3. File-level and answer-level measures only. Repository-level numbers are reported as a diagnostic, never as
   the result.
4. The product's real entry point is what gets measured.
5. A layer is judged only at full coverage of the corpus it is compared on (partial lanes diluted results three
   times on 2026-11-16).
6. At answer level: three runs per arm, a calibrated blind judge, mechanical citation caps first.
7. A failed rule is reported as failed and the rule is not retuned on the same questions.
8. For anything rUv ships: before writing "does not work", state the designed regime, whether it was tuned,
   whether the right component was used, and whether the harness was sound (PATTERNS §13).
9. No code may mention the wording of a test question.

## 5. Ranked experiments

Ranking = expected gain on the weakest stratum (amateurs, which-tool) per unit of cost, with cheap tests that
unblock others first. "E+F" = the 244 blind questions of 2026-11-16 (56 + 32 amateur askers). "Pool" = the
run's rig over rebuilt passages. Costs are on this machine; LLM work is subscription (no API billing).

### N1. Let the calling model rewrite the question before searching (never tried)
- **What.** The tool description and the first result tell the calling model to issue two or three searches:
  the user's words, then a version in likely documentation words (product-neutral: "copy-on-write branch of a
  vector memory" for "20 copies of my helper each need their own memory"). Compare with a fixed single
  search. A second arm lets a small local step expand the question with terms taken from the first result's
  own text (pseudo-relevance feedback), no LLM.
- **Targets.** Amateur which-tool and troubleshooting (keyword lane finds 16 of 56 amateur questions on E).
- **Pass rule.** On E+F amateur questions (n = 88), gold file in the union of the top 5 of each search rises
  by at least 15 points over the single search with the same total number of result slots, exact McNemar
  p < 0.05, and expert questions do not fall by more than 3 points. Answer level (84 questions, 3 runs):
  amateur mean at least +5 points with an interval excluding zero.
- **Cost.** No index work. About 2 hours of subscription LLM time for the rewrites; search time is 1.8 s
  each.
- **Regime note.** Glossary expansion failed (62 vs 78 of 164) because it added words blindly to one query.
  This test keeps the original query and adds separate searches; it is a different mechanism and must not be
  rejected on the glossary result.

### N2. Newcomer questions and summaries for every section of every store, as separate vectors and as keyword text
- **What.** The pilot's derived layer at full coverage: for each file section, one summary and about six
  questions a newcomer would ask, each stored as its own vector pointing at the section; the same text in the
  keyword index.
- **Targets.** Amateurs, which-tool.
- **Pass rule (rule R4 again, on new questions).** On a fresh blind amateur set of at least 100 questions,
  gold file in the top 5 rises by at least 10 points over the keyword lane alone, p < 0.05, with no other
  group falling by more than 3 points. Leakage check: any generated question sharing 8 consecutive words with
  a test question is listed and the test question reported both ways.
- **Cost.** About 14.7k Sonnet calls for documents and CLI files (about 3.6 hours at 8 parallel), about 40k
  for every file (about 9.7 hours); 280k short vectors, about 1.6 embedding hours (RECIPE §3, §5).
- **Why ranked here.** It is the one lever with a noise-clearing result behind it, and it was stopped twice
  for reasons unrelated to quality.

### N3. Finish the embedder question properly, including the cheap arms nobody ran
- **What.** (a) Complete the pre-registered screen on E and F for the listed models. (b) Add three arms that
  cost almost nothing on the same pool: the incumbent with full-precision weights (fp32) instead of 8-bit;
  the incumbent with batches sorted by length (fixed batching); MiniLM-384 (the model the June comparison
  never fairly tested, and rUv's own default). (c) A code-aware model on code-gold questions only.
- **Targets.** All strata; reported for amateurs first.
- **Pass rule.** As pre-registered (R1 with A3): at least +10 points dense-only and at least +5 points fused
  with the same weighting on the blind part, p < 0.05, and fused beats the keyword lane alone by at least 5
  points on E+F; otherwise "better than the incumbent, still not worth a vector lane". For the fp32 arm: any
  difference of 5 or more questions out of 224 is reported as "the 8-bit build costs quality" and fp32 becomes
  the control.
- **Cost.** About one hour per model on the pool; a full re-embed is 9 to 49 hours and is run only for a
  model that passes.
- **Regime note.** "Vectors add nothing" (A9) stays open until this, N1 and N2 are done; the owner's direction
  D15 holds.

### N4. Answer verification: check every claim against the served text before the answer leaves
- **What.** After the model drafts an answer, a second pass (same subscription model, or mechanical where
  possible) lists each factual claim, finds the supporting line in the served sources, and removes or flags
  unsupported claims; cited paths must resolve.
- **Targets.** Gap two (found but answered badly): 28% of answers with gold in hand still score below 8; 6 to
  12% of answers contain a false claim.
- **Pass rule.** On the 84-question answer test, 3 runs: share of answers at 8 or better, *among answers where
  gold was served*, rises from 72% by at least 8 points with an interval excluding zero; false-claim count
  falls by at least half; "does not exist" stays 36 of 36.
- **Cost.** One extra model call per answer; about 3 hours for the test.

### N5. Coverage rule for cross-repository and build questions: one slot per named or implied system
- **What.** When the first results (or the calling model's rewrite, N1) name two or more systems, the served
  set reserves slots so each system contributes its best file, and an "integration" slot prefers files that
  mention both. No rank fusion.
- **Targets.** Cross-repository (0 of 22 all-gold today; 14 of 22 with both repositories represented in ten
  files), build tasks (69.4 at answer level).
- **Pass rule.** On E+F cross-repository and build questions (n = 60): all gold repositories represented in
  the served set for at least 80% of them (today 14 of 22 on E within ten files, run decision D8), and answer score on those strata at least +5 with an interval
  excluding zero, other strata not down more than 3.
- **Cost.** Reader logic only; no index work.

### N6. Chunk size and header, as a clean A/B on three stores
- **What.** Re-chunk ruflo, RuVector and metaharness four ways: 480 tokens with header (pilot), about 200
  tokens with header, about 140 words with header (the expert-KB recipe), 480 tokens without header. Same
  embedder, vector lane only, plus keyword lane on each.
- **Targets.** The largest untested variable for the vector lane (RECIPE §6).
- **Pass rule.** A variant replaces 480-with-header if it raises dense top-5 by at least 5 points on the
  questions whose gold lies in those stores (109 of 286 known; n stated), p < 0.05, without lowering the
  keyword lane by more than 3 points. The no-header arm quantifies A4.
- **Cost.** Three stores are about 40% of pilot passages: roughly 4 to 6 embedding hours per variant.

### N7. SONA / MicroLoRA query adaptation, tested once in its designed regime
- **What.** Train a rank-2 adapter on question vectors using the N2 pairs (generated newcomer question →
  section vector), through the Rust API that accepts a chosen gradient; apply it to the question vector before
  the vector search. Beside it, a plain baseline with the same data: a single learned linear map (least
  squares) from question vectors to section vectors. Bypass when untrained (an untrained adapter already
  changes the vector, ADR-0099).
- **Targets.** Amateurs, vector lane only.
- **Pass rule.** On blind amateur questions, dense top-5 with the adapter exceeds dense top-5 without by at
  least 5 points, p < 0.05, expert questions not down more than 3 points. If the adapter fails and the linear
  map passes, the record says "query adaptation works; the rank-2 residual with a gain cap is too small for
  it", not "SONA does not work". If neither passes, "query-side adaptation on this embedder does not close
  the amateur gap".
- **Cost.** Needs N2's pairs. Training is minutes; a small Rust harness is about a day of work.
- **Regime note.** Designed regime: a global wording shift, trained, with a persisted adapter. Never yet
  tested by anyone, including rUv, on text retrieval.

### N8. Replace or drop the reranker by measurement
- **What.** On the top 50 files of the keyword lane (plus N2 lanes), compare: no reranker; the shipped
  ms-marco-MiniLM-L-6; mxbai-rerank-xsmall (the one that did not hurt indirect wording in rUv's agentdb
  ADR-016); reranking the best 480-token passage rather than a 3,000-character document head.
- **Targets.** Top-5 precision for all groups; amateurs first.
- **Pass rule.** A reranker is kept only if gold in the top 5 rises by at least 5 points on E+F over no
  reranker, p < 0.05, and added time is under 2 s per search.
- **Cost.** Half a day; models are about 25 to 90 MB each.

### N9. Authority order and corrections served with claims
- **What.** Label every unit implemented / measured / corrected / decided / claimed / planned; when two served
  sources disagree, the higher standing is shown first and the disagreement is stated.
- **Targets.** False claims (the `doctor --fix` class), why-was-it-built questions.
- **Pass rule.** On a blind set of at least 40 questions whose gold includes a correction or a
  code-versus-doc disagreement (to be written), false-claim rate at answer level falls by at least half with
  no fall in mean score.
- **Cost.** Mechanical labels for code/doc/date; extraction for corrections (part of the run's S5 layer).

### N10. Learning from use, measured offline before it ships
- **What.** Replay the grounding receipts already on disk (which sources were cited after which searches) as
  extra question → file pairs; add them to N2's lane.
- **Targets.** The questions real users ask.
- **Pass rule.** With receipts from before a cut-off date as training, gold-in-top-5 on questions *after* the
  cut-off (gold = the file finally cited and verified) rises by at least 5 points, and E+F does not fall.
- **Cost.** Local data only. Note the stated risk: "cited" is not "correct" (ADR-0099).

### N11. The instrument itself
- **What.** Grow the blind set to about 300 amateur and 300 expert questions, each gold confirmed by a second
  author; keep the sealed 237 for the final qualification; add a paraphrase-pair stratum (both wordings found
  in 0 of 8 pairs today).
- **Pass rule.** Not a pass rule: a precondition. Until it exists no claim above about 93% can be supported.
- **Cost.** About 12 Opus author-hours on subscription, plus mechanical verification.

## 6. Order of work the history argues for

1. N11 in the background (it gates every claim).
2. N1 and N5 (no index work) and N3's cheap arms on the existing pool.
3. N2 at full coverage, then N4.
4. N3 full embed only for a model that passes; N6; N7 on top of N2's pairs; N8.
5. N9, N10.

## 7. What I could not establish

- Whether any of N1 to N10 will work. None has been run.
- The deep dive of rUv's stack was still being written while this was drafted. Of its six raw files I read
  one in full (embedders and learning), the first 140 lines of another (ruflo/agentdb retrieval), and only
  the lines citing ADR-210 in a third; the store, graph and RAG files were not read. Its final
  recommendations may add candidates; they should be added to the pre-registration before any is scored.
