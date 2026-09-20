---
id: ADR-090
title: Reviewed-source discovery for finite capability queries
status: Accepted
date: 2026-09-19
updated: 2026-09-19
reviewed_digest: 517fc91452d5
authors: [Stuart Kerr, Codex]
tags: [retrieval, routing, source-grounding, capability-discovery]
relates: [ADR-060, ADR-074]
governs:
  - kb/capability-families.mjs
  - kb/card-lane.mjs
  - kb/forge-ask-all.mjs
  - kb/forge-mcp-all.mjs
  - kb/implementation-evidence.mjs
  - kb/identifier-lane.mjs
  - kb/repo-aliases.json
  - tests/unit/capability-family-routing.test.mjs
  - tests/unit/capability-discovery.test.mjs
  - tests/integration/forge-mcp-capability-discovery.test.mjs
  - tests/unit/implementation-truth.test.mjs
  - tests/unit/grounding-identifier-recall.test.mjs
  - tests/unit/card-lane.test.mjs
  - tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt
  - tests/fixtures/retrieval/ruflo-cross-project-transfer-reviewed-passage.txt
---

Updated: 2026-09-19 | Version 1.1.2
Created: 2026-09-19

# ADR-090 — Reviewed-source discovery for finite capability queries

## Context

Broad requests such as “store embeddings in this project without running a server” and “carry
useful learning from one project to another” can be routed to an unrelated store by lexical card
overlap. A curated capability card can also appear conclusive while the current corpus contains no
source that covers the user's requested deployment, persistence, or transfer properties.

The search corpus can contain documentation that describes a capability without proving that a
particular installation or application implements it. The retrieval path must keep those states
separate.

## Decision

1. A narrowly matched capability family may choose one bounded source owner. It never supplies an
   answer. Ambiguous multi-family questions fall through to ordinary routing.
2. Only the finite allowlist of complete normalized query templates may use the reviewed,
   no-rerank discovery reply. Other queries in a matched capability family may add that family's
   independently reviewed passage as one hash-bound retrieval candidate. The original query,
   including every qualifier, continues through the ordinary reranker and evidence gates; the
   witness candidate carries no positive grade or automatic answer authority. Existing same-path retrieval evidence is preserved; the short witness is added only when that path is absent. Template normalization
   changes only case, surrounding whitespace, and trailing punctuation; it never drops numbers,
   clauses, or qualifiers.
3. Each catalog entry binds one repository, source path, exact passage SHA-256, and fixed claim
   groups. A missing or changed passage fails closed to ordinary retrieval. The excerpt is assembled
   only from exact slices in source order of the hash-matched passage; there is no generic claim-word grader.
4. The two approved entries describe one browser vector-search option using IndexedDB and privacy
   language, and Ruflo's titled cross-project IPFS transfer section. The local entry makes no native
   or on-disk claim. The cross-project entry includes the documented store/load operations and the
   required `PINATA_API_JWT` configuration note.
5. Exact-template replies are `source_grounded` with a null cross-encoder score and
   `implementation: unproven`. Their caveats state that runtime behavior and relevant user
   configuration were not verified. A stale or missing witness hash contributes no candidate and
   ordinary retrieval continues. No claim is made that candidate availability alone improves
   held-out recall, answer quality, or latency.
6. Broad capability-family questions bypass the curated answer-card fast path at the MCP boundary
   so a card cannot circumvent reviewed-source verification. Explicitly named owners and unrelated
   queries keep their existing paths.
7. A new source version may enter this catalog only after independent source review, exact passage
   hashing, and an updated fixture. Runtime code must never regenerate a pinned hash from returned
   answers or current retrieval results.
8. This decision changes no candidate-pool size, cross-encoder cascade setting, rerank threshold,
   timeout, or default `k`. In particular, omitted MCP `k` continues to reach the default-k card
   guard fixed by `55f98705`.

## Verification boundary

Unit tests cover route selection, exact query templates, exact passage hashes and excerpts, changed
source fallback, negative qualifier controls, the omitted-`k` MCP boundary, and the generalized
candidate path for an unseen paraphrase. They assert that qualifiers remain intact through ordinary
reranking and that changed witnesses are excluded. Runtime, held-out quality, and latency remain
unmeasured for this change. Documentation discovery establishes only what the reviewed source
describes, not that the described runtime is wired or operational.

## Currency log

| Date | Review |
|---|---|
| 2026-09-19 | Reviewed retrieval integration: preserve existing same-path evidence instead of replacing it with a short catalog excerpt; preserve source order in the catalog excerpt. No OFF/scope or cascade-default changes, and no latency or installed-runtime claim. | `kb/forge-ask-all.mjs`; `tests/unit/capability-discovery.test.mjs`; reviewed_digest 517fc91452d5. |

| 2026-09-19 | Generalized broad-family discovery without broadening the exact no-rerank allowlist: a matching query can add one independently reviewed, SHA-bound passage as a candidate in the normal rerank/evidence path. Curated cards cannot return early for a family query. Changed hashes fail closed; original query text and qualifiers are preserved. Focused unit tests only; no latency, held-out recall, or installed-runtime claim. | Reviewed the scoped `searchAll` handoff, witness injection, source hash check, card-lane bypass, and focused capability-discovery tests. |
| 2026-09-19 | Exact `Owner.member()` questions now require relevant implementation source declaring that exact member before implementation is reported proven; a class match or callsite alone leaves a qualified insufficient-evidence result. Exact identifiers are matched case-insensitively so normalized PascalCase symbols reach the existing widened-only scan. Added exact `RvfStore`/`RvfDatabase` owner aliases and a full Cognitum ruOS disambiguator; bare `ruos` remains the ruvnet desktop-control owner. Focused unit tests only; no MCP runtime or global absence claim. | Reviewed `kb/implementation-evidence.mjs`, `kb/identifier-lane.mjs`, `kb/repo-aliases.json`, `kb/card-lane.mjs`, and the focused evidence/router/scanner tests. |
| 2026-09-19 | Removed capability-family guesses from the card router after a reviewed cross-project paraphrase showed the override could replace its existing `codex-one` owner with `ruflo`. The card router retains its baseline owner selection; the family matcher has no authority to replace that source route. Existing reviewed-source discovery remains separately governed. | Reviewed `kb/card-lane.mjs` and `tests/unit/capability-family-routing.test.mjs`; baseline fixture continues to route to `codex-one`. |
| 2026-09-19 | Reviewed the exact query-template allowlist, passage-hash gate, excerpt construction, and MCP default-`k` route. Independent source review pinned the approved passage hashes in this ADR's governed implementation. A same-size, same-mtime passage mutation is rejected. reviewed_digest fe7a22ebf299. | Reviewed `kb/capability-families.mjs`, `kb/forge-ask-all.mjs`, `kb/forge-mcp-all.mjs`, and `tests/unit/capability-discovery.test.mjs`; confirmed changed or missing source passages fail closed. |
