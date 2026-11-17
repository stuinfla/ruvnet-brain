Updated: 2026-11-17 01:00:28 EST | Version 1.0.0
Created: 2026-11-17 00:48:46 EST

# 4. The storage and retrieval design, the way rUv builds memory: reconstructive capability memory

Read `ORIGIN-AND-PHILOSOPHY.md` first. This design applies rUv's own pattern (MRAgent: cue, tag, content;
freeze the store, evolve the harness; abstain when unsure; learn by consolidation; branch and prove) to this
corpus. Nothing here is built or scored. Every element is marked: **S** shipping and callable from Node,
**R** real Rust without a Node binding, **X** experimental (rUv's own numbers are on made-up data), **P**
placeholder. Experiments and pass rules are in section 8 and in `AMENDMENT-A4-PROPOSED.md`.

## 1. The idea in plain words

Today the Brain compares a question with stored text. An amateur's question is a description of a problem, and
the stored text describes solutions, so the two do not match however good the embedding.

In rUv's memory design the first match is only a **cue**. The question is compared with short cue sentences
written the way people ask. Each cue is linked to **tags**: the capability it is about, the concept family,
the package, the decision behind it. Tags are linked to **content**: the actual files, passages and history.
The search lands on cues, walks the links, keeps what several paths agree on, stops when the evidence is
strong, and says "nothing in rUv's work matches that" when it is weak. The settings of that walk are tuned by
rUv's evolutionary loop on training questions and judged on questions it never saw. When an answer is later
confirmed, a shortcut link is laid so the same need resolves in one step next time. The shipped store is
frozen and signed; what a user's copy learns lives on a branch that can be dropped.

Outside evidence for the pattern: rUv's MRAgent implements the paper "Memory is Reconstructed, Not Retrieved:
Graph Memory for LLM Agents" (Ji, Li, Hooi; arXiv 2606.06036, 4 June 2026, ICML 2026; fetched by me), which
reports gains "up to 23%" over strong baselines on the LoCoMo and LongMemEval memory benchmarks with a
Cue-Tag-Content graph in which the model explores and prunes paths. That is conversation memory, not a code
corpus, and the abstract does not name the metric. It is the one real-data result for this pattern.

## 2. What is stored (the unit is not a chunk)

| Layer | Unit | Carries | Built from | Count (estimate, method in section 7) |
|---|---|---|---|---|
| **Cue** | one short sentence in the asker's words | kind (problem, goal, symptom, newcomer question, name), vector, keywords | generated per capability and per file section from source alone; names and commands taken mechanically | 25,000 at capability level + about 178,000 at section level |
| **Tag** | Capability, Concept, Package, Repository, Decision, Lesson, Release | plain definition, standing (implemented, measured, decided, corrected, planned ...), date, maturity, hierarchy position | the ontology run (726 cards, 420 everyday-word bridges), manifests (1,148 packages), ADRs (about 1,900), extraction for the rest | about 10,000 |
| **Content** | file section, passage, commit, issue, release note | text, path, hash, standing, date | the lead's stores S1 (passages + lexical index) and S2 (history), unchanged | 1.1 M passages, 52,000+ history items |
| **Edges** | cue -about-> tag; tag -part_of / is_a-> tag; tag -depends_on-> tag; tag -implemented_in-> package; tag -documented_in-> content; decision -explains-> tag; tag -supersedes / contradicts / alternative_to-> tag; commit -changed-> content; shortcut edges | a verbatim quote and source path for every extracted edge | manifests (2,066 edges exist), quoted relations (689 exist), extraction | about 100,000 |

rUv's own shipped answer to "which capability fits this task" has this shape already. Ruflo's capability brain
is a typed catalogue of domains, each carrying a list of **task signals** (short phrases a task description
might contain), its tools, health, authority and risk; `recommendCapabilities` counts which signals appear in
the task text, ranks domains by that count with a fixed tie-break, and falls back to general guidance when
none match (ruflo `v3/@claude-flow/cli/src/mcp-tools/capability-brain.ts:833-852`, read by me; the regex
routing table is `guidance-tools.ts:255-268`). Task signals are cues; domains are tags. The design below is
that catalogue made corpus-wide, with vectors on the cues so the match does not depend on exact words.

This follows rUv's own knowledge export (ADR-056: identity, taxonomy, decisions, dependency graph, timeline,
patterns, lessons as separate kinds) and the lead's principle 1 and 2 (natural units, each with its standing).

