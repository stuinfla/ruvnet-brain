# Retrieval capabilities survey, late 2026

Compiled 2026-11-17. Every row below comes from a page opened in this session on 2026-11-17 (the "read on"
date for every source is 2026-11-17). Each table cites sources by ID (S1, S2, ...); the numbered list under
each table gives the URL and the release or publication date. Numbers are copied as the source states them.
"Self-reported" means the number comes from the authors or vendor, not an independent run.

Scope reminder: offline on a laptop (Node via transformers.js / ONNX, or Rust), nightly rebuild in CI,
about 1.1 million passages, hardest users ask problem-only questions in everyday words.

Reading guide for sizes: "int8 17MB" means the int8 ONNX file in the hub repo is 17 MB. "No ONNX in repo"
means the hub file listing (S6) shows no .onnx file; a community conversion may exist but was not checked.
Release date is the hub repo creation date (S6) or the paper date, never the hub "last updated" date.

Runtime facts used throughout (S20, registry reads on 2026-11-17):
- transformers.js (npm @huggingface/transformers): 4.0.0 published 2026-03-30; latest 4.3.2; next
  4.4.0-next.0.
- fastembed (Rust crate, Qdrant): 7.7.1, updated 2026-11-16. Supports EmbeddingGemma, BGE-M3,
  SPLADE++ v1 and OpenSearch doc-v3-gte sparse (S19). No 2025-2026 reranker listed (S19).
- model2vec-rs (Rust, static embeddings): crate created 2025-05-15, 0.4.0 updated 2026-10-30.
- next-plaid (Rust, multi-vector index): crate created 2026-01-12, 1.8.5 updated 2026-10-10.
- seismic (Rust, learned-sparse index): crate created 2024-07-04, 0.2.1 updated 2025-03-05.

---

## 1. Text embedding models

| Candidate | What it is |
| --- | --- |
| EmbeddingGemma-300m | 303M general embedder, MRL 768 to 128 |
| mdbr-leaf-ir (LEAF) | 23M distilled IR embedder |
| granite-emb small-en-r2 | 47M ModernBERT embedder |
| granite-emb english-r2 | 149M ModernBERT embedder |
| gte-modernbert-base | 149M ModernBERT embedder |
| DenseOn (LightOn) | 149M ModernBERT dense model |
| jina-emb-v5-text-nano | 212M, 32k ctx, binary-quant robust |
| jina-emb-v5-text-small | 596M (Qwen3-0.6B base) |
| potion-code-16M-v2 | 16M static (no transformer) code model |
| potion-retrieval-32M | 32M static retrieval model |
| C2LLM-0.5B | 497M code embedder |
| jina-code-emb-0.5b | 494M code embedder |
| ReasonIR-8B | 8B reasoning-trained embedder |
| BGE-Reasoner-Embed 8B | 8B reasoning embedder (Qwen3 base) |
| Reason-Embed-4B | 4B reasoning embedder (ReasonEmbed) |
| inf-retriever-v1-pro | 7B dense retriever (Qwen2.5-7B) |
| MRE-T1 | 4B reasoning embedder |
| Qwen3-Embedding-0.6B | context only (family excluded) |

| Candidate | Released | Local size and runtime | Evidence on vague / reasoning queries | Src |
| --- | --- | --- | --- | --- |
| EmbeddingGemma-300m | 2025-09-04 | ONNX q4 197MB, q8 309MB | MTEB Code 68.76; no BRIGHT | 16,6,11 |
| mdbr-leaf-ir (LEAF) | 2025-09-16 | ONNX q8 23MB, fp32 91MB | BEIR #1 at size (self); no BRIGHT | 14,6 |
| granite-emb small-en-r2 | 2025-07-17 | 95MB; no ONNX in repo | MTEB Code 55.84 | 6,11 |
| granite-emb english-r2 | 2025-07-17 | 298MB; no ONNX in repo | MTEB Code 57.22 | 6,11 |
| gte-modernbert-base | 2025-01-20 | ONNX int8 150MB; tfjs tag | MTEB Code 71.66 | 6,11 |
| DenseOn (LightOn) | 2026-03-13 | 596MB; no ONNX in repo | BEIR-15 56.20 | 6,18 |
| jina-emb-v5-text-nano | 2026-02-17 | 495MB; no ONNX; NON-COMMERCIAL | BRIGHT none found | 15,6 |
| jina-emb-v5-text-small | 2026-02-17 | 1.37GB; no ONNX; NON-COMMERCIAL | BRIGHT none found | 15,6 |
| potion-code-16M-v2 | 2026-07-04 | 32MB; model2vec-rs (Rust) | Semble set 0.854 with BM25 (self) | 6,13 |
| potion-retrieval-32M | 2025-01-23 | ONNX 129MB; model2vec-rs | BRIGHT none found | 6 |
| C2LLM-0.5B | 2025-12-22 | 995MB; no ONNX in repo | MTEB Code 75.46 | 6,11 |
| jina-code-emb-0.5b | 2025-08-19 | 993MB; no ONNX; NON-COMMERCIAL | not checked | 6 |
| ReasonIR-8B | 2025-04-03 | 15GB; NON-COMMERCIAL | BRIGHT 24.38; 29.96 w/ GPT-4 query | 6,7 |
| BGE-Reasoner-Embed 8B | 2025-09-22 | 30GB repo; no ONNX | BRIGHT 38.1 | 1,3,6 |
| Reason-Embed-4B | 2025-10 | not checked | BRIGHT 36.9 (indep. run) | 2,3 |
| inf-retriever-v1-pro | 2025-11-12 | 14GB; no ONNX | BRIGHT-long R@1 30.5 (self) | 4,6 |
| MRE-T1 | 2026-04-01 | NO WEIGHTS in repo (README only) | BRIGHT 39.6 (self) | 49,6 |
| Qwen3-Embedding-0.6B | 2025-06-03 | 1.19GB; no ONNX in repo | MTEB Code 75.42 | 6,11 |

