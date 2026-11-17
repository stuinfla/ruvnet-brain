Updated: 2026-11-17 01:00:28 EST | Version 1.0.0
Created: 2026-11-17 00:06:00 EST

# 5. What rips: things the Brain hand-rolls that rUv already ships (or already fixed)

The owner's rule: never hand-roll what rUv ships. Each row says what the Brain does today, what rUv ships
instead, the evidence, and how sure this is. "Rip" means replace after the usual gates, not delete tonight.

| # | In the Brain today | What rUv ships | Evidence | Confidence |
|---|---|---|---|---|
| 1 | Pinned `@ruvector/rvf` 0.3.4 and `rvf-node` 0.2.3 (`node_modules/@ruvector/*/package.json`), which rewrite the id sidecar on a read-only open (the lead's D11) | 0.4.12 / 0.4.7: `saveMappings()` returns early when read-only, with a test that the bytes are unchanged | `npm/packages/rvf/src/backend.ts:731` (read); npm registry checked 2026-11-16 | high: upgrade. Not run against the Brain's stores. The same upgrade brings per-vector metadata that survives close and reopen (ADR-280; `rvf-runtime/src/store.rs:1981`), which 0.3.4 does not have |
| 2 | Chunk-and-embed as the only shape of knowledge (`kb/forge-corpus.mjs`, `kb/forge-big.mjs`) | Knowledge stored by kind (ADR-056), and reconstruction over cue, tag, content (`examples/mragent`, README line 444) | `04-DESIGN-THE-RUV-WAY.md` | this is the design under test, not a proven swap |
| 3 | Hand-set retrieval weights and thresholds (lane weights, abstain threshold, router gates) | Evolve the harness on a training split with cross-validation and report held-out: `@metaharness/darwin` 0.14.0; the loop in `examples/mragent/optimize.mjs` | ran MRAgent in scratch: 14 of 14 tests, benchmark reproduced | high that the tool exists and runs; its benefit here is rule R21 |
| 4 | A fixed threshold deciding "insufficient evidence" (19 refusals and 90 flags of 164 on E) | Abstention scored by risk-adjusted utility, threshold on raw relevance, tuned on training only (ADR-270); typed decisions with an abstain mass (`@ruvector/typesafe`); conformal prediction (`ruvector-core`, Rust only) | ADR-270; MRAgent `harness.mjs:58-108` | medium: the scoring rule can be adopted now; the components need R20 |
| 5 | Cross-encoder `Xenova/ms-marco-MiniLM-L-6-v2` used as a gate (ADR-0099) | rUv uses a re-ranker as an added rank term `8 / (60 + rank)`, never a gate, and measured `mxbai-rerank-xsmall` ahead of the ms-marco model, which hurt on the vague-question slice | agentdb `docs/adrs/ADR-016-hybrid-retrieval-longmemeval.md`; `src/search/cross-encoder.ts` | medium: rule R11 |
| 6 | The Brain's own paired statistics and promotion bookkeeping for retrieval changes | Research gate: paired-bootstrap decision, hard vetoes, signed replay bundles (`crates/ruvector-sota-bench/harness/src/statistics.ts`, `vetoes.ts`; `scripts/research-gate/`); Dream Machine nightly verdict ledger (npm `dream-machine` 0.1.2) | read file lists and ADR-282 (status Proposed); not run | low to medium: look before building more; the lead's exact McNemar is fine as it stands |
| 7 | Nightly corpus rebuild by replacing stores | Branch, verify with a deterministic external check, promote or discard: `RvfDatabase.branch()` / `freeze()`; `agenticow` 0.3.1 | `rvf-node/src/lib.rs:888`, `:1126`; agenticow README | medium: fits ADR-0098's "exactly one copy" only if branches are cleaned on promote |
| 8 | Capability cards as flat documents | A typed graph with vectors bound to node labels (`ruvector-graph` `typed_graph.rs`, Rust only) or, from Node today, `@ruvector/core` + `@ruvector/graph-wasm` (`examples/npm-vector-graph`); code-entity graphs via ruflo `ruflo-knowledge-graph` | read; the typed graph has 25 unit tests | medium |
| 9 | Dependency and relation edges kept as JSON side files | `@ruvector/graph-node` / `graph-wasm` (Cypher), `@ruvector/kge` for link prediction, `@ruvnet/sublinear-core` for personalised PageRank | npm registry checked | medium |
| 10 | Any use of the `ruvector` npm embedder for BGE models | It hard-codes mean pooling for every model and cannot load 8-bit weights; BGE needs CLS pooling. Keep the Brain's transformers.js path for BGE | `npm/packages/ruvector/src/core/onnx-embedder.ts:142`, `:320`, `:693-699` | high (a "do not adopt" row) |
| 11 | The global instruction to store vectors with RVF compression options | RVF ignores `compression` and always writes f32 (`write_path.rs:120-141`, pilot `RECIPE.md` row 8); quantisation lives in separate components (RaBitQ in RAM, Turbo4 in core) | reader's reading + pilot | high: a documentation correction for the owner's notes |

## Things the Brain should keep, although RuVector has something with the same name

| Brain component | Why keep | Evidence |
|---|---|---|
| SQLite FTS5 lexical lane with rUv's Lucene analyzer | RVF has no text index (the MetaIdx segment is defined and unused); `ruvector-hybrid` is a two-lane in-memory proof of concept with no tokenizer; `ruvector-core`'s BM25 splits on whitespace and is unwired | `01-CAPABILITY-CATALOG.md` section B |
| The history store | nothing in RuVector ingests commits or issues; the temporal tensor store is for tensors | section G of the catalog |
| The mechanical citation check and the authority order | prime-radiant's answer gate has placeholder factual and citation scores | `crates/prime-radiant/src/ruvllm_integration/gate.rs:150-152`, `:309` |

## Defects worth reporting upstream (not mine to file)

- `search_ruvnet` routes any question containing the word "brain" to the ruvnet-brain repository, so rUv's pi
  brain cannot be asked about by name (logged in `BRAIN-QUESTION-LOG.md`, entry 0c).
- `search_ruvnet` answers of 70,000 to 90,000 characters at k = 8 exceed what a calling model can read.
- `@ruvector/typesafe` as published uses the hash test embedder.
- `@ruvector/sona` Node interface: no way to save or load an adapter, no supervised update.
- DiskANN: search ignores its PQ codes; build is unseeded.
- ADR-002 (hyperbolic) cites files that do not exist and a WordNet table with no run artefact.
