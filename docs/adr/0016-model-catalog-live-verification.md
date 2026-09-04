---
id: ADR-016
title: Model-catalog live-verification wall — model/version facts cannot ship from memory
status: Accepted
date: 2026-07-15
authors: [Stuart Kerr, Claude Code]
tags: [routing, models, enforcement, ci, rule-0]
supersedes: []
relates: [ADR-015, ADR-0012]
updated: 2026-09-04
updated_source: derived-from-git
---

**Status**: Accepted (implemented in v3.0.3)

## Status

**Implemented — v3.0.3 (2026-07-15); scheduled ownership repaired 2026-09-04.** `data/model-catalog.json` (per-provider tier ladders),
`data/openrouter-catalog-snapshot.json` (committed live snapshot), `scripts/verify-model-catalog.mjs`
(the gate), `scripts/refresh-model-catalog.mjs` (live re-pull + factual price sync), `tests/unit/model-catalog.test.mjs`,
and the CI step `catalog:verify` all shipped. The router-optimizer/console *consumption* of the catalog
(per-user personalized frontier + corrected effort defaults) is tracked separately under ADR-015.

## Context

On 2026-07-15 I told Stuart "OpenAI's top is gpt-5.5-pro, there is no gpt-5.6" — from a price-sorted
glance at a catalog I had *just pulled*, without doing the live check I had explicitly said I would do.
GPT-5.6 (Sol/Terra/Luna) had shipped GA six days earlier. This was not a knowledge gap; it was **Rule 0
("verify the live source before asserting a fact, model, version, or 'latest/best'") being skipped
because the fact lived in prose/memory, where laziness is invisible and unenforceable.**

This is the same class of failure ADR-0012 (`ground-before-write.sh`) fixed for "hand-rolling rUv's
tools" and the `no-silent-substitution` CI check enforces: **the way to stop a rule from being skipped is
a wall that fails the build, not a promise to try harder.** Model facts had no such wall.

## Decision

**Model/version facts leave memory and become verified data behind a gate.**

1. **`data/model-catalog.json`** — the single source of per-provider (house) tier ladders, each entry a
   concrete model id + price + independent-benchmark rank + provenance. Modeled on ruflo ADR-148's
   `openrouter-alts.json` `_meta`/provenance conventions; extended with a provider-house axis rUv's
   registry does not carry.
2. **`scripts/refresh-model-catalog.mjs`** — pulls the live OpenRouter `/models` catalog (a free
   metadata endpoint, no spend) into a committed snapshot with a `pulledAt` stamp, synchronizes factual
   catalog prices from that same response, and flags drift (any catalog model that vanished). Runs weekly
   through `.github/workflows/model-catalog-refresh.yml` (the anti-rot mechanism) + on demand. The workflow
   owns one maintenance PR, dispatches the required protected-branch checks explicitly, and enables
   auto-merge only after those checks pass.
3. **`scripts/verify-model-catalog.mjs`** — the wall. Every catalog model MUST exist in the snapshot and
   be priced within 5%; a missing model, a wrong price, or a snapshot older than 14 days is a **hard
   failure (exit 1)**. CI runs it offline against the snapshot (`catalog:verify`), so a bad or stale
   model fact is a **red build**. `--live` checks against OpenRouter directly.
4. **The provenance rule (rUv ADR-206):** vendor self-reported benchmark scores are optimistic and
   scaffold-confounded — the *same* 500 SWE-bench tasks swing 76.8%→95.0% on scaffold alone. Rankings
   come only from independent evaluators carrying current-gen models (Artificial Analysis + Arena);
   vendor numbers are excluded. The stale canonical hard benchmarks (SWE-bench Verified standardized
   harness, LiveCodeBench, Aider polyglot) are noted, not used, until they carry current models.

## Verification (so it is real, not theater)

- **2026-09-04 issue #238 repair:** the accepted plan said the snapshot refreshed nightly, but no
  GitHub workflow invoked `catalog:refresh`; the snapshot aged past 14 days and made every PR's `check`
  lane red. The new weekly owner refreshes seven days inside the hard deadline, synchronizes live price
  changes deterministically, verifies the result, and routes it through a single auto-merged maintenance
  PR plus the repository's required `integration` and `canonical-qa` checks. A live repair pull also
  detected and corrected GPT-5.6 Sol pricing from $2.50/$15 to $2/$10 per million tokens.

- **2026-08-01 refresh:** CI correctly rejected the 14.3-day-old OpenRouter snapshot. A live
  `scripts/refresh-model-catalog.mjs` pull then found real price drift: GPT-5.6 Terra moved to
  $1/$6 per million input/output tokens and Luna to $0.10/$0.60. The catalog and committed
  337-model snapshot were refreshed together; the 14-day wall remains unchanged.

- The wall caught **two real errors in the first catalog I wrote** (`google/gemini-3.1-pro` → the live id
  is `-preview`; `x-ai/grok-4.1-fast` does not exist) — proving it checks *me*, not a strawman.
- It **rejects a fabricated model id** (`openai/gpt-9.9-ultra-imaginary` → exit 1) and passes clean on
  the corrected catalog (exit 0), against both live and the committed snapshot.
- `tests/unit/model-catalog.test.mjs` exercises every failure branch (missing / mispriced / stale /
  no-frontier) plus the drift + price helpers — a gate is only trustworthy if the gate itself is tested.

## Consequences

- A model/version claim can no longer be asserted from memory anywhere the catalog feeds — the assertion
  is the verified catalog's, not the model's recollection.
- The catalog stays current automatically (weekly protected refresh) and can't silently rot (14-day CI freshness
  fail) — a new flagship like GPT-5.6 surfaces as drift instead of a stale omission.
- The automated always-current path (predicting tier placement for a brand-new model from a few probes)
  is rUv's ADR-206 (BenchPress) — the next step beyond this snapshot-verification floor.