Notes for family 1:
- No embedder under 1B parameters has a confirmed BRIGHT score from a page opened here. The BRIGHT
  leaderboard (S1) lists no entry under 1B; the smallest named entries are 1.5B and 3B.
- MRE-T1 lists the BRIGHT dataset (xlangai/BRIGHT) as a training dataset in its hub metadata (S49); its
  BRIGHT number should be read as possibly in-domain.
- EmbeddingGemma query prompt is "task: search result | query: "; context 2K tokens; RAM under 200 MB
  when quantised (S16). It is gated under Gemma terms (S6).
- Top of the MTEB leaderboard today: not confirmed (see section d).

Sources: S1 brightbenchmark.github.io (leaderboard, latest entry 2026-11-10). S2 arxiv.org/html/2509.02558v2
(Sharifymoghaddam et al., 2026-06-01, SIGIR 2026). S3 arxiv.org/abs/2510.08252 (ReasonEmbed, 2025-10-09).
S4 yaoyichen.github.io/INF-X-Retriever/ (snapshot 2025-12-20). S6 huggingface.co/api/models/<id>?blobs=true
(hub metadata). S7 huggingface.co/lightonai/Reason-ModernColBERT (2025). S11 huggingface.co/lightonai/
LateOn-Code-edge (2026-02-05). S13 minish.ai/packages/semble/benchmarks/ (no date on page). S14 hf://papers/
2509.12539 (LEAF, 2025-09-16). S15 hf://papers/2602.15547 (jina-embeddings-v5-text, 2026-02-17).
S16 huggingface.co/blog/embeddinggemma (2025-09-04). S18 huggingface.co/lightonai/SlideOn (2026-10-12).
S49 huggingface.co/ForwardAILabs/MRE-T1 plus hub file listing (2026-04-01).

---

## 2. Late-interaction (multi-vector) and learned-sparse retrievers, and their indexes

| Candidate | What it is |
| --- | --- |
| Reason-ModernColBERT | 149M ColBERT on ReasonIR data |
| GTE-ModernColBERT-v1 | 149M general ColBERT |
| LateOn (LightOn) | 149M general ColBERT |
| LateOn-Code | 149M code ColBERT |
| LateOn-Code-edge | 17M code ColBERT |
| mxbai-edge-colbert-v0 17M | 17M ColBERT, long context |
| mxbai-edge-colbert-v0 32M | 32M ColBERT |
| SmallReason-ColBERT | 32M ColBERT for reasoning queries |
| OpenSearch doc-v3-gte | inference-free sparse, 137M doc side |
| OpenSearch doc-v3-distill | inference-free sparse, 67M doc side |
| granite-emb-30m-sparse | 30M SPLADE-style sparse |
| SlideOn (LightOn) | 174M sparse over 32,768 latents |
| SPLADE-v3 (context) | 2024 sparse baseline |

