---
id: ADR-004
---
# ADR-0004: Effectiveness first — size is a later optimization

**Status**: Accepted (2026-06-27)
**Date**: 2026-06-27

**Owner directive** (supersedes the v0.2 SQ8 default)

## Context
Every prior optimization for size bled effectiveness below the threshold where the tool works at all. The
owner's directive: "every time we try to be efficient, we give up massive chunks of effectiveness... maximize
for effectiveness."

## Decision
**Effectiveness is the only first-class metric.** For v1: use the **sharpest retrieval regardless of size** —
a strong code-aware embedder and/or a larger prose model, with **multiple vectors per chunk** (prose + code,
kind-routed) if it raises answer quality, in **f32** (no quantization that costs any measurable quality).
Quantization (SQ8/RaBitQ) is a **later efficiency pass**, gated on answer-quality delta. The Full bundle is
honestly ~1–1.5 GB; we ship it anyway. SKUs (Core/T0-only) exist for *convenience*, never to shrink an
in-scope answer.

## Consequences
- v1 is large; accepted. A "lite" quantized build comes only after effectiveness is proven.
- The dimensionality decision is made by measured effectiveness on implementation-lookups, not by size.

## Alternatives rejected
- *768-SQ8 default (v0.2)* — a size optimization; demoted to a later pass.
- *384-dim MiniLM* — smaller but weaker on code lookups; rejected for the shipping build.
