# DDD-0001: Bounded contexts for RuvNet Brain

**Status**: Proposed
**Date**: 2026-07-09
**Related**: ADR-0011 (verified quality program), ADR-0002 (ground-truth gate), ADR-0008 (autonomous loop)

## Why model this at all

Most of this repo does not need DDD. It is a retrieval tool with a hook. Modelling it because
"we should do DDD" would be ceremony, and ADR-0009 (Mirror Discipline) forbids exactly that kind of
process theatre.

There is one thing that does need it, and it cost us real trust today: **the system consumes
external tools that confidently return numbers they never measured.**

- `routing_economics` returned `qualityScore: 0.75 / 0.45 / 0.9` — hardcoded constants — alongside
  `currentDailyCostUsd: 0`, having observed nothing.
- `qe_qx_analyze` graded a live page **F (54) in 2 ms**, every claim false against the real HTML.
- `metaharness_evolve` returned `{success: true, degraded: false, exitCode: 0, data: null}` while the
  wrapper beneath it returned `{degraded: true, reason: "metaharness-darwin-timeout"}`.
- Its sandbox scored a **killed** test suite as `testPassRate: 0` and then promoted it as champion.

Each of those is the same failure: **a foreign model leaked into our domain and was treated as fact.**
That is precisely what an anti-corruption layer exists to stop. The rest of this document exists to
make that layer's boundary explicit, and to name what must be true inside each region.

## Ubiquitous language

| Term | Means exactly | Does NOT mean |
|---|---|---|
| **Grounded** | The answer cites a path, and that passage resolves in an on-disk store | The answer mentions the right words |
| **Verified** | Checked by a gate that would have failed if the claim were false | Reviewed, or produced by a tool that reported success |
| **Receipt** | The concrete artifact a claim can be re-checked against (a path, a witness, a log) | A summary of what happened |
| **Measured** | An observation of the real system | A default, a constant, or a projection |
| **Promoted** | Beat the incumbent on held-out data, with the interval to prove it | Scored higher once |

## Bounded contexts

### 1. Grounding (core domain)
Turns a question into cited source. **Aggregate: `Citation`** — `{repo, docPath, title}`.
**Invariant:** a Citation is valid *only if* `docPath` resolves to a real passage in
`<repo>.passages.jsonl`. An unresolvable citation is not a weak citation; it is a fabrication, and
must be rejected with a distinct reason (`no-citations` vs `citations-do-not-resolve`).
*Enforced today by `kb/verify-citation.mjs`.*

### 2. Evaluation (core domain)
Decides whether a change may ship. **Aggregate: `HeldOutSet` + `Baseline`.**
**Invariants:** the set is frozen and never tuned against; expectations are chosen from first
principles *before* the system is run; promotion requires the **Wilson lower bound** ≥ baseline —
never a point estimate; and a missing baseline is a failure, because you cannot promote against
nothing.
**Domain event:** `PromotionRefused(reason, interval)`.

### 3. Autonomy (supporting)
Runs work while no human is watching. **Aggregate: `LoopRun`** — `{iteration, doneCriteria, done,
next, blockers, noProgressCount}`.
**Invariants:** never halt to ask; always resume from the last checkpoint before doing work; stop on
done-criteria, on two no-progress iterations, or when a fenced action is required.
**Fenced actions** (a hard boundary, not a preference): publish, deploy, force-push, history rewrite,
data deletion, secret rotation, outward-facing posts, new paid spend.

### 4. Economy (supporting)
Owns what a turn costs the user. **Aggregate: `TurnBudget`** — `{injectedTokens, queries, latencyMs}`.
**Invariant:** cheapness is never bought with worse answers — any economy change is fail-closed
against the Evaluation context's baseline. A brain that is 90% cheaper and 5 points less grounded has
regressed.

### 5. Knowledge Supply (supporting)
Gets rUv's source and thinking into stores. **Aggregates: `RepoSnapshot`, `GistDocument`.**
**Invariants:** a private store never enters a shippable artifact (fail-closed: a fence that cannot be
read aborts the build); **every** gist chunk carries its own provenance banner, because retrieval
returns *a chunk*, not a document — a banner on chunk 0 leaves chunk 2 naked.

### 6. Trust & Safety (supporting)
**Aggregates: `SignedBundle`, `PrivateFence`.** Invariant: fail closed. A missing signature, a corrupt
fence, or an unreadable topics file aborts — never degrades to "ship everything".

## The anti-corruption layer

Every foreign capability crosses one boundary, and nothing crosses it unchecked.

```
  agentic-qe · metaharness · routing_economics · rulake · GitHub · npm
                              │
                    ┌─────────▼──────────┐
                    │  Verifier port      │   REJECT unless the result carries a receipt
                    │  (ACL)              │   we can re-derive from the artifact itself
                    └─────────┬──────────┘
                              │
         Grounding · Evaluation · Autonomy · Economy · Knowledge · Trust
```

**Three rules, each written from a real incident:**

1. **A tool's `success` is not evidence.** Translate the tool's own trace, not its verdict.
   `metaharness_evolve` reported success while the wrapper reported `degraded: true`.
2. **A number without an observation is dropped, not relayed.** `routing_economics` has never seen a
   token of ours; its `qualityScore` constants must never reach a user-facing sentence.
3. **A grade against an artifact we can read is re-checked against that artifact.** `qe_qx_analyze`
   graded a page in 2 ms; every claim failed against the real HTML.

**Corollary — the failure path must produce an error, not a number.** A killed test suite scored
`testPassRate: 0` and was promoted. `0` is the *absence* of a measurement; the scorer read it as one.
Any adapter that cannot distinguish "bad" from "unmeasured" is not an adapter, it is a rumour.

## Context map

| Upstream | Downstream | Relationship |
|---|---|---|
| Knowledge Supply | Grounding | Supplier — stores must exist and be fenced before anything is cited |
| Grounding | Evaluation | Supplier — Evaluation grades Citations, and only Citations |
| Evaluation | Economy | **Conformist** — Economy must accept Evaluation's verdict; it may never redefine "good" as "cheap" |
| Evaluation | Autonomy | Customer/Supplier — a loop may only promote what the gate accepts |
| Trust & Safety | all | Open-host, fail-closed — any context may abort the build |
| External tools | all | **Anti-corruption layer** — nothing enters without a re-derivable receipt |

## Consequences

- The ACL becomes a real module (`kb/verify-citation.mjs` is its first citizen), not a convention.
- "Verified" acquires a testable meaning, which is what makes a 1–100 score worth reading.
- Economy being *conformist* to Evaluation is the load-bearing constraint of the whole program: it is
  the reason a 90% token cut cannot quietly cost 5 points of grounding.