| Candidate | Released | Local size and runtime | Evidence on vague / reasoning queries | Src |
| --- | --- | --- | --- | --- |
| Reason-ModernColBERT | 2025-05-22 | ONNX 597MB; NON-COMMERCIAL | BRIGHT 22.62; 30.28 GPT-4 query | 6,7 |
| GTE-ModernColBERT-v1 | 2025-04-30 | ONNX int8 150MB | base of the above | 6 |
| LateOn (LightOn) | 2026-03-13 | ONNX int8 155MB | BEIR-15 57.22 | 6,18 |
| LateOn-Code | 2026-02-11 | ONNX int8 150MB | MTEB Code 74.12 (self) | 6,11 |
| LateOn-Code-edge | 2026-02-05 | ONNX int8 17MB; ColGREP default | MTEB Code 66.64; Semble 0.693 | 6,11,13 |
| mxbai-edge-colbert-v0 17M | 2025-10-13 | ONNX int8 17MB; 275MB RAM | BEIR 0.490; LongEmbed 0.847 | 6,9 |
| mxbai-edge-colbert-v0 32M | 2025-10-13 | ONNX int8 33MB; 366MB RAM | BEIR 0.521; LongEmbed 0.849 | 6,9 |
| SmallReason-ColBERT | 2026-08-29 | model licence not stated | BRIGHT 21.41 (vs 22.62) | 8 |
| OpenSearch doc-v3-gte | 2025-06-18 | 550MB; no ONNX; fastembed-rs | BEIR-13 54.6 | 6,17,19 |
| OpenSearch doc-v3-distill | 2025-03-28 | 268MB; no ONNX in repo | BEIR-13 51.7 | 6,17 |
| granite-emb-30m-sparse | 2025-02-17 | 61MB safetensors; no ONNX | BEIR-13 50.8 | 6,17 |
| SlideOn (LightOn) | 2026-10-12 | 697MB; no ONNX; needs PyTorch | BEIR-15 56.68 | 6,18 |
| SPLADE-v3 (context) | 2024-03-08 | NON-COMMERCIAL | BRIGHT 15.6 | 2,6 |

| Index library | What it is |
| --- | --- |
| NextPlaid + ColGREP | Rust PLAID engine, 2/4-bit PQ, mmap |
| MUVERA | multi-vector to single-vector FDE |
| Seismic | Rust inverted index for sparse vectors |

| Index library | Released | Local / offline | Evidence | Src |
| --- | --- | --- | --- | --- |
| NextPlaid + ColGREP | 2026-01-12 | CPU, Apache-2.0, ONNX encode | Semble set 0.846-0.859 (S10) | 10,20 |
| MUVERA | 2025-06-25 | C++ code in google/graph-mining | vs PLAID: ~10% recall up, ~90% less latency | 21 |
| Seismic | 2024-07-04 | crate 0.2.1 (2025-03-05) | not measured on reasoning sets | 20 |

Notes for family 2:
- Inference-free sparse models encode the query with a static lookup, so query cost is near zero, but
  query expansion is lost (S17). That matters for problem-only questions, which need expansion.
- ColGREP scores differ by source: 0.846 for LateOn-Code-edge in the NextPlaid README (S10) and 0.693 in
  the Semble benchmark (S13). Both use about 1,250 queries; S13 labels were generated by Claude Sonnet 4.6.
- No source opened here reports a multi-vector index size for 1.1 million passages.

Sources: S8 arxiv.org/abs/2609.29652 (2026-08-29). S9 mixedbread.com/blog/edge-v0 (2025; arXiv 2510.14880).
S10 github.com/lightonai/next-plaid (2026). S17 sbert.net/docs/sparse_encoder/pretrained_models.html.
S19 github.com/Anush008/fastembed-rs. S20 crates.io and npm registry API reads (2026-11-17).
S21 research.google/blog/muvera-making-multi-vector-retrieval-as-fast-as-single-vector-search/ (2025-06-25).

---

## 3. Re-rankers

| Candidate | What it is |
| --- | --- |
| gte-reranker-modernbert | 149M cross-encoder |
| mxbai-rerank-base-v2 | 0.5B RL-trained reranker |
| jina-reranker-v3 | 0.6B listwise reranker |
| Rank1-0.5B | reasoning-distilled reranker |
| Rank1-7B / 14B / 32B | same, larger |
| ReasonRank 7B / 32B | reasoning listwise reranker |
| ReasonRank 8B | same, Qwen3-8B base |
| gpt-oss-120b listwise | LLM listwise rerank (RankLLM) |
| DIVER-v3-GroupRank | group-wise reranker pipeline |
| Qwen3-Reranker-0.6B | context only |

| Candidate | Released | Local size and runtime | Evidence on vague / reasoning queries | Src |
| --- | --- | --- | --- | --- |
| gte-reranker-modernbert | 2025-01-20 | ONNX int8 151MB; tfjs tag | BRIGHT none found | 6 |
| mxbai-rerank-base-v2 | 2025-03-03 | 988MB; no ONNX in repo | BRIGHT not confirmed | 6 |
| jina-reranker-v3 | 2025-09-29 | 1.19GB; no ONNX; NON-COMMERCIAL | BEIR 61.94; BRIGHT none | 24,6 |
| Rank1-0.5B | 2025-02-25 | 1.26GB; no ONNX; MIT | BRIGHT ~ RankLLaMA-13B (13.7) | 22,6 |
| Rank1-7B / 14B / 32B | 2025-02-25 | 7B+ | BRIGHT 27.5 / 28.7 / 29.4 | 22 |
| ReasonRank 7B / 32B | 2025-08-09 | 7B+; MIT code | BRIGHT 40.8 (32B) | 1,23 |
| ReasonRank 8B | 2026-02-24 | 8B | BRIGHT not stated | 23 |
| gpt-oss-120b listwise | 2025-2026 | 120B | Diver 29.1 to 39.1; R-Em 36.9 to 40.3 | 2 |
| DIVER-v3-GroupRank | 2025-11-13 | not checked | BRIGHT 46.8 | 1,38 |
| Qwen3-Reranker-0.6B | 2025-05-29 | 1.19GB; no ONNX in repo | not checked | 6 |

