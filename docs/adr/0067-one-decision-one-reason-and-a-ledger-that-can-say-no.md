---
id: ADR-067
title: One decision, one reason — and a ledger that can report bad news
status: Accepted
date: 2026-08-10
updated: 2026-08-10
authors: [Stuart Kerr, Claude Code]
tags: [hooks, architecture, enforcement, measurement, simplification]
supersedes: []
relates: [ADR-040, ADR-054, ADR-063, ADR-065, ADR-066, ADR-0012]
governs:
  - plugin/scripts/decision-gate.mjs
  - plugin/scripts/decision-outcomes.mjs
  - plugin/hooks/hooks.json
  - tests/unit/decision-gate.test.mjs
  - tests/unit/decision-outcomes.test.mjs
---

# ADR-067 — One decision, one reason

**Status**: Accepted

## The measurement

Read from `hooks.json`'s own matchers, 2026-08-10:

```
Write | Edit  →  hijack-ruvnet · ground-before-write · protect-state · unprompted-speech
Bash          →  hijack-ruvnet · design-wall · unprompted-speech
```

**Four independent processes could refuse the same Write.** Five `exit 2` sites across four bash
scripts, no precedence, no shared context, no way for any of them to know what the others thought.
Whichever exited first won; the user got that one's reason and no hint that a second wall stood
behind it. Fix the first, re-run, hit the second — one round-trip per wall.

That is the concrete form of the owner's own words: *"not just a bunch of constraints rules that
break and collapse on each other."* Nothing owned the decision, so everything had an opinion.

## Decision 1 — the refusal chokepoint

**Every refusal of a tool call passes through ONE gate that consults every policy and alone decides.**

Not a new mechanism: this is ADR-040's invariant for *speech* (`unprompted-runtime.mjs` — "ONE runtime
alone decides whether bytes reach the user") applied to the other half. One pattern used twice keeps
the codebase learnable; inventing a parallel vocabulary here would repeat exactly what ADR-066
records.

**The policies do not change.** Each already speaks a precise contract — `exit 0` allow, `exit 2` +
stderr refuse — documented identically in all four files. That contract *is* a verdict function; it
was only ever missing a caller. The gate runs each as a captured child and reads `(code, stderr)`.
Zero edits to four working guards, zero new protocol to keep in sync, every existing per-policy test
still exercising the real thing.

What the user gains: one message naming the policy that refused **and every other that also would
have**; declared precedence (consent → correctness → grounding → taste); one process on the hot path
under one deadline.

**Fail-open, deliberately.** Any failure of the *gate itself* allows. `lesson-gate.mjs` states the
rule this repo paid for: a gate that blocks because it cannot read a config file "would be worse than
no gate, and would be switched off within a day, which is how every over-eager gate dies."

## Decision 2 — measure whether a refusal teaches

ADR-066's honesty boundary said it plainly: *"Delivery is proven; obedience is not measured."* And
`lesson-stamps-prove-ceremony-not-obedience` — itself a bridged lesson — names that exact failure.

**What is NOT observable:** whether the model obeyed an advisory. It reaches the context and what
happens next is unconstrained prose. Claiming to measure it would be the inflated-score failure.

**What IS observable**, from the one gate that sees every Write/Edit/Bash — what happened after a
refusal:

| outcome | meaning |
|---|---|
| `corrected` | the same target was retried and ALLOWED — the reason landed |
| `repeated` | retried and refused again — the reason did **not** land |
| `abandoned` | never retried. Ambiguous on purpose, never counted as a win |

**The one way to fabricate this is to record only `corrected`.** So the invariant is not "record
outcomes" but **every refusal produces exactly one record**, and `abandoned` is what an unresolved
refusal becomes — swept from the gate on activity, not at SessionEnd, because SessionEnd does not
fire on a crash, a kill, or a compact (ADR-027 already paid for that with 1,884 undelivered events).
An empty ledger reports `null`, never 0% or 100%: both are claims about a measurement that has not
happened.

## Decision 3 — the bridge reads both tiers

`lesson-bridge` read only global memory. A project's own `.swarm/memory.db` holds the lessons learned
*here*, and 35 of them reached nothing. Both tiers now bridge, distinguished only by SCOPE: a global
row is unscoped (it won twice, it may travel), a project row carries its own directory so
`lesson-gate`'s existing `isHome()` keeps it home. Ten were tagged; the rest are reported unbridged
by name, most because they duplicate a native or global lesson and a second copy teaches skimming.

## What this cost to learn

1. **`skipNoBash` is not a predicate.** It is a one-time notice emitter that returns 0 and writes to
   stderr — which on this hot path *is* the refusal channel. Calling it would have injected an install
   hint into the middle of a refusal. Read the signature; do not infer it from the name.
2. **A `const` arrow used by a top-level block is in the temporal dead zone.** The first live refusal
   threw `Cannot access 'speechEventFor' before initialization`.
3. **Severity had to outrank enforcement class.** Bridging ten project `checklist` lessons displaced
   issue #122's high-severity `inject` lesson from `write-code` — the *second* time in one day that
   lesson lost its slot. With `limit: 3`, selection is the scarce resource: what matters more must not
   lose to what merely acts more forcefully. The prior test asserting the old rule was updated with
   the reason, not silently flipped, and a case still proves enforcement decides at equal severity.

## Honesty boundary

- **MAY claim**: exactly one hook can refuse a given tool call, pinned by a test that reads
  `hooks.json` and fails if a second refuser ever appears; and refusal outcomes are now recorded with
  `abandoned` inside the denominator.
- **May NOT claim**: that advisory lessons change behaviour. That remains unobservable and unmeasured,
  and is stated rather than estimated.
- **Coverage is partial and deliberately so**: this measures the blocking path. Advisories are counted
  as surfaced for coverage and never scored.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-10 | Accepted as built: `decision-gate.mjs`, `decision-outcomes.mjs`, `hooks.json` rewired from 7 PreToolUse entries (4 able to refuse) to 4 (1 able to refuse). | Live-fired both paths: allow → exit 0, 1525B advisory forwarded, byte-empty stderr; refuse → exit 2, the policy's own words, byte-empty stdout. Obedience loop proven end-to-end: refuse → retry → scored `repeated`; a dead session's debt → `abandoned`. 152/152 across the six affected suites, and the structural invariant is mutation-proved (re-adding a second refuser fails two cases). |
