Updated: 2026-11-17 00:42:00 EST | Version 1.0.0
Created: 2026-11-17 00:42:00 EST

# The embedding recipe: current, shipped (RuvNet Brain 4.7.28)

> **v5 will replace this recipe.** This page describes what 4.7.28 ships today. Section (f) is the proposal
> under test for v5. Nothing in section (f) is in force or decided.

This is the single page that says how the Brain turns knowledge into vectors and how a question finds it. It
was read from the code at git commit `0e7b9cfa` (release 4.7.28). Every value has a `file:line`. The block in
section (g) is checked against the code by `tests/unit/embedding-recipe-record.test.mjs` (ADR-109).

Words used on this page:
- **Embedding**: turning text into a list of numbers (a **vector**) so texts with similar meaning sit close
  together. The model that does it is the **embedder**.
- **Passage** or **chunk**: the piece of a file that gets one vector.
- **Store**: one searchable index. The Brain keeps one store per source repository.
- **Token**: the unit a model reads, about a short word or part of a word. The embedder reads at most 512.
- **Pooling**: how one vector is taken from the model's output. "CLS" means the vector of the model's first,
  summary position.
- **Quantized**: the model's own weights compressed to 8-bit numbers to make the file smaller. It is not about
  the stored vectors.
- **Reranker** (cross-encoder): a second, slower model that reads the question and one candidate together and
  scores the match.
- **Lexical** or **keyword** search (BM25): matching on the words themselves.
- **Lane**: one way of finding candidates (by meaning, by keyword, by exact name, by a hand-written card).
- **Gold file**: the file a question's author marked as holding the answer.

## (a) The recipe in ten lines

1. **Model:** `Xenova/bge-base-en-v1.5`, pinned to revision `4d6cd88e18e51a5e020c2c305726d76ada9c03cf`.
2. **Vector size:** 768 numbers per passage, stored at full precision, cosine distance.
3. **Pooling and weights:** CLS pooling, length-normalised; the model runs with 8-bit (quantized) weights.
4. **Text in:** the bare passage text. No title, no file path, no repository name is put in front of it.
5. **Questions:** get the prefix "Represent this sentence for searching relevant passages: " before embedding.
6. **Chunks:** up to 4,000 characters, cut at a paragraph break when one falls in the second half, with 400
   characters of overlap. The model reads only the first 512 tokens, so about half of all text is never seen.
7. **What is not embedded:** most source code (an ordinary source file contributes only its opening comment,
   or nothing), any folder named `v2`, commits, issues, pull requests, and any header text.
8. **Stored where:** one `<repo>.big.rvf` vector file per repository, beside `<repo>.passages.jsonl` (full text)
   and `<repo>.meta.json` (path, kind, title).
9. **A question flows:** hand-written cards may answer it with no search; otherwise a card-based router picks
   a few repositories or refuses; then meaning search, hand-tuned boosts and exact-name lanes, then the
   `Xenova/ms-marco-MiniLM-L-6-v2` reranker reads the first 3,000 characters of each candidate; results it
   scores below zero are dropped.
10. **Returned:** 6 documents by default, each shown to the model as its first 6,000 characters, with a
    confidence label.

## (b) Full tables

### Build side (what gets written)