Notes for family 3:
- All Rank1 runs rerank the top 100 from BM25 run on the query plus GPT-4o chain of thought, which scores
  26.5 on its own (S22). Rank1-7B to 32B add 1.0 to 2.9 points over that first stage; Rank1-0.5B and
  RankLLaMA (13.7 to 13.9) score below it. A small reranker can lower BRIGHT quality.
- Listwise reranking with a large LLM helps weak first stages most: SPLADE-v3 plus BM25 17.5 to 33.4 (S2).
- FreshStack (S47) found rerankers did not improve first-stage accuracy on 2 of its 5 topics.
- No reranker small enough for a laptop CPU has a confirmed BRIGHT number in the pages opened here.

Sources: S22 arxiv.org/abs/2502.18418 and /html/2502.18418v2 (Rank1, 2025-02-25, COLM 2025).
S23 github.com/8421BCD/ReasonRank. S24 arxiv.org/abs/2509.25085 (jina-reranker-v3, 2025-09-29).
S38 arxiv.org/abs/2508.07995 (DIVER, 2025-08-11, v5 2026-04-02). S47 arxiv.org/abs/2504.13128 (2025-04-17).

---

## 4. Index-time generation

| Method | What it is |
| --- | --- |
| Contextual retrieval | LLM writes 50-100 token context per chunk |
| + reranking | same plus reranker |
| NavTree | balanced segment tree, no summaries |
| LATTICE semantic tree | LLM walks a corpus tree at query time |
| Fact extraction + raw chunks | LLM facts at ingest kept beside chunks |
| RAPTOR (as baseline) | LLM summary tree |

| Method | Released | Local / offline cost | Evidence | Src |
| --- | --- | --- | --- | --- |
| Contextual retrieval | 2024-09-19 | one-time LLM pass at build | top-20 failures 5.7% to 2.9% (49%) | 25 |
| + reranking | 2024-09-19 | reranker at query time | 5.7% to 1.9% (67%) | 25 |
| NavTree | 2026-09-30 | zero LLM calls at index | ties best flat; beats RAPTOR | 35 |
| LATTICE semantic tree | 2025-10-15 | LLM per query (Gemini default) | BRIGHT 42.1 (S1); 46.7 / 49.1 | 1,34 |
| Fact extraction + raw chunks | 2026-09-21 | LLM at ingest | LongMemEval 86.5% vs 83.4% raw | 43 |
| RAPTOR (as baseline) | pre-2025 | LLM at index | GraphRAG-Bench row; see family 5 | 31 |

Notes for family 4:
- Contextual retrieval is from 2024, not new; it is listed because its numbers come from codebases among
  other corpora and it is the vendor-published method (S25). Cost stated: about $1.02 per million document
  tokens with prompt caching; 20 chunks returned beat 5 or 10 (S25).
- NavTree attributes most of a summary tree's gain to navigation and leaves-only output, not to the LLM
  summaries (S35); abstract gives no numbers.
- No 2025-2026 source opened here measures generated questions (doc2query successors), propositions or late
  chunking on non-expert or problem-only queries. See section d.

Sources: S25 anthropic.com/news/contextual-retrieval (2024-09-19). S31 arxiv.org/html/2506.05690v3.
S34 arxiv.org/abs/2510.13217 and github.com/nilesh2797/lattice (MIT). S35 arxiv.org/abs/2610.06902.
S43 redis.io/agent-memory-benchmark-report/ (2026-09-21, vendor-authored).

---

## 5. Graph-structured retrieval

| Candidate | What it is |
| --- | --- |
| HippoRAG 2 | passage graph + Personalized PageRank |
| LightRAG | entity graph, dual-level retrieval |
| LazyGraphRAG | NLP noun-phrase concept graph |
| MS GraphRAG | LLM-built entity graph + summaries |
| Mem0g (graph memory) | Mem0 with graph store |
| Zep / Graphiti | temporal knowledge graph memory |

| Candidate | Released | LLM at query time? | Evidence | Src |
| --- | --- | --- | --- | --- |
| HippoRAG 2 | 2025-02-20 | yes ("online use of an LLM") | +7% associative vs embedding | 30 |
| LightRAG | 2024-10 (EMNLP 25) | yes, keyword LLM step | GraphRAG-Bench below | 31,33 |
| LazyGraphRAG | 2024-11-25 | yes (relevance tests) | index cost = vector RAG | 32 |
| MS GraphRAG | pre-2025 | yes | GraphRAG-Bench below | 31 |
| Mem0g (graph memory) | 2025-04-28 | yes | ~2% over base Mem0 on LoCoMo | 41 |
| Zep / Graphiti | pre-2025 paper | yes | LongMemEval 71.2% (reported) | 43 |

