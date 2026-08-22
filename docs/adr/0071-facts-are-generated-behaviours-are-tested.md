---
id: ADR-071
title: Facts are generated, behaviours are tested — retire the fact-gates
status: Proposed
date: 2026-08-10
updated: 2026-08-22
updated_source: derived-from-git
authors: [Stuart Kerr, Claude Code]
tags: [architecture, gates, drift, simplification]
supersedes: []
relates: [ADR-011, ADR-056, ADR-058]
governs:
  - scripts/sync-version.mjs
  - scripts/sync-census.mjs
  - tests/unit/no-restated-truth.test.mjs
---

# ADR-071 — Facts are generated, behaviours are tested

**Status**: Proposed

## The measurement that forces this

Across all 76 issues this repository has received, **47% are one disease**:

```
20  a gate that cannot pass, or never fires
16  a surface that states something false
```

And of the 17 gates currently on the restated-truth debt list:

```
gates asserting a FACT (a value)  : 17
gates asserting a BEHAVIOUR       :  0
```

Every one is checking a *value*. None is checking that the system *does* something.

## The mistake, stated plainly

This repo has been answering every incident by **adding a gate**. That is why the gates now
collapse on each other — a real, observed sequence, not a worry:

- `doc-currency` REQUIRES an ADR's `updated:` stamp to move when governed code moves.
- `fix-workstream-guidance` FROZE that same stamp at `2026-08-02`.
- Correct maintenance of the ADR was therefore impossible: satisfying one gate broke the other.

The same shape recurred three more times in one week — a frozen coverage %, frozen repo counts,
frozen versions in six places plus a seventh that was missed. Each fix added or tightened a rule,
and the rules began contradicting each other because **nothing owned the fact; every gate had an
opinion about it.**

A constraint that guards a value is strictly worse than a producer that emits it:

| | gate | generator |
|---|---|---|
| when it acts | after drift, as a failure | before drift, as an output |
| failure mode | red build for an unrelated reason, or vacuous green | none — the value cannot disagree |
| conflicts | two gates can demand opposite things | one producer, one value |
| maintenance | must be updated when reality moves | reality moving IS its input |

## Decision

**A FACT is generated. A BEHAVIOUR is tested. Nothing else is a gate.**

1. **Every fact that appears in more than one place gets exactly one PRODUCER**, and every other
   occurrence is written from it. Drift stops being *detected* and starts being *impossible*.
   `sync-version.mjs` has done this for version strings for months and has produced zero issues of
   this class. `sync-census.mjs` (2026-08-10) does it for the corpus census, which had been
   hand-edited on three consecutive nightly rebuilds.

2. **The 17 fact-gates are RETIRED, not converted.** A gate that checks a generated value is dead
   weight: the generator already guarantees it. Retiring them removes 17 things that can break,
   rather than rewriting 17 things that can break differently. Each retirement is one commit and is
   provable alone — delete the gate, run the generator's `--check`, confirm the fact is still
   protected.

3. **What REMAINS a test is behaviour**: the publisher verifies hosts before sealing; an idle worker
   exits; a refused command names the sanctioned path; the reclaimer refuses a symlinked store file.
   These cannot be generated, and they are where tests earn their cost.

4. **`no-restated-truth.test.mjs` is scaffolding with an end date.** It exists to stop new fact-gates
   while the 17 are retired. When the debt list reaches zero, this ADR requires it be deleted too —
   a ratchet that outlives its debt becomes another rule nobody can remove.

## What this is NOT

It is not "fewer checks". The system ends up with *more* certainty and *less* machinery: a generated
value cannot be wrong, whereas a gated value is only as good as the gate's own freshness. The
publisher, host-convergence, idle-exit and refusal tests all stay.

## Consequences

- ~17 test files disappear over time; each removal is accompanied by proof the generator covers it.
- New facts require naming a producer, which is a design question asked once, rather than a gate
  written per incident.
- The failure mode that produced 47% of this repo's issues becomes structurally unavailable, instead
  of being caught later by something that itself needs maintaining.

## Honesty boundary

- **MAY claim** once the debt list is empty: facts in this repo are generated, and a surface cannot
  disagree with the artifact it describes.
- **May NOT claim** yet: the debt list holds 17 entries today and two producers exist
  (`sync-version`, `sync-census`). Everything above is a decision, not an accomplishment.
- **The 17/0 split is DIRECTIONAL, not audited.** It came from a keyword classifier, and spot-checking
  it immediately found a false positive: `install-scope.test.mjs` asserts `toBe('user')`, a string
  constant with no producer — a legitimate assertion, not a fact-gate. The first step of executing
  this ADR is therefore a hand audit of the 17, file by file, sorting each into GENERATED (retire),
  BEHAVIOUR (keep), or CONSTANT (keep). Acting on the unaudited number would repeat the mistake this
  ADR exists to stop: trusting a measurement because it was convenient.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-22 | `tests/unit/no-restated-truth.test.mjs`'s `isDebt()` now strips lines carrying a `// sync-version-ignore` comment before testing them against `RESTATED`. Dream Cycle 2026-08-22 (`enforcement-integrity`/`gate-teeth`) found the marker this gate's own failure message names as the sanctioned remediation ("add `sync-version-ignore` on the line and say why") was never read by `isDebt()` — an annotated line was flagged identically to an unannotated one, proven live with a red-before/green-after TEETH test. Zero of the 6 files (28 line occurrences, re-grepped directly — an earlier draft of this row said "7", which conflated a prose-only mention in `sync-version-drift.test.mjs`'s comments with a real per-line annotation; corrected before this ADR was touched again, per an independent adversarial critic's review of this same diff) currently using the marker were exercising it as a real exemption — each already escaped the narrow `RESTATED` regexes for an unrelated reason (a `v`-prefixed version string, a literal passed as a function argument rather than an assertion, a variable reference) — so this closes a latent gap rather than fixing a live false-positive. The strip also requires a `//` prefix, not a bare substring match, so the marker cannot be smuggled inside a string literal under test to blanket-exempt a real, unrelated offender sharing its line — a second finding from the same critic pass, fixed before this diff shipped. This is exactly the disease this ADR names — a documented remediation is a restated claim about the gate's own behaviour until the gate itself derives it — applied to the frozen-debt gate itself, not yet to the 17-file sweep this ADR still has open. | See `tests/unit/no-restated-truth.test.mjs`. |