| # | Choice | Value | Where (commit 0e7b9cfa) |
|---|---|---|---|
| 1 | Embedder | `Xenova/bge-base-en-v1.5` | `kb/forge-big.mjs:79`; `kb/forge-refresh.mjs:31`; `kb/model-requirements.mjs:5`; build fingerprint `kb/forge-corpus.mjs:7-10` |
| 2 | Pinned revision | `4d6cd88e18e51a5e020c2c305726d76ada9c03cf` | `kb/forge-big.mjs:85`; `kb/forge-refresh.mjs:32` |
| 3 | Vector size | 768, checked on every batch | `kb/forge-big.mjs:86`, check at `:304` |
| 4 | Weights | 8-bit (`quantized: true`); the cached file it needs is `onnx/model_quantized.onnx` | `kb/forge-big.mjs:121`; `kb/forge-refresh.mjs:195`; `kb/model-requirements.mjs:21` |
| 5 | Pooling | CLS, then normalised | `kb/forge-big.mjs:87`, `:127` |
| 6 | Passage prefix | none | comment `kb/forge-big.mjs:6`; the call `:302` |
| 7 | Question prefix | "Represent this sentence for searching relevant passages: " | `kb/forge-big.mjs:88`; written into `<repo>.big.rvf.embed.json` at `:429-434`; read by `kb/forge-ask.mjs:77-87`; applied at `:245` |
| 8 | Chunk size | 4,000 characters; a paragraph break in the second half ends the chunk early | `kb/forge-corpus.mjs:11`, `:53-68` |
| 9 | Overlap | 400 characters | `kb/forge-corpus.mjs:12`, `:65` |
| 10 | Chunker identity | `forge-corpus-v1` | `kb/forge-corpus.mjs:6` |
| 11 | Text embedded | the field `text` (the bare chunk). The chunker also makes `embedText` (title, a dash, the path, a line break, then the chunk) but the bge build does not use it | `embedText` made at `kb/forge-corpus.mjs:329`; build embeds `text` at `kb/forge-big.mjs:302`; nightly refresh embeds `text` at `kb/forge-refresh.mjs:202` |
| 12 | Batching | 32 passages per call, in corpus order | `kb/forge-big.mjs:299-302`; `kb/forge-refresh.mjs:199-203` |
| 13 | Documents (`.md`, `.txt`, `.rst`) | whole file, then chunked | `kb/forge-corpus.mjs:168-181` |
| 14 | Ordinary source files | only the comment lines in the first 30 lines; a file with none is skipped | `kb/forge-corpus.mjs:263-270` |
| 15 | Crate entry files (`lib.rs`, `main.rs`) | leading doc comment plus the first 100 lines | `kb/forge-corpus.mjs:253-262` |
| 16 | Full source bodies | only for folders named with `--full` at build time | `kb/forge-corpus.mjs:251-252` |
| 17 | Folders never read | `node_modules, target, .git, dist, build, .next, .cache, coverage, .venv, venv, __pycache__, .vite, vendor, v2` | `kb/forge-corpus.mjs:14-17` |
| 18 | Vector file | `<repo>.big.rvf`, cosine, only `dimensions` and `metric` passed (no vector compression) | `kb/forge-big.mjs:379-381` |
| 19 | Approximate index (HNSW) | required once a store has 1,024 or more vectors; smaller stores are scanned exactly | `kb/rvf-index.mjs:36-40` |
| 20 | Text beside the vectors | `<repo>.passages.jsonl` (id, text, path, title) and `<repo>.meta.json` | `kb/forge-refresh.mjs:158-186`; reader `kb/forge-ask.mjs:64-75` |
| 21 | Older small build | `Xenova/all-MiniLM-L6-v2` (384 numbers) is still readable as a fallback for a store with no `.big.rvf`; ADR-0004 says it is retired from the build | `kb/forge-ask.mjs:44`, `:77-80`; `docs/adr/0004-effectiveness-first.md:28-33` |

### Read side (what happens to a question, in order)

The path a real user takes is the MCP tool `search_ruvnet` in `kb/forge-mcp-all.mjs`.