GraphRAG-Bench (S31, ICLR 2026), Novel set, accuracy, GPT-4o-mini:

| Method | Fact retrieval | Complex reasoning | Summarise | Query prompt tokens |
|---|---|---|---|---|
| Vanilla RAG, no rerank | 58.76 | 41.35 | 50.08 | 879 |
| Vanilla RAG, rerank | 60.92 | 42.93 | 51.30 | not stated |
| HippoRAG 2 | 60.14 | 53.38 | 64.10 | 1,008 |
| LightRAG | 58.62 | 49.07 | 48.85 | 100,832 |
| MS-GraphRAG | 49.29 | 50.93 | 64.40 | 38,707 (local) |

Notes for family 5:
- The paper's conclusion (S31): plain RAG matches or beats GraphRAG on simple fact lookup; graph methods
  lead on complex reasoning and summarisation. HippoRAG 2 costs about the same prompt tokens as plain RAG.
- None of the graph systems opened here runs without an LLM at query time. LightRAG suggests
  Qwen3-30B-A3B as a minimum local extraction model and marks the keyword step as required (S33).
- LazyGraphRAG builds its index with no LLM (noun phrases plus graph statistics); open-source status is not
  stated on the page (S32).

Sources: S30 arxiv.org/abs/2502.14802 (ICML 2025). S32 microsoft.com/en-us/research/blog/lazygraphrag-
setting-a-new-standard-for-quality-and-cost/ (2024-11-25, note 2025-06-06). S33 github.com/HKUDS/LightRAG
(news to 2026-07, MIT). S41 arxiv.org/abs/2504.19413 (Mem0, 2025-04-28).

---

## 6. Query-side methods when the caller is already a language model

| Method | What it is |
| --- | --- |
| BM25 + LLM reasoning query | LLM writes reasoning, BM25 searches |
| Same on a 150M ColBERT | reasoning query into small ColBERT |
| ThinkQE | iterative thinking expansion + BM25 |
| Expandorini study | 13 expansion methods, 25 sets |
| INF-X-Retriever | 7B RL query aligner + 7B retriever |
| Mira pipeline | GRPO query rewriter + MRE-T1 |
| NeMo agentic retrieval | LLM agent iteratively refines dense |
| LATTICE | LLM navigates semantic tree |
| Deep-research agent | GPT-5 agent over fixed corpus |

| Method | Released | Cost / local | Evidence on vague / reasoning queries | Src |
| --- | --- | --- | --- | --- |
| BM25 + LLM reasoning query | 2024 | caller LLM only | BRIGHT 14.53 to 26.46 | 7 |
| Same on a 150M ColBERT | 2025 | caller LLM + 150M model | BRIGHT 22.62 to 30.28 | 7 |
| ThinkQE | 2025-06 | 6 calls to a 14B LLM | BRIGHT-SE 17.0 to 34.9 | 36 |
| Expandorini study | 2026-12 venue | 0.5B to 72B, API models | iterative methods win 21/25 sets | 37 |
| INF-X-Retriever | 2025-12-20 | two 7B models, no reranker | BRIGHT 63.4 | 1,4,6 |
| Mira pipeline | 2026-04-22 | weights not published | BRIGHT 66.9 (self) | 1,5,49 |
| NeMo agentic retrieval | 2026-03-13 | agent LLM not named | BRIGHT 50.9 | 1,40 |
| LATTICE | 2025-10-15 | LLM calls per query | BRIGHT 42.1 / 46.7 / 49.1 | 1,34 |
| Deep-research agent | 2025-08-08 | caller LLM | BM25 55.9% vs better retriever 70.1% | 39 |

Vendor guidance on search tools for agents (all read 2026-11-17):
- Anthropic, "Writing effective tools for agents" (2025-09-11, S26): return high-signal fields and resolve
  opaque IDs to names ("significantly improves Claude's precision in retrieval tasks"); offer a
  response_format of "concise" or "detailed"; paginate, filter or truncate with sensible defaults (Claude
  Code caps tool responses at 25,000 tokens by default); "even small refinements to tool descriptions can
  yield dramatic improvements"; build evaluations with held-out sets and track accuracy, calls and tokens.
- Anthropic, "Effective context engineering for AI agents" (2025-09-29, S27): just-in-time retrieval by
  reference; agentic exploration is slower than precomputed retrieval; a hybrid of some up-front retrieval
  plus autonomous exploration may work best; Claude Code uses CLAUDE.md up front plus glob and grep.
- OpenAI, "A practical guide to building agents" (S28, date not printed on the pages read): each tool should
  have a standardized definition; well-documented, tested, reusable tools; split across agents as tool count
  grows. OpenAI file-search guide (S29): semantic plus keyword search, max_num_results trades tokens for
  quality.

