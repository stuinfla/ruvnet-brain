Updated: 2026-11-17 00:49:11 EST | Version 1.0.0
Created: 2026-11-16 23:47:56 EST

# 2. Embedding options: what is RuVector-native, what rUv uses, and what to add to the screen

## The answer in plain words

1. **There is no RuVector-native embedding model for finding documents.** Nothing in RuVector, ruvllm, ruflo,
   agentdb or agentic-flow was trained or fine-tuned by rUv for text retrieval. Every surface wraps a stock model
   from another lab, or falls back to a word-hash that is not a language model at all.
2. **What rUv's own code uses and recommends:** all-MiniLM-L6-v2 (384 numbers per passage) is the default almost
   everywhere. RuVector's core names bge-small-en-v1.5 as "default, recommended for `.rvf` packs". His best
   measured retrieval runs used bge-base-en-v1.5 (the Brain's current model) together with keyword search and a
   re-ranker.
3. **What rUv measured about embedders** (ruflo and agentdb, real public test sets): a bigger model gave no lift
   (bge-large 0.350 against bge-base 0.352); the recommended query prefix was a wash; keyword search beat vectors
   on two of the larger sets; on every set the best single addition was a re-ranker, and the best re-ranker was
   not the one the Brain tried.
4. **So the embedding model is not where RuVector's cleverness lies, and it is not the first decision.** The
   decision that matters more is *what gets embedded* (section 3 of this report). For the design recommended
   here, the vectors are short "need" sentences, a job for which a small 384-number model is the right size.
5. **The route to a model that is genuinely the Brain's own** exists in RuVector as a training pipeline, not as a
   model: rUv's OpenJev trainer fine-tunes bge-small and re-packs it for the same runtime. It needs one new piece
   (a loader for question-and-passage pairs). That is Recipe B.

## Table 1. Which embedder each rUv surface uses by default

| Surface | Default embedder | Dims | Evidence | Verified |
|---|---|---|---|---|
| npm `ruvector` (embed, intelligence engine) | all-MiniLM-L6-v2, WASM ONNX, fp32, mean pooling, downloaded on first use | 384 | `npm/packages/ruvector/src/core/onnx-embedder.ts:121`, `:142`, `:320` | V (pooling lines) |
| npm `ruvector hooks remember / recall / rag-context`, fresh store | word-hash unless `RUVECTOR_EMBEDDER=auto`, `RUVECTOR_ONNX=1` or `--semantic` | 64 / 256 | `npm/packages/ruvector/bin/cli.js:5317-5336` | R |
| `ruvector-core` (Rust), default build | hash placeholder; real models behind feature flags | - | `crates/ruvector-core/src/embeddings.rs:722` | R |
| `ruvector-core` with `lattice-embeddings` | **bge-small-en-v1.5, "default, recommended for `.rvf` packs"** | 384 | `crates/ruvector-core/src/embeddings.rs:1485` | V |
| pi.ruv.io brain (server and client) | 128-d hash of bytes and byte pairs, re-conditioned on neighbours | 128 | `crates/mcp-brain-server/src/embeddings.rs:1-26` | V |
| ruvllm | hash; a real sentence model is "future" | 64 / 128 | `crates/ruvllm/src/bitnet/rlm_embedder.rs:649`; ADR-074 | V (hash line) |
| ruvector-hailo, ruvector-postgres | all-MiniLM-L6-v2 | 384 | `crates/ruvector-hailo/src/lib.rs:160`; `ruvector-postgres/src/embeddings/models.rs:129` | R |
| `@ruvector/typesafe` 0.2.0 as published | hash test embedder; bge-small or MiniLM only from a source build | 384 | package README (installed copy) | V |
| ruflo memory | all-MiniLM-L6-v2 | 384 | ruflo `embedding-config.ts:27` | R |
| ruflo BEIR benchmarks | Xenova/bge-base-en-v1.5 (int8), bge-large as a test | 768 / 1024 | ruflo `v3/docs/adr/ADR-088-lucene-bm25-and-rerank.md`, `ADR-089` | V |
| agentdb | Xenova/all-MiniLM-L6-v2 | 384 | agentdb `docs/adrs/ADR-016-...md` (protocol section) | V |
| Owner's own `rvf-expert-kb` recipe | Xenova/bge-base-en-v1.5 fp32, CLS, query prefix | 768 | `~/.claude/skills/rvf-expert-kb/SKILL.md` | V |

## Table 2. What rUv measured about retrieval quality (real text)

| When | Corpus | Result as recorded | Source |
|---|---|---|---|
| 2026-05-30 | ruflo commit history, 385 items, 10 queries, MiniLM | cosine alone 0 of 10 right at rank 1; with keyword blend 50%; multi-field BM25 80% | ruflo ADR-078 (V), ADR-079 (R) |
| 2026-05-30 | BEIR NFCorpus (323 q), SciFact (300 q), bge-base int8 | dense 0.352 / 0.626; Lucene BM25 0.328 / 0.681; BM25 + dense (RRF) 0.360 / 0.632; **+ cross-encoder 0.358 / 0.683** | ruflo ADR-088 (V) |
| 2026-05-30 | same | fusing a weak BM25 with dense made it worse (mean 0.489 to 0.449) | ruflo ADR-087 (R) |
| 2026-05-30 | NFCorpus | bge-large int8 0.350 against bge-base 0.352: "no lift"; published full-precision bge-large is 0.380 | ruflo ADR-089 (V) |
| 2026-05-30 | 3 BEIR sets | bge query prefix: +0.0087, -0.0070, +0.0034: "not a free win" | ruflo ADR-090 (V) |
| 2026-05-30 | ArguAna | cross-encoder hurt (0.283 at 50 queries against 0.431) and was pulled | ruflo ADR-089 (V) |
| 2026-04/05 | LongMemEval via ruflo, MiniLM | right content at rank 1: 22.2% to 26.8%; rUv's note: "embedding model quality and chunking strategy are the primary levers" | ruflo ADR-088-longmemeval:189-208 (V) |
| 2026-10-31 | LongMemEval S and M (470 q), MiniLM | M: dense 0.630, BM25 0.702, hybrid 0.719, + ms-marco MiniLM-L-6 re-ranker 0.789, + mxbai-rerank-xsmall 0.791 (recall-all@5). S: 0.883 / 0.830 / 0.900 / 0.934 / **0.962** | agentdb ADR-016 (V) |
| 2026-10-31 | same, "preference" slice (n=30, the nearest thing to vague everyday questions) | ms-marco MiniLM re-ranker **lowered** nDCG@5 from 0.503 to 0.399; mxbai-rerank-xsmall raised it to 0.595 | agentdb results JSON (R) |

Two things follow. First, rUv's own data agree with the lead's: keyword first, and a vector lane only helps when
the keyword lane is strong and the fusion is right. Second, the Brain's earlier negative result on re-ranking
(ADR-0099: the ms-marco model scores true answers below zero for newcomer questions; pilot: flat on dev) is
about **one model**. rUv's later measurement found a different small re-ranker that helps exactly where that one
hurts. That is a candidate, not a result for this corpus.

## Table 3. Candidates compared

Sizes and licences were read from the Hugging Face hub on 2026-11-16 (API file listing and model cards).

| Model | Kind | Dims | Window | Licence | ONNX size (fp32 / 8-bit) | Who names it | Evidence on this corpus |
|---|---|---|---|---|---|---|---|
| Xenova/bge-base-en-v1.5 | passage embedder (incumbent) | 768 | 512 | MIT | 436 / 110 MB (lead's manifest) | ruflo BEIR runs; owner's recipe | dense lane weakest on D, E, F; adds nothing fused |
| Alibaba-NLP/gte-modernbert-base | passage embedder | 768 | 8,192 | Apache-2.0 | 596 / 150 MB | lead's screen | dev: dense 42 against 25 of 76; E and F pending |
| Snowflake arctic-embed-m-v1.5, nomic v1.5, jina v2 code, bge-large, embeddinggemma-2 | passage embedders | - | - | - | - | lead's screen | see `candidates/rig/rigB-R1-final.md` |
| **Xenova/all-MiniLM-L6-v2** | small symmetric embedder | 384 | 256 | Apache-2.0 | 90 / 23 MB | **rUv's default on eight surfaces** | not in the screen |
| **Xenova/bge-small-en-v1.5** | small embedder | 384 | 512 | MIT (BAAI card) | 133 / 34 MB | **ruvector-core "recommended for .rvf packs"; base of rUv's OpenJev fine-tune** | not in the screen |
| mixedbread-ai/mxbai-rerank-xsmall-v1 | re-ranker (reads question and passage together) | - | 512 | Apache-2.0 | 284 / 87 MB | **rUv's best measured re-ranker** (agentdb ADR-016) | not tested |
| Xenova/ms-marco-MiniLM-L-6-v2 | re-ranker | - | 512 | Apache-2.0 | 22 M parameters | agentdb and ruflo default | Brain: flat on dev; scores true newcomer answers below zero (ADR-0099) |
| Alibaba-NLP/gte-reranker-modernbert-base | re-ranker, long window | - | 8,192 | Apache-2.0 | 599 / 151 MB | none in rUv's stack | not tested; pairs with gte-modernbert if that wins |
| answerdotai/answerai-colbert-small-v1 | token-level embedder for MaxSim | 96 per token | 512 | Apache-2.0 | 133 / 34 MB | none (RuVector's MaxSim crate ships no model) | not tested |
| opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill | learned-sparse document expander; the query side needs no model, only a word-weight table (0.7 MB) | sparse | 512 | Apache-2.0 | 268 MB safetensors, build-time only | none | not tested |
| Brain-tuned bge-small (does not exist yet) | fine-tuned on generated question / passage pairs | 384 | 512 | MIT base | 133 / 34 MB | built with rUv's trainer pipeline | Recipe B |

Query-side adapters, for completeness:

| Adapter | RuVector-native? | State | Evidence |
|---|---|---|---|
| SONA MicroLoRA (`@ruvector/sona` 0.1.13) | yes | rank 1 by default, learning rate 0.001, gain capped at 1.0 (`crates/sona/src/lora.rs:13-20`, `loops/instant.rs:32-35`, V). Node API: trajectories only; no supervised gradient; no save or load | Probe here, synthetic 384-d data, 12,000 rewarded trajectories: mean cosine to target 0.6946 to 0.6947 (default) and 0.9624 to 0.9642 (rank 2, learning rate 0.1). `probes/sona-probe-output.txt`. This is a small probe on made-up data; it shows the adapter barely moves through this API, not that the idea is wrong |
| RLM query-conditioned embedding (ruvllm) | yes | Rust only; production use is over hash vectors | no text measurement anywhere |
| AdaptiveEmbedder (npm `ruvector`) | yes | time-varying output, silent hash fallback | no quality measurement; would worsen run-to-run stability |
| ruflo `ruvllm_sona_adapt`, `ruvllm_microlora_adapt` MCP tools | yes | instances live in a process-local map that no search path reads (ruflo `ruvllm-tools.ts:184-262`, R) | bookkeeping, not retrieval |

## What should be ADDED to the embedder screen, and how

Three additions, each for a stated reason. None may be scored before the lead amends the pre-registration.

1. **all-MiniLM-L6-v2 and bge-small-en-v1.5 as "rUv default" rows in the existing stage-1 pool screen.** Reason:
   the owner asked whether RuVector-native choices were considered; these are what rUv's code ships and
   recommends, and they are one third to one fifth the size. The existing rule R1 asks a challenger to beat the
   incumbent by 10 points; a smaller model only has to *not lose* to be worth adopting under ADR-0098, so they
   need a non-inferiority rule (A4.2 below).
2. **A second screen on a different task: the need index** (short generated newcomer questions and summaries
   pointing at a file section; see `03-NOVEL-STRATEGIES.md` S1). The models that win on 480-token passages are not
   necessarily the ones that win on sentence-to-sentence matching, and that is the task the amateur stratum needs.
3. **Re-rankers as their own screen** (mxbai-rerank-xsmall-v1, gte-reranker-modernbert-base, the ms-marco model as
   the control), judged as a rank contribution only, never as a gate that can refuse to answer.

### Proposed amendment text (A4), for the lead to adopt, edit or reject before any score exists

> **A4, proposed 2026-11-17 by the RuVector deep-dive researcher. Not in force until the lead hashes it.**
> Reason: the embedder screen (A1.2) lists general-purpose models from other labs only. A source traversal of
> RuVector, ruflo and agentdb (`ruvector-deepdive/`) found no rUv-trained retrieval embedder, but found the models
> rUv's own code defaults to and recommends, a re-ranker rUv measured as his best, and a storage pattern (many
> short need vectors per file section) the pilot measured as its only clear single gain. The researcher has not
> read any E or F question or gold, and no score exists for any item below.
>
> A4.1 Added to the stage-1 pool screen, same pools, same rig, same control: `Xenova/all-MiniLM-L6-v2` (mean
>      pooling, no prefix, 256-token window) and `Xenova/bge-small-en-v1.5` (CLS pooling, BGE query prefix,
>      512-token window). Weight precision as for the other rows.
> A4.2 Non-inferiority rule R1b, for any candidate whose stored vector is at most half the incumbent's bytes:
>      it replaces the incumbent if, on the pooled n = 224 and on the blind part n = 148 separately, its fused
>      any-gold@5 (both weightings) is not lower than the incumbent's by more than 3 points, and its dense
>      any-gold@5 is not lower by more than 5 points. R1 as written still decides whether any dense lane is
>      fused into the file ranking (A3.3 stands).
> A4.3 Need-index screen (rule R4b). Corpus: summaries and newcomer questions for every file section of the
>      stores that hold the file gold of E and F (full coverage of those stores, not a subset), generated by a
>      model that sees only the source, under the leak rule of A1.4 (8 consecutive shared words). Each summary and
>      each question is one vector that maps to its file. Candidates: the two models of A4.1, the incumbent, and
>      the best passage model from A3 if any. Metric: the file of the best-matching need vector, any-gold@5, on
>      amateur askers of E + F (n = 88) and on all of E + F. A model is adopted for the need index if it is the
>      smallest model within 3 points of the best on amateurs.
> A4.4 Need-index adoption (rule R4c), replacing R4's partial-coverage test: served result = first 5 files of
>      the lexical lane + first 5 files of the need index (duplicates collapsed). Control = the lexical lane
>      truncated to the same number of files. Adopted if any-gold exceeds the control by at least 10 points on
>      amateur askers of E + F, exact McNemar p < 0.05, with no stratum falling by 5 or more questions. Because
>      n = 88 amateurs can detect about +15 points but not +10, a fresh amateur-only set G (about 120
>      problem-only questions, authors and protocol as in A2.1, gold found without keyword search) is written
>      before the build, and the rule is judged on E + F + G amateurs pooled, with G reported alone.
> A4.5 Re-rank screen (rule R11). Input: the union of the first 60 passages of the lexical lane and the first 60
>      of the need index (or of the dense lane where no need index exists). The re-ranker contributes
>      `w / (60 + rank)` to a reciprocal-rank sum, `w` fixed at 8 (the constant agentdb ships), and is never used
>      as a threshold. Candidates fixed: `mixedbread-ai/mxbai-rerank-xsmall-v1`, `Alibaba-NLP/gte-reranker-modernbert-base`,
>      control `Xenova/ms-marco-MiniLM-L-6-v2`. Adopted if any-gold@5 rises by at least 5 points on E + F and by
>      at least 10 on amateurs, p < 0.05, and median added latency is at most 1.5 s on the reference machine at
>      load below 60.
> A4.6 Tuned embedder (rule R1c). A model fine-tuned on generated (question, passage) pairs is admitted to the
>      screens above only if its training pairs were generated from source alone, share no 8-word run with any
>      D, E, F or G question, and exclude the pairs of one held-out repository per stratum, on which it is also
>      reported. It is judged by R1 against its own base model.
> A4.7 Stability (rule R12), for every lane that is adopted: three runs in three separate processes return the
>      same first five files for at least 99% of questions. A lane that fails is not shipped whatever its score.
> A4.8 Multiplicity: the rules of A4 are one family; p-values are Holm-adjusted across the rules that are
>      actually run. The sealed exam2 set stays sealed.

## What I did not do

- No embedder or re-ranker was run on D, E or F. Every "not tested" above is literal.
- Model facts for the lead's existing screen rows were not re-checked; they are in the lead's manifest.
- I did not check whether `lattice-embed` (the pure-Rust runtime behind `bge-small` in ruvector-core) is rUv's
  crate or a third party's.
- Licences were read from hub tags; the Xenova mirror of bge-small states none, so the BAAI card (MIT) was used.