| Step | What it does | Value | Where |
|---|---|---|---|
| A | Default number of documents | 6 | `kb/forge-mcp-all.mjs:279`, `:325` |
| B | Reviewed discovery answer | a small reviewed set can answer broad discovery questions with a pointer | `kb/forge-mcp-all.mjs:343-346` |
| C | Card lane, before any search | keyword overlap with `kb/capability-cards.md`; a confident card answers and no search runs. Confident = at least 2 shared content words, at least 34% of the question's content words, and 1 more shared word than the runner-up | call `kb/forge-mcp-all.mjs:381`; thresholds `kb/card-lane.mjs:337-339`; rule `:722-727` |
| D | Router, may refuse | search is called with `allowFullCorpus: false`; a router built on the cards picks a few repositories; if it cannot, no search runs | call `kb/forge-mcp-all.mjs:427-433`; refusal `kb/forge-ask-all.mjs:3610-3616`; card router `kb/card-lane.mjs:345` |
| E | Hand-written question shapes | functions that recognise particular wordings and force repositories (for example a cost-versus-quality detector) | first one at `kb/forge-ask-all.mjs:309` |
| F | Meaning lane per repository | at least 24 nearest chunks (or 4 times k); chunks collapsed to documents by path, a document scored by its best chunk | `kb/forge-ask.mjs:379`, `:866-875` |
| G | Hand tuning | boosts when question words appear in the path or title, intent classification, scoring with a forced-win constant | `kb/forge-ask.mjs:730-733`, `:828-830`, `:926-928` |
| H | Candidates per repository | 64 by default; 24 at least for the `concepts` store and transcript stores | `kb/forge-ask-all.mjs:3473`, `:3686-3690` |
| I | Exact-name lanes | package names and other exact-match candidates | starts `kb/forge-ask-all.mjs:3719-3721` |
| J | Keyword lane for repositories | exists, off unless `RUVNET_BRAIN_KEYWORD_LANE=1`, because its index is built at question time | `kb/keyword-lane.mjs:27-41`; gate `kb/forge-ask-all.mjs:3783-3785` |
| K | Keyword lane for transcripts | on for stores in `KB_TRANSCRIPT_STORES` (default `ruv-meetings`), top 40 | `kb/forge-ask-all.mjs:83-86`, `:3786-3791` |
| L | Document assembled per candidate | up to 12,000 characters | `kb/forge-ask.mjs:378` |
| M | Reranker | `Xenova/ms-marco-MiniLM-L-6-v2`, revision `a09144355adeed5f58c8ed011d209bf8ee5a1fec`, 8-bit weights, batches of 16 | `kb/model-requirements.mjs:8`; `kb/forge-rerank.mjs:69-76`, `:100`, `:153` |
| N | What the reranker reads | first 3,000 characters, then cut to 512 tokens | `kb/forge-rerank.mjs:133`, `:169`, `:143-147` |
| O | Reranker pool cap and cascade | cap 0 (off) for routed questions, 408 pairs for the full-corpus fallback; cascade off | `kb/forge-ask-all.mjs:2709`, `:2729`, `:2787-2788` |
| P | Boost when the question names the repository | +2.0 | `kb/forge-ask-all.mjs:2874` |
| Q | Pruning | after the first result, anything the reranker scores below 0 is dropped unless its repository was named | `kb/forge-ask-all.mjs:3076-3080` |
| R | Confidence label | top score 6.0 or more "strong", 4.0 or more "ok", 0 or more "thin", else "insufficient evidence" | `kb/forge-ask-all.mjs:3055`, `:3082-3086` |
| S | Learned judge | off unless `RUVNET_BRAIN_JUDGE=1` and a weights file exist | `kb/judge-rank.mjs:10-13`; `kb/forge-ask-all.mjs:3880` |
| T | Time limit | 20 seconds per query | `kb/query-deadline.mjs:37`, `:60-62` |
| U | Shown to the model | each document cut to its first 6,000 characters | `kb/forge-mcp-all.mjs:127-136`, `:459-462` |
| V | Repositories searched at once | 5 | `kb/forge-ask-all.mjs:3666` |

## (c) Known weaknesses, each measured

Source folder for every path below: `evals/runs/2026-11-16-knowledge-architecture/` (the run folder).