Notes for family 6:
- Of the BRIGHT top-10 entries whose method was read here (INF-X, Mira, NeMo, LATTICE, ReasonRank, DIVER),
  every one puts an LLM on the query side or uses an LLM reranker (S1, S4, S5, S23, S34, S38, S40).
- Larger rewriters do not always help: no meaningful average gain from Qwen2.5-32B to 72B; expansion can fall
  below BM25 on some sets (ArguAna, FiQA); a 0.5B rewriter lost 0.087 nDCG@10 in one setting (S37).
- Retriever quality still matters with a strong agent: BrowseComp-Plus GPT-5 rose from 55.9% to 70.1%
  accuracy with a stronger retriever and needed fewer search calls (S39).

Sources: S5 wanggz.github.io/mira-reasoning-retrieval. S26 anthropic.com/engineering/writing-tools-for-agents.
S27 anthropic.com/engineering/effective-context-engineering-for-ai-agents. S28 cdn.openai.com/business-guides-
and-resources/a-practical-guide-to-building-agents.pdf. S29 developers.openai.com/api/docs/guides/tools-file-
search. S36 arxiv.org/html/2506.09260v2 (ThinkQE). S37 cs.uwaterloo.ca/~jimmylin/publications/
Sadeghi_Lin_SIGIR-AP2026b.pdf (SIGIR-AP 2026, 2026-12-13). S39 arxiv.org/abs/2508.06600 (2025-08-08).
S40 github.com/NVIDIA/NeMo-Retriever/tree/main/retrieval-bench (Apache-2.0).

---

## 7. Retrieval that learns from use

| Candidate | What it is |
| --- | --- |
| TTT-Embed | learned vector added to frozen query embedding |
| Relevance prior (Parry) | offline query-independent doc prior, fused |
| ReasoningBank | memory of strategies from wins and losses |
| Mem0 | extracted long-term agent memory |
| Redis Remis + Instruct | raw chunks + LLM-extracted facts |
| Mastra Observational Mem. | observation log memory |
| RAG-mem k=20 baseline | plain retrieval memory |

| Candidate | Released | Needs retraining? | Evidence | Src |
| --- | --- | --- | --- | --- |
| TTT-Embed | 2026-08-12 | no; index unchanged | up to +8.36 nDCG@10, 15 MTEB tasks | 44 |
| Relevance prior (Parry) | 2026-07 SIGIR | no query-time model | up to +0.046 nDCG@10 (DL-2019) | 45 |
| ReasoningBank | 2025-09-29 | no weight update stated | "consistently outperforms" (abstract) | 42 |
| Mem0 | 2025-04-28 | no | +26% LLM-judge vs OpenAI (LoCoMo) | 41 |
| Redis Remis + Instruct | 2026-09-21 | no | LongMemEval 86.5% (gpt-4o, repro) | 43 |
| Mastra Observational Mem. | 2026 | no | LongMemEval 84.2% (repro) | 43 |
| RAG-mem k=20 baseline | 2026-09-21 | no | LongMemEval 61.5% (repro) | 43 |

Notes for family 7:
- TTT-Embed's feedback comes from a reranker or LLM judge, not from users (S44). The Parry prior is learned
  offline from model scores, not from logs (S45).
- No 2025-2026 source opened here shows retrieval gains learned from real user or caller outcome logs
  without retraining a model. See section d.
- Redis found published memory-system numbers differed from its reproductions by +3 to -28 points (S43).

