Updated: 2026-11-17 01:00:28 EST | Version 1.0.0
Created: 2026-11-17 00:48:53 EST

# What 2024 thinking misses: the parts of the recipe that exist only because of 2026

A 2024 retrieval design for this corpus would be: split files into chunks, embed each chunk with a
general model, add keyword search, fuse the two lists, maybe re-rank, tune the weights by hand. The run so far
has measured that design carefully: it reaches about 30% for amateurs.

The recipe in `04-DESIGN-THE-RUV-WAY.md` is different in eight ways. Each row names the idea, what makes it
possible, the date that thing appeared, and whether it has been tried on this corpus (none has).

| # | Idea in the recipe | What it replaces from 2024 | What makes it possible | First existed | Tested here? |
|---|---|---|---|---|---|
| 1 | The first match is a **cue**, and the answer is rebuilt by walking cue to tag to content, pruning weak paths and stopping when evidence is decisive | top-k chunks by similarity | the paper "Memory is Reconstructed, Not Retrieved" (ICML 2026, arXiv 2606.06036, 4 June 2026: "up to 23%" over baselines on two memory benchmarks) and rUv's implementation `examples/mragent` (ADR-269, 270) | June 2026 | no. rUv's version runs (14 of 14 tests here) on made-up tasks |
| 2 | **Vectors are bound to typed graph nodes**; one operation searches one node type and returns another by a named link | a vector per chunk, graph bolted on afterwards | `TypedGraph::search_then_traverse` (ADR-253, `typed_graph.rs`); from Node, `@ruvector/core` + `@ruvector/graph-wasm` | 15 June 2026 | no |
| 3 | **The search settings are evolved**, on training questions, and accepted only on held-out ones | lane weights and thresholds set by hand while looking at results | `@metaharness/darwin`; the field's GEPA (July 2025) and Meta-Harness (March 2026) | June 2026 | no |
| 4 | **"I don't know" is a scored outcome**: a wrong confident answer costs more than abstaining, and the threshold is set on training data against raw relevance | a fixed "insufficient evidence" cut-off | ADR-270's risk-adjusted utility; `@ruvector/typesafe` abstain mass (September 2026); conformal methods (2025-2026) | June to September 2026 | no |
| 5 | **Learning is new links, written after a verified answer, on a branch** that can be dropped; promotion needs repeated evidence | re-embedding, or adapters on the query vector | MRAgent consolidation (June 2026); RVF copy-on-write branches (February 2026); agenticow (June 2026); the Brainpedia evidence rule (February 2026) | 2026 | no |
| 6 | **"Which capability fits this problem" is a typed catalogue with task signals**, made corpus-wide | hoping the right README is the nearest chunk | ruflo's capability brain (`capability-brain.ts`, July 2026); rUv's measured router result of 10 November 2026 (ruflo ADR-527: one mean vector per label from example prompts, 62.8% right on 113 held-out prompts against 25.7% for the shipped router, with a "no match" outcome); the field's tool-retrieval results (ToolRet, RAG-MCP, 2025) | July to November 2026 | no |
| 7 | **Nightly update as branch, verify, promote**, with a generation token per repository so only what changed is rebuilt, and a signed record of what went in | rebuild and replace | RVF branch / freeze / witness (February 2026); ruLake generation tokens (April 2026); Dream Machine verdict ledger (August 2026) | 2026 | no |
| 8 | **Vague questions are treated as their own problem**, with the calling model's rewrite and a re-ranker as measured levers | one pipeline for every question | BRIGHT and ReasonIR (2025); rUv's LongMemEval run showing which re-ranker helps vague questions (agentdb ADR-016, 31 October 2026) | 2025 to October 2026 | no |

## What is not new, and stays

- Keyword search as the backbone. rUv's 2026 measurements, his production brain, and the coding agents all
  keep it. It is the expert's path.
- A general embedding model. In this recipe it does a smaller job (short sentence against short sentence).
- Chunks, as the content at the end of the walk.

## The honest edge of this page

Every "tested here" cell says no. The 2026 pieces exist, most of them run, and one has a peer-reviewed result
on other data. Their value for this corpus and for amateurs is what rules R19 to R23 in the amendment are for.
