Updated: 2026-11-17 12:21:10 a.m. EST | Version 1.0.0
Created: 2026-11-17 12:21:10 a.m. EST

# The embedding and search recipe as shipped in RuvNet Brain 4.7.28

Every line below was checked by reading the code in the worktree at release 4.7.28 (git 0e7b9cfa). Paths are
relative to the repository root; `file:line` points at the line that sets the value. Nothing here comes from a
document's description of the code. Words that need a gloss get one the first time they appear.

Glossary used throughout:
- **Embedding**: turning a piece of text into a list of numbers (a "vector") so that texts with similar meaning
  land close together. The model that does it is the **embedder**.
- **Passage / chunk**: the piece of a file that gets one vector.
- **Store**: one searchable index. The Brain has one store per source repository.
- **Reranker / cross-encoder**: a second, slower model that reads the question and a candidate text together
  and scores how well they match.
- **Lane**: one way of finding candidates (by meaning, by keyword, by exact name, by a hand-written card).

## 1. What gets written (the build side)

| # | Choice | Value in 4.7.28 | Where |
|---|---|---|---|
| 1 | Embedder | `Xenova/bge-base-en-v1.5`, pinned to Hugging Face revision `4d6cd88e18e51a5e020c2c305726d76ada9c03cf` | `kb/forge-big.mjs:79,85`; `kb/forge-refresh.mjs:30-35`; `kb/model-requirements.mjs:5` |
| 2 | Vector size | 768 numbers per passage | `kb/forge-big.mjs:86`, checked at `:304` |
| 3 | Model weights | the 8-bit ("quantized", q8) ONNX file, `quantized: true`. This is the model's own weights being compressed, not the stored vectors | `kb/forge-big.mjs:121`; `kb/forge-refresh.mjs:194-196`; the file it needs is `onnx/model_quantized.onnx`, `kb/model-requirements.mjs:21` |
| 4 | Pooling (how one vector is taken from the model's output) | CLS token, then length-normalised | `kb/forge-big.mjs:87,127` |
| 5 | Prefix on passages | none | `kb/forge-big.mjs:6,302` |
| 6 | Prefix on questions | `Represent this sentence for searching relevant passages: ` | `kb/forge-big.mjs:88`, written into each store's `<name>.big.rvf.embed.json` at `:429-434`; read back by the reader at `kb/forge-ask.mjs:77-87`, applied at `:245` |
| 7 | Chunk size | up to 4,000 characters, cut at a paragraph break when one falls in the second half | `kb/forge-corpus.mjs:11,53-68` |
| 8 | Chunk overlap | 400 characters | `kb/forge-corpus.mjs:12,65` |
| 9 | Chunker identity | `forge-corpus-v1`; build fingerprint `forge-corpus-v1|Xenova/bge-base-en-v1.5@4d6c…:768:cls` | `kb/forge-corpus.mjs:6-10` |
| 10 | Header inside the embedded text | **none**. The chunker does produce a second field, `embedText` = `title — path` + the chunk (`kb/forge-corpus.mjs:329`), but the bge build embeds the bare `text` field | `kb/forge-big.mjs:302` (`batch.map((r) => r.text)`), smoke path `:444`; the nightly refresh does the same, `kb/forge-refresh.mjs:202` |
| 11 | What the model actually sees of a chunk | the first 512 tokens (the model's window; roughly 2,000 characters of prose, less of code). The rest of a 4,000-character chunk is cut off silently by the tokenizer. Measured on a 3,000-passage sample of today's corpus: median passage 985 tokens, 73.7% longer than the window, 50.0% of all tokens never embedded | window: the model's own limit, no override in `kb/forge-big.mjs:125-128`; measurement: `evals/runs/2026-11-16-knowledge-architecture/inventory/knowledge-type-census.json` (run decision D4) |
| 12 | Batch size while embedding | 32 passages per call, in corpus order (not sorted by length) | `kb/forge-big.mjs:299-302`; refresh `kb/forge-refresh.mjs:199-203` |
| 13 | Which files become passages: documents | every `.md`, `.txt`, `.rst` in full | `kb/forge-corpus.mjs:168-181` |
| 14 | Which files become passages: source code | **only the opening comment** for an ordinary source file: the comment lines found in its first 30 lines, and the file is skipped entirely if it has none. A crate's `lib.rs`/`main.rs` gets its doc comment plus its first 100 lines. A file gets its full body only when its folder was named with `--full` at build time | `kb/forge-corpus.mjs:245-271` (`docBlock(firstLines(text, 30))` at `:264`, skip at `:265-268`, full body at `:251-252`, crate lead at `:253-262`) |
| 15 | Manifests, config, HTML | a summary of `Cargo.toml` / `package.json`; config files up to 12,000 characters; visible text of HTML | `kb/forge-corpus.mjs:183-231, 23, 290-310` |
| 16 | Folders never read | `node_modules, target, .git, dist, build, .next, .cache, coverage, .venv, venv, __pycache__, .vite, vendor, v2`. The `v2` entry drops every folder with that name, including whole current source trees | `kb/forge-corpus.mjs:14-17` |
| 17 | Index layout | one vector file per repository: `<repo>.big.rvf` (rUv's RVF format, cosine distance), built from per-shard vector files, with an id check that every passage has a vector | `kb/forge-big.mjs:379-381, 403-426` |
| 18 | Approximate-search index (HNSW) | built and persisted by `@ruvector/rvf`; required once a store has 1,024 or more vectors, smaller stores are scanned exactly | `kb/rvf-index.mjs:24-41` |
| 19 | Stored vectors | full precision (f32); no vector compression is requested | `kb/forge-big.mjs:381` (only `dimensions` and `metric` are passed) |
| 20 | Text storage | full chunk text in `<repo>.passages.jsonl`, joined to vectors by id; `<repo>.meta.json` holds path, kind, title | `kb/forge-refresh.mjs:160-185`; reader `kb/forge-ask.mjs:64-75` |
| 21 | Second, small variant | the 384-number `Xenova/all-MiniLM-L6-v2` build still exists as code (`kb/forge-build.mjs:131,148`, and it does embed the header field `embedText`), but ADR-0004 as updated 2026-07-28 says it is "retired from the Brain build" (`docs/adr/0004-effectiveness-first.md:28-33`). The reader still falls back to it for a store that has no `.big.rvf` | `kb/forge-ask.mjs:44, 77-80` |

## 2. What happens to a question (the read side), in the order it happens

The path a real user takes is the MCP tool `search_ruvnet` in `kb/forge-mcp-all.mjs`. It is not the same path
the older evaluation scripts took (see section 4).

| Step | What it does | Value | Where |
|---|---|---|---|
| A | Default number of documents returned | 6 | `kb/forge-mcp-all.mjs:279, 325` |
| B | Reviewed "discovery" answer, before any search | for a few hand-reviewed capability areas the tool answers with a pointer and does not search | `kb/forge-mcp-all.mjs:343-366` |
| C | **Card lane (answers first)** | plain keyword overlap between the question and `kb/capability-cards.md`, no model. If a card is a confident match the tool returns the card and **never runs the search**. Confident means: at least 2 shared content words, at least 34% of the question's content words explained, and at least 1 more shared word than the runner-up | `kb/forge-mcp-all.mjs:367-416` (call at `:381`); thresholds `kb/card-lane.mjs:337-339`, rule `:722-727` |
| D | **Router (may refuse)** | if no card answered, the search is called with `allowFullCorpus: false`. A router built on the same cards, then on file metadata, picks at most a few repositories. If it cannot place the question, the tool returns "The question was too ambiguous to select a source repository safely" and **no search is run** | call `kb/forge-mcp-all.mjs:427-433`; refusal `kb/forge-ask-all.mjs:3610-3641`; router `kb/forge-ask-all.mjs:3254-3470`, card router `kb/card-lane.mjs:345` |
| E | Hand-written question shapes | about a dozen functions recognise particular question wordings (cost/quality trade-off, harness evolution, cheap-first escalation, on-device index, gists…) and force a fixed list of repositories | `kb/forge-ask-all.mjs:309-467` (detectors), applied at `:3281-3443` |
| F | Dense lane, per chosen repository | the question vector is compared with the store; `max(24, 4k)` nearest chunks are taken; chunks are collapsed to documents by file path (a document's score = its best chunk) | `kb/forge-ask.mjs:379 (RAW_HITS = 24), 866, 868-875` |
| G | Per-repository hand tuning | about fifteen rules adjust the distance: boosts when question words appear in the path or title (up to 0.18, plus 0.30 for an ADR number), primer routing, crate-name detection, symbol routing, code-versus-design tilt, demotions | `kb/forge-ask.mjs:730-738` (lexical boost, path and title only), `:828-864` (intent classification), `:926-958` (scoring) |
| H | Candidates per repository | the default pool is 64 documents per repository (the caller passes none), deeper only for exact package-name questions | `kb/forge-ask-all.mjs:3473 (pool = 64), 3679, 3690-3706` |
| I | Extra lanes that add candidates | exact package names, manifest inventory, quoted claims, exact ADR numbers, RVF backend details, the **identifier lane** (rare exact tokens such as `agentdb-memory.db`) | `kb/forge-ask-all.mjs:3719-3778`; `kb/identifier-lane.mjs` |
| J | Keyword (BM25) lane for repositories | exists, **off by default** (`RUVNET_BRAIN_KEYWORD_LANE=1` turns it on), because it builds its index at question time | `kb/keyword-lane.mjs:27-41`; gate `kb/forge-ask-all.mjs:3783-3785` |
| K | Keyword (BM25) lane for transcripts | on, only for stores listed in `KB_TRANSCRIPT_STORES` (default `private store H`), top 40 | `kb/forge-ask-all.mjs:83-111, 3786-3791` |
| L | Document assembled for each candidate | up to 12,000 characters centred on the matching chunk | `kb/forge-ask.mjs:378, 767-815` |
| M | **Reranker** | `Xenova/ms-marco-MiniLM-L-6-v2`, 8-bit weights, revision `a09144355adeed5f58c8ed011d209bf8ee5a1fec`; batches of 16 | `kb/model-requirements.mjs:8`; `kb/forge-rerank.mjs:69-76, 100, 153` |
| N | What the reranker reads | the first 3,000 characters of the assembled document, then cut again to the model's 512 tokens | `kb/forge-rerank.mjs:133, 169`; `:143-147` |
| O | Reranker pool cap / cascade | cap: off (0) for routed questions, 408 pairs for the full-corpus fallback; two-stage cascade: off | `kb/forge-ask-all.mjs:2709, 2729, 2787-2788` |
| P | Boosts added to the reranker score | +2.0 when the question names the repository; +3.0 exact package title; +10 for quoted-claim, exact-ADR and source-detail candidates; identifier boosts; newest-release boosts | `kb/forge-ask-all.mjs:2874-2968` |
| Q | **Pruning** | every result after the first is dropped if its reranker score is below 0, unless the question named its repository | `kb/forge-ask-all.mjs:3076-3080` |
| R | Evidence grade | top score at least 6.0 "strong", at least 4.0 "ok", at least 0 "thin", otherwise "insufficient evidence"; a thin grade adds a "weak coverage" warning | `kb/forge-ask-all.mjs:3055, 3082-3100` |
| S | Learned judge | exists, off by default (`RUVNET_BRAIN_JUDGE=1` and a weights file are both needed) | `kb/judge-rank.mjs:10-13`; `kb/forge-ask-all.mjs:3880` |
| T | Time limit | the 20-second limit (`kb/query-deadline.mjs:37`) is armed only in the command-line entry point (`kb/forge-ask-all.mjs:3922-3923`); the MCP tool handler passes no deadline to the search (`kb/forge-mcp-all.mjs:427-433`). For the tool, the limit is the plug-in parent's call timeout, 240 seconds by default, which kills and restarts the search worker (`plugin/mcp/server.mjs:300-337, 329`) | as cited |
| U | What is shown | each document is cut to its first 6,000 characters in the text shown to the model (the whole document is carried in a structured field) | `kb/forge-mcp-all.mjs:127-136, 459-471` |
| V | Repositories searched at once | 5 | `kb/forge-ask-all.mjs:3666` |

## 3. Cards, primers and other distilled layers

- Capability cards: one markdown file, `kb/capability-cards.md`, used both to answer (step C) and to route
  (step D). The run's census counted 185 cards of which 134 are auto-derived placeholders
  (`evals/runs/2026-11-16-knowledge-architecture/DECISIONS.md`, D4; not re-counted here).
- Primers: one hand-written overview per major repository (`kb/*-primer.md`), held in a `concepts` store that
  is searched like any other store and given a deeper pool (`kb/forge-ask-all.mjs:3686-3690`).
- Symbol index (`<repo>.symbols.json`): maps a function or package name to its file; used only when the
  question looks like a code question (`kb/forge-ask.mjs:603-632, 862`).

## 4. How it is refreshed and how it is checked

- Nightly: a CI job rebuilds changed repositories incrementally with the same embedder and the same chunker
  (`kb/forge-refresh.mjs`; workflow `.github/workflows/corpus-nightly-dispatch.yml`) and publishes a signed
  bundle as a GitHub release named `corpus-sha256-…`. Installed copies update from it (`kb/forge-update.mjs`).
- Two receipts are published beside every nightly bundle. Read from the 45 bundles published between
  2026-09-29 and 2026-11-16 (downloaded for this report):
  - "repo recall": 182 questions, one per repository, **with the repository given**, exact labelled file in
    the top 5: 161 to 163 of 182 on every night (89%).
  - "retrieval accuracy" (a sample of 80 machine-written questions asked two ways): 46-47 of 80 with the
    repository given, 43-44 of 80 across the whole corpus; state `FAIL` against its own 19-of-20 threshold on
    every night; the receipt marks itself "diagnostic", so it does not block a release.
- The release gate `scripts/eval-brain.mjs` asks 120 frozen questions and scores a question as "routed" when
  the answer came from the **expected repository** (`evals/held-out.json`, field `expectRepo`;
  `scripts/eval-brain.mjs:83-88, 120-122`). It does not check which file was returned.

## 5. Footprint

- Bundle published 2026-11-16 for 4.7.28: 906,562,749 bytes zipped, 1,494,277,626 bytes and 1,210 files
  unpacked (`corpus-receipt.json` of release `corpus-sha256-d2cc093e…`).
- 218 stores and 187,117 passages (run decision D3, measured on the installed copy by the run's lead; not
  re-measured here because this report does not open the installed copy).
- Three models are downloaded on first use: the embedder (about 110 MB), the reranker (about 23 MB) and, for
  legacy stores only, MiniLM (about 23 MB). Sizes are the publishers' figures, not measured here.

## 6. The recipe in one paragraph

Each repository is cut into pieces of up to 4,000 characters (ordinary source files contribute only their
opening comment). Each piece is embedded with the 8-bit build of bge-base-en-v1.5 into 768 numbers, with no
title or path in front, and the model reads only about the first half of a typical piece. One index is kept per
repository. A question first meets a keyword match against hand-written cards, which may answer it outright. If
not, a router built on the same cards picks a few repositories or declines to search. In the chosen
repositories the closest pieces by meaning are collected, a dozen hand-tuned rules and exact-name lanes add or
re-order candidates, a small MS-MARCO reranker reads the first 3,000 characters of each candidate, anything it
scores below zero is dropped, and what is left is returned with a confidence label. There is no general keyword
search over repository text in the default path.

## 7. What I did not verify

- The installed copy under `~/.cache/ruvnet-brain` was not opened (rule of this task). Store and passage counts
  are quoted from the run's own decision record.
- I did not run the product. Behaviour is read from code; measured behaviour is in BISECT.md.
- `kb/card-lane.mjs`, `kb/identifier-lane.mjs` and `kb/forge-update.mjs` were read in the parts cited, not end
  to end.
