---
id: ADR-066
title: The lesson bridge — machine-wide knowledge reaches the gate that already fires
status: Accepted
date: 2026-08-10
updated: 2026-08-10
authors: [Stuart Kerr, Claude Code]
tags: [learning, hooks, memory, agentdb, simplification]
supersedes: []
relates: [ADR-029, ADR-030, ADR-040, ADR-065]
governs:
  - plugin/scripts/lesson-bridge.mjs
  - plugin/scripts/lesson-store.mjs
  - tests/unit/lesson-bridge.test.mjs
---

# ADR-066 — The lesson bridge

**Status**: Accepted

## The measurement

Two stores of "what we learned" existed on the owner's machine, connected by nothing. A grep for a
reader settled it: no `lesson-*` script referenced `.swarm/memory.db`.

```
~/.config/ruvnet-brain/lessons.json                17 lessons  → lesson-gate → the model
~/.claude/global-memory/.swarm/memory.db (global)  33 lessons  → nothing
```

The disconnected 33 are the expensive ones. Global memory is Tier 1 of the promotion ladder: a
lesson reaches it only after independent rediscovery in more than one project (ruflo ADR-G008, *win
twice to promote*). By construction they are the lessons that generalise — and they were the ones
with no way to speak.

What that cost, precisely. `lesson-tests-that-cannot-fail-on-broken-code` was recorded 2026-07-21:
*"WOULD THIS TEST FAIL IF THE THING IT GUARDS WERE BROKEN? Prove it by breaking the code and watching
it fail."* On 2026-08-08 this repository shipped issue #122's guard as a test that piped `/dev/null`,
where stdin EOF made the enabled and the disabled case **both exit 0** — a test that could not fail,
written 18 days after the lesson naming that exact mistake was already on the machine.

The knowledge was not missing. Nothing put it in front of the decision.

## Decision

**Bridge the store; add no gate.**

47% of this repo's 76 issues are gates that cannot pass or surfaces that state something false
(ADR-065). The reflex to unlearn is answering every incident with another gate. So this adds zero
hooks, zero matchers and zero decision points, and feeds the pipeline that already exists and is
already proven live:

```
AgentDB global store ─▶ lesson-bridge ─▶ lessons.json ─▶ lesson-gate ─▶ unprompted-runtime ─▶ model
                        (new, 1 file)    (unchanged)     (unchanged)     (ADR-040 chokepoint)
```

A bridged lesson **is** a native lesson by the time anything reads it, so the frequency cap, the
project-scope filter, nudge-not-block, and the single-writer chokepoint all apply unchanged.

## The trigger lives on the row

A lesson with no trigger is prose, and `lesson-store` refuses it. The two obvious ways to supply one
are both wrong:

- **Classify the text.** A keyword mapper guessing which moment a lesson belongs to. ADR-065 was
  written hours earlier about exactly this: its own 17/0 split came from a keyword classifier and the
  first spot-check found a false positive.
- **A side manifest.** A second file naming the same rows — the disease itself, drifting the first
  time a lesson is added to one and not the other.

So the trigger is a **tag on the AgentDB row**, using rUv's own structured fields (`--tags`, and
`--provenance` per ruflo ADR-323):

```bash
ruflo memory store --path ~/.claude/global-memory/.swarm/memory.db -n global \
  -k "lesson-tests-that-cannot-fail-on-broken-code" --value "<text>" \
  --tags "trigger:write-code,enforce:inject,severity:high" --provenance user_claim
```

One fact, one place, carried by the store that already owns the lesson. This is
`lesson-govern-at-structured-boundaries` applied to the bridge itself. **An untagged lesson does not
bridge and is reported by name** — silence would read as "that is all there is".

## The trust boundary is not widened

A bridged lesson is `origin: imported` unless the row's own `provenance` column says `user_claim`,
and `makeLesson` refuses `enforcement: block` on anything that is not user-stated. Blocking
additionally requires the opt-in file the mining pipeline never writes. The worst a planted global
row can achieve, even tagged, is an advisory the user sees and can delete.

## What this cost to learn, recorded because it is the point

Three defects were found by running it rather than reviewing it, and each is a lesson already in the
store being violated by the file built to carry it:

1. **The tag parser read the wrong wire shape.** `ruflo memory store --tags "a,b"` accepts a comma
   string and *persists a JSON array*. The CLI reported success on all 30 rows; the bridge read 0.
   The test fixture had been built to the same assumption, so it was green while the product read
   nothing — `lesson-fixture-cannot-falsify-its-own-choice`, verbatim. The fixture now writes what the
   CLI writes.
2. **`limit: 3` silently dropped the most important lesson.** Five lessons compete at `write-code`;
   ranking was enforcement then repeat count, so equal-force lessons fell back to array order and the
   `severity: high` one — issue #122's own lesson — lost its slot. `lessonsFor` now breaks the tie on
   severity first, which is `weightOf`'s documented reasoning applied where `limit` decides who
   speaks.
3. **The 500-line ceiling caught the comment explaining fix 2**, which is the guard working.

## Consequences

- 30 machine-wide lessons now fire across 10 decision points; 3 are deliberately not bridged
  (a duplicate, a project-specific playbook, a machine fact with no decision point).
- Adding a lesson to global memory now has a defined path to behaviour: tag it. No code change.
- The store grows without bound while the nudge stays budgeted — the presentation layer caps at 3 per
  trigger and 1200 characters total, so lesson #60 costs nothing at the point of delivery.

## Honesty boundary

- **MAY claim**: the bridge is wired and delivering. Measured live — `PreToolUse-write` carried
  `A TEST THAT CANNOT FAIL ON BROKEN CODE IS NOT A TEST` after the change and did not before.
- **May NOT claim**: that this changes outcomes. Delivery is proven; *obedience is not measured*, and
  `lesson-stamps-prove-ceremony-not-obedience` is itself one of the bridged lessons. Whether a
  surfaced lesson alters what gets written is unmeasured and stays unmeasured until there is a
  counter.
- **Not addressed here**: the four independent blocking hooks that can each refuse the same
  `Write`/`Edit` with no shared precedence. That is a separate consolidation, still open.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-10 | `lesson-bridge.mjs`'s entrypoint guard and its test structure changed. **The decision is unchanged** — the tag-on-the-row design, the trust boundary, and the "no new gates" constraint all stand. | Two Windows/Node defects in MY code, found by CI, not by review. (1) `new URL(import.meta.url).pathname` yields `/D:/…` on Windows and `realpathSync` throws on an unresolvable `process.argv[1]`, so the guard crashed the suite that merely imported the module (`ENOENT: lstat 'D:\D:'`). Fixed to the pattern already present in `scripts/selfcheck.mjs:660` and `plugin/scripts/hook-input.mjs:538`, and swept across every shipped `.mjs` by `tests/unit/entrypoint-guard-safety.test.mjs`. (2) The test imported `node:sqlite`, absent on Node 20 which CI's `check` job runs — the PRODUCT was always fine (it probes, falls back to the `sqlite3` CLI, then to a no-op), only the test was absolutist. Restructured so every case encoding a trust boundary or refusal runs on plain rows on EVERY runtime, and only the two database-reader cases are conditional. |
| 2026-08-10 | **Honesty boundary corrected.** This ADR claimed "the bridge is wired and delivering — measured live". That measurement was taken on macOS/Node 24 only, and CI then failed on Node 20 and on Windows. The delivery claim holds for the platform it was measured on; it was not evidence about anyone else's machine. | `lesson-test-the-artifact-not-the-checkout`. The three CI defects above were all invisible to a green local run, by construction. |
