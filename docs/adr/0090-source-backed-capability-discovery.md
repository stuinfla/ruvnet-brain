---
id: ADR-090
title: Reviewed-source discovery for finite capability queries
status: Accepted
date: 2026-09-19
updated: 2026-09-19
authors: [Stuart Kerr, Codex]
tags: [retrieval, routing, source-grounding, capability-discovery]
relates: [ADR-060, ADR-074]
governs:
  - kb/capability-families.mjs
  - kb/card-lane.mjs
  - kb/forge-ask-all.mjs
  - kb/forge-mcp-all.mjs
  - tests/unit/capability-family-routing.test.mjs
  - tests/unit/capability-discovery.test.mjs
  - tests/integration/forge-mcp-capability-discovery.test.mjs
  - tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt
  - tests/fixtures/retrieval/ruflo-cross-project-transfer-reviewed-passage.txt
---

Updated: 2026-09-19 | Version 1.0.0
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
2. Positive discovery replies use a finite allowlist of complete normalized query templates and
   a reviewed source catalog. Normalization changes only case, surrounding whitespace, and trailing
   punctuation; it never drops numbers, clauses, or qualifiers.
3. Each catalog entry binds one repository, source path, exact passage SHA-256, and fixed claim
   groups. A missing or changed passage fails closed to ordinary retrieval. The excerpt is assembled
   only from exact slices of the hash-matched passage; there is no generic claim-word grader.
4. The two approved entries describe one browser vector-search option using IndexedDB and privacy
   language, and Ruflo's titled cross-project IPFS transfer section. The local entry makes no native
   or on-disk claim. The cross-project entry includes the documented store/load operations and the
   required `PINATA_API_JWT` configuration note.
5. Replies are `source_grounded` with a null cross-encoder score and `implementation: unproven`.
   Their caveats state that runtime behavior and relevant user configuration were not verified.
   Any query outside the finite templates, or any source hash mismatch, uses ordinary retrieval.
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
source fallback, negative qualifier controls, and the omitted-`k` MCP boundary. Runtime and held-out
measurements are recorded with the operational repair receipt; this ADR itself makes no performance
or installation-health claim. Documentation discovery establishes only what the reviewed source
describes, not that the described runtime is wired or operational.
