Updated: 2026-11-17 01:00:28 EST | Version 1.0.0
Created: 2026-11-17 00:15:17 EST

# Capability map of RuVector and what is built on it

One line per capability, in plain words, grouped by what it is for. Made by walking the tree, not by reading
all the code: every crate's manifest description and opening doc comment (201 crates), the ADR index (374
titles), `docs/` (41 folders), `docs/research/` (43 topics), `examples/` (77 folders, 72 RVF examples), the 62
npm packages, the changelog, the RVF format types, and the neighbouring repositories (ruflo, agentdb,
agentic-flow, agenticow, RuLake, midstream, SAFLA, FACT). Source: RuVector commit `979c31ac` and the sibling
clones under `~/RVF-KnowledgeBases/ruvnet-brain-v2-work/src/`.

Maturity key: **S** shipping and callable from Node (published, checked on npm 2026-11-16); **R** real Rust
code, no Node binding; **X** experimental or proof of concept, numbers on made-up data only; **P** placeholder.
"ran" = I ran it in scratch. Deeper evidence with file:line for most rows is in `01-CAPABILITY-CATALOG.md`.

## 1. Storage

| Capability | Where | M |
|---|---|---|
| RVF: one file holding vectors, index, metadata, an append-only witness log, and optionally models, WASM, an OS kernel | `crates/rvf/*`; `@ruvector/rvf` 0.4.12 | S |
| RVF segment model: 29 kinds of segment so different kinds of knowledge live in one container | `rvf-types/src/segment_type.rs` | S for 12 kinds, defined-only for the rest |
| RVF domain profiles: `.rvtext`, `.rvgraph`, `.rvdna`, `.rvvis` variants of the container | `rvf-types/src/profile.rs:40-75` | S (a label; behaviour not read) |
| **Knowledge export: rUv's own project knowledge stored by kind in RVF segments** (identity, crate taxonomy, decisions, dependency graph, timeline, patterns, lessons) | `docs/adr/ADR-056-rvf-knowledge-export.md`; `docs/research/knowledge-export/` | a JSON rendering exists in the tree |
| Copy-on-write branches, freeze, membership views (one index, many filtered views) | `rvf-node/src/lib.rs:888,1126`; `examples/rvf/examples/membership_filter.rs` | S (branch, freeze); R (membership view) |
| agenticow: "Git for agent memory" with branch, checkpoint, rollback, diff, promote | agenticow repo; npm `agenticow` 0.3.1 | S |
| Property graph with hyperedges, persisted | `crates/ruvector-graph`; `@ruvector/graph-node` 2.1.4, `@ruvector/graph-wasm` 2.0.6 | S |
| rvlite: SQL + SPARQL + Cypher in one WASM database | `crates/rvlite`; npm `rvlite` 0.2.8 | S (its README calls it proof of concept) |
| Temporal tensor store: tiered 8/7/5/3-bit compression by access pattern | `crates/ruvector-temporal-tensor` | R |
| Delta stores: track how a vector or graph changes over time | `ruvector-delta-core`, `-index`, `-graph`, `-consensus` | R |
| Postgres extension: 230+ SQL functions (vectors, BM25, sparse, graph, attention) | `crates/ruvector-postgres` | S, needs a server |
| Kernel-resident vector and graph stores | `crates/ruvix/crates/vecgraph` | R |

## 2. Indexing

| Capability | Where | M |
|---|---|---|
| HNSW graph index (in RVF, in core) | `rvf-index`, `ruvector-core` | S |
| Progressive index: answer from entry points first, then hot region, then full graph | `examples/rvf/examples/progressive_index.rs`; ADR-033 | R |
| DiskANN / Vamana | `ruvector-diskann`; `@ruvector/diskann` 0.1.4 | S |
| Filtered search inside the graph walk (ACORN) | `ruvector-acorn`; `@ruvector/acorn-wasm` | X |
| IVF families, SPANN, LSM-ANN (write-optimised), streaming quantised graphs | their crates | X |
| Hyperbolic HNSW (search in the Poincare ball) | `ruvector-hyperbolic-hnsw` | X |
| Micro-HNSW in under 12 KB of WASM with spiking neurons | `micro-hnsw-wasm` | X |
| Multi-vector index per document (MaxSim), MUVERA fixed encodings | `ruvector-maxsim`; `ruvector-core/.../multi_vector.rs` | R / X |
| Typed-graph vector index: vectors bound to a node label | `ruvector-graph/src/typed_graph.rs:233` | R |
| Keyword (BM25) indexes | `ruvector-graph/src/bm25.rs`, `ruvector-core/.../hybrid_search.rs`, `ruvector-hybrid` | R / X |

