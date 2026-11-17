Updated: 2026-11-17 01:00:28 EST | Version 1.0.0
Created: 2026-11-17 00:48:50 EST

# Proposed pre-registration amendment A4 (for the lead to adopt, edit or reject)

Not in force until the lead adds it to `PREREGISTRATION.md` and records the new hash. Written by the RuVector
deep-dive researcher, who has read no E or F question or gold and has produced no score for any item below.
The only analysis run on E and F data is a descriptive recount of the lead's existing lanes by asker group
(`analysis/pool_depth_by_asker.py`), which adds no candidate.

**Reason.** The owner asked that RuVector's own capability space be traversed before any embedding decision, and
that unconventional designs be scored before any verdict. The traversal (`01-CAPABILITY-CATALOG.md`) found no
rUv-trained retrieval embedder, and found a schema-first typed graph with vectors bound to node labels, a
hyperbolic toolkit with a Riemannian optimizer, knowledge-graph embeddings, copy-on-write branches, a typed
decision engine with abstention, and rUv's own measured re-ranker. Each becomes a candidate with a rule fixed
here.

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
- A4.1 Screen additions (stage-1 pool screen, same pools and control): `Xenova/all-MiniLM-L6-v2` (mean pooling,
  no prefix) and `Xenova/bge-small-en-v1.5` (CLS pooling, BGE query prefix).
- A4.2 R1b, non-inferiority for a candidate whose stored vector is at most half the incumbent's bytes: adopted
  in place of the incumbent if, on pooled n = 224 and on the blind n = 148 separately, fused any-gold@5 (both
  weightings) is not lower by more than 3 points and dense any-gold@5 not lower by more than 5.
- A4.3 R4b, node and need embedder screen: on short texts (problem statements, summaries, questions) mapped to
  files; candidates = A4.1 models, the incumbent, and the best passage model of A3 if any. Adopt the smallest
  model within 3 points of the best on amateurs.
- A4.4 R4c, need index (U3): result = 5 lexical files + 5 need-index files; control = lexical at equal slots.
  Adopted at +10 points on amateurs, exact McNemar p < 0.05, no stratum down 5 or more questions.
- A4.5 R11, re-rank (U6): union of first 60 lexical and first 60 need / graph-hop passages; contribution
  `8 / (60 + rank)`, never a threshold. Candidates: `mixedbread-ai/mxbai-rerank-xsmall-v1`,
  `Alibaba-NLP/gte-reranker-modernbert-base`, RuVector MaxSim with `answerdotai/answerai-colbert-small-v1`,
  Sinkhorn transport over the same token vectors; control `Xenova/ms-marco-MiniLM-L-6-v2`. Adopted at +5 points
  overall and +10 on amateurs, p < 0.05, median added latency at most 1.5 s at load below 60.
- A4.6 R13, graph hop (U1): result = 5 lexical files + 5 files reached by `search_then_traverse` from `Problem`
  and `Capability` nodes; control = lexical at equal slots. Adopted at +10 points on amateurs, p < 0.05, and
  +10 points on "both repositories present" for the cross-repo stratum, no stratum down 5 or more questions.
  If both R4c and R13 pass, the one with the higher amateur any-gold is the default and the other is kept only
  if it adds at least 5 points on top.
- A4.7 R14, hyperbolic hierarchy (U2, U2b): added to the R13 lane; adopted at +5 points on amateurs and +5 on
  which-tool, p < 0.05 on the two pooled. Stage 0: held-out parent links, hyperbolic Hits@10 at 32 dimensions
  at least equal to Euclidean at 64.
- A4.8 R15, link prediction (U4): stage 0 filtered Hits@10 at least 0.5 on held-out `implemented_in` and
  `solved_by` edges; adopted at +5 points on which-tool, p < 0.05, no stratum down 5 questions.
- A4.9 R16, learning from use on a branch (U5): admitted as "off by default, safe" if no blind stratum falls by
  more than 3 points with the branch attached and dev held-out rises by 5 points. Adapter variant (U5b): stage 0
  in Rust with a supplied gradient, +5 points recall@5 on held-out generated pairs, before any blind score.
- A4.10 R17, typed decision with abstain (U7): correct "does not exist" not lower than the current candidate's,
  false claims down at least 30% at answer level over 3 runs, no in-corpus stratum down 5 questions.
- A4.11 R18, one result per system (U8): cross-repo "both repositories in the first 10" up at least 15 points;
  no other stratum down 5 questions.
- A4.12 R1c, tuned embedder: training pairs from source alone, clause G4 applies, one repository per stratum
  held out of training and reported; judged by R1 against its own base model.
