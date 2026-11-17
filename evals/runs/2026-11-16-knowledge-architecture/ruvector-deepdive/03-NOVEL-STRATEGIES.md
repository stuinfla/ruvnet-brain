Updated: 2026-11-17 01:00:28 EST | Version 1.0.0
Created: 2026-11-16 23:50:58 EST

# 3. Unconventional storage and retrieval strategies for this corpus

## The idea in plain words

The conventional design asks one question: "which stored text is most like the question?" An amateur's question
is not like any stored text. It is a description of a *problem*; the corpus holds descriptions of *solutions*.
No embedding model, however good, is being asked the right question.

RuVector's unconventional pieces all point at a different design: **store the knowledge as a map, not a pile.**
Problems, capabilities, tools, files and decisions become typed things with typed links between them. Vectors
are attached to the things an amateur can actually hit (problems and capabilities, written in everyday words),
and the links carry the search from there to the source files. A hierarchy tells the search how general or
specific a thing is. A learned layer on a cheap branch records which problems led to which sources.

Where the evidence already points this way (all measured by the lead or the pilot, none by me):
- Dev novices: the plain lexical lane finds 12 of 35; a lane over generated "newcomer question" text finds 22
  of 35 (`candidates/rig/per-question.jsonl`, lanes `v2-bm25` and `units-bm25`). Storing each generated question
  as its own vector lifted any-gold@6 from 28.9% to 52.6% (pilot `RECIPE.md` row 3).
- Blind amateurs on F: the right file is inside the first 100 of the lexical or dense pool for 22 of 25, but
  inside the first 5 for only 12 of 25 (`analysis/pool_depth_by_asker.out.txt`). On E: 18 of 27 against 12 of
  27 on the dense-covered questions; the lexical pool alone holds it for 30 of 54. So part of the amateur gap is
  ordering (the file is found and ranked too low) and part is reach (it is never found).
- Concept cards where they exist: +5.3 answer points and half the false claims (lead D13); they failed as a
  ranked list at half coverage.

## Rules for every experiment below

- **No score before the lead amends the pre-registration** (proposed text: `AMENDMENT-A4-PROPOSED.md`).
- I have not read any E or F question or gold. Design examples come from the dev set, which is declared non-blind.
- **Designed regime first, then the corpus.** Each element has a stage-0 check on the kind of data it was built
  for, with a known right answer, before it is asked to help retrieval. An element that fails stage 0 is a
  broken build, not a negative result.
- **Tuned before judged.** Each element lists its tuning knobs. They are tuned on dev (113) plus generated
  questions only, frozen, then scored once on E + F (and the proposed amateur set G).
- **"Does not work" is admissible only if** stage 0 passed, the tuned setting was used, the component is the
  one rUv ships for the purpose, and the harness reproduces a known-answer case.
- Amateur stratum sizes: E 56 + F 32 = 88. That detects about +15 points; +10 needs set G (about 120 more).
- Heavy compute only below load 60. Sealed exam2 stays sealed.

---

## U1. Problem-to-capability graph with vectors bound to nodes (the centre of the design)

