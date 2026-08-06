---
id: ADR-048
title: Measuring latency-to-surface, and claiming the right to speak
status: Accepted
date: 2026-07-24
updated: 2026-08-06
authors: [Stuart Kerr, Claude Code]
tags: [proactive, advocacy, L3, metrics, latency, concurrency, 4.0]
supersedes: []
relates: [ADR-027, ADR-028, ADR-042, ADR-047]
governs:
  - scripts/latency-to-surface.mjs
  - scripts/advocacy-outcomes.mjs
---

# ADR-0048 — Measuring latency-to-surface, and claiming the right to speak

**Status**: Accepted
**Date**: 2026-07-24
**Unblocks**: ADR-042 Gate 2 (real-ledger metrics), partially.
**Related**: ADR-027 (advocacy), ADR-028 (what proactive means), ADR-047 (Rejected — offer delivery)

## Context

An independent grader assessed 3.9.56 on 2026-07-24 with no access to our claims, running its own
commands. It scored PROACTIVE 64 / LEARNING 66 / USER IN CONTROL 84 and returned "4.0.0 today: NO."
Two of its deductions were not opinions but absences, and both are addressed here.

**-6, latency-to-surface.** ADR-028:103 defines it — "time between a capability becoming dormant and
the user being told" — target "hours, not weeks", against a 21-day baseline the ADR calls "the number
this whole project exists to destroy", and names it "the single best summary metric". The grader
searched `scripts/`, `plugin/`, and `tests/` and found no implementation. It was correct: the metric
existed only as prose, for 20 ADRs.

**-5, the offer ledger has no transactional claim.** From the ADR-047 duel, GPT-5.6-Sol drove
`shouldStillOffer()` to `true` with **twenty** offers already pending for the same finding. The
rejection of ADR-047 acknowledged the defect and did not fix it.

## Decision

### 1. Record capability state TRANSITIONS, and compute latency from them

The metric is a subtraction, and only one operand existed. The advocacy ledger records when we
**spoke**. Nothing recorded when a capability **went dormant**, because the registry is a pure
detector: it reports the state it observes right now and keeps no history. A detector with no memory
can say "this is off"; it can never say "this has been off since Tuesday."

`scripts/latency-to-surface.mjs` supplies the missing operand as an append-only log, written from the
capability audit that already runs on every console load.

**Only transitions are recorded, and that is a correctness decision, not a disk-space one.** If every
observation were appended, "when did it go dormant" would depend on how often the console happened to
be opened: identical facts would read as "dormant 1 hour" for an hourly user and "dormant 1 week" for
a weekly one. Recording only changes makes the onset a property **of the capability** rather than of
our sampling schedule.

**Dormant means `off` or `idle` — never `absent`, never `unknown`.** `absent` was never installed, so
nothing lies unused. `unknown` means we could not establish the state, and silently converting that
into "off" would inflate the metric with invented dormancy — the exact fabrication the registry rule
exists to prevent.

**Two rules keep the number from flattering itself:**

- An offer made **before** the current dormancy began does not count as surfacing it. Otherwise one
  old notification would make every future lapse look instantly surfaced, and a capability could rot
  forever behind a good number.
- **`stillDark` is reported separately and never folded into the median.** Two capabilities surfaced
  in an hour plus one dark for a month averages to a beautiful ~1h — certifying precisely the outcome
  ADR-028 exists to prevent. Successes and failures are not averaged together.

**The honest null.** With no history every latency is `null`, never `0`. A fresh install has not
achieved instant surfacing; it has no measurement. Rendering that as zero would be the product's
first lie about itself.

### 2. `claimOffer()` — an atomic right to speak

`shouldStillOffer()` is a pure read over the ledger. Two Claude Code sessions in two terminals — the
normal way this product is used — both read "not yet offered", both conclude yes, and the user is
told twice. Nothing between the read and the write said "mine."

A lock around the whole decision is the obvious fix and the wrong one: the decision reads the ledger,
and this repo has already been burned holding a lock across a read (`updateLessons` read outside its
own lock and raced anyway). So the claim is narrow — it protects **the right to speak**, not the
decision.

Leases expire (default 60s), because a crashed session must never silence a capability forever. The
asymmetry is deliberate and runs one way throughout: a **missed** offer is the failure this product
exists to prevent; a **duplicate** is merely annoying. Every error path — unwritable directory,
unparseable claim, unexpected FS error — therefore fails **toward speaking**.

## Consequences

**A bug in the first implementation, found only because the test forks real processes.** The obvious
primitive is `open(file,'wx')` then `write()`. It is wrong: `wx` publishes the filename *before* the
content, leaving a window where the claim exists and is EMPTY. Competitors read it, fail to parse it,
conclude "unknown age ⇒ stale ⇒ take over", and speak. **Measured with 12 concurrent OS processes:
five of twelve won.** A single-process loop would have been serialised by the event loop, reported
one winner, and hidden the defect completely.

The fix is write-then-`link()`: content is staged in a private temp file, so the moment the claim name
becomes visible it is already complete and parseable, and `link()` supplies the same atomic
exactly-one-winner guarantee with no torn state for losers to misread. **12/12 processes, one winner,
three consecutive runs.**

This generalises, and it is the second time in one session the same shape has appeared: *a test that
cannot fail on broken code is not a test* — and for concurrency specifically, a race test that does
not actually race is not a race test.

**What this does NOT close.** Latency now has an instrument, not a measurement: this machine has zero
dormancy history, so the metric honestly reports "no data". The 21-day baseline remains prose until
real dormancy is observed and surfaced. The ground-truth cohort is still 2 of 11 capabilities.
`offer_id` and `session_id` identity, and a monotonic state generation, remain open from Sol's list —
`claimOffer` addresses the race, not the identity model. **3.9.x-dev remains the honest version.**

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-06 | `advocacy-outcomes.mjs` moved from `scripts/` into `plugin/scripts/`; `scripts/advocacy-outcomes.mjs` is now an `export *` shim. No measurement, threshold, or claim in this ADR changes — the module is byte-identical, only its home moved. | ADR-065: only `plugin/` reaches a user (`.claude-plugin/marketplace.json` declares `"source": "./plugin"`, and `update-apply.mjs` `stagePayload()` copies that directory verbatim), so a module outside it can never ship. Measured on this machine before the move: an install-shaped flattened fixture running `anticipate.sh --status` printed `advocacy-outcomes module not found at <fixture>/../../scripts/advocacy-outcomes.mjs` — the DismissalLedger this ADR governs was unreachable on every real install. After the move the same fixture renders the real ledger. `scripts/latency-to-surface.mjs` is untouched by that change and was re-read against this ADR: no drift. |
