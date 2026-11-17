Updated: 2026-11-17 00:49:11 EST | Version 1.0.0
Created: 2026-11-16 23:51:13 EST

# 1. Capability catalog: what RuVector and the rUv retrieval stack can actually do

## How to read this

Plain summary first, then the tables.

- **What was traversed.** RuVector at commit `979c31ac` (the current upstream head, 201 crates, 62 npm packages),
  plus the ruflo, agentdb, agentic-flow, ruvllm, RuLake, midstream, SAFLA and FACT clones under
  `~/RVF-KnowledgeBases/ruvnet-brain-v2-work/src/`. The older clone at `~/Code/RuVector_Clean` is 623 commits behind
  (checked with the hosting API) and was not used. Six Sonnet readers took disjoint sets; their full notes with
  file:line are in `raw/A` to `raw/F`. I re-checked every claim this report leans on; those are marked **V**. Claims
  I took from a reader without re-checking are marked **R**.
- **Grounding.** `search_ruvnet` is down in this session (the lead's decision D5), so everything here comes from
  reading source. Paths are relative to the RuVector clone unless they name another repository.
- **Maturity words.** SHIPPING = published, real code, reachable from Node (the Brain is a Node product).
  RUST-ONLY = real code in a crate, no Node or WASM binding, so the Brain cannot call it without building a
  binding. RESEARCH = a standalone proof-of-concept crate whose only numbers are on synthetic vectors. STUB =
  placeholder code.
- **The one-paragraph finding.** RuVector is a wide and real storage, index and compression toolkit. What it does
  **not** contain is a text-retrieval quality layer that has been measured on real text: no rUv-trained embedding
  model for retrieval, no lexical index inside RVF, no multi-vector store reachable from Node, and no retrieval
  benchmark run on real documents inside the RuVector tree. rUv's real text-retrieval measurements live in ruflo
  and agentdb, and they say the same thing the lead's rig says: keyword search first, vectors second, a reranker
  on top.

Failure modes used in the last column: **AM** amateur problem-only questions with no word overlap; **XR**
cross-repository and relationship questions; **HI** history; **ST** run-to-run instability; **FC** false claims;
**AB** abstention ("that does not exist").

## A. Storage: RVF and the core database

| Capability | What it does | Where | Maturity | Cost | Could address |
|---|---|---|---|---|---|
| RVF vector store | One file per store: f32 vectors, HNSW index, metadata, witness log | `crates/rvf/rvf-runtime/src/store.rs` | SHIPPING, `@ruvector/rvf` 0.4.12 (npm, checked live) | 8 + 4 x dims bytes per vector, uncompressed; all vectors loaded into RAM at open (`store.rs:3611-3635`, R). 1.1 M passages at 768 dims is about 3.4 GB | the vector lane only |
| RVF metadata filter at query time | eq, ne, lt, le, gt, ge, in, range, and, or, not over numbers, strings, booleans. No contains, prefix or regex | `rvf-runtime/src/filter.rs:13-43` (R); `npm/packages/rvf/src/types.ts:59-95` (R) | SHIPPING | metadata held in RAM; total cap 256 MiB (`rvf-types/src/metadata.rs:15`, V) so passage text cannot live there | per-repo, per-kind, per-standing filters; XR |
| Copy-on-write branch and freeze | `branch()` makes a child store that shares the parent's data; `freeze()` seals a snapshot | `rvf-node/src/lib.rs:888`, `:1126` (V); `store.rs:3179`, `:3259` (R) | SHIPPING | small | continuous update: nightly delta on a branch, swap when verified |
| derive / merge lineage | Records where a store came from. The child starts empty; merge does not read through to parents | `store.rs:3300-3345`, `store/lineage.rs:30-75` (R) | provenance only | n/a | audit trail, not retrieval |
| Witness chain | Hash-linked log of ingest, delete, compact, derive. A query is logged only if `audit_queries` is on, and then only k, count and epoch | `store.rs:3477`, `:1567` (R) | SHIPPING for writes. Node `verifyWitness` only counts segments (`rvf-node/src/lib.rs:1082-1121`, R); the real verifier is in the CLI and WASM | 73 bytes per event | proves what was ingested; does not prove what a query returned |
| RVF segment types | 29 defined. Read and written: Vec, Index, Journal, Manifest, Meta, Witness, Kernel, Ebpf, Wasm, Dashboard, CowMap, Membership. **Defined but unused: Quant (0x06), MetaIdx (0x0D, the inverted-index segment), Sketch, Hot, Overlay, Delta, the 0x30 family** | `rvf-types/src/segment_type.rs` (V for the list; R for used/unused) | mixed | n/a | the "lexical index inside RVF" idea needs MetaIdx, which is not implemented |
| Custom key-value segments 0xC0-0xEF | Up to 16 MiB each, hashed and witnessed | `store/custom_segments.rs` (R) | RUST-ONLY, no Node binding | n/a | could carry a small adapter or model manifest |
| RVF quantization on disk | None. The `compression` option is accepted and ignored; vectors are always f32 | `write_path.rs:120-141` (R; the pilot found the same, `RECIPE.md` row 8) | not implemented | n/a | footprint: no help today |
| RVF RaBitQ query path | 1-bit scan in RAM, then exact f32 re-score, oversample 4 | `rvf-runtime/src/rabitq_path.rs`; native flag at `rvf-node/src/lib.rs:98` (V) | native layer only; the TypeScript SDK does not expose it (R) | RAM only, no disk saving | speed, not quality |
| Multi-vector or named vectors in one RVF | Not supported: one dimension, one metric, one row per id, one index per file | `store.rs` (R) | absent | n/a | multi-vector must be done by many ids mapping to one unit |
| Read-only open rewrites the id sidecar | The defect the lead hit (D11). Fixed upstream on 2026-11-06: `saveMappings()` returns early when read-only | `npm/packages/rvf/src/backend.ts:731` (V) | fixed in 0.4.x. **The Brain pins `@ruvector/rvf` 0.3.4 and `rvf-node` 0.2.3 (V), which predate the fix** | none | upgrade removes defect 2 of the architecture document |
| ruvector-core `VectorDB` | HNSW database; rebuilds the whole index at every open | `ruvector-core/src/vector_db.rs:464-482` (R) | SHIPPING but RVF is the better container | rebuild cost at open | none beyond RVF |
| ruvector-core quantization tiers | scalar, product and binary are explicit no-ops; only Turbo4 (4-bit) is applied | `ruvector-core/src/types.rs:101-117` (R) | Turbo4 SHIPPING in core (`ruvector-turboquant`, D/2 + 8 bytes per vector) | 200 B at 384 dims, 392 B at 768 | footprint, if a vector lane is admitted |

## B. Lexical, sparse and hybrid search

| Capability | What it does | Where | Maturity | Could address |
|---|---|---|---|---|
| Lexical index inside RVF | Does not exist | see MetaIdx above | absent | - |
| `ruvector-core` BM25 + `HybridSearch` | BM25 over text kept in a RAM map, whitespace tokens, drops tokens of 2 characters or fewer, score blend 0.7 cosine + 0.3 BM25 after min-max | `ruvector-core/src/advanced_features/hybrid_search.rs:15-316` (V for API and tokenizer) | RUST-ONLY, unwired (no binding in node, wasm, cli; V by grep). rUv's own ADR-256 calls its fusion "obsolete" and its BM25 a latency regression | weaker than the lexical lane the Brain already measured |
| `ruvector-core` sparse vectors | Sparse index with rank fusion | `advanced_features/sparse_vector.rs` (775 lines; R) | RUST-ONLY, unwired | a learned-sparse lane would need a binding |
| `ruvector-hybrid` | In-memory BM25 (k1 1.2, b 0.75) + flat dense + three fusions (min-max, RRF k=60, per-list min-max) | `crates/ruvector-hybrid/src/bm25.rs:16-17`, `fusion.rs:23`, `lib.rs:31` (V) | RESEARCH, v0.1.0, no tokenizer (the caller passes tokens), no persistence, two lanes only, not on npm (checked live). Its own benchmark is synthetic: BM25 77.3% against dense 7.5% (`docs/adr/ADR-256`, V) | nothing the SQLite FTS5 lane does not already do better |
| `ruvector-graph` text search | BM25 + vector fused by RRF, then graph traversal (`hybrid_search_text`, `search_then_traverse`) | `ruvector-graph/src/typed_graph.rs:325`, `:420` (V) | RUST-ONLY (not bound to Node or WASM; its only built-in embedder is a lexical hash) | XR, if bound |
| `ruvector-postgres` BM25, sparse, hybrid, local embeddings (MiniLM via fastembed) | SQL functions | `crates/ruvector-postgres/src/...` (R) | SHIPPING but needs a Postgres server | not usable on end-user laptops |
| ruflo Lucene-style BM25 | Porter stemmer, Lucene stopwords, k1 1.2, b 0.75; matches published Lucene BM25 within 0.003 nDCG on two BEIR sets | ruflo `v3/docs/adr/ADR-088-lucene-bm25-and-rerank.md` (V) | SHIPPING in ruflo as a benchmark module. **This is the analyzer the lead's lexical lane already uses** | AM partly; the backbone |
| agentdb hybrid | BM25 + dense by RRF k=60, light stemmer, optional cross-encoder with weight 8 | agentdb `docs/adrs/ADR-016-hybrid-retrieval-longmemeval.md`, `src/search/conversation-retrieval.ts`, `src/search/cross-encoder.ts` (V) | SHIPPING in agentdb 3.2+ | the pattern to copy for a rerank stage |

## C. Vector indexes and compression

All numbers in this block are on synthetic vectors unless stated; none measures text relevance.

| Capability | What it does | Where | Maturity | Measured (as recorded upstream) | Could address |
|---|---|---|---|---|---|
| HNSW in RVF | Graph index, persisted | `rvf-index` | SHIPPING | recall@10 0.89 at ef=256 on random uniform 384-d (`index_path.rs:45-60`, R) | speed |
| RaBitQ (1-bit + re-score) | 56 B per vector at 384 dims, 104 B at 768; needs the f32 originals for re-scoring | `crates/ruvector-rabitq/src/lib.rs`, `index.rs:754`, `persist.rs` (R) | SHIPPING; `@ruvector/rabitq-wasm` 0.1.2 (npm) | 1-bit alone 8.1% recall@10; with x20 re-score 100% (clustered synthetic, 128-d, n=100k). Python re-measure: 0.636 at x20 on random Gaussian | RAM and speed; no disk saving because originals are kept |
| DiskANN / Vamana | SSD-friendly graph | `crates/ruvector-diskann/src/index.rs` | SHIPPING, `@ruvector/diskann` 0.1.4. **Search never reads the PQ codes (`index.rs:229-262`, R); the Node binding has no mmap load; build is non-deterministic (`graph.rs:159`, R)** | 0.998 recall@10 on 5,000 x 128-d | not needed at 1 M vectors; hurts ST |
| Turbo4 / TurboVec (2-4 bit Lloyd-Max) | Packed codes with direct scoring | `ruvector-turboquant`, `ruvector-turbovec` | Turbo4 in core; TurboVec RESEARCH | 4-bit 0.879 recall@10 on 5k x 256 random | footprint |
| Product quantization, IVF (RAIRS), SPANN, LSM-ANN, streaming PQ | Compressed or partitioned indexes | their crates | RESEARCH, Rust-only | e.g. residual PQ 0.678 at 10k x 128 | none now |
| Matryoshka funnel | Search on a prefix of the vector, re-score on the full vector | `crates/ruvector-matryoshka/src/lib.rs:69`; also `ruvector-core/.../matryoshka.rs` | RESEARCH; needs a model trained for prefix truncation | 0.947 on 3k x 128 synthetic; 0.17-0.26 on random Gaussian | footprint, only with an MRL-trained embedder |
| ACORN filtered HNSW | Evaluates a predicate inside the graph walk | `crates/ruvector-acorn/src/index.rs:6-18` | RESEARCH; `@ruvector/acorn-wasm` 0.1.1 on npm; no persistence | 24.7% recall at 50% selectivity; 97.6% at 1% but slower than brute force | none now |
| Adaptive, entropy, speculative, recall-bounded, coherence-gated beam search; HNSW repair | Search-time heuristics | their crates | RESEARCH, Rust-only | none on text | none now |
| Benchmarks in the tree | `ruvector-sota-bench` "MTEB" runner uses synthetic topic vectors, not a model (`runners/mteb.rs:14-16`, `:118`, V); two bins are stubs; `bench_results` recall and memory fields are hard-coded (R) | - | - | - | tells us rUv has not measured text relevance inside RuVector |

## D. Retrieval-pipeline crates

| Capability | What it does | Where | Maturity | Could address |
|---|---|---|---|---|
| Multi-vector MaxSim (late interaction) | Scores a query's token vectors against a document's token vectors | `crates/ruvector-maxsim` (R); `ruvector-core/src/advanced_features/multi_vector.rs:85-216` (V for API) | RESEARCH / RUST-ONLY. **No token-embedding model ships; the caller must supply vectors.** Raw f32 storage, no compression. Best number is 0.797 recall against its own exact scorer on synthetic data | AM as a re-ranker, if a token model and a binding are added |
| Cluster-RAG | Two-level k-means with centroid routing. **Not RAPTOR: no summaries, no text, no LLM** | `crates/ruvector-cluster-rag/src/cluster.rs:21`, `tree.rs:11` (R) | RESEARCH | none |
| Bounded-RAG (min-cut), diverse beam, MMR, GNN re-rank, query cache, temporal coherence, namespace merge, memory admission, agent memory | Research operators on vectors | their crates | RESEARCH, Rust-only, synthetic numbers; MMR lowers recall in rUv's own run (0.779 against 0.816) | none measured on text. Query cache has no index-version invalidation: a ST risk |
| GraphRAG in `ruvector-core` | Entity graph, community detection, local / global / hybrid search | `advanced_features/graph_rag.rs:129-452` (V for API) | RUST-ONLY, unwired; entities and relations must be supplied | XR, if bound and fed the lead's edges |
| GraphRAG in `ruvector-graph` | - | `rag_integration.rs`, `semantic_search.rs:81-130` (R) | STUB (documents are `"Document {id}"`, dummy 0.85 scores) | - |
| Conformal prediction | Calibrates a threshold so a result set has a stated coverage; `adaptive_top_k` | `ruvector-core/src/advanced_features/conformal_prediction.rs:68-291` (V for API) | RUST-ONLY, unwired | AB: a principled "not sure" signal, if bound |
| Retrieval receipts | Hashes query-embedding bytes, index root, id, rank, score; optional Ed25519 signature | `crates/ruvector-retrieval-receipt/src/receipt.rs:29-72` (R) | RESEARCH, Rust-only. Binds passage text only if the writer put its hash in the write metadata; says itself it does not defend against a dishonest engine | citations with proof, later |
| REFRAG example | Compress / sense / expand | `examples/refrag-pipeline` (R) | simulated (random data, untrained policy) | none |
| pi.ruv.io brain server (rUv's own production knowledge search) | Linear scan; 128-d **hash** embeddings re-conditioned on neighbours; hand-built keyword score (title 6, tag 4, category 3, content 1); personalised PageRank; votes. When any keyword matches: `1.0 + 0.85 kw + 0.05 cos + 0.04 graph + 0.03 rep + 0.03 vote` | `crates/mcp-brain-server/src/routes.rs:2044-2056`, `src/embeddings.rs:1-26` (V) | SHIPPING as a service | evidence of how rUv himself ranks: a keyword hit always outranks an embedding-only hit |

## E. Graphs, relations, hierarchy, coherence

| Capability | What it does | Where | Maturity | Could address |
|---|---|---|---|---|
| Property graph + hyperedges, persisted | Real store (redb) | `ruvector-graph/src/graph.rs`, `hyperedge.rs`, `storage.rs` (R) | SHIPPING core; `@ruvector/graph-node` 2.1.4 | holds the lead's 2,066 + 689 edges |
| Cypher | Parsed; executed only in the bindings. Node: single-pattern MATCH + WHERE; aggregation, ORDER and LIMIT parsed but not applied. WASM adds OPTIONAL MATCH, CREATE, aggregates, ORDER/SKIP/LIMIT; no variable-length paths | `ruvector-graph/src/executor/mod.rs:127-133`, `ruvector-graph-node/src/cypher_exec.rs` (R) | partial | XR by explicit lookup, not by ranking |
| rvlite (SQL, SPARQL, Cypher in WASM) | Small embedded database | `crates/rvlite`; npm `rvlite` 0.2.8 | SHIPPING; SPARQL subset not read | small typed-edge queries |
| Knowledge-graph embeddings (HolE, RotatE) | Trains on triples, ranks the missing tail: `predict({s, r, k})` | `crates/ruvector-kge`; `@ruvector/kge` 0.2.1 (npm, checked live) | SHIPPING. Receipt: test MRR 0.4995, Hits@10 0.795 on a 493-entity FB15k-237 subgraph, 64 dims, 15 epochs (`npm/packages/kge/bench/results/fb15k237-500-hole-2026-09-21.json`, V). No text-embedding initialisation in the Node API | AM "which tool" as link prediction; XR. Untested on this corpus |
| Personalised PageRank | Power iteration over a CSR graph with a seed vector | `crates/ruvector-solver-node/src/lib.rs:806-935` (V) | real code, but `@ruvector/solver` is **not on npm** (checked live) | XR, if published; the lead's one-hop expansion showed no gain |
| Hyperbolic HNSW | Indexes vectors that are already hyperbolic; on insert it clips to the ball. No assembled trainer for a hierarchy, but the optimizer for one exists elsewhere (see section G, which corrects this row) | `crates/ruvector-hyperbolic-hnsw/src/poincare.rs:173-431`, `hnsw.rs:240` (V for functions) | RESEARCH, WASM crate, not on npm. ruflo's `embeddings_hyperbolic` is an exponential map at the origin and its own note says it "does not encode hierarchy" (ruflo `embeddings-tools.ts:195-197`, R) | AM, XR through the ontology hierarchy (strategy U2) |
| GNN layer on the HNSW graph | GAT + GRU forward pass with random weights; **no weight-update path** (`graphmae.rs:410`, `cold_tier.rs:497-505`, R). `differentiableSearch` = softmax over cosine | `crates/ruvector-gnn`; `@ruvector/gnn` 0.1.28 | forward SHIPPING, learning STUB | none |
| Attention mechanisms (18+) | Forward operators | `crates/ruvector-attention`; `@ruvector/attention` 2.3.1 | SHIPPING as math; nothing trained for relevance | none without training |
| Optimal transport (Sinkhorn) | Real set-to-set distance | `crates/ruvector-math/src/.../sinkhorn.rs:124`, `:285` (R); `@ruvector/math-wasm` 2.2.2 | SHIPPING as math | an alternative token-set distance for re-ranking; untested |
| prime-radiant coherence / "hallucination" gate | Energy = weighted squared distance between embeddings of context, response and support. **Factual and citation scores are placeholders fixed at 1.0** (`ruvllm_integration/gate.rs:150-152`, `:309`, V). A close but contradicting claim passes | `crates/prime-radiant` | RESEARCH, not on npm, synthetic tests only | FC: not usable as it stands |
| Min-cut and coherence gates (cognitum gate, mcp-gate) | Graph-cut based permit / defer / deny | their crates; `@ruvector/mincut-wasm` 2.3.1 | SHIPPING as math; the decision ignores content (R, inferred) | none for answers |

## F. Embedders and learning (detail in `02-NATIVE-EMBEDDING-OPTIONS.md`)

| Capability | What it does | Where | Maturity | Could address |
|---|---|---|---|---|
| ONNX embedder in npm `ruvector` | Runs a stock model in WASM; default all-MiniLM-L6-v2, 384 dims, fp32, **mean pooling hard-coded for every model** (`src/core/onnx-embedder.ts:142`, `:320`, V); int8 does not load (`:693-699`, V) | `npm/packages/ruvector` 0.3.27 | SHIPPING | not for BGE models (they need CLS pooling) |
| Hash embedding fallbacks | Word-hash vectors used when no model is loaded | ruvector-core `embeddings.rs:722`; `ruvector hooks` default; pi-brain; ruvllm; agentdb; ruflo (R) | SHIPPING and the silent default in several places | a known trap (ruflo ADR-086) |
| RLM recursive embedder | Training-free: embed, fetch 5 neighbours, blend 0.6 base + 0.3 neighbours - 0.1 anti-cluster, repeat. Query-conditioned and corpus-conditioned variants | `crates/ruvllm/src/bitnet/rlm_embedder.rs:1-170` (V) | RUST-ONLY; used in production only over the hash embedder | AM: embedding-space feedback; untested on real text |
| SONA MicroLoRA | Rank 1-2 residual adapter on a vector, updated from rewarded trajectories | `crates/sona/src/lora.rs:60-245`, `loops/instant.rs:32-35` (V); `@ruvector/sona` 0.1.13 | SHIPPING. Node API has no direct gradient, no save or load (`index.d.ts`, V). **Probe run here on synthetic data: after 12,000 rewarded trajectories the adapter moved the mean cosine to the target by 0.0001 to 0.002** (`probes/sona-probe-output.txt`) | AM in principle; nothing measured supports it |
| AdaptiveEmbedder (npm `ruvector`) | JS rank-4 adapter + prototypes + episodic mixing over frozen MiniLM | `npm/packages/ruvector/src/core/adaptive-embedder.ts:807-932` (R) | SHIPPING but the same text embeds differently over time, falls back to hash silently, and has a divide-by-empty-buffer path | hurts ST |
| ReasoningBank | Stores patterns from past trajectories; ranks them by cosine + recency + confidence | agentic-flow `src/reasoningbank/core/retrieve.ts:61-79` (R); sona `reasoning_bank.rs:349` | SHIPPING; returns past patterns, not documents; no relevance measurement | none for document retrieval |
| typesafe typed decisions | `choice`, `score`, `noul` over sentence embeddings with an abstain mass and a receipt | `crates/ruvector-typesafe-core`; `@ruvector/typesafe` 0.2.0 (npm) | SHIPPING, but the published package uses the **hash test embedder**; real models need a source build (package README, V) | AM "which tool" as a classification with abstention; AB |
| OpenJev trainer | Fine-tunes bge-small in candle (supervised contrastive + class heads, sequences of 64 tokens), transplants weights into a pinned ONNX graph | `crates/ruvector-typesafe-train/src/loss.rs`, `configs/openjev-small-v0.toml` (V) | real pipeline, CPU or CUDA only; the model is **not published** (`npm/packages/typesafe/docs/adr/ADR-008-openjev-model.md:3-9`, V); no pair loader, no in-batch passage loss (R) | the nearest thing to a RuVector-native way to train an embedder |
| ruvllm contrastive trainers | - | `crates/ruvllm/src/training/contrastive.rs:345`, `:473-491` (V) | STUB ("dummy embeddings for demonstration"; simulated accuracy) | - |
| Models packed in an .rvf-named file (agentdb) | Ships an ONNX model beside the code; resolution order env, bundle, cache | agentdb `src/model/ModelCacheLoader.ts:1-15` (V); the file is a SQLite container (R) | SHIPPING in agentdb | install: a pattern for shipping a model with the corpus |

## G. Second pass on the unconventional pieces (leads from the coordinator, each read in source)

The first pass above asked the conventional question (is there a text embedder, a lexical index). This pass asks
what RuVector offers that a conventional vector database does not, and corrects one first-pass statement.

| Lead | What the source shows | Where | Maturity | Designed regime | Could address |
|---|---|---|---|---|---|
| **Schema-first typed graph with vectors bound to a node label** | `TypedGraph` wraps the graph store with a schema. A vector type is bound to a node label and property; `search_then_traverse` does a vector search over that label and walks a named edge type in one operation ("land on a node, traverse to its sources"). Exact scan by default, optional HNSW with exact re-score. `build_text_index` + `hybrid_search_text` add BM25 on a text property fused with the vector hit by reciprocal rank. 25 unit tests in the two files | `crates/ruvector-graph/src/typed_graph.rs:1-20`, `:135`, `:325`, `:384`, `:420`; `schema.rs` (V). Design: `docs/adr/ADR-253-helixdb-comparison-ruvector-improvements.md` | real Rust code with tests; **not bound to Node or WASM** (V by grep of `ruvector-graph-node`, `ruvector-graph-wasm`, `rvlite`, `npm/packages/graph-node`). Not compiled or run here | a typed graph of a few thousand to a few hundred thousand nodes where the query should hit one node type and return another | **AM, XR: this is the exact operator for "problem lands on a capability, traverse to its files"** |
| **Hyperbolic hierarchy embeddings** | ADR-002 (Accepted 2026-03-12) adopts the Poincare ball. Its WordNet table (Poincare 100 dims: mean rank 456, Hits@10 0.68, against Euclidean 100 dims: 1,287 and 0.42) carries no run artefact in the tree and names files (`crates/ruvector-core/src/hyperbolic/`) that do not exist (V). The pieces that do exist: Poincare distance, Mobius addition, exp and log maps (`crates/ruvector-hyperbolic-hnsw/src/poincare.rs:173-431`); a hyperbolic HNSW index; hyperbolic attention; and **a Riemannian Adam optimizer on the Poincare ball** (`crates/ruvector-graph-transformer/src/manifold.rs:668-790`, V) | as listed | math and index real; the optimizer takes a gradient the caller supplies, so a hierarchy trainer = that optimizer + a loss. **Correction: my first-pass row said "no trainer"; the optimizer exists, the assembled trainer does not.** Rust-only (the Node package exposes product-manifold distance and attention, not the optimizer) | a tree or near-tree of parent-child edges, 16-100 dimensions, scored by "is the true parent ranked first" | AM and XR through the ontology: general problem words sit near the root, specific tools near the rim |
| **Hierarchy-composed vectors in RVF** | The shipped example builds each child vector as its parent's vector plus a small step that shrinks with depth, stores name, depth and parent as metadata, and queries with a depth filter. It uses made-up vectors to stand in for Poincare embeddings | `examples/rvf/examples/hyperbolic_taxonomy.rs:27-52`, `:170-183` (V) | demonstration, but the pattern needs nothing beyond `@ruvector/rvf` | a known hierarchy | AM: lets a passage inherit the meaning of its package and capability; cheap to test |
| **Branchable stores** | agenticow: copy-on-write branches of a vector memory, about 0.5 ms and 162 bytes per branch (its README), exact read-through; RVF `branch()` / `freeze()` do the same inside one format | agenticow repo README; `rvf-node/src/lib.rs:888`, `:1126` (V) | SHIPPING (npm `agenticow`; ruflo exposes `agenticow_*` tools) | many cheap variants of one base | continuous update; a per-user learned layer over the shipped corpus; safe trial of a new layer |
| **Self-learning / GNN-refined index** | The GNN layer runs forward with random weights; no code updates them (`crates/ruvector-gnn/src/graphmae.rs:410`, `cold_tier.rs:497-505`, R). `ruvector-gnn-rerank` smooths scores over neighbours with fixed weights (RESEARCH). RuVector's README itself says reading memory does not change learned weights | as listed | learning not implemented | - | none today; "does not learn yet" is a statement about the code, not the idea |
| **Temporal tensor store** | Tiered quantisation of tensor frames over time | `crates/ruvector-temporal-tensor` (R) | SHIPPING for tensor frames; not a retrieval index | time series of dense tensors | none for this corpus; history is text and is served by the history store |
| **RuLake** | Federation and cache in front of vector backends, dense only, in RAM; hosted MCP | `crates/ruvector-rulake` (R) | experimental crate + hosted service | many backends, repeated queries | not for an offline laptop product |
| **Coherence / min-cut** | Min-cut is real math (`@ruvector/mincut-wasm`); the "hallucination gate" measures closeness, with placeholder factual and citation scores (section E) | section E | math SHIPPING; answer checking not implemented | graph partition | a designed-regime use exists: cut the candidate graph into clusters and serve one result per cluster (diversity across systems, XR) |
| **Learned routing** | Tiny Dancer (FastGRNN router), `@ruvector/router`, domain-expansion bandit, typesafe `choice` | their crates | SHIPPING as routers for agents and models; typesafe's published build uses a hash embedder | choosing one of N labelled options from a short text | AM "which tool" as a routing decision with an abstain option |

## What I could not verify

- No Rust crate was compiled or run (machine load 45-60). Maturity of Rust-only items rests on reading code.
- npm publish status was checked live for 39 package names; platform binaries inside them were not inspected.
- Whether the committed native binaries match the source at this commit.
- LongMemEval haystack size per question in agentdb's benchmark (a reader's reading of `run.mts`: about 1.8k chunks
  per question, not the full 850k). Not re-checked.
- RVF open time and memory on a 1 M-vector store: not measured anywhere, here or upstream.
- Crates not read at all: the robotics, trader, photonics, consciousness, kernel (`ruvix`, `rvm`), CNN, FPGA, Hailo
  cluster, TimesFM, thermal, sonic-ct and edge-auth families. They do not touch text retrieval by their manifests.
