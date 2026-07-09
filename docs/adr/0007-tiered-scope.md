---
id: ADR-007
---
# ADR-0007: Tiered scope (T0–T3) by ingest depth; union selection rule

**Status**: Accepted (2026-06-27)
**Date**: 2026-06-27

**Red-team origin:** Proof-H8, F7

## Context
169 non-fork repos under `github.com/ruvnet`. A single star cutoff is wrong (it would drop core pieces like
RuLake ⭐11, agentdb ⭐70). "Index everything equally" never finishes. The eval can meaningfully cover ~25
repos, so claiming "world-class on all 169" is unsupported.

## Decision
`IN_SCOPE = (stars ≥ 1000) ∪ (pushed ≤ 3 months) ∪ (core-architecture allowlist)`, **tiered by depth**:
**T0** pillars (RuView, ruflo, RuVector) — max depth + L2 + primer; **T1** core stack (~20 repos) — full +
L2 + primer; **T2** latest ≤3mo — full source + primer, no L2; **T3** long-tail (~95) — primer-depth,
deep-walk on demand. Tier membership is **data** (`data/registry.tiers.json`). Claim is scoped:
**world-class on T0/T1, breadth-attested beyond** — per-tier scores reported separately, never blended.
New repos crossing a rule auto-onboard (evergreen) and bump the version.

## Consequences
- Finite, finishable; effort concentrated where ~95% of value lives.
- Honest, tier-scoped claims; no single blended "98" hiding lightly-evaluated long tail.

## Alternatives rejected
- *Flat "index all 169 at full depth"* — never converges; unbounded cost.
- *Single star threshold* — drops load-bearing low-star core repos.