Sources: S42 arxiv.org/abs/2509.25140 (ICLR 2026). S44 arxiv.org/abs/2608.12569. S45 eprints.gla.ac.uk/
383302/ (SIGIR '26, 2026-07-20 to 24).

---

## 8. Evaluation practice

| Benchmark | What it tests |
| --- | --- |
| BRIGHT (12 short sets) | reasoning-intensive retrieval |
| BRIGHT, retriever only | no LLM in loop |
| NanoBRIGHT | 2,245-query BRIGHT subset |
| TREC ToT 2025 | vague tip-of-the-tongue queries |
| FreshStack | Stack Overflow + GitHub docs |
| BrowseComp-Plus | agent over fixed corpus |
| MTEB Code v1 | code retrieval incl. CoIR parts |
| Semble code set | 1,251 LLM-made code queries |
| GraphRAG-Bench | graph vs vector RAG |
| LongMemEval | agent memory |

| Benchmark | Released | Best published number | Plain baseline | Src |
| --- | --- | --- | --- | --- |
| BRIGHT (12 short sets) | ICLR 2025 | 63.4 open (INF-X); 69.4 undisclosed | BM25 14.5 | 1 |
| BRIGHT, retriever only | 2025-2026 | 36.9 indep.; 38.1 self (8B) | BGE 13.8 | 2,3 |
| NanoBRIGHT | not dated | profile table only | BM25 per task | 48 |
| TREC ToT 2025 | 2026-01-28 | nDCG@10 0.6576; R@1000 0.9051 | BM25 0.1223 | 46 |
| FreshStack | 2025-04-17 | below oracle on all 5 topics | not checked | 47 |
| BrowseComp-Plus | 2025-08-08 | GPT-5 70.1% | GPT-5 + BM25 55.9% | 39 |
| MTEB Code v1 | 2025-2026 | 75.46 (C2LLM-0.5B, in table) | not checked | 11 |
| Semble code set | not dated | 0.854 (semble) | ripgrep 0.126 | 13 |
| GraphRAG-Bench | ICLR 2026 | see family 5 | vanilla RAG | 31 |
| LongMemEval | ICLR 2025 | 86.5% reproduced | RAG k=20 61.5% | 43 |

Sources: S46 arxiv.org/html/2601.20671v1 (2026-01-28). S48 hakari-bench-leaderboard.hf.space/docs/
benchmark-tasks/NanoBRIGHT.

---

## (b) What did not exist, or was not usable locally, at the end of 2024

Each item is new in 2025 or 2026; dates are hub creation or paper dates.

- Reasoning-trained retrievers: ReasonIR-8B (2025-04-03), Reason-ModernColBERT 149M (2025-05-22),
  BGE-Reasoner-Embed (2025-09-22), ReasonEmbed / Reason-Embed-4B (2025-10-09), inf-retriever-v1-pro and
  inf-query-aligner (2025-11-12), MRE-T1 (2026-04-01, no weights), SmallReason-ColBERT 32M (2026-08-29).
- Small local embedders with ONNX: EmbeddingGemma-300m (2025-09-04, ONNX q4 197MB), mdbr-leaf-ir 23M
  (2025-09-16, ONNX q8 23MB), granite r2 (2025-07-17, no ONNX in repo), gte-modernbert-base (2025-01-20).
- Static code embeddings for Rust or Node with no transformer at query time: potion-code-16M-v2 (2026-07-04)
  and the model2vec-rs crate (2025-05-15).
- Small ColBERT models with ONNX int8 and a Rust CPU engine: mxbai-edge-colbert-v0 17M/32M (2025-10-13),
  LateOn-Code-edge 17M (2026-02-05), LateOn-Code (2026-02-11), LateOn (2026-03-13), NextPlaid / ColGREP
  (crate 2026-01-12).
- MUVERA multi-vector to single-vector encoding (2025-06-25).
- Inference-free learned sparse with near-zero query cost: OpenSearch doc-v3-distill (2025-03-28) and
  doc-v3-gte (2025-06-18), the latter supported in fastembed-rs; SlideOn (2026-10-12, PyTorch only).
- Reasoning rerankers: Rank1 (2025-02-25), ReasonRank (2025-08-09; 8B 2026-02-24), jina-reranker-v3
  (2025-09-29), DIVER-v3-GroupRank (2025-11-13).
- LLM query rewriters trained for retrieval: inf-query-aligner (2025-11-12); ThinkQE (2025-06).
- LLM-navigated and LLM-free trees: LATTICE (2025-10-15), NavTree (2026-09-30).
- Graph retrieval: HippoRAG 2 (2025-02-20); GraphRAG-Bench analysis (2025-06, ICLR 2026).
- Learning from feedback without retraining: TTT-Embed (2026-08-12), ReasoningBank (2025-09-29), Mem0
  (2025-04-28), Parry relevance prior (SIGIR 2026).
- Vendor tool-design guidance: Anthropic tools (2025-09-11) and context engineering (2025-09-29).
- Evaluation: BrowseComp-Plus (2025-08-08), FreshStack (2025-04-17), TREC ToT 2025 general-domain track
  (overview 2026-01-28), Expandorini cost-controlled expansion study (SIGIR-AP 2026).
- Runtime: transformers.js 4.x (4.0.0 on 2026-03-30).

Pre-2025 items that appear above only as context: contextual retrieval (2024-09-19), LazyGraphRAG
(2024-11-25), LightRAG (arXiv 2024-10), SPLADE-v3 (2024-03), Seismic crate (2024-07), CodeRankEmbed
(2024-11-03), BM25 with GPT-4 reasoning on BRIGHT (2024).

---

## (c) What the public evidence says about vague, problem-only queries

BRIGHT is the closest public test: real StackExchange, coding and math questions whose relevant documents
share little vocabulary with the question. Scores are nDCG@10 averaged over 12 sets unless noted. BM25
appears as 14.5 (S1), 14.53 (S7) and 14.8 (S2, S22) depending on the run; ThinkQE numbers cover only the
StackExchange sets and are not comparable to 12-set averages.

By kind of method, best number found on an opened page:

| Method kind | Best published BRIGHT nDCG@10 | Size at query time | Src |
|---|---|---|---|
| Keyword only (BM25) | 14.5 to 14.8 | none | 1,2 |
| General dense embedders, no LLM | 13.7 to 22.5 | up to 7B+ | 7 |
| Small reasoning ColBERT, no LLM | 22.62 (149M); 21.41 (32M) | 149M / 32M | 7,8 |
| Reasoning embedder, no LLM | 36.9 (indep.); 38.1 (self) | 4B / 8B | 2,3 |
| BM25 + LLM reasoning query | 26.46 | caller LLM | 7 |
| Small ColBERT + LLM reasoning query | 30.28 | caller LLM + 149M | 7 |
| Reasoning embedder + LLM listwise rerank | 40.3 | 4B + 120B | 2 |
| LLM-walked tree (LATTICE) | 42.1 board; 46.7 / 49.1 paper | LLM per query | 1,34 |
| Agentic dense retrieval (NeMo) | 50.9 | agent LLM | 1 |
| Trained 7B query rewriter + 7B retriever | 63.4 | 2 x 7B | 1,4 |
| Rewriter + retriever (Mira, no weights) | 66.9 (self) | 2 x 4B | 1,5 |
| Undisclosed (GRAIL, 2026-11-10) | 69.4 | method not confirmed | 1 |

What this means in plain terms:
- Without a language model touching the query, the best confirmed retrievers reach about 37 to 38 nDCG@10,
  and they are 4B to 8B models. The best small model (149M) reaches 22.6, which equals a 2024 7B embedder.
- Letting a language model rewrite or reason about the query is the largest single lever in every source:
  +12 points on BM25 and +7.7 on a 150M ColBERT with the same GPT-4 reasoning text (S7). In this product the
  caller is already such a model, so that lever costs no extra local compute.
- Every disclosed number above 50 uses a language model in the loop (agent or rewriter); GRAIL (69.4)
  does not disclose its method.
- Rerankers help strong pipelines only when they are large; small rerankers can fall below the first stage
  (S22), and rerankers did not help on 2 of 5 FreshStack topics (S47).
- Tip-of-the-tongue queries (people describing a thing they cannot name) are the nearest public match to
  "describes the problem, not the name": the best TREC ToT 2025 run reaches nDCG@10 0.658 and Recall@1000
  0.905, against BM25 at 0.122 and a dense baseline at 0.019 (S46). Its methods are not described in the
  overview text read here.

Against the product target: the product measures "right file in the top 5"; BRIGHT reports nDCG@10 and ToT
reports nDCG and recall, so the numbers are not directly comparable. No public benchmark opened here reports
any system near 98% on underspecified or reasoning-style queries; the strongest disclosed open system is at
63.4 nDCG@10 on BRIGHT, and the best ToT run finds the target in the top 1,000 for 90.5% of queries.

---

## (d) Not confirmed

Looked for and not confirmed from a page opened in this session; left out of the tables' evidence columns.

- Current top of the MTEB leaderboard (English, multilingual, retrieval): the leaderboard page did not render;
  only blog summaries were found.
- BRIGHT scores for any embedder under 1B other than the two ColBERT models (EmbeddingGemma, LEAF, granite
  r2, gte-modernbert, jina v5, potion): none found. Qwen3-Embedding-4B 16.3 seen only in a search snippet.
- BRIGHT scores for small rerankers (gte-reranker-modernbert, mxbai-rerank-v2, jina-reranker-v3).
- jina-reranker-v3 CoIR 70.64 (search snippet only; the abstract gives only BEIR 61.94).
- GRAIL (BRIGHT 69.4): method, model sizes and openness.
- NeMo agentic retrieval: which LLM and embedder produced 50.9.
- Whether MRE-T1 or inf-query-aligner trained on BRIGHT queries or corpora (MRE-T1 lists the dataset; the
  aligner card is silent).
- LongMemEval vendor claims seen only in search snippets: Exabase 96.4%, Mem0 94.4%, Mastra 94.87%.
- Absolute LoCoMo scores for Mem0, Mem0g, Zep (abstract gives only relative numbers).
- FreshStack per-model numbers (0.343 fusion, 0.365 Qwen3-8B, 0.541 oracle): seen in snippets only.
- 2025-2026 evidence that generated questions per passage, proposition indexing, or late chunking help
  non-expert queries: none found. Dense X, Atom-RAG, Psi-RAG, SVD-RAG and the late-chunking comparison
  (arXiv 2504.19754) were seen only in snippets.
- Li-LSR and Amazon inference-free sparse numbers: snippets only.
- fast-plaid release date and mutability: snippets only.
- OpenAI file search rewriting queries internally: stated in a snippet; the guide page read does not say so.
  OpenAI agents guide publication date: not printed on the pages read.
- EmbeddingGemma ONNX no-fp16 warning: snippet only.
- Retrieval gains learned from real user or caller outcome logs without retraining (2025-2026): none found.
- Index size and query latency of a multi-vector index at 1.1 million passages on a laptop: none found.
- Whether transformers.js 4.x runs the ModernBERT encoder and EmbeddingGemma: the hub repos carry the
  transformers.js tag (S6), but release notes confirming support were not opened.
- Mixedbread edge ColBERT licence (Apache-2.0 per hub tag) and BRIGHT score: blog states neither.