## 3. Search

| Capability | Where | M |
|---|---|---|
| Vector search with metadata filters | `@ruvector/rvf` | S |
| **Vector hit, then graph expansion, from Node** (official example using two published packages) | `examples/npm-vector-graph` (`@ruvector/core` + `@ruvector/graph-wasm`) | S |
| **Search a node label, traverse an edge type, in one operation** | `typed_graph.rs:325` | R |
| Keyword + vector on graph node text, fused | `typed_graph.rs:420` | R |
| Cypher, SPARQL, SQL | graph-node, graph-wasm, rvlite | S (subsets) |
| **Reconstruct, do not retrieve: cue to tag to content traversal with adaptive depth and abstention** | `examples/mragent` (ADR-269, ADR-270) | X, runnable in Node; ran: 14 of 14 tests, benchmark reproduced |
| GraphRAG (entities, communities, local / global / hybrid) | `ruvector-core/.../graph_rag.rs` | R |
| Bounded-context retrieval by min-cut; diverse beam; recall-bounded; speculative; adaptive; entropy-adaptive search | their crates | X |
| Hierarchical search, taxonomy reasoning, entailment cones in the Poincare ball | ruflo `v3/plugins/hyperbolic-reasoning`; npm `@claude-flow/plugin-hyperbolic-reasoning` 3.0.0-alpha.3 | X: published, but it falls back to a mock module because its WASM dependency is not on npm (`hyperbolic-bridge.ts:114-119`), and its entailment graph embeds by character hash |
| Pathfinder traversal over a code knowledge graph | ruflo `plugins/ruflo-knowledge-graph`; `agentdb_graph-pathfinder` | S |
| Replace retrieval by cached, deterministic tool calls (no vectors) | FACT repo | S (Python) |
| **Task to capability by a typed catalogue: each domain lists "task signals"; a task is matched by which signals it contains** (rUv's own "which tool for this job") | ruflo `v3/@claude-flow/cli/src/mcp-tools/capability-brain.ts:833-852`, `guidance-tools.ts:255-268` (`guidance_recommend`, `guidance_brain`) | S |

## 4. Ranking

| Capability | Where | M |
|---|---|---|
| Personalised PageRank, forward and backward push | npm `@ruvnet/sublinear-core` 1.0.1; ruflo `plugins/ruflo-graph-intelligence`; `ruvector-solver` | S |
| Keyword-first blend with graph and votes (rUv's own production ranking) | `mcp-brain-server/src/routes.rs:2044-2056` | S (service) |
| Reciprocal-rank fusion, cross-encoder re-rank, MMR | agentdb `src/search`, ruflo memory | S |
| Utility re-ranking: similarity + causal uplift - cost, with a certificate | agentdb `CausalRecall.ts` | S |
| GNN score diffusion over candidates | `ruvector-gnn-rerank` | X |
| Late interaction (MaxSim), optimal transport (Sinkhorn) | `ruvector-maxsim`; `@ruvector/math-wasm` | X / S |
| 18+ attention operators incl. hyperbolic, sheaf, min-cut gated | `ruvector-attention`; `@ruvector/attention` 2.3.1 | S (untrained) |
| Conformal prediction: result sets with stated coverage | `ruvector-core/.../conformal_prediction.rs` | R |
| Temporal decay with coherence gating | `ruvector-temporal-coherence` | X |

## 5. Learning

| Capability | Where | M |
|---|---|---|
| SONA: micro-LoRA, base LoRA, EWC++, pattern bank from trajectories | `crates/sona`; `@ruvector/sona` 0.1.13 | S (ran a probe: negligible movement through the Node API) |
| ReasoningBank: retrieve, judge, distil, consolidate | agentic-flow, agentdb, sona | S |
| Reflexion memory (episodes with self-critique and outcome), skill library (promote successful trajectories), nightly learner (discover causal edges, A/B test, prune) | agentdb `src/controllers` | S |
| **Consolidation / replay: lay shortcut edges along paths that worked** | `examples/mragent/agent/consolidate.mjs` | X, ran |
| **Darwin / MetaHarness: freeze the store, evolve the retrieval harness on a train split, report held-out** | `examples/mragent/optimize.mjs`; `@metaharness/darwin`; ADR-266, 269-271 | X, ran the benchmark |
| Knowledge-graph embeddings (HolE, RotatE) with link prediction | `@ruvector/kge` 0.2.1 | S |
| Hierarchy embedding by Riemannian descent | `@claude-flow/plugin-hyperbolic-reasoning` (`hyperbolic_embed_hierarchy`, `src/bridges/hyperbolic-bridge.ts:141-262`); optimizer in `ruvector-graph-transformer/src/manifold.rs:682` | S (alpha) / R |
| Typed decisions with calibration and abstain; governed self-optimisation | `@ruvector/typesafe` 0.2.0 | S (hash embedder in the published build) |
| Embedder fine-tune + ONNX transplant (OpenJev) | `ruvector-typesafe-train` | R |
| Learned routers: Tiny Dancer (FastGRNN), semantic router, value-of-information routing, domain-expansion bandit | `@ruvector/tiny-dancer`, `@ruvector/router`, `ruvector-voi`, `ruvector-domain-expansion` | S / R |
| Weight-space registry: warm-start from the nearest past task | `@ruvector/weight-space` 0.1.0 | S |
| GNN on the index graph | `ruvector-gnn` | forward S, learning P |
| Federated learning of adapters across sessions | `mcp-brain-server/src/trainer.rs`, `aggregate.rs` | S (service; not read) |
| Bio-inspired memory: Hopfield recall, hyperdimensional vectors, pattern separation, global workspace | `ruvector-nervous-system`; used in `mcp-brain-server/src/cognitive.rs` | R / S (service) |

## 6. Compression

| Capability | Where | M |
|---|---|---|
| RaBitQ 1-bit with re-score | `ruvector-rabitq`; `@ruvector/rabitq-wasm` 0.1.2 | S |
| Turbo4 4-bit primary storage; 2-3-4 bit TurboVec | `ruvector-turboquant`, `ruvector-turbovec` | S in core / X |
| Product, residual, streaming quantisation; dithering; Matryoshka prefix search | their crates | X |
| Graph condensation and spectral sparsification (shrink a graph, keep its structure) | `ruvector-graph-condense`, `ruvector-sparsifier` | X / R |
| Memory compaction by coherence; write-time admission by min-cut | `ruvector-agent-memory`, `ruvector-memory-admission` | X |
| E-means deterministic clustering | `@ruvector/e-means` 0.1.0 | S |

## 7. Graph and reasoning

| Capability | Where | M |
|---|---|---|
| Dynamic minimum cut (find the boundary, not the centre) | `ruvector-mincut`; `@ruvector/mincut-wasm` 2.3.1 | S |
| "Boundary-first discovery": structure found as cuts in a coherence graph | 14 `examples/*-boundary-discovery` | X (applications) |
| Sheaf-Laplacian coherence engine: contradiction as energy on a graph of facts | `prime-radiant` | R; its LLM gate has placeholder scores |
| Coherence gate: permit / defer / deny with signed tokens | `cognitum-gate-*`, `mcp-gate`; `@cognitum/gate` 0.1.1 | S |
| Neural-symbolic bridge: extract rules from patterns, reason with confidence | `mcp-brain-server/src/symbolic.rs` | S (service) |
| Causal memory graph: do-calculus estimates and uplift | agentdb `CausalMemoryGraph.ts` | S |
| Graph transformer with proof-gated mutation; physics, biological, temporal-causal, economic, manifold layers | `ruvector-graph-transformer`; `@ruvector/graph-transformer` 2.0.4 | S / X |
| Sublinear solvers (sparse systems, PageRank) | `ruvector-solver`, `@ruvnet/sublinear-core` | S |
| Code knowledge graph: entities and relations extracted from source | ruflo `plugins/ruflo-knowledge-graph`, `v3/plugins/code-intelligence` | S |
| A codebase stored as structure: module split by graph partition, dependency graph, call graphs, class hierarchy, in RVF with witness | `ruvector-decompiler`; `docs/research/claude-code-rvsource/` | S (tool) |

## 8. Memory (agent-facing)

| Capability | Where | M |
|---|---|---|
| AgentDB: episodes, skills, causal edges, patterns, explainable recall | agentdb 3.10.1 | S |
| Three-tier and hierarchical memory designs; compaction-to-memory bridge | ADR-136, ADR-307, ADR-320; gist 29f8fa68 | design / partly built (reader notes pending) |
| Shared brain: memories as signed RVF containers with votes, reputation, drift detection | `mcp-brain-server`; `@ruvector/pi-brain` 0.1.4 | S (service) |
| RuLake: a cache that learns what gets asked, in front of existing storage | RuLake repo | S (service) |
| Session index, context manager, reflection | `crates/ruvllm/src/{session_index.rs,context,reflection}` | R |
| Semantic query cache, tool-call cache | `ruvector-query-cache`; `examples/rvf/examples/tool_cache.rs` | X |

## 9. Provenance and trust

| Capability | Where | M |
|---|---|---|
| Witness chain on every write; lineage of derived stores | `rvf-runtime` | S |
| Proof-gated writes with Merkle log; signed retrieval receipts | `ruvector-proof-gate`, `ruvector-retrieval-receipt` | X |
| Explainable recall: minimal set of facts that justify an answer, with a Merkle proof | agentdb `ExplainableRecall.ts` | S |
| Formal verification of vector operations | `ruvector-verified` | R |
| Signed packages, registry, revocation | `rvf-forge-core`, `rvforge-registry`; `@ruvector/rvforge` 0.2.0 | S |
| Capability-gated and scope-sharded retrieval | `ruvector-capgated`, `ruvector-context` | X |
| Differential-privacy proofs, redaction logs (segments) | `rvf-types` 0x34-0x35 | defined |

## 10. Distribution

| Capability | Where | M |
|---|---|---|
| Models shipped inside the knowledge file | RVF Wasm / Kernel segments; agentdb `ModelCacheLoader.ts` | S |
| RVF registry on the edge; snapshots; tenancy | `ruvector-edge-*` | X |
| Federated RVF transfer learning | `rvf-federation`; ADR-057 | R |
| Raft, replication, CRDT delta consensus | `ruvector-raft`, `-replication`, `-delta-consensus` | S / R |
| Runs in browser, edge, ESP32, Pi cluster, bare-metal kernel | WASM crates, `ruvector-hailo*`, `ruvix`, `rvm` | S / X |

## 11. Interfaces

| Capability | Where | M |
|---|---|---|
| npm `ruvector` CLI + MCP server (118 tools: hooks, brain, rvf, rvlite, diskann, weights) | `npm/packages/ruvector` 0.3.27 | S |
| RVF MCP server | `@ruvector/rvf-mcp-server` 0.2.5 | S |
| Local embedders (ONNX WASM, Lattice pure Rust, Hailo NPU) | `ruvector` npm, `ruvector-core`, `ruvector-hailo` | S / R |
| Local LLM runtime | `@ruvector/ruvllm` 4.2.2 | S |
| Python bindings | `ruvector-py` | S |

## 12. Evaluation and promotion machinery (found on the second walk)

| Capability | Where | M |
|---|---|---|
| Darwin: evolutionary search over a harness "genome" with Pareto selection and a behavioural-diversity archive | npm `@metaharness/darwin` 0.14.0, `metaharness` 0.4.23; `crates/ruvector-sota-bench/harness/src/darwin.ts`, `genome.ts`, `pareto.ts` | S |
| Dream Machine: nightly, evidence-gated evaluation with verdicts ACCEPT / REJECT / INCONCLUSIVE, a ledger and a witness stamp | npm `dream-machine` 0.1.2; `docs/research/perpetual-intelligence-runtime/05-dream-machine-consolidation.md` | S |
| Research gate: paired-bootstrap significance, hard vetoes, signed replay bundles, promotion check | `crates/ruvector-sota-bench/harness/src/statistics.ts`, `vetoes.ts`; `scripts/research-gate/`; ADR-282 (Proposed) | R / scripts |
| Flywheel, skill forge, environment designer | same harness folder | not read |
| Research plans for the index itself: GNN-guided routing, neuro-symbolic query, embedding crystallisation (a hierarchy that forms itself from flat vectors), temporal GNN | `docs/research/gnn-v2/` (plans) | design only |
| RVF format specification: segment model, manifest, temperature tiering, progressive indexing, overlay epochs, filtered search, deletion lifecycle, versioning | `docs/research/rvf/spec/00` to `11`; `docs/research/rvf/profiles/domain-profiles.md` | spec (not read line by line) |

## Outside the scope of knowledge retrieval (seen, not mapped further)

Robotics (`agentic-robotics-*`, `ruvector-robotics`), trading (`neural-trader-*`, `ruvector-kalshi`), optics
(`photonlayer-*`), ultrasound (`sonic-ct`), consciousness metrics, emergent time, time-series (`timesfm`),
image CNN, FPGA and sparse-inference backends, thermal control, OAuth for the edge, the decompiler's model
training, the fabric work queue (`ruvector-weaver`).

## Surprises: what a "vector database plus RAG" mindset would not expect

1. **The intended unit is not a chunk.** rUv's own knowledge export (ADR-056) stores a project as typed
   knowledge: identity, taxonomy, decisions, dependency graph, timeline, patterns, lessons, each in its own
   segment of one file.
2. **Retrieval is treated as reconstruction.** MRAgent ("Memory is Reconstructed, Not Retrieved") searches for
   *cues*, walks cue to tag to content, prunes, stops early when evidence is decisive, and answers "I don't
   know" when it is weak. It scores itself by a risk-adjusted utility in which a confident wrong answer is
   worse than abstaining.
3. **The store is frozen and the harness evolves.** A genetic loop tunes twelve retrieval settings on a train
   split and reports on a held-out split. Learning from use is new shortcut edges, not new weights.
4. **Vectors are bound to graph nodes.** A search lands on a node of one type and returns nodes of another by
   walking a named edge. An official example does vector-then-graph from Node with two published packages.
5. **Hierarchy has its own geometry**, and a hierarchy embedder ships in ruflo (alpha), with entailment cones.
6. **Boundaries matter more than centres.** Min-cut is used everywhere: to find structure, to bound a context,
   to admit a memory, to split a codebase into modules.
7. **Coherence instead of confidence.** The stated thesis of RuVector V2 is to prove when facts fit together
   (contradiction as energy on a graph of facts), and to refuse when they do not.
8. **Memory branches like Git.** Branch, mutate, verify by an external deterministic check, promote or discard;
   never a cheap model as the judge (agenticow README).
9. **Recall carries its justification.** AgentDB's explainable recall returns the minimal set of facts that
   justify an answer plus a proof; causal recall ranks by measured uplift, not similarity alone.
10. **rUv has an anti-RAG line of work.** FACT replaces vector retrieval by cached, deterministic tool calls.
11. **His own production brain ranks by keyword first**, over hash vectors, with a graph walk and votes.
12. **One file can carry the knowledge, the model that reads it, and the proof of what went in.**

## First question list for the RuvNet Brain (written before asking)

Recorded here before any is asked; answers and leads go to `BRAIN-QUESTION-LOG.md`.

1. In MRAgent, how are Cue, Tag and Content nodes defined and built from raw documents, and what does ADR-270
   say makes reconstruction better than retrieval?
2. What does ADR-253 say remains to be built for the typed graph (phases), and is `search_then_traverse`
   planned for the Node or WASM bindings?
3. How does ADR-136 (memory hierarchy reconstruction) or ADR-307 (three-level persistent memory) organise
   knowledge into levels, and how does a query move between levels?
4. In the pi brain, what does "cognitive enrichment" (ADR-123) add to a stored memory, and how is the
   knowledge graph between memories built and used at search time?
5. How does `ruflo-knowledge-graph` extract entities and relations from source code, where is the graph
   stored, and how does the pathfinder score a path?
6. What does `hyperbolic_embed_hierarchy` optimise, and has any hierarchy embedding been evaluated on a real
   taxonomy in rUv's repositories?
7. How does AgentDB's ExplainableRecall compute the "minimal hitting set" of facts, and what does a recall
   certificate contain?
8. How does the ruvector-decompiler turn a JavaScript bundle into modules with min-cut, and how were the
   Claude Code RVF containers built and queried?
9. What is the "Brainpedia" (ADR-062): what is a page, how are pages linked and revised?
10. What does RuVector's README say distinguishes a self-learning index from a vector database, and which
    part of that is implemented (GNN on HNSW topology)?
11. How does SONA's ReasoningBank turn trajectories into patterns, and where are patterns used to change a
    later search?
12. What is the RVF cognitive container (ADR-030, ADR-036): what makes a container "cognitive"?
13. How does ruLake "learn what gets asked", and what is a witness-pinned answer?
14. What is "boundary-first discovery" and how is the coherence graph built from raw data before the cut?
15. How does the MetaHarness Darwin loop define a genome and a fitness for retrieval, and what gates stop it
    overfitting (ADR-266, ADR-271)?
16. What does FACT put in place of a vector store, and what kinds of question does rUv say it suits?
17. What do ADR-320 (atomic observation, causal graph) and ADR-330 (correlation-aware memory arbitration)
    change about how a memory is written and chosen?
18. Is there any place where rUv maps a plain-language problem to the right tool or package (a capability
    catalogue, `guidance_recommend`, a router), and how is it built?

## Addendum, 2026-11-17 (second own walk, started 12:50 a.m. ET)

Directories and documents opened in this walk that the map above did not cover, read by me. Same maturity key.

### RuVector: ADRs from July 2026 onward (88 dated files listed; those bearing on storage and retrieval)

| Date | ADR | What it adds, in plain words | State |
|---|---|---|---|
| 2026-07-29 | ADR-280 durable metadata | Before this, an RVF file kept vectors across close and reopen but lost its metadata, and the SDK rejected metadata. Now per-vector metadata persists (`rvf-runtime/src/store.rs:1981`, `:4296`; SDK needs `rvf-node` 0.4.2 or later; the WASM backend still rejects it) | S in 0.4.x. **The Brain's pinned 0.3.4 / 0.2.3 predates it** |
| 2026-08-03 | ADR-288 immutable base + delta lifecycle | A signed RVF is never modified; accumulated state lives in deltas and checkpoints tied to the base's lineage | Accepted |
| 2026-08-06 | ADR-297 adaptive compression plane | One interface for every vector encoding, with each vector placed at the cheapest precision that keeps its retrieval value, and the encoding's provenance recorded | Accepted; `ruvector-core::encoding` |
| 2026-08-07 / 08 | ADR-300 cluster retrieval; ADR-299 namespace routing by min-cut | see sections 3 and 6 | X |
| 2026-08-13 | ADR-303 entropy-adaptive search | closed as a negative result, documented | closed |
| 2026-08-19 to 23 | ADR-305 to 338 "perpetual intelligence runtime" wave | Each adopts one 2026 paper as a pattern: memory ledger (307), harness evolution with frozen weights (313), atomic observations (320), project-specific skills distilled from synthetic issues (321), stage-level memory diagnosis (325), capability-grounded reasoning (326), cost-aware routing (331), scope-sharded context index (334) | mostly Proposed, several with real crates |
| 2026-08-23 | ADR-339 context JavaScript binding | a JS binding for the scope-sharded context index | Accepted |
| 2026-10-26 | ADR-353 RVF stream descriptor | a signed descriptor so a reader can verify a file while it is still arriving | Proposed |
| 2026-11-05 to 11 | ADR-355 weaver, 358 weight-space, 359/360 e-means | ecosystem work queue; model registry by task embedding; deterministic clustering | Accepted |

### RuVector: other places opened

| Capability | Where | M |
|---|---|---|
| Retrieval contract: the invariants a store must keep (filtered top-k returns exactly min(k, eligible) on the exact path, no cross-tenant ids, no duplicate ids, scores agree with returned vectors, deleted ids never returned) | `docs/testing/retrieval-contract-qualification-1313.md` (a test plan) | plan |
| "Learn-from-feedback actually learns" as an executable contract across three SONA implementations, after the same stub shipped twice | `scripts/sona-drift/` (`harness.mjs`, `reference.rvf`, `stub-tripwire.mjs`) | scripts; not run |
| Training-data contamination check by 13-word overlap with the evaluation set; release gate | `scripts/training/contamination_check.py`, `release_gate.py` | scripts |
| Dataset discovery framework: data as a graph, min-cut for regime change ("discover what you don't know you're looking for") | `examples/data/` | X |
| Hybrid vector-graph example | `examples/graph/hybrid_search.rs` | P (every call is commented out) |
| rvlite SPARQL triple store (basic patterns; property paths not supported, `sparql/executor.rs:359`) and Cypher (path ranges parsed in `cypher/ast.rs:98`, no use in the executor) | `crates/rvlite/src` | S, subset |
| pi brain ingest: content-hash de-duplication, novelty scoring against what is already stored, compression tier; gist publisher that only publishes findings above a novelty and evidence bar | `mcp-brain-server/src/web_ingest.rs`, `gist.rs` | S (service) |
| Capability-grounded "thought map" navigation between agents | `crates/rvAgent/latentmesh-thoughtmap` (ADR-326) | X |
| Semantic index of execution history; policy store | `crates/ruvllm/src/witness_log.rs`, `policy_store.rs` | R |
| Reward-hacking defences and a staleness-weighted online tuner for evolved settings | `crates/sona/src/darwin_guard.rs`, `auto_tuner.rs` | R |

### Neighbouring repositories opened

| Capability | Where | M |
|---|---|---|
| **A learned projection on top of frozen embeddings**: InfoNCE loss, hard-negative mining, curriculum, AdamW; a full matrix initialised at identity | agentdb `src/backends/rvf/ContrastiveTrainer.ts` (559 lines, with tests) | S in agentdb 3.10.1 (TypeScript). Weights in memory only (no export found); initial noise unseeded; no measured retrieval gain found |
| Self-learning RVF backend: query router + SONA on search, contrastive trainer on feedback, bandit for strategy | agentdb `SelfLearningRvfBackend.ts`, `SemanticQueryRouter.ts`, `SolverBandit.ts`, `AdaptiveIndexTuner.ts` | S; effect unmeasured |
| **Experiments on a copy-on-write RVF branch, bound to commit, benchmark hash and embedding-space hash; the candidate can ask for promotion and never holds release authority** | agentdb `src/governance/RvfExperimentBranch.ts`, `MetaHarnessGateway.ts`; agentdb ADR-013 (2026-07-29) | S, with a test |
| Learned re-ranker trained on labelled relevance, evaluated held-out before it becomes active, with a revisioned pointer | agentdb `NeuralReranker.ts`; ADR-019 (2026-11-10) | S; evaluated on synthetic data only |
| Outcome feedback re-orders patterns: 0.7 similarity + 0.2 success rate + 0.1 reward; exact search under 1,000 rows because the approximate index misses neighbours on tiny graphs | agentdb ADR-015 (2026-10-31) | S |
| Promotion pipeline as a runnable example: agent branch, test sandbox, review gate, promote to base, lineage audit at each step; also A/B branches, rollback and quarantine, time-travel debugging | agenticow `examples/promotion-pipeline.mjs` and 16 others | S (examples) |
| Decisions linked to code: ADR lifecycle with a hierarchical store and causal edges | ruflo `plugins/ruflo-adr` | S |
| Domain graph (bounded contexts, aggregates, events) as a navigable store; documentation drift detection | ruflo `plugins/ruflo-ddd`, `ruflo-docs` | S |
| **Nearest-centroid router with an explicit `none` label, refusing to score a query embedded by a different model than the artefact** | ruflo `v3/@claude-flow/cli/src/ruvector/centroid-router.ts`; ADR-527, ADR-391 | S (opt-in flag) |
| rUv's own pre-registration for a router: frozen hashed corpus, blind labels, dev / test split touched once, metrics including "wrong at high confidence" and abstain precision, an AND-gate for promotion, and "changing the gate in the same commit as the result it would flip is exactly what this ADR forbids" | ruflo ADR-391 | S (process) |
| Adapters for open models kept only if they beat the unchanged base under a rule written first, with every raw answer kept | ruvllm repo README | S (process) |

All 48 ruflo plugins and 14 v3 plugins were listed with their descriptions; those not in the tables are
orchestration, security, trading, browser, cost or domain plugins without a retrieval role.

### Capabilities I now think matter for the recipe that were not in it

1. **A learned projection on frozen vectors ships in agentdb** (`ContrastiveTrainer`). It is the full-size
   version of what the rank-1 SONA adapter could not do, callable from Node. It becomes the first candidate for
   "learned from question and answer logs", before any model fine-tune.
2. **Experiment branches with anchors** (`RvfExperimentBranch`): the nightly branch, verify, promote step
   already exists as governed code.
3. **`none` as a label with its own examples** (centroid router): abstention learned from examples of
   out-of-scope questions, not only a threshold.
4. **Metadata persistence arrived in RVF 0.4.x**: the design's metadata filters need the upgrade.
5. **The retrieval contract invariants** as stage-0 checks for every store in the design.
6. **Novelty scoring at ingest** (pi brain): store a new cue only if it is not already covered.
7. **The contamination check by 13-word overlap** as rUv's own leak rule (the lead uses 8 words, stricter).
8. **Navigation, not only search.** The paper behind MRAgent has the calling model choose which link to follow
   and when to stop, and reports that accuracy rises with the number of reasoning turns while wider results per
   turn saturate. The Brain's caller is such a model, so the store should expose "follow this link" operations
   as well as "search".

### What this walk corrected

- `01-CAPABILITY-CATALOG.md` listed the LongMemEval haystack size as unverified. Verified: the benchmark ranks
  within each question's own haystack (`agentdb/benchmarks/longmemeval/run.mts:4`), about 50 sessions (S) or
  500 (M), not one 850,000-chunk corpus.
- The hybrid example in `examples/graph` is a placeholder; the working Node example is `examples/npm-vector-graph`.

### More from the same walk

| Capability | Where | M |
|---|---|---|
| RVF adapters: how each rUv system maps its records onto RVF (key, namespace and tags as metadata fields; experiences as a state / next-state vector with action and reward as metadata; patterns with reward and critique; every store, delete and search written to the witness segment) | `crates/rvf/rvf-adapters/{claude-flow,sona,agentdb,agentic-flow,ospipe,rvlite}` | R |
| Query-shape router: time words to a temporal store, "related to" to the graph, one or two words or a quoted phrase to keywords, everything else to hybrid | `examples/OSpipe/src/search/router.rs` (90 lines) | X (example) |
| Content-addressed release registry with trust levels, revocation and a Merkle transparency log; edge package registry with immutable versions and yanking | `crates/rvforge-registry` (38 tests), `crates/ruvector-edge-registry` (19 tests) | R |
| Stale-view protection: an artefact is bound to a content hash and revision, and stale views fail closed | `crates/ruvector-staged-workspace` (ADR-318) | R |
| Embedding-space identity as the compatibility key for stores, caches and benchmarks | agentdb ADR-011 (2026-07-29); RuVector ADR-281 | S in agentdb |
| Immutable signed base with state in separately deletable deltas | RuVector ADR-288 (Accepted 2026-08-03) | design + RVF branch code |

Walk accounting: this second walk ran from 12:50:04 a.m. to 1:00:11 a.m. ET by the machine clock (about 55
read commands and three page fetches, all read by me). With the first walk (11:55 p.m. to about 12:04 a.m.)
that is about 19 minutes of my own reading of the tree.

Three more items for the list of capabilities that matter for the recipe and were not in it:

9. **Co-change links from history.** rUv's hooks record which files are edited together and suggest them
   (`npm/packages/ruvector/bin/cli.js:5700-5712`). The history store already holds every commit, so
   "changed together" links between files can be built mechanically and walked like any other link.
10. **A ledger for beliefs.** `ruvector-agent-memory/src/ledger.rs:244-262`: a credible contradicting statement
    supersedes the old one, the old one is marked rejected, and whatever depended on it is put back to
    pending. This is the lead's "store the correction with the claim" as working code (Rust only).
11. **Question shape and embedding identity** (OSpipe's router; agentdb ADR-011): route by the kind of
    question before searching, and refuse to compare vectors made by different models or settings.
