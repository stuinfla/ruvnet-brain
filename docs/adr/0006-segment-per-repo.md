---
id: ADR-006
---
# ADR-0006: Segment-per-repo indexing + cross-segment normalization

**Status**: Accepted (2026-06-27)
**Date**: 2026-06-27

**Red-team origin:** Arch-H3

## Context
You cannot concatenate 169 per-repo HNSW graphs into one "well-routed" index — HNSW is a navigable
small-world graph; merging requires re-insertion (O(N log N) over the full set). v0.1 wanted both "one
well-routed index" and "cheap modular incremental rebuild"; those are mutually exclusive. RVF is already
segment-based (Ask-Ruvnet runs 27 segments).

## Decision
Index **one segment per repo**. Queries **fan out across segments** with an explicit **cross-segment score
normalization** step (so a ruvector hit and a ruflo hit are comparable). Incremental rebuild touches only
changed segments; the global ranking layer is rebuilt when needed. "Cheap incremental" is **deleted** from
claims — the real rebuild cost is stated and measured at P1.

## Consequences
- Modular, parallel, independently evergreen per repo.
- Adds a cross-segment normalization + routing step that must be eval'd (P2 routing eval: no cross-repo
  confusion).

## Alternatives rejected
- *One merged HNSW over ~300k+ vectors* — not incrementally cheap; rebuild on every high-churn push.
