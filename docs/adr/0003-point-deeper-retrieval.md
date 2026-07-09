---
id: ADR-003
---
# ADR-0003: Point deeper — the KB resolves to exact code; the agent never chooses to dig

**Status**: Accepted (2026-06-27)
**Date**: 2026-06-27

**Red-team origin:** owner directive (the core 15-month failure)

## Context
The failed assumption: "point Claude at a deep repo and it will keep reading until it finds the answer."
It doesn't — it skims, falls back to training, and quits. Any design that *relies on the agent deciding to
look deeper* will fail the same way.

## Decision
The KB does the deep traversal **at build time** and retrieval **resolves every query to the exact deepest
location and serves it**: the L4 **symbol index** maps the target (`min-cut`, `adapt()`) to
`repo:file:line`; retrieval returns that **full implementation passage + its call-graph neighbors** (callers
/ callees) via **whole-document assembly** (collapse hits by path, concat in order, center on the match).
The §5 enforcement hook **injects this into context**, so the agent answers from the implementation — it has
no skim-or-quit option.

## Consequences
- "Which crate implements X?" is deterministic (symbol index), not a lucky vector hit.
- Eval includes deep-implementation-lookups graded by ground-truth — if the KB can't point to the right
  location, the question fails and that failure is the build's worklist.

## Alternatives rejected
- *Semantic top-k only* — probabilistic; the long-tail implementation lookup is exactly where it misses.
- *Trust the agent to follow links* — the documented failure mode.
