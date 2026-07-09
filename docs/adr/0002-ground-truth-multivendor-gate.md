---
id: ADR-002
---
# ADR-0002: Quality gate of record = ground-truth-against-source + multi-vendor panel

**Status**: Accepted (2026-06-27)
**Date**: 2026-06-27

**Red-team origin:** Proof-H1/H12, Arch-H7 · **Owner directive**

## Context
For 15 months the failure was an LLM judging RuvNet from memory and being confidently wrong. A proof that
*terminates in a builder-controlled LLM grader* launders an assertion into an official-looking "98." A human
expert as gate is ideal but unavailable at cadence. The one anchor that can't be gamed is **the real
source** — the very thing the agent kept refusing to read.

## Decision
The **gate of record is automated ground-truth verification**: for each graded answer, (a) extract cited
`repo:file:line`; (b) fetch the actual source at the pinned commit; (c) verify it **exists and supports the
claim** (mechanical span-match + check); (d) an **independent deep-dive agent re-answers from the raw repo**
and we diff. A **multi-vendor LLM panel** (different families/vendors) cross-checks completeness; report
inter-judge κ; a frozen **calibration-anchor set** + measured test-retest reliability make "≥98" real, not
false precision. **No single same-family LLM is ever the final word.** Held-out/adversarial sets are
independently sourced, hashed, **burn-after-one-use**; the grader model is rotated/held-out.

## Consequences
- An answer whose citations don't hold up **fails**, however good it reads.
- "98/100" is anchored to source, not opinion.
- **Residual (named):** semantic completeness still has an LLM component — mitigated, not eliminated.

## Alternatives rejected
- *LLM grader as final authority* — the captured instrument; rejected.
- *Human-expert gate* — owner can't staff it at cadence; ground-truth is a stronger, available anchor.
