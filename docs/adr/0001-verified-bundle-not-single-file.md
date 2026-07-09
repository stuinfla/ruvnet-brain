---
id: ADR-001
---
# ADR-0001: Ship a verified zip bundle, not a single embedded `.rvf`

**Status**: Accepted (2026-06-27)
**Date**: 2026-06-27

**Red-team origin:** Arch-H1

## Context
The aspiration was "one magic `.rvf` you drop in." But the entire proven toolchain (`rvf-kb-forge`,
Cognitum) is **3-part**: `.rvf` returns `{id, distance}` only; retrieval MUST join to a separate
`passages` sidecar. RVF *can* embed payloads (Ask-Ruvnet does, at 1.4 MB) but no shipped tool does it at
~300 MB+ with random access. Claiming "one file" would be false and would re-introduce the "card catalog
with no library" failure.

## Decision
Distribute a **self-contained zip bundle**: `brain.rvf` (segments) + `brain.passages.zst` (block-indexed
full text) + `brain.symbols.json` + `brain.graph.json` + `primers/` + `gate/` (the forced-grounding wiring)
+ signed `manifest`. One `.mcp.json` line wires it. A **true single-container `.rvf`** (zstd block index
for mmap'd random access) remains a **deferred spike** with its own gate; the bundle is the shipping
fallback until/unless that passes.

## Consequences
- "Drop one file" becomes "download one bundle, add one line" — honest.
- The bundle includes the wiring, so it is never "download and hope Claude reads it."
- The guard FAILS the build if passages != vectors != ids (no embeddings-only ship).

## Alternatives rejected
- *Single embedded `.rvf` now* — unproven at scale; would block shipping. Deferred, not abandoned.
- *Sidecars the user assembles* — fragile; we ship one zip.