- A4.13 R12, stability: three runs in three separate processes return the same first five files for at least
  99% of questions; a lane that fails is not shipped whatever its score.
- A4.15 R19, reconstruction lane (the design of `04-DESIGN-THE-RUV-WAY.md`, recipe 1): cues, tags, content and
  edges built from source alone under G4 and G5; the walk implemented as a port of rUv's MRAgent store
  interface with his harness and twelve settings. Stage 0: (a) the MRAgent benchmark reproduces on the ported
  code path (accuracy 50.0% baseline, 70.0% evolved; hallucination 0.17, 0.03 on its 60 tasks); (b) a
  capability's own definition, used as a question, lands on that capability and reaches its README for at least
  95% of capabilities. Result = CAPABILITIES section + 5 lexical files + 5 reconstructed files; control =
  lexical at equal file slots. Adopted at +10 points any-gold on amateurs (E + F + G), exact McNemar p < 0.05,
  +10 points "both repositories present" on cross-repo, no stratum down 5 or more questions.
- A4.16 R20, risk-adjusted utility, reported for every candidate beside any-gold: answerable question: gold
  served +1, abstained 0, served without gold -1; not-in-corpus question: abstained +1, anything served as an
  answer -1; score = (mean + 1) / 2. The abstain threshold is set on the training split only. A candidate is
  preferred over another with equal any-gold if its risk score is higher by at least 0.10.
- A4.17 R21, evolved harness: settings evolved on dev + generated questions by rUv's loop (3-fold
  cross-validation, mean minus half the range), frozen and recorded with a hash before any blind score.
  Adopted over the default settings if the blind any-gold on amateurs is higher by at least 5 points;
  otherwise defaults ship. A "dead setting" check (each setting shown to change the training score) is
  reported.
- A4.18 R22, consolidation: shortcut edges only for paths whose answer passed the mechanical citation check.
  Simulated on half of dev; adopted as "safe, off by default" if the other half of dev rises by at least 5
  points and no blind stratum falls by more than 3.
- A4.19 R23, concept layer on cues: stage 0, generated paraphrase pairs with no shared content word meet at
  rank 1 for at least 90%; adopted at +5 points on amateurs over R19 without it.
- A4.21 R24, landing by centroid (ruflo ADR-527, 2026-11-10: nearest centroid 62.8% against nearest stored
  pattern 36.3% on 113 held-out prompts): each capability carries the mean of its cue vectors; landing =
  nearest centroids, then cues. Stage 0: on held-out generated cues, the right capability is first for a
  higher share by centroid than by nearest cue. Adopted as the default landing if any-gold on amateurs is not
  lower than nearest-cue landing and the "does not exist" rate is higher or equal; a tuned embedder (R1c) is
  judged against this baseline.
- A4.22 R19a, evidence source (required before R19 is scored): the walk's content evidence is set to
  `content`, `cue` or `max` on the training split only. Stage 0: on generated problem-only questions whose
  gold file shares no content word with the question, the gold file survives pruning for at least 90% with
  `cue` or `max`; the same check with `content` is reported, to show the difference. R19 is scored with the
  frozen choice.
- A4.23 R25, learned projection from logs (agentdb `ContrastiveTrainer`, seeded and saved): trained on
  confirmed (question, capability) pairs from half of dev plus generated pairs, applied to question vectors
  only. Stage 0: held-out generated pairs, right capability first, +5 points over no projection. Adopted as
  "off by default, safe" if no blind stratum falls by more than 3 points and dev held-out rises by 5.
- A4.24 R26, navigation at answer level: arm N = the R19 result plus the operations `expand`, `siblings`
  and `why`, same question set, 3 runs, same blind judge, searches and navigation calls counted together under
  one cap. Adopted if answers at 8 of 10 or better rise by at least 5 points on amateurs with a 95% interval
  excluding zero, and false claims do not rise.
- A4.25 Stage 0 for every store: the retrieval-contract invariants (filtered top-k returns exactly
  min(k, eligible); no duplicate ids; reported scores agree with returned vectors; nothing deleted is
  returned) and an embedding-space identity check (a query embedded by another model or precision is
  refused).
- A4.20 R16b, query adapter in its designed regime: rUv's micro-LoRA driven from Rust with a supplied
  contrastive gradient, ranks 1 and 2, learning rates 0.001 to 0.1; stage-0 pass = +5 points recall@5 on
  held-out generated pairs. No blind score before that.
- A4.14 Answer level: the layer or layers that pass are run in the answer test (R8, R9; 3 runs per arm, blind
  calibrated judge), amateurs and experts reported separately, on at least 200 questions so that 93% and 98%
  can be told apart (at n = 84 they cannot, D14).