| Weakness | Measurement | Source |
|---|---|---|
| Chunks are longer than the model reads | 3,000-passage sample with the real tokenizer: median 985 tokens; 2,210 of 3,000 passages (73.7%) longer than 512 tokens; 1,290,111 of 2,577,677 tokens (50.0%) beyond position 512, so never embedded | `inventory/knowledge-type-census.json`, `task3_truncation` |
| No header in the embedded text | the build embeds `text`, not `embedText` | `kb/forge-big.mjs:302` |
| Source code is mostly not indexed | ordinary source files contribute only opening comments, or nothing | `kb/forge-corpus.mjs:263-270` |
| Whole folders are skipped | the `v2` entry drops every folder with that name, including current source trees (found 2026-07-10, still present) | `kb/forge-corpus.mjs:16`; `history/HISTORY.md` |
| The right file is rarely returned | gold file in the top 5: 4 of 113 development questions; 8 of 164 blind questions (set E). Counting everything returned, not only the top 5, set E is 9 of 164 | `DECISIONS.md` D3, D7; `SIDE-BY-SIDE.md` |
| The files are there | the gold file's path is in the shipped stores for 110 of 113 development questions | `DECISIONS.md` D3; `baseline-v1/gold-indexed.json` |
| The search often does not run | on set E: refused to search 19 times, "insufficient evidence" 90 times, one file only 120 times, of 164 | `DECISIONS.md` D7 |
| Same model, better chunks would help | same embedder, rebuilt chunks (at most 480 tokens, with a path header): gold in top 6 for 26 of 76 against 3 of 76 | `candidates/rig/rigA-rules.md` (R2) |
| The current vectors add nothing to keyword search on blind questions | set E: keyword 45 of 80, keyword plus current vectors 37 of 80; set F: 41 against 39 of 68 | `DECISIONS.md` D7, D10; `candidates/rigF/rigF-rules.md` (C3) |
| The reranker's zero line is wrong for newcomers | it scored the verbatim gold text below 0 for 32 of 35 newcomer questions whose gold was in the pool | `docs/adr/0099-self-learning-retrieval.md` |
| 8-bit model output depends on batch | re-embedding the same passages gave the same top five files for only 28 of 76 questions | `architecture/ARCHITECTURE.md` section 4 |
| Nightly receipts name the repository in the question | file in top 5 for 161 to 163 of 182 every night (one question per repository, the repository named), so they cannot see the problem-only case | `history/CURRENT-EMBEDDING-STRATEGY.md` section 4 |

## (d) Build command, where it runs, and its cost

- **Where:** in CI only, per `CONTRIBUTING.md` ("The knowledge corpus"). `.github/workflows/corpus-seed.yml`
  runs `scripts/corpus-reconcile.mjs`, which runs `kb/forge-refresh.mjs` for each changed repository
  (`scripts/corpus-reconcile.mjs:672`, `:737`). Publishing is `protected-release.yml mode=corpus`, dispatched
  nightly by `corpus-nightly-dispatch.yml`. Nothing on a developer machine publishes.
- **Local, for development only:** `node scripts/ingest-repo.mjs --name <repo>` makes a repository searchable
  on one machine (`CONTRIBUTING.md`). It never reaches users.
- **Footprint (4.7.28 corpus):** 218 stores and 187,117 passages (`DECISIONS.md` D3, measured on the installed
  copy). Bundle 906,562,749 bytes zipped, 1,494,277,626 unpacked, as read from the release receipt by
  `history/CURRENT-EMBEDDING-STRATEGY.md` section 5 (not re-measured for this page).