**What.** A typed graph: `Problem` -[solved_by]-> `Capability` -[implemented_in]-> `Package` -[documented_in]->
`File`, plus `Capability` -[part_of]-> `Capability` (the hierarchy), `Package` -[depends_on]-> `Package` (the
lead's 2,066 manifest edges), `Decision` -[explains]-> `Capability` (the 689 quoted relations), `Commit`
-[changed]-> `File`. Vectors are bound to `Problem` nodes (everyday-language statements, several per capability)
and `Capability` nodes (one plain definition each). A query does one operation: nearest `Problem` and
`Capability` nodes, then traverse to `File`. This is RuVector's `TypedGraph::search_then_traverse`
(`crates/ruvector-graph/src/typed_graph.rs:325`), with `hybrid_search_text` (`:420`) adding keyword match on the
node text.

**Why it should help amateurs.** The amateur's sentence is compared with other problem sentences, the only text
in the system written the way they write. The hop to files is by link, not by similarity, so the file does not
need to share a single word with the question. Cross-system questions are served by traversing from two
capability nodes and returning both sides.

**Why this is not the failed "concept cards" lane again.** Cards failed at half coverage, ranked as one list and
fused with files. Here (a) coverage is a gate: the layer is not scored until every package has at least one
capability and every capability has problem statements; (b) the hop returns *files*, scored by the same file
metric; (c) it is shown in its own section, never rank-fused.

**Data it needs.** The ontology's 726 cards and 420 everyday-word bridges are the seed for `Capability` and
`Problem` nodes; they cover about 300 of 5,243 units, so the build is: one extraction pass per unit giving
(capability, 5-8 problem statements, links with quotes), mechanical verification of every quote, then merge.

**Stage 0 (designed regime).** Build the graph for one repository whose structure is known (RuVector: 201 crates
with manifests). Known-answer check: for each crate, a query made of that crate's own description must land on
its capability node and traverse to its README at rank 1 for at least 95% of crates. This checks the build and
the operator, not usefulness.

**Tuning knobs (dev + generated questions only).** Number of problem statements per capability (3, 6, 12); k of
nodes kept before traversal (3, 5, 10); whether a file reached from two nodes ranks above one reached from one;
node embedder (A4.3 screen); cap on files per capability.

**Experiment.** Lane `graph-hop`: top files by traversal. Served result = 5 lexical files + 5 graph-hop files +
history. Control = lexical lane with the same number of slots. Sets: E + F (+ G), amateurs and the cross-repo
stratum reported separately.

**Pass rule (U1).** Any-gold up at least 10 points on amateurs, exact McNemar p < 0.05; on the cross-repo
stratum "both repositories present in the result" up at least 10 points; no stratum down 5 or more questions.

**Cost.** Extraction over about 5,000 units with Sonnet on subscription (the pilot built 2,278 units for one
repository; time not recorded there); graph of roughly 10^4 to 10^5 nodes; vectors for about 30,000 to 60,000
short texts (pilot rate: 15,909 vectors in 6.4 minutes). Query cost: one embed + exact scan of at most 60,000 x
384 numbers + a hop. Footprint: about 25-90 MB of vectors plus the graph file.

**Binding.** `TypedGraph` is Rust-only. Two honest routes: (1) ask upstream for a Node binding (it is 1,083
lines with tests; the Node package already wraps the same crate); (2) for the experiment only, run the Rust
operator from a small harness binary built in scratch. The experiment must use rUv's operator, not a
re-implementation, so a negative result is about the design and not about my copy of it.

---

## U2. Hyperbolic hierarchy for the ontology

**What.** Learn a low-dimension Poincare embedding of the capability hierarchy (`part_of`, `is_a` edges, and
package-in-capability edges) so that general things sit near the centre and specific tools near the rim. Use it
for one job: given the capability nodes a query landed on (U1), widen to the right neighbours. If the hit is
specific, also offer its parent's other children ("you asked about X; the same family has Y and Z"). If the hit
is general, descend to the most specific children that still match. RuVector supplies the distance and maps
(`ruvector-hyperbolic-hnsw/src/poincare.rs`), the index, and the Riemannian Adam optimizer
(`ruvector-graph-transformer/src/manifold.rs:682`); the training loss is the missing piece.

**Why it should help amateurs.** An amateur's words are general ("keep my agents from forgetting"); the gold is
specific. In flat space "general" and "specific" are just far apart. In the ball, norm is depth, so the search
can deliberately move outward from a general landing point. It is a way to rank *by level*, which no flat
embedding offers.

**Stage 0 (designed regime, ADR-002's own protocol).** Train on the ontology hierarchy at 16, 32 and 64
dimensions, hold out 10% of parent links, report mean rank and Hits@10 of the true parent, against a Euclidean
embedding of the same dimension trained the same way. ADR-002 states the expected shape (hyperbolic better at
low dimension) from WordNet; its numbers have no run artefact in the tree, so this stage produces the first one.
Pass for stage 0: hyperbolic Hits@10 at 32 dimensions at least equal to Euclidean at 64.

**Tuning knobs.** Dimension, curvature, negative samples, learning rate, burn-in epochs.

**Experiment.** `graph-hop` (U1) with and without hyperbolic widening, same slots.

**Pass rule (U2).** On top of U1: at least +5 points on amateurs and at least +5 on which-tool, p < 0.05 for the
pooled amateur + which-tool questions; otherwise the hierarchy stays as plain parent links.

**Honest prior.** The hierarchy has a few thousand nodes; at that size plain "walk up to the parent, list its
children" may do the same job. That is why U2 is an add-on to U1 with its own rule, not a foundation.

**Cost.** Training a few thousand nodes at 32 dimensions is seconds to minutes on a laptop CPU; storage is
kilobytes. The cost is the Rust harness (the optimizer is not exposed to Node).

**Cheap variant that needs no binding (U2b).** Hierarchy-composed vectors, the pattern in rUv's own
`examples/rvf/examples/hyperbolic_taxonomy.rs`: store for each node its text vector plus a shrinking share of
its ancestors' vectors, with `depth` as metadata, and filter by depth at query time using the RVF filter. Same
experiment and rule as U2. It runs on `@ruvector/rvf` as shipped.

---

## U3. Need index: many short vectors per file section, in RVF

**What.** For every file section: a two-sentence summary and 6 newcomer questions, each stored as its own vector
in an RVF store whose metadata carries store, path, kind and standing. Many vectors map to one file. Query:
nearest need vectors, collapse to files.

**Why it should help amateurs.** Question-to-question matching, in their words. It is the strongest measured
lever so far (dev novices 12 to 22 of 35 by text alone; pilot 28.9% to 52.6% by vectors). It is also the
conventional end of this design, kept because it is measured, and because the `Problem` nodes of U1 are the
same sentences lifted from file level to capability level. U3 is the fallback if U1's extraction cannot reach
coverage.

**Stage 0.** Each stored question retrieves its own file at rank 1 (at least 99%); a paraphrase set written by a
second model retrieves the file within 5 for at least 90% (the owner's `rvf-expert-kb` gate used the same shape
and measured 96-98% on a single-expert corpus).

**Tuning knobs.** Questions per section (3, 6, 12), section size, embedder (A4.3), whether summaries are indexed.

**Pass rule.** A4.4 (R4c): +10 points on amateurs against the lexical lane at equal slots, p < 0.05.

**Cost.** About 25,000 doc-tier sections (my estimate from the pilot's 13 passages per unit) gives about 178,000
vectors: 273 MB at 384 numbers each, about 72 minutes to embed at the pilot's rate; all files: about 600,000
vectors, 0.9 GB, about 4 hours. Generation is the large cost and is already in the lead's plan as S4.

---

## U4. Rank by link prediction: knowledge-graph embeddings

**What.** Train `@ruvector/kge` (HolE or RotatE; on npm, native Node) on the graph of U1. At query time, after
landing on capability nodes, ask `predict({s: capability, r: 'implemented_in', k})` and
`predict({s: problem, r: 'solved_by', k})` to rank packages and capabilities that are *not* linked yet but
should be. This fills holes in the extracted graph.

**Why it should help amateurs.** Extraction will miss links. Link prediction proposes them from the pattern of
the rest of the graph, so a problem phrased in a new way but attached to a neighbouring capability still
reaches the right package.

**Stage 0 (its designed regime, its own metric).** Hold out 10% of `implemented_in` and `solved_by` edges;
report filtered MRR and Hits@10. rUv's receipt for scale: MRR 0.4995, Hits@10 0.795 on a 493-entity subgraph
(`npm/packages/kge/bench/results/fb15k237-500-hole-2026-09-21.json`). Stage-0 pass: Hits@10 at least 0.5 on
held-out edges; below that the graph is too sparse and U4 stops there, as a finding about the graph.

**Tuning knobs.** Model (HolE, RotatE), dimensions (32-128), epochs, negatives.

**Pass rule (U4).** On top of U1: +5 points on which-tool, p < 0.05, no stratum down 5 questions.

**Cost.** Minutes of CPU for 10^4 to 10^5 triples by extrapolation from the receipt (unmeasured at that size);
megabytes of storage.

---

## U5. Learning from use, stored as data on a branch

**What.** Every answered question leaves a receipt the hooks already write: the question, the files cited. Turn
each confirmed pair into a new `Problem` node (or need vector) linked to the file that was used, written to a
copy-on-write **branch** of the shipped store (`RvfDatabase.branch()`, or agenticow). The shipped corpus is
never modified; the branch is the user's learned layer; a bad layer is dropped in milliseconds. Opt-in pooling
of anonymised pairs back into the corpus build is a separate owner decision.

**Why this and not an adapter.** rUv's adapter route (SONA MicroLoRA) is rank 1-2 and, through the published
Node API, moved a vector by 0.0001-0.002 cosine after 12,000 rewarded trajectories in my synthetic probe
(`probes/`). That is one probe through one door: the Rust API accepts a direct gradient
(`crates/sona/src/types.rs:57`, R) and was not exercised. Learning-as-data is deterministic, auditable, needs
no training, and fits ADR-092 (knowledge is data only).

**Stage 0 for the adapter, so it is not dismissed on one probe (U5b).** In Rust, feed `LearningSignal::with_gradient`
the true gradient of a contrastive loss on generated (question, passage) pairs, ranks 1 and 2, learning rates
0.001 to 0.1; report held-out pair recall@5 against no adapter. Pass: +5 points on held-out generated pairs.
Only then is it tried on E + F.

**Experiment for U5.** Simulate use with the dev set: add (question, cited file) pairs from the answer-level
runs of half the dev questions; score the other half and E + F, to measure spill-over to questions never seen.

**Pass rule.** No loss on any blind stratum (pollution check, as R6) and +5 points on dev held-out; the real
gain can only be shown in use, so this is admitted as "safe to ship off by default", not as a quality claim.

---

## U6. Re-order the candidates the search already finds

**What.** A second stage over the union of the first 60 lexical and first 60 need or graph-hop passages. Three
candidates: a cross-encoder (rUv's best measured: mxbai-rerank-xsmall, agentdb ADR-016), late interaction with
RuVector's MaxSim scorer plus a small token model (answerai-colbert-small-v1), and Sinkhorn transport between
token sets (`@ruvector/math-wasm`).

**Why.** On F the right file is in the pool for 22 of 25 amateurs and in the first five for 12. The earlier
negative result is for one model (ms-marco MiniLM), which rUv's own data also show hurting vague questions.

**Stage 0.** On generated question / passage pairs with 59 lexical distractors each, the re-ranker must place
the true passage first more often than BM25 does. A re-ranker that fails this is not run on E + F.

**Pass rule.** A4.5 (R11).

**Cost.** 87 MB model; latency not measured here (rUv: about 200 ms per 60 pairs for a model one third the size).

---

## U7. Typed decision with an abstain option for "which tool"

**What.** Treat "which tool?" as choosing one of the capability families, with "none of these" as a real
outcome: `choice({...})` in rUv's typesafe engine, examples drawn from U1's problem statements, out-of-scope
examples from unrelated public intent sets (the OpenJev recipe; CLINC150 out-of-scope AUROC 0.966 on validation,
`docs/research/openjev/v1-results.md`).

**Why.** It gives a calibrated "this is not something rUv built" for the not-in-corpus stratum and narrows the
search to a family for the rest. Honest prior: on dev, the right repository is already in the top three for 72
of 76 questions (pilot), so narrowing by family may add little; the value is abstention.

**Stage 0.** Held-out generated problem statements classified into their family: accuracy and expected
calibration error, with the published hash embedder and with a real model from a source build (they must
differ, or the harness is wrong).

**Pass rule.** Correct "does not exist" rate not lower than today's and false claims down at least 30% at
answer level over 3 runs; no fall in any-gold on in-corpus strata.

---

## U8. One result per system: min-cut over the candidate graph

**What.** Build a small graph over the top 60 candidates (edges = same package, dependency, shared capability),
cut it into clusters with `@ruvector/mincut-wasm`, and serve the best file of each cluster before a second file
of any.

**Why.** Cross-repo gold is 2 to 8 files in two repositories; a plain ranking fills the first five slots from
one. Designed regime: partition of a graph with real community structure, which package and dependency edges
have.

**Stage 0.** On pairs of repositories with known dependency links, the cut separates them (at least 90%).
**Pass rule.** Cross-repo "both repositories in the first 10" up at least 15 points (lexical today: 14 of 22),
any-gold elsewhere not down 5 questions.

---

## U9. Stability and provenance by construction

- Exact scan instead of an approximate index wherever the store is under about 200,000 vectors (U1, U3): no
  build randomness, same answer every run. Full-precision model weights (the lead found the 8-bit model changes
  with batch composition). Explicit tie-break by id. Rule A4.7.
- Every served passage carries its content hash; the same hash is written at ingest, where RVF's witness chain
  records it. A citation can then be checked against the store that served it. RuVector's retrieval receipts
  (Rust-only) would add a signed record per query later.

## What is deliberately not proposed

| Piece | Why not, on evidence |
|---|---|
| Lexical index inside RVF | not implemented (MetaIdx segment unused); SQLite FTS5 with rUv's analyzer stays |
| DiskANN, IVF, PQ families | solve scale and memory at 10^8 vectors; this design has 10^5 |
| prime-radiant as an answer checker | scores closeness; factual and citation scores are fixed placeholders |
| GNN-refined index | no weight update exists in the crate |
| Cluster-RAG | k-means routing without summaries; nothing for amateurs |
| RuLake, Postgres extension | need a service; the product is offline |

## Order

Stage 0 for U1 and U3 can start as soon as the extraction pass exists; they share it. U2, U4 and U8 are small
once U1's graph exists. U6 is independent and cheap. U5 and U7 follow.