**What is a vector, a graph, a hierarchy, sparse, learned, branched**

| Aspect | Choice | Component | Maturity |
|---|---|---|---|
| Vector | on cues and capability definitions only; 384 numbers; exact scan (no approximate index at this size) | `@ruvector/rvf` 0.4.12 with metadata filter (kind, repository, standing) | S |
| Graph | typed property graph, Cypher traversal `(:Cue)-[:ABOUT]->(:Tag)-[:LINKED*1..N]->(:Tag)-[:DOCUMENTED_IN]->(:Content)` | today `@ruvector/graph-wasm` / `graph-node` (the pattern of `examples/npm-vector-graph`); target `TypedGraph::search_then_traverse` | S (Cypher subset; variable-length paths not supported in the bindings, so hops are issued one at a time) / R |
| Hierarchy | the capability and concept tree, with Poincare coordinates per tag for "widen to siblings" and "descend to specifics" and entailment cones | `@claude-flow/plugin-hyperbolic-reasoning` (alpha; random initialisation, so seeded or replaced by a deterministic placement); plain parent links as the fallback | X (see 8a: the published plugin falls back to a mock module) |
| Sparse | keyword index on cue and tag text; the existing lexical lane on content (identifiers are cues too: this is the expert's path and it stays) | SQLite FTS5 with rUv's Lucene analyzer (ruflo ADR-088) | S (the lead's lane) |
| Concept layer | everyday-word groups mapped to shared concept slots so two phrasings with no common word still meet (the device in `examples/mragent/agent/concepts.mjs`), built from the 420 bridges and extended | new data, rUv's mechanism | X |
| Learned | (a) the walk's settings, evolved; (b) shortcut edges after confirmed answers; (c) votes on cue-to-content links, canonical only after repeated evidence (Brainpedia rule, ADR-062) | `@metaharness/darwin` 0.14.0; MRAgent `consolidate.mjs` semantics | S / X |
| Branched | shipped base frozen; a user's learned edges on a copy-on-write branch; nightly corpus delta on a branch, promoted only after the gate battery passes | `RvfDatabase.branch()` / `freeze()`, or `agenticow` 0.3.1 (branch, checkpoint, rollback, diff, promote) | S |
| Proof | content hash on every unit, written through RVF's witness chain at ingest; every result carries the hashes of the cue, the path walked and the content | `rvf-runtime` witness; signed receipts later (`ruvector-retrieval-receipt`, R) | S / R |

## 3. How a question is answered

1. **Cue search.** The question is embedded once and compared with all cue vectors (exact), and its words are
   matched against cue and tag text; the two lists are merged (rUv's gene `hybridAlpha`, `fusion`). In
   parallel the unchanged lexical lane searches content directly.
2. **Reconstruction.** From the top cues (`cueK`), walk to tags, optionally one or two tag-to-tag hops
   (`traversalDepth`, `tagFanout`), then to content. Each path's evidence decays with length; weak paths are
   pruned (`pruneThreshold`).
3. **Corroboration.** Content reached from several independent cues or tags is raised (MRAgent's
   corroboration re-rank). A file found by both the walk and the lexical lane is raised further.
4. **Level control.** If the landing tags are general (near the root of the hierarchy), descend to their most
   specific matching children; if specific, also list siblings as alternatives.
5. **Early stop.** Stop when the best content's own relevance passes `haltConfidence`.
6. **Abstain.** If the best content's raw relevance to the question is under `abstainThreshold`, say so, and
   show the nearest capabilities instead of files. Abstention is judged on raw relevance, not on the decayed
   path score (the overfit rUv found and fixed in ADR-270).
7. **Spread across systems.** For questions that land on two capability clusters, serve the best file of each
   cluster before a second file of either (min-cut over the candidate graph, `@ruvector/mincut-wasm`).
8. **Result.** Sections, not one fused list (the lead's principle 3): CAPABILITIES (the tags landed on, each
   with standing, one line, package, alternatives), FILES (reconstructed + lexical), HISTORY, and the proof
   hashes. Latency budget: one small-model embedding, a scan of about 200,000 x 384 numbers, a few hundred
   graph lookups; not measured.

Why this should reach amateurs: the comparison that has to succeed is question against cue, both in everyday
words and both short. Everything after that is a link, which needs no shared vocabulary.

## 4. How it learns from use

- **Consolidation.** When an answer cited a file and the mechanical citation check passed, add a shortcut
  edge from the cues that fired to that content, on the user's branch. Only paths that already produced a
  verified result are consolidated, so no association is invented (the rule in `consolidate.mjs`).
- **Evidence gate.** A shortcut or a new cue becomes part of the shipped base only after repeated,
  independent confirmations (Brainpedia: quality mean at least 0.7, at least 5 observations, evidence from at
  least 2 contributors).
- **New cues from real questions.** A confirmed question becomes a cue for its capability. This is the
  query-side learning: the store acquires the vocabulary people actually use, as data.
- **Evolving the harness.** Nightly, Darwin re-tunes the twelve settings on the training questions; a setting
  is promoted only if it improves the held-out split under cross-validation with a variance penalty.
- **Not used:** weight adapters on query vectors. rUv's README says learning comes from recorded outcomes;
  the MicroLoRA path moved a vector by 0.0001 to 0.002 cosine in my probe through the Node interface. Its
  designed-regime test (Rust, supplied gradient) is experiment R16b; until it passes it is not in the design.

## 5. How it stays small and updates nightly

- Vectors exist for cues only. About 203,000 x 384 x 4 bytes = 312 MB at full precision, against about 3.4 GB
  for a vector per passage at 768. RaBitQ (`@ruvector/rabitq-wasm`) can hold a 56-byte code per cue in RAM
  (11 MB) with exact re-scoring from disk if memory matters.
- Model: one small embedder (34 MB at 8 bits, 133 MB at full precision), shipped beside the store.
- Graph and tags: tens of megabytes. Content: the lexical store already planned (about 2.3 GB projected).
- Nightly: for each changed file, regenerate its cues and edges; write to a branch; run the gate battery
  (known-answer checks, stability rule, the held-out set); promote and freeze, or discard. The witness chain
  records every write, so a release can state exactly what changed.

## 6. Which embedding model, and is it RuVector-native

- There is no rUv-trained retrieval embedder (`02-NATIVE-EMBEDDING-OPTIONS.md`). In this design the embedder's
  job shrinks to matching one short everyday sentence against another, the job small symmetric models are
  made for.
- Default: **`BAAI/bge-small-en-v1.5`** (384 numbers, MIT, 512-token window; ONNX build `Xenova/bge-small-en-v1.5`,
  full precision), the model RuVector's core names "default, recommended for `.rvf` packs"
  (`crates/ruvector-core/src/embeddings.rs:1485`) and the base of rUv's own fine-tune. Alternate, to be chosen
  by the screen in A4.3: `Xenova/all-MiniLM-L6-v2` (rUv's default on eight surfaces), and whichever passage
  model wins the lead's screen.
- RuVector-native parts around it: the concept layer (section 2), the store, the graph, the walk, the
  harness evolution, and, as stage 3, a cue embedder fine-tuned with rUv's OpenJev pipeline on the generated
  cue-to-capability pairs (its supervised-contrastive loss over classes fits "many cues, one capability"
  directly; `crates/ruvector-typesafe-train/src/loss.rs`).

## 7. Three recipes (build stages), fully specified

Counts: section-level cue estimate = pilot ratio of 13 passages per unit applied to the documentation tier
(30% of 1.1 M passages) = about 25,000 sections x 7 sentences = 178,000; capability level = about 3,000
capabilities x 8 = 25,000. Embedding time from the pilot: 15,909 short texts in 6.4 minutes.

### Recipe 1: reconstructive memory on shipped Node packages (build first)

| Item | Specification |
|---|---|
| Embedder | `Xenova/bge-small-en-v1.5`, fp32, CLS pooling, BGE query prefix on the question only, 384 dims (final choice by rule R4b) |
| Units and header | cues as in section 2, each at most 40 words; tags with definition and standing; content = lead's S1 chunks (at most 480 tokens, path header) and S2 |
| Indexes | cue vectors in one RVF (`@ruvector/rvf`), exact scan, metadata filter; cue and tag keyword index (FTS5); graph in `@ruvector/graph-wasm` or `graph-node`; lexical lane (FTS5) on content; history lane |
| Query path | section 3, implemented as a port of MRAgent's store interface (`hybridSearch`, `reconstruct`) onto the real stores, with rUv's harness (`agent/harness.mjs`) and its twelve settings unchanged |
| Tuning | `@metaharness/darwin` (or MRAgent's built-in loop) on dev (113) + generated questions; 3-fold cross-validation with variance penalty; frozen before any blind score |
| Result | CAPABILITIES + FILES + HISTORY + hashes |
| Update | nightly branch, gate battery, promote, freeze |
| Build compute | extraction and cue writing: one Sonnet pass over about 5,000 units plus sections (subscription-paced; time not measured); embedding 203,000 cues: about 80 minutes at the pilot's rate; graph load: minutes |
| Footprint | cue vectors 312 MB (or 11 MB of codes in RAM), model 34-133 MB, graph and tags under 100 MB, on top of the lexical store |
| Predicted amateur gain | from 29.5% (26 of 88 on E + F, lexical, top 5) to **50-65%** gold in the served result. Derivation: on dev, text written as newcomer questions finds 22 of 35 novice golds against 12 for lexical, and either-of-three reaches 27 of 35; the one derived layer that was re-tested blind (cards) kept about three quarters of its covered-subset hit rate (80% on E, 60% on F). 63% x 0.75 = 47% for the cue path alone, joined with a lexical path at 30% that overlaps partly. Uncertainty: wide (the range could be 40-70%); it rests on dev data and one shrinkage observation, and on reaching full coverage, which the cards never had |

### Recipe 2: the native operator and calibrated abstention

Recipe 1 plus: `TypedGraph::search_then_traverse` and `hybrid_search_text` in place of hop-by-hop Cypher
(needs a Node or WASM binding: an upstream request, or a small harness binary for the experiment); conformal
calibration of the abstain threshold (`ruvector-core` `conformal_prediction.rs`, R) so "I don't know" has a
stated coverage; hyperbolic coordinates on tags; link prediction with `@ruvector/kge` to propose missing
cue-to-capability and capability-to-package links. Added build: KGE training (minutes, unmeasured at this
size), hierarchy embedding (seconds). Added footprint: megabytes. Predicted amateur gain over recipe 1: +0 to
+8 points, mostly on which-tool and cross-repo; the main expected effect is on abstention and false claims.
Uncertainty: no measurement of any of these on text exists anywhere.

### Recipe 3: a cue embedder that is the Brain's own

Recipe 1 or 2 plus a fine-tuned `bge-small` trained on (cue, capability) classes with rUv's OpenJev pipeline
(supervised contrastive + class heads, out-of-scope exposure for abstention, ONNX transplant with parity
check). Needs: the cue set from recipe 1 as training data (free), CPU or CUDA (the trainer has no Apple GPU
path; rUv's plan estimates 4-5 hours on CPU per run), one held-out repository per stratum. Shipped as a
model file beside the store, same size as the base. Predicted amateur gain over recipe 1: +5 to +15 points on
the cue-search step. rUv's own estimate for fine-tuning on a BEIR set is +0.02 to +0.05 nDCG (ruflo ADR-088);
OpenJev lifted department accuracy from 78-81% to 95% on its ticket task (`docs/research/openjev/v1-results.md`).
Uncertainty: large; the model was never tried on retrieval.

**Build first: recipe 1.** It needs no binding and no training, it produces the data the other two need, and
its central claim (cues reach amateurs) is the one the whole design stands on.

## 8. Experiments and pass rules (summary; full text in the amendment)

Each has a designed-regime check first (stage 0), tuning on dev + generated questions only, then one score on
E + F + the proposed amateur set G. Sealed exam2 stays sealed.

| # | Experiment | Stage 0 (designed regime) | Pass rule |
|---|---|---|---|
| R19 | Reconstruction lane (recipe 1) against lexical at equal slots | port check: the MRAgent benchmark reproduces on the ported store (50% / 70%, hallucination 0.17 / 0.03); known-answer: a capability's own definition lands on it and reaches its README, at least 95% | +10 points on amateurs, exact McNemar p < 0.05; cross-repo "both repositories present" +10 points; no stratum down 5 questions |
| R20 | Risk-adjusted utility (rUv's scoring: right +1, abstain 0, wrong -1; not-in-corpus: abstain +1, answer -1) | threshold band found on training split only | risk score above the lexical + history candidate's by at least 0.10; "does not exist" rate not lower |
| R21 | Evolved harness against the default settings | every setting shown to matter on generated tasks (rUv's "no dead genes" test) | held-out gain at least +5 points; else ship defaults |
| R22 | Consolidation | shortcuts only for verified paths; fewer hops at equal accuracy on training | simulate use on half of dev; other half and E + F not lower by more than 3 points; dev held-out +5 |
| R23 | Concept layer on cues | paraphrase pairs with no shared word meet at rank 1, at least 90% | +5 points on amateurs over R19 without it |
| R14, R15, R18, R11, R17 | hierarchy widening, link prediction, one-per-system, re-order, typed abstention | as in `03-NOVEL-STRATEGIES.md` U2, U4, U8, U6, U7 | as in the amendment |
| R12 | Stability | - | same first five files in 3 separate processes for at least 99% of questions |
| A4.14 | Answer level | - | amateurs and experts at 8 of 10 or better in 2 of 3 runs, on at least 200 questions |

## 8a. What the question loop against the Brain changed (round 1; `BRAIN-QUESTION-LOG.md`)

Each item was re-checked by me in source unless marked "reader".

- **MRAgent is a pattern and a harness, not a ready extractor.** Its store is built from generated task specs;
  its concept layer is 15 hand-written synonym groups; its "GNN re-rank" is `score x (1 + 0.7 x (paths - 1))`;
  its consolidation uses the known right answer (reader; I read `memory.mjs`, `consolidate.mjs`,
  `harness.mjs`). So recipe 1 must build three things that do not exist: the cue / tag / content extractor,
  the concept groups for this corpus, and a consolidation signal that does not need a known answer (the
  citation check). The walk, the twelve settings, the scoring and the evolution loop are reusable as they are.
- **The hyperbolic plugin is weaker than its README.** It imports `@ruvector/hyperbolic-hnsw-wasm`, which is
  not on npm, and silently falls back to a mock module (`hyperbolic-bridge.ts:114-119`); its entailment graph
  embeds text by character hashing (`gnn-bridge.ts:297-299`); its cone test is a fixed angle (reader). The
  hierarchy element therefore starts from plain parent links and depth, with U2's stage 0 deciding whether a
  trained Poincare embedding adds anything. Maturity in section 2 is corrected to X.
- **ruflo's "pathfinder" is personalised PageRank** over a SQL edge table (damping 0.85, 20 steps;
  `agentdb-tools.ts:1331`, `:1400-1428`), not the similarity-weighted path score its README describes. It is a
  shipped, simple way to spread relevance from the landed tags, and is added as an alternative walk in R19's
  tuning (walk = bounded traversal or PageRank from the cue set).
- **Nightly delta the ruLake way.** ruLake detects change by a generation token per source, hashed with the
  source reference and parameters into a witness (`RuLake .../bundle.rs:31-35`, `:131`, `:171-174`), with
  Fresh / Eventual / Frozen consistency (reader). The nightly update uses the same idea: a generation token
  per repository (its commit hash); only repositories whose token changed are re-extracted.
- **rUv's code-to-RVF containers are not a semantic search precedent.** The Claude Code containers hold
  128-number content fingerprints ("NOT a semantic embedding", `scripts/lib/rvf-builder.mjs:31`); their value
  is the module partition (Louvain above 5,000 nodes, exact min-cut below; reader) and the witness. The
  precedent they do set: split a codebase into modules by its graph, and attach knowledge to modules.
- **ADR-056's knowledge export** is a curated 23 KB JSON without vectors and is stale (91 crates; reader). It
  supports "store by kind"; it is not a working store.
- **Explainable recall** is a greedy cover of caller-supplied requirements plus a Merkle root; receipts are
  commitments by the engine, not proof the result is right (reader). The design's proof claim stays as worded:
  hashes show what was served and that it was not altered.
- **The Brain as an instrument** (16 questions by the reader, 4 by me): informed questions put the right source
  at rank 1 for 4 of 13 and in the top three for 9 of 13; none of 3 naive questions was answered. Ten defects
  are listed in the log. This is the amateur problem again, seen from the inside.

## 8b. What round 2 of the question loop added (reader's reports from source; not re-checked by me)

- **A ready template for the cue-to-tag walk exists in rUv's benchmarks**: `Doc`, `Topic`, an `ABOUT` edge and
  a vector type bound to (Doc, embedding, cosine) in `crates/ruvector-graph/benches/typed_graph_bench.rs`
  (random vectors, so its timings say nothing about relevance). Recipe 2 starts from it.
- **Promotion rule to copy for the nightly gate** (`crates/ruvector-agent-memory/src/diagnostic.rs`, ADR-325,
  status Proposed, 998 lines of real code): promote a new memory strategy only if a paired-bootstrap
  improvement holds, a protected held-out slice does not regress, and any regression can be traced to one of
  four stages (ingestion, retrieval, filtering, generation). Strategies are immutable, versioned artefacts.
  The nightly branch-verify-promote step in section 5 adopts these three conditions.
- **Ordering is deterministic in RVF**: results sort by distance then id in the index and the runtime
  (`rvf-index/src/hnsw.rs:458`, `rvf-runtime/src/store.rs:984`). Whether the index build is seeded identically
  across processes is being checked in round 3; exact scan in recipe 1 does not depend on it.
- **Temperature tiering is not wired** (`assign_tier` is called only from a test), so footprint in section 5
  assumes full-precision vectors on disk.
- **"The index learns from queries" is roadmap text**; the planned files do not exist. The learning that does
  exist sits above the index (counters, bandits, shortcut edges), which is what this design uses.
- Nothing in round 2 contradicted the design.

## 8c. Round 3: rUv's newest measurement is on exactly this step (checked by me in the ADR)

Ruflo ADR-527 (Accepted, 2026-11-10) measured "plain task description to the right label, with `none` as a
label" on a frozen corpus of 197 prompts labelled blind (84 for building, 113 held out; ADR-391), all with
`Xenova/all-MiniLM-L6-v2`:

| Router, held-out 113 | Right label |
|---|---|
| shipped default (hash vectors + keywords) | 25.7% |
| same router on MiniLM (nearest stored pattern) | 36.3% |
| a small trained network (10 seeds) | 57.8% |
| **nearest centroid: one mean vector per label from its example prompts** | **62.8%** |
| network initialised at the centroids | 62.8% (cross-validation chose zero training) |

Its abstain rule: when the top two centroid scores are nearly tied or the score is low, return "no match".
What the design takes from this:
- Each capability tag stores the **mean of its cue vectors** as well as the cues. Landing is two-step:
  nearest capability centroids first, then nearest cues inside and outside them. This is a setting of the
  walk (`landing = cue | centroid | both`), tuned on training data like the others. New rule R24.
- "Do not train what a mean already does" is rUv's own finding a week ago; recipe 3 (a tuned embedder) has to
  beat the centroid baseline, not the nearest-cue one.
- The same ADR is a model for the instrument: a frozen, blind-labelled set with a `none` label and a held-out
  split, after which the held-out prompts became a regression set because they had been looked at.

Other round-3 items (reader, from source): the RVF index build is deterministic across processes (levels are
seeded from the vector id, `rvf-runtime/src/index_path.rs:104-108`) and search is exact under 1,024 vectors;
min-cut write-time admission (ADR-344) lifted recall@10 from 0.784 to 0.862 on 4,000 made-up vectors at about
1,600 times the insert cost and is not wired into anything; the overlay segment is defined only; a SONA
pattern adds 0.1 to a route score when its quality passes 0.7, with no measured effect.

**The loop did not run dry.** Four rounds, 53 logged questions; the last four questions each still found
something. Totals from the log: informed questions put the right source first for 21 of 42 classified (and in
the returned set for 10 more); naive questions, 1 of 7.

## 8d. Changes after my second walk and after fetching the two primary pages (12:50 to 1:00 a.m. ET)

**The two 2026 facts, checked against their primary pages.**
- ruflo ADR-527 (fetched from the repository's raw file): says what I reported: Accepted, 2026-11-10; 197
  prompts, 11 labels including `none`, 84 / 113 split; MiniLM; 25.7%, 36.3%, 57.8% +/- 1.5, 62.8%, 62.8%.
  Caveats I had not carried: the near-tie margin is 0.005 and a near-tie keeps the old router's pick; the
  router stays opt-in because it fails rUv's latency gate (p95 +503%); the ADR calls label agreement "pilot
  evidence only" and says the 113 test prompts "have been looked at".
- arXiv 2606.06036 (abstract page and full HTML fetched): title, authors, date and ICML 2026 as reported.
  "Up to 23%" is the relative gain in judged score on LoCoMo with one backbone (84.21 against 68.31 for the
  best baseline); with another backbone it is about 12%. On LongMemEval-S: 72.95 against 54.92; on its
  "single-preference" questions 66.67 against 46.67. **Three things I had not reported, and they matter:**
  (1) in the paper a cue is a keyword such as an entity or attribute, and the graph is built by a language
  model; (2) at question time a language model chooses which link to follow, prunes, and decides when to
  stop, for up to 8 turns; accuracy rises steadily with turns while wider results per turn "quickly
  saturate"; (3) it costs about 118,000 tokens and about 586 seconds per benchmark sample. So the paper's
  result is for model-driven navigation, and rUv's example replaces the model with a fixed harness.

**Design changes that follow.**

1. **Evidence must be carried from the cue, not re-measured against the file.** I read MRAgent's walk
   (`agent/memory.mjs:253-320`): every content item is scored by the question's own similarity to that
   content, and abstention uses the same number. For an amateur that similarity is exactly what is missing, so
   the walk as written would prune the right file. rUv's typed-graph operator already returns the seed's score
   with what it reached (`typed_graph.rs:325-374`). The port therefore adds one setting,
   `evidence = content | cue | max` (default `max`), and judges abstention on the cue or centroid match for the
   cue path. This is a deviation from the harness as shipped, stated here so it is not mistaken for rUv's code.
2. **Offer navigation, not only search.** Since the caller is a model, the tool surface gets small, cheap
   operations beside `search`: `expand(capability)` to its files, decisions, alternatives and history;
   `siblings(capability)`; `why(file)` back to the capabilities and decisions that point at it. Results per
   call stay small. This is the paper's mechanism; the fixed walk remains as the default first answer.
3. **Cues are sentences here, keywords in the paper.** Sentences are kept because rUv's own measurement on
   plain prompts (ADR-527) used example prompts averaged per label, and because the lead's dev data favour
   question-shaped text. Keyword cues (names, commands, error strings) are kept as a second cue kind.
4. **`none` is a label with examples.** A set of out-of-scope questions forms its own centroid; landing on it
   is the abstain outcome (the centroid router's `ABSTAIN_LABEL`).
5. **Learning from question and answer logs: first candidate is the projection agentdb ships**
   (`ContrastiveTrainer`: InfoNCE, hard negatives, a full matrix starting at identity; agentdb 3.10.1), trained
   on confirmed (question, capability) pairs on the user's branch, applied to the question vector only. It
   precedes the SONA adapter and any model fine-tune. Its weights have no export and its start is unseeded, so
   a seeded, saved variant is a prerequisite. New rule R25.
6. **The nightly branch is agentdb's governed experiment branch** (`RvfExperimentBranch`, agentdb ADR-013):
   candidate on a copy-on-write child, anchored to commit, benchmark hash and embedding-space hash, promoted
   by a separate trusted step. RuVector ADR-288 states the same invariant for the shipped file: the base is
   never written after signing; state lives in deltas that can be deleted on their own.
7. **Every store carries an embedding-space identity** (model, tokenizer, prompt, pooling, precision, runtime;
   agentdb ADR-011, RuVector ADR-281) and refuses a query embedded any other way, as the centroid router does.
8. **RVF 0.4.x is a precondition**: per-vector metadata did not persist before ADR-280.
9. **Stage 0 for every store includes rUv's retrieval contract** (`docs/testing/retrieval-contract-qualification-1313.md`):
   filtered top-k returns exactly min(k, eligible), no duplicate ids, scores agree with returned vectors.
10. **Route by the shape of the question** before searching, as OSpipe does (`examples/OSpipe/src/search/router.rs`):
    words about time go to history; a quoted phrase or one or two words go to the keyword lane; a plain
    sentence goes to cues and the keyword lane together.

## 9. What this design does not claim

- That it reaches 98%. No layer here has been scored on this corpus. What it would take is stated plainly:
  the right source in the served result for nearly every question, and an answer step that turns served gold
  into a good answer far more often than today's 72% (lead D14). The second half is not a storage question.
- That rUv's unconventional pieces are proven. MRAgent's numbers are from its own simulation; the typed graph
  has unit tests and no retrieval benchmark; hyperbolic and link-prediction layers have no text measurement.
  They are the direction rUv has taken, with working code, and the experiments are how their value for
  amateurs gets established rather than assumed in either direction.
