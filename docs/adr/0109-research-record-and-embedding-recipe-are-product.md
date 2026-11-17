---
id: ADR-109
title: The research record and the embedding recipe page are part of the product
status: Proposed
date: 2026-11-17
updated: 2026-11-17
version: 1.0.0
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [retrieval, embedding, documentation, currency, research]
supersedes: []
relates: [ADR-004, ADR-034, ADR-071, ADR-099]
governs:
  - docs/brain-research/EMBEDDING-RECIPE.md
  - docs/brain-research/DECISIONS.md
  - tests/unit/embedding-recipe-record.test.mjs
---

# ADR-109: The research record and the embedding recipe page are part of the product

**Status**: Proposed (2026-11-17)

**Related**: ADR-0004, ADR-0034, ADR-0071, ADR-0099

## Why

On 2026-11-16 the owner asked which embedding recipe the Brain ships and why. Nobody could answer from a
document. The answer had to be rebuilt from code and git history
(`evals/runs/2026-11-16-knowledge-architecture/history/CURRENT-EMBEDDING-STRATEGY.md`, `HISTORY.md`). That
rebuild found that the recipe was set by a template, a directive and a 12-question test; that the promised
benchmark in ADR-0004 was never run; and that a build with a title and path header was retired on 2026-07-28
without any record of the effect on what the model reads.

## Decision

1. `docs/brain-research/` is a permanent part of the repository: README, OWNER-NOTE, EMBEDDING-RECIPE, STORY,
   DECISIONS (append-only) and EXPERIMENTS (append-only).
2. `docs/brain-research/EMBEDDING-RECIPE.md` is the one page that states the shipped recipe. Its section (g) is a
   block tagged `json recipe-constants` carrying every recipe constant, a `recipeVersion`, a `lastChanged` date
   and a digest of the constants.
3. **The rule.** Any change to a recipe constant in code must, in the same change: update the block (value,
   `recipeVersion`, `lastChanged`, digest); add one row to the page's version table carrying that version, date
   and digest; and add an entry to `docs/brain-research/DECISIONS.md` naming `recipe-version: Rn`.
4. **Enforcement.** `tests/unit/embedding-recipe-record.test.mjs` reads every constant at every code site that
   defines it (build, nightly refresh, build fingerprint, reader defaults) and fails, naming the constant and
   both values, when the sites disagree, when the block differs, when the digest does not match the code, when
   the version table has no single matching row, or when DECISIONS.md does not name the version. It is listed in
   the source suite of `scripts/release-qualification-contract.mjs` (`embedding-recipe-record`).
5. The test's list of constants and their code sites is one data structure (`RECIPE_SOURCES`). A new
   architecture (v5) replaces that list and the block; the rule stays.

## What this does not do

It guards the constants only. The `file:line` citations and the prose on the pages are not checked by code and
can go stale; they are reviewed when the recipe changes. It does not decide any recipe: the proposal in the
page's section (f) is under test and is not in force.

## Principles

Serves P2 (a claim and the customer's experience are the same thing: the page cannot claim a recipe the code
does not ship), P5 (make the murky legible), P6 (derive, never assert: the digest is computed from the code) and
P7 (the test is wired into the qualification inventory, not left as a file). Trades against ADR-0071 ("facts
are generated, behaviours are tested"): the block restates facts the code holds. It is kept because the page's
version table and reasons are history that cannot be generated, and the test makes the restated facts fail
loudly instead of drifting. Relates to ADR-0034 (document currency): this is a narrower, code-enforced currency
check for one page.

## Relation to other records

- ADR-0004: its "controlled bake-off" of embedders is recorded here as never run; the recipe it describes is R3.
- ADR-0099: its measurements are entries X7 and H16 of the research logs.
- Prior decisions consulted: `plugin/scripts/decision-record.mjs --consult` timed out on 2026-11-17, so the
  history of related decisions in project memory is UNKNOWN for this record.

## Consequences

A recipe change now costs four edits instead of one. A release qualification fails if the code and the page
disagree. The v5 rewrite inherits the same rule by swapping one list.