- **Model files (measured by the run's screen):** bge-base-en-v1.5 ONNX 110.1 MB at 8 bits, 435.8 MB at full
  precision (`candidates/rig/rigB-R1-final.md`). The reranker has 22 million parameters
  (`ruvector-deepdive/02-NATIVE-EMBEDDING-OPTIONS.md`, table 3).
- **Speed:** 5.18 passages per second for the incumbent model on the run's machine at load 8.13
  (`candidates/rig/rigB-R1-final.md`). A full embed of the pilot corpus takes 9 to 49 hours per model
  (`DECISIONS.md` D1, citing the pilot's RECIPE.md section 5). The time of the nightly CI build itself was not
  measured for this page.

## (e) Version table

Recipe versions R0 to R3 change the constants in section (g). Rows Q1 to Q8 change the path a question takes
under the recipe in force at that date; they are listed because they changed results, but they are not recipe
constants. Rows P1 and P2 were never shipped. Basis: MEASURED (numbers on a named set), ASSERTED (a stated
reason, no measurement), INHERITED (came with a template or default). Sources: `history/HISTORY.md` and
`history/VERSION-TABLE.md` in the run folder, which carry the original citations.

| Version | Date | What changed | Why | Decided by, basis | Evidence at the time | Why replaced, or what later contradicted it | Digest |
|---|---|---|---|---|---|---|---|
| R0 | 2026-06-13 | The `rvf-kb-forge` skill template: 4,000-character chunks, 400 overlap, MiniLM-384 small build, optional bge-base-768 big build (CLS, question prefix), 12,000-character documents | to have a reusable build | an agent porting earlier scripts; INHERITED | none; the skill says "NOT executed end-to-end" and rates itself 68 of 100 | became R1 unchanged | none |
| R1 | 2026-06-29 | First commit `1bcc60b8`: both builds for every repository; small build embeds title and path before the chunk, big build embeds the bare chunk; ms-marco reranker added; 8-bit weights; 6 results | owner directive "maximize for effectiveness" (ADR-0004) | owner directive plus agent; ASSERTED, small MEASURED | 12 questions on one repository: MiniLM 49.5 / 81.8, bge 31.6 / 68.0, marked "not comparable"; reranker +10 points | the promised benchmark of a code-aware embedder and bge-large was never run; the header difference was never recorded | none |
| R2 | 2026-07-07 | Model files pinned to exact revisions (`0a90a380`) | reproducibility | agent; ASSERTED | none needed | still in force inside R3 | none |
| R3 | 2026-07-28 | MiniLM build retired (`3760c32d`, no message); bge-base only, bare text; chunker named `forge-corpus-v1`; nightly refresh made incremental | non-duplication and download size (bundle 806 MB to 469 MB) | agent; ASSERTED | none on quality; the retired build was the only one that embedded a header | in force in 4.7.28; measured weak in November (section c) | 622e012e1dc0 |
| Q1 | 2026-07-20 | Results scored below 0 withheld; confidence label added (`2906422f`), under R2 | a user misread weak results | agent; MEASURED on six example queries | six queries | the zero line scores newcomer gold below 0 (32 of 35, 2026-10-01) | n/a |
| Q2 | 2026-07-27 | Card lane answers before any search (`2f9726d0`), under R2 | speed: search had reached 91 to 151 s | agent; MEASURED for speed | 19 of 19 capability questions, repository level; 0.07 ms against 19.6 s | rUv reported on 2026-07-28 that the Brain "manufactured things he had not built" from cards | n/a |
| Q3 | 2026-07-28 | Card-based router (`859a16de`) | speed | agent; ASSERTED | none recorded | see Q4 | n/a |
| Q4 | 2026-07-30 | Route or refuse: the product search stops searching every store (`453ae584`, no message); offline evaluation kept the old path | none recorded | agent; no reason recorded | none | 4.0.36 answered "Searched 0 RuvNet repos" for 45 of 80 questions in the run's bisect | n/a |
| Q5 | 2026-09-07 | Per-repository pool 8 to 64 (`c5eb2abc`, no message) | none recorded | agent; no reason recorded | none | a deeper pool (160) gained 0 on 2026-10-01 | n/a |
| Q6 | 2026-09-11 | Exact-token identifier lane; 20-second query limit | top-1 document wrong for 8 of 9 questions | agent; MEASURED | recall@10 0.9433 with, 0.9124 without, repository named, 194 questions | still in force | n/a |
| Q7 | 2026-10-01 | Keyword lane for repositories added, switched off; learned judge added, switched off (ADR-0099) | first newcomer test: gold in top 5 for 4 of 206 | owner and agent; MEASURED | keyword lane: 162 to 165 of 182, newcomer 4 to 10 of 206, +2.1 s | the index-at-build-time fix was never built | n/a |
| P1 | 2026-11-15 | Pilot, not shipped: same embedder, chunks of at most 480 tokens with a path header, real keyword index, summaries with newcomer questions | owner's 98% question | lead agent; MEASURED on development questions | gold in top 6: 3.5% to 53-66%; answers 82.6 of 100 | not blind; superseded by P2 | n/a |
| P2 | 2026-11-16 | Candidate, not shipped: keyword lane over rebuilt passages plus a history section | pre-registered rules | lead agent; MEASURED on blind sets | E: 78 of 164 against 8; answers 73.1 to 75.7 against 25.4 with no tool | open; see section (f) | n/a |

## (f) Proposed next recipe for v5 (NOT in force)

> **Nothing in this section is decided.** It is the proposal under test in the run folder (`REPLAN.md`,
> `ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md`). It becomes a recipe only when its pre-registered rules
> (`PREREGISTRATION.md`, amendments A5 to A10) are met on blind questions.

- **No RuVector-native embedding model for document retrieval exists.** Every text embedder in RuVector,
  ruvllm, ruflo and agentdb wraps another lab's model or uses a word hash (`ruvector-deepdive/02-NATIVE-EMBEDDING-OPTIONS.md`,
  "The answer in plain words", item 1). So the model cannot be "rUv's own" today.
- **What carries the vectors:** short cue sentences in everyday words and one-line capability definitions,
  not 480-token passages. The proposed model is `bge-small-en-v1.5` (384 numbers), which RuVector's core names
  "default, recommended for .rvf packs". It is chosen only if rule A5.3 picks it.
- **A graph walked by rUv's own operator:** Problem, then Capability, then Package, then File, plus Decision and
  Commit links. Vectors sit only on Problem and Capability nodes. The walk uses
  `TypedGraph::search_then_traverse` from RuVector. Rules A6.5 and A7.15.
- **Lanes kept:** the keyword lane over rebuilt passages and the history lane (both met their rules on blind
  sets: `DECISIONS.md` D10).
- **A reranker over found candidates**, never as a cut-off: `mixedbread-ai/mxbai-rerank-xsmall-v1`, rUv's best
  measured one. Rule A5.5; registered and being tested in reduced form as U6-lite, no result yet.
- **Sections, not one fused list:** capabilities with their standing, files, history.
- **Guidance stores, beside passages and cues** (amendment A10): playbooks (ordered steps for a goal, taken
  from quick-starts, guides and examples, each step with its source); how-the-author-decides notes (the 69
  reasoning habits found by the ontology traversal, `evals/runs/2026-11-16-knowledge-architecture/ontology/ontology-merged.json`; 58 of them carry two
  or more examples, 11 only one); and anti-patterns (corrections, negative results and known limits stored
  with the claims they overturn; 77 supersessions or contradictions found so far, same file). None of these has
  been measured as a guidance layer; rule A10.3 decides it.
- **Typed abstention:** "nothing in rUv's work matches that" as a scored answer. Rule A5.10.
- **What is unproven:** every item above on this corpus. Nothing measured supports a figure above 62% of
  answers at 8 of 10 or better (`REPLAN.md` section 4).

## (g) Machine-readable constants of the current shipped recipe

Read by `tests/unit/embedding-recipe-record.test.mjs`. Change a constant in code and this block, the digest,
a new version-table row and a `DECISIONS.md` entry must all change with it, or the test fails. This block
guards only these constants; it does not keep the line numbers or the prose above current.

```json recipe-constants
{
  "recipeVersion": "R3",
  "lastChanged": "2026-07-28",
  "digest": "622e012e1dc0",
  "constants": {
    "embeddingModel": { "value": "Xenova/bge-base-en-v1.5", "from": "kb/forge-big.mjs" },
    "embeddingRevision": { "value": "4d6cd88e18e51a5e020c2c305726d76ada9c03cf", "from": "kb/forge-big.mjs" },
    "dimensions": { "value": 768, "from": "kb/forge-big.mjs" },
    "pooling": { "value": "cls", "from": "kb/forge-big.mjs" },
    "quantized": { "value": true, "from": "kb/forge-big.mjs" },
    "queryPrefix": { "value": "Represent this sentence for searching relevant passages: ", "from": "kb/forge-big.mjs" },
    "embeddedTextField": { "value": "text", "from": "kb/forge-big.mjs" },
    "chunkChars": { "value": 4000, "from": "kb/forge-corpus.mjs" },
    "chunkOverlap": { "value": 400, "from": "kb/forge-corpus.mjs" },
    "chunkerId": { "value": "forge-corpus-v1", "from": "kb/forge-corpus.mjs" },
    "rerankerModel": { "value": "Xenova/ms-marco-MiniLM-L-6-v2", "from": "kb/model-requirements.mjs" },
    "rerankerRevision": { "value": "a09144355adeed5f58c8ed011d209bf8ee5a1fec", "from": "kb/forge-rerank.mjs" },
    "defaultK": { "value": 6, "from": "kb/forge-mcp-all.mjs" },
    "storeSuffix": { "value": ".big.rvf", "from": "kb/forge-big.mjs" }
  }
}
```

The test also reads the second and third places each constant is defined (the nightly refresh, the build
fingerprint, the reader's default) and fails if they disagree with each other.
