Updated: 2026-11-17 00:05:00 EST | Version 1.0.0
Created: 2026-11-17 00:05:00 EST

# First re-plan: the route to about 98%, after the research

Written by the lead after reading the research that landed by 12:05 a.m. ET on 2026-11-17:
`ruvector-deepdive/ORIGIN-AND-PHILOSOPHY.md`, `02-NATIVE-EMBEDDING-OPTIONS.md`, `03-NOVEL-STRATEGIES.md`,
`AMENDMENT-A4-PROPOSED.md`, `raw/E-embedders-learning.md`, and `history/CURRENT-EMBEDDING-STRATEGY.md`
(`CAPABILITY-MAP.md` and the catalog skimmed; `STORY.md` and `BISECT.md` had not landed). One direct question to
the shipped Brain is recorded in section 5. Measurements cited are in `DECISIONS.md` (D3 to D16). All
measurement jobs are paused (`PAUSED.md`); this plan says which are worth resuming. Nothing here is a result
unless it cites one.

## 1. What I got wrong, and what the research changes

The owner's criticism is right, and it is specific. The run so far asked "which stored text is most like the
question, and which model measures likeness best". The research shows rUv never built toward that question:

- RuVector began as agent memory, and its design rests on these ideas (each quoted with source in the
  philosophy document): the stored unit is a thing with links and an outcome, not a passage; an answer is
  rebuilt by walking from a cue to what it leads to ("Follow Cue, Tag, and Content associations instead of
  retrieving one flat chunk"); knowledge has kinds that are stored separately; hierarchy has its own
  geometry; "I don't know" is a designed, scored answer; how the store is searched is evolved against a
  held-out split, not hand-tuned; learning is edges and votes written after outcomes, on a branch that can be
  dropped; everything carries proof of what went in and what came out.
- rUv has already written down how a project's knowledge should be stored by kind. RuVector ADR-056 maps
  project identity, crate taxonomy, decision history, the dependency graph, the evolution timeline, patterns
  and conventions, and lessons learned to separate RVF segments of one file. My ontology found the same kinds
  from the other direction (21 kinds, `ontology/ONTOLOGY.md`). I stored them as side tables and tested them as
  ranked lists. That is the conventional reading the owner objects to.
- There is no RuVector-native embedding model for finding documents. Every text embedder in RuVector, ruvllm,
  ruflo and agentdb is another lab's model in an rUv wrapper, or a word hash. rUv's defaults are
  all-MiniLM-L6-v2 almost everywhere and bge-small "recommended for .rvf packs"; his best measured retrieval
  runs used bge-base (the Brain's model) with keyword search and a re-ranker; a bigger model gave him no lift.
  So "which embedding model" has an honest answer today (section 3), and it is not where the design's value is.
- The honest other half, in rUv's own corrections: the similarity engine is ordinary, most learning layers are
  young or idle (SONA's adapter barely moves through the Node interface; "learns from every query" was
  withdrawn), and the parts measured on real text say keyword search and a re-ranker do the heavy lifting.
  My blind measurements agree with that half exactly.

What does not change: the measurements. Lexical over rebuilt passages is the backbone on three question sets;
the history store finds what nothing else finds; the current vectors add nothing when fused; rank-fusing unlike
units hurts. Those are facts about lanes. They are not a design.

## 2. The two gaps, and what each needs

From the answer-level test (84 blind questions, three runs, calibrated blind judge):

| | All | Amateurs | Experts |
|---|---|---|---|
| Gold reached the answering session (gap one: finding) | 72.5% | 54.0% | 91.7% |
| Of answers where it did, share graded 8 of 10 or better (gap two: answering) | 72% | not split | not split |
| Answers at 8 or better overall | 59% to 62% | 43% to 52% | 69% to 75% |

Gap one is the amateur's gap, and the research names its cause precisely: an amateur's sentence describes a
PROBLEM; the corpus holds descriptions of SOLUTIONS; no likeness measure bridges that. rUv's design does not
try to. It stores problems and capabilities as things, attaches vectors to the things a person's words can
touch, and walks links from there to the source. Evidence that this direction is right, all measured before
the research: generated newcomer questions found gold for 22 of 35 development novices against 12 for the
lexical lane; concept cards, where one existed, found gold for 66 of 82 against 45, independent of word
overlap; on F the right file is in the first 100 candidates for 22 of 25 amateurs and in the first 5 for 12.
Evidence against over-reading it: cards failed their pre-registered confirmation at a quarter to half coverage.

Gap two is not a retrieval gap. Even with the right file in hand, 28% of answers fall short. The research
supplies rUv's own instruments for it: standing and evidence on every claim (Brainpedia: "A claim without
evidence is a candidate"), corrections stored with the claims they overturn, abstention as a scored answer,
and a typed decision engine with an abstain option. The one measured hint: with cards, which carry standing,
false claims were 15 against 29.

## 3. The recipe I now propose to build and test (not yet a result)

Stated the way the owner asked: which embedding model, is it RuVector-native, what is the hybrid design.

- **Embedding model: no RuVector-native retrieval model exists, so none can be chosen.** The proposal is
  `bge-small-en-v1.5` (384 numbers), the model RuVector's core names "default, recommended for .rvf packs" and
  the base of rUv's own fine-tuning pipeline (OpenJev), used for what it is sized for: short need sentences and
  capability definitions on graph nodes, not 480-token passages. It is run through RuVector's own embedding
  runtime with CLS pooling (the research found the npm wrapper hard-codes mean pooling for every model, which
  rUv's own manifest says is wrong for bge; to be verified before use). This is a proposal pending rule A5.3
  (smallest model within 3 points of the best on amateurs, tuned on development questions only). The route to
  a model that is genuinely the Brain's own is rUv's OpenJev trainer with a new question-and-passage loader;
  it is last in the order because it needs new code and a GPU.
- **Passage vectors: none in the base design.** Three blind sets say the current ones add nothing to the
  lexical lane; the two candidates measured so far (development questions only) improve the dense lane but not
  clearly the fused result. The paused screen decides whether an optional passage-vector tier is worth its
  1 to 3.4 GB.
- **Hybrid design, in rUv's terms:**
  1. One knowledge unit per repository in RVF, with a segment per kind as ADR-056 lays out: identity; taxonomy
     of capabilities; decision history with status and supersession; dependency graph; timeline; patterns;
     lessons and corrections. Passages and the lexical index stay beside it in SQLite, because RVF has no
     lexical index (the research checked: the segment for it is unused).
  2. A typed graph: Problem -> Capability -> Package -> File, plus Decision -> Capability, Package -> Package,
     Commit -> File. Vectors only on Problem and Capability nodes. Query = nearest problem and capability
     nodes, then traverse to files, with rUv's own operator (`TypedGraph::search_then_traverse`).
  3. The lexical lane and the history lane as they are (admitted on blind sets).
  4. A re-ranker over the candidates the lanes already find: rUv's best measured one
     (`mxbai-rerank-xsmall-v1`), never as a threshold. The Brain's earlier negative result was about a different
     model, which rUv later measured as harmful on exactly the vague-question slice.
  5. Sections, not one fused list: what the problem maps to (capabilities with standing), files, history.
  6. Abstention by a typed decision over the capability nodes, replacing the fixed reranker threshold that
     today produces "insufficient evidence" on 90 of 164 blind questions.
  7. Search settings evolved by rUv's own loop (MetaHarness Darwin) on a training split, judged on a held-out
     split, never tuned by hand on test questions. This run tuned nothing by evolution; it should.
  8. Learning from use as edges and votes on a copy-on-write branch, off by default until rule A5.9 passes.
  9. Witness chains on what is written and receipts on what is returned, which the RVF format already carries.

## 4. Route to 98%: what has to be shown, in order

No step below is a claim. Each has a rule already hashed (A5, A6) or needs one.

| Step | Aims at | Expected size, and where the number comes from | Gate |
|---|---|---|---|
| 1. Extraction pass over the slice (7 stores), every claim with a verbatim quote | prerequisite | none by itself | quotes verify by code; leak check |
| 2. Need index + problem-to-capability graph on the slice | gap one, amateurs | from 31-37% first-page toward the 60-80% seen where units or cards exist (22 of 35; 66 of 82; 12 of 20 on F). Unproven at full coverage | A6.4, A6.5: +10 points on amateurs, p < 0.05 |
| 3. Re-ranker over found candidates | gap one, ordering | F amateurs: in the first 100 for 22 of 25, in the first 5 for 12: up to 10 questions of 25 are an ordering problem | A5.5: +5 overall, +10 amateurs |
| 4. Typed decision with abstain; corrections served with claims | gap two | false claims are 6% to 12% of answers; cards halved them once | A5.10: false claims down 30%, no stratum down |
| 5. Worked examples per capability (how rUv's own examples do the task) | gap two, build and cross-system questions (67 to 69 of 100, the lowest strata) | not measured; no rule yet | needs a rule |
| 6. Evolve the search settings with rUv's loop | both | not measured | held-out split |
| 7. Instrument able to see 98% | measuring | at n = 84, 98% and 93% cannot be separated; 17 of 84 questions cross the bar between runs; one question in eight has gold its author doubts | 300+ questions per group, gold confirmed by a second author, 2-of-3 scoring |
| 8. Hierarchy, link prediction, learning on a branch, tuned embedder | upside | unknown | A5.7 to A5.12 |

Plainly: nothing measured supports a figure above 62% of answers at 8 or better. The research gives a
credible design for the finding gap and named instruments for the answering gap; it gives no measured evidence
that they reach 98%. Steps 2 to 4 on the slice are the cheapest experiments that could show a large move for
amateurs, and they are the ones to run first.

## 5. One question put to the shipped Brain, and what it showed

Query: "RuVector ADR-056 RVF knowledge export: which kinds of project knowledge go into which RVF segments".
The shipped Brain returned ADR-056 first (relevance 27.1; the next result 4.2), in full, with the segment
table. A second informed query (typed graph, ADR-253) returned 65,066 characters, more than the host accepts,
so the result was not delivered to the model at all: an oversized answer is a failure mode of its own, to add
to the defect list. One hit is an anecdote, not a rate; the paused ladder (A4) is the measurement.

## 6. Which paused jobs are worth resuming, and which are not

| Paused job | Verdict | Why |
|---|---|---|
| A6 slice: extraction, need index, graph | RESUME FIRST (it never started) | it is the research's central design and the amateur path |
| Re-ranker test (U6-lite) | resume, cheap | rUv's own measured lever; models already downloaded |
| Set G (amateur questions) | resume | every amateur rule needs it to detect 10 points |
| Embedder screen | resume only the two small rUv-default models and finish gte on blind sets; drop nomic, jina, bge-large, embeddinggemma | the research shows the passage-model question is secondary; rUv's own data say a bigger model gives no lift |
| Stage 2 full re-embed | do not run | superseded by the design above |
| F answer-level judging (480 answers written) | resume, cheap | 20 minutes of judging confirms or refutes the E answer result |
| Side-by-side document | resume | owner asked for it; needs about 50 more shipped queries |
| Informed-query ladder | resume the candidate-lane half; shipped half only on an idle machine | bounds what query rewriting can do |
| Shipped arm B to three runs | do not run | 11 hours of 7-core search for a number that is not in doubt |

## 7. What the project history and the Brain question log add (read 12:10 a.m., after sections 1 to 6)

Sources: `history/HISTORY.md`, `history/CURRENT-EMBEDDING-STRATEGY.md`, `history/bisect/RESULTS-scores.md`
(bisect still running), `ruvector-deepdive/BRAIN-QUESTION-LOG.md`. `STORY.md` and `BISECT.md` had not landed.

1. **The current embedding recipe was asserted, never tested.** ADR-0004 (2026-06-27) chose "the sharpest
   retrieval regardless of size" on the owner's directive and promised a benchmark of a code-aware embedder
   and bge-large "at P1". That benchmark, and "multiple vectors per chunk", were never run; no other embedder
   was compared on this corpus until 2026-11-16. The one early comparison had the small MiniLM model HIGHER
   (49.5 / 81.8 against 31.6 / 68.0), flagged as not comparable and never repeated. This is a second,
   independent reason to put rUv's two small models on the rig (A5.1), and it removes any presumption in
   favour of the 768-number model.
2. **8-bit model weights have been used since the first commit and were never compared with full precision.**
   This run found the 8-bit model's ranking changes with batch composition (same five files for 28 of 76
   questions). New test to add, cheap: the incumbent and the proposed small model at full precision against
   8-bit, on the same pools, with the stability rule (A5.13). It needs a pre-registered line before it is
   scored.
3. **Several earlier "it does not help" verdicts were measured in the wrong regime**, in the history's own
   words: global hybrid search was rejected on a battery of questions that name the product; the reranker
   threshold was trusted until it was shown to score the true answer below zero for 32 of 35 newcomer
   questions. The same mistake is the one to avoid now with the graph design: it will be judged on amateur,
   problem-only questions, after a stage-0 check in its designed regime (clauses G1, G2).
4. **The bisect so far does not show a better past on these questions.** Release 4.0.36 on 60 file-gold
   questions drawn from D, E and F: gold file in the top 5 for 0 of 60, zero results for 45 of 80, a card
   answered 18 of 80. The earlier corpus generation tested: 1 of 31 so far. If the Brain "worked much better
   months ago", it was on questions that name the product or on measures that counted which card answered
   (the history records "by-description routing 96%" as exactly that). There is, on this evidence, no
   regression to restore for problem-first questions; the capability was never there. To be revised if the
   finished bisect says otherwise.
5. **Informed, name-bearing questions do work on the shipped Brain.** In the researcher's log and my one
   question, a query naming the ADR or the mechanism returned the right document first (ADR-270 at 17.3,
   ADR-253 at 16.9, ADR-056 at 27.1). So the index holds and can surface the material; what it cannot do is
   bridge from a problem described in everyday words. That is the cue layer's job in the new design, and it is
   what the paused ladder (A4) would put a number on. Two defects seen in the same log: answers of 20,000 to
   90,000 characters, several rejected by the host; and any question containing "brain" routed to the wrong
   repository.

Effect on the order of work: unchanged for the slice build, the re-ranker and set G (all three now running by
the parent session's go at 12:06 a.m.). Added to the queue behind them: the full-precision test of item 2,
and, once the slice scores exist, the candidate-lane half of the ladder as the measure of item 5.
