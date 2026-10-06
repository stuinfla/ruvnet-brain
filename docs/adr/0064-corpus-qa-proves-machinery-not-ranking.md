---
id: ADR-064
title: The corpus-QA round trip proves the machinery, not the ranking
status: Accepted
date: 2026-08-06
updated: 2026-10-05
updated_source: derived-from-git
reviewed_digest: 4065daa92b17
version: 1.0.3
authors: [Stuart Kerr, Claude Code]
tags: [corpus-qa, nightly, retrieval, near-duplicates, diagnosability, escalation]
supersedes: []
relates: [ADR-050]
governs:
  - scripts/corpus-qa.mjs
  - scripts/self-update.mjs
  - scripts/nightly-wrapper.sh
  - tests/unit/corpus-qa.test.mjs
  - tests/unit/self-update-failure-reason.test.mjs
---


## Current source review — 2026-10-05

Reviewed candidate source `1ccc1e633772c549e4a23596a1ce3c743e797315`. The accepted
machinery-versus-answer-quality distinction remains intact. `scripts/corpus-qa.mjs` still
checks structure, vector/read compatibility, and bounded deterministic self-retrieval; it
reports near-duplicate/deep-crowd observations and fails absence from the wider query window.
`tests/unit/corpus-qa.test.mjs` remains the fixture boundary for those semantics. A passing
round trip is not evidence that real user questions retrieve the right answer.

The source formula is `min(500, max(10, floor(n/2)))`. Its lower floor means that for a tiny
corpus of at most ten rows the requested window can cover the entire corpus; the historical
absolute “never the whole corpus” sentence below is therefore too broad. For larger stores
the window remains a bounded subset. Whole-corpus presence alone cannot establish ranking
quality or eliminate the need for structural/negative controls. This document-only review
neither changes the formula nor runs a fresh real-store retrieval campaign.

`scripts/self-update.mjs` captures and re-emits the verdict-bearing streams and preserves a
bounded failure reason; it is an author-side candidate builder whose apply path refuses an
unsafe worktree, not an installed updater or publisher. `scripts/nightly-wrapper.sh` is likewise
an author diagnostic. Its learning step now requests the full causal portfolio through native
Codex rather than the historical single Haiku trap; source wiring does not prove that it is
scheduled, ran, completed, or established current learning quality. No such model run was made
for this review. Current corpus publishing belongs to the protected workflow described in
CONTRIBUTING.md, and installed refresh ownership remains separate. The 2026-08 real-data A/B,
mutation campaign, and abort/stamp observations below remain historical evidence with their
original artifact bounds, not proof of today's store generation.

# ADR-064 — The corpus-QA round trip proves the machinery, not the ranking

**Status**: Accepted

**Date**: 2026-08-06

## The problem, measured

The nightly knowledge-bundle rebuild failed **six times across three nights** (2026-08-03 →
2026-08-06) on the same row, and escalated six times saying nothing.

`logs/nightly.log` lines 16531, 16891, 17307, 17662, 18117, 18489 — identical every time:

```
metaharness               big     8986      721     8986     2/3        FAIL
    ↳ R1 self-retrieval missed: id=chunk:2b7c2755… ABSENT from top-10
      submissions/swe-bench-lite/darwin-glm-opus-cascade/logs/django__django-13315/test_output.txt
```

Not a build failure. A **QA-gate verdict**, and a wrong one.

### What the row actually is (measured, read-only, on a copy of the live store)

| Question | Measured |
|---|---|
| Is the vector in the store? | **Yes** — rank **188** at k=500 |
| Is it absent from top-10? | Yes — hence the FAIL |
| How far behind #1? | Δ**0.0557** cosine |
| What is ahead of it? | **187 of 187** hits share its first 200 normalized characters |
| What is that text? | conda-activation boilerplate (`export PATH=/opt/miniconda3/envs/testbed/…`) |
| How much of the corpus is that shape? | **4,428 of 8,979 rows = 49.3%** are `submissions/swe-bench-lite/**` |

The store is correct. The row embeds, writes, and reads back fine. It simply loses a popularity
contest to 187 near-copies of itself.

### Why it appeared out of nowhere

`scripts/corpus-qa.mjs` samples deterministically from the row count:

```js
const picks = sampleIndices(`${store}.${variant}`, rows.length, samples);
```

`rows.length` is part of the hash input, so **every change in passage count re-rolls the entire
sample**. Verified:

| rows | picks |
|---|---|
| 8,945 | `[305, 6049, 6707]` |
| 8,979 | `[5565, 1433, 4850]` |
| **8,986** | `[1188, **1945**, 8660]` |

The failing chunk sits at index **1945**. It had been un-self-retrievable the whole time; the corpus
growing by seven rows is what pointed the sampler at it. With ~49% of the corpus in near-duplicate
families, a re-roll lands on one of these roughly one time in four — so this recurs on a coin flip,
forever, until the rule changes.

### The rule was wrong, by the file's own contract

`scripts/corpus-qa.mjs` states its own scope:

> "Retrieval QUALITY (real questions) stays forge-guard/prove's job; **this gate proves the
> machinery, not the answers.**"

Requiring a row to *win its own query* inside a half-near-duplicate corpus is an assertion about
ranking quality. That is the bug: the gate was enforcing a promise it had explicitly disclaimed.

## Decision

**A row that is present and readable passes. A row that cannot be found at all fails.**

On anything that is not a clean top-3 hit and not a NEAR_DUP_EPS photo-finish, R1 **re-queries wide**
before returning any verdict:

- **Present within wide k** → **PASS**, with a loud `deep crowd` note carrying the rank, the window,
  the Δ behind #1, and how many hits ahead of it are its own near-duplicates.
- **ABSENT from wide k** → **hard FAIL**, unchanged and unweakened. A missing vector, a zero vector,
  a mis-slotted vector, and a broken read path are absent at *any* k; nothing forgives them.

`WIDE_K = 500` (~5.6% of metaharness), bounded by `wideKFor(n) = min(500, max(10, floor(n/2)))`.
For corpora larger than the minimum window, wide k stays below the whole corpus. The current
implementation's floor of 10 can cover every row of a corpus with at most 10 rows; the absolute
historical "never whole corpus" claim was stronger than the implemented boundary. Whole-window
presence alone does not establish ranking quality.

### The wide arm covers both shapes of miss, deliberately

It would have been smaller to re-query only on a top-10 *absence*. That is incoherent: a row buried
under 187 siblings would pass while the same row buried under 5 failed. Since crowd depth is a fact
about corpus composition and not about store health, both shapes route through the same check.

**This supersedes the previous "ranked 4th+ and more than NEAR_DUP_EPS behind #1 is a hard FAIL"
rule.** The epsilon arm is retained: it still labels drift-scale ties as `near-dup crowd` rather than
`deep crowd`, which keeps the two signals distinguishable for the dedup backlog.

## The second failure: the escalation carried no reason

The log had the answer every night. The alert never did.

`scripts/self-update.mjs` ran every child with `stdio: 'inherit'`. Verified live: a failing child's
Error then has `e.stdout === null`, `e.stderr === null`, and `e.message === "Command failed: <argv>"`
— **argv and nothing else**. That empty reason became the failure record, which became the `[FATAL]`
summary, which `scripts/nightly-wrapper.sh:159` sampled with `tail -8 | cut -c1-600` — truncating
mid-argv. Six escalations, zero information.

Two corrections were needed beyond the obvious one:

1. **Capturing stderr alone would not have worked.** `corpus-qa` prints its verdict table and every
   `↳ <reason>` line with `console.log` — on **stdout**. A stderr-only fix would have captured
   nothing for the exact failure it was meant to explain.
2. **The failing step was `[refresh]`, not `[qa]`.** `kb/forge-refresh.mjs` runs `corpus-qa` against
   its own **candidate** directory and refuses to promote on a FAIL, so the run died inside
   forge-refresh — before self-update's own `[qa]` step was ever reached.

`runStep()` now captures, **re-emits verbatim** (the log is unchanged), and keeps a bounded tail on
the failure record. Builders keep stdout inherited for live progress; the two steps that carry a
corpus-QA verdict capture both streams. The `[FATAL]` block prints each reason and the push alert
quotes the first. The wrapper sample is `tail -25 | cut -c1-2000`.

## What was deliberately NOT changed

**The all-or-nothing abort stays.** It was assessed and found correct, contrary to the initial
suspicion that it leaves `kb/` in a worse state than either extreme:

- `kb/forge-refresh.mjs:287` calls `promoteArtifactSet()` **only after** its candidate QA passes, so
  a failing store is never promoted — its candidate is discarded and the live store keeps its last
  good generation. Confirmed on disk: `kb/metaharness.passages.jsonl` is still the 8,979-row build
  from Aug 3 after six rejected 8,986-row candidates.
- `promoteArtifactSet()` (`kb/incremental-refresh.mjs:237`) is transactional per store — backup,
  rename in, roll back on error.

So after an abort, **every store in `kb/` is a store that passed its own QA**. Only the stamp and the
`dist/` bundle are skipped, which is precisely the conservative outcome: the published bundle stays
at the last fully consistent generation. Stamping anyway would ship a generation containing one
silently stale store — the "product can never lie" failure. Rolling back the stores that did promote
would require a cross-store transaction that does not exist and would discard good work for no gain.

Residual, accepted and unfixed: between an aborted run and the next successful one, `kb/` can hold
stores newer than the stamp that describes them. Local reads get fresh data with a stale generation
label. Noted, not load-bearing for anything published.

## Consequences

- The nightly stops failing on corpus composition; it still fails on a broken store.
- Near-duplicate crowding becomes a **visible, quantified signal** (`deep crowd: … 187/187 ahead are
  near-duplicates`) feeding the dedup backlog, instead of a nightly outage.
- A nightly failure now escalates with its reason attached.
- The R1 block went from **zero** coverage (eight `it.todo`s) to ten behavioural tests, each proven
  to fail under a targeted mutation of the code it guards (13 mutations, 13 caught).

## Verification

- Real-data A/B on a scratchpad copy of the live store, sampler steered onto index 1945:
  - pre-fix: `0/1 store-variants PASS — 1 FAILED … ABSENT from top-10` (reproduces the nightly byte
    for byte)
  - post-fix: `1/1 PASS` + `deep crowd: … rank 188/500 (absent from top-10), Δ0.0556 behind #1,
    187/187 ahead are near-duplicates`
- `.rvf` distance fidelity measured exact to ~1e-8 against `1-cos(θ)` before any rank-engineered
  fixture was written, so tests assert the numbers the gate really prints.
- Mutation campaign: 13 mutants across `corpus-qa.mjs`, `self-update.mjs`, `nightly-wrapper.sh` —
  every one killed by the intended test; sources restored and re-verified byte-identical.

## Currency log
| 2026-10-05 | Reviewed current source and recorded remaining limitations; no verification or implementation-status promotion. | reviewed_digest 4065daa92b17; inspected `scripts/corpus-qa.mjs` and all expanded governs against source 5d9ea4df. Independent review preserved incident dates, Proposed/expired states and historical evidence; notification and oldest-runtime limits are explicit. |
| 2026-09-27 | Currency review: decision unchanged. Motion: self-update.mjs restricted Cognitum ruOS to curated capabilities -- unrelated to corpus-QA's machinery-vs-ranking distinction, which is untouched. | Reviewed `scripts/corpus-qa.mjs`, `scripts/self-update.mjs`, `scripts/nightly-wrapper.sh`, `tests/unit/corpus-qa.test.mjs`, `tests/unit/self-update-failure-reason.test.mjs` against the commits listed above; reviewed_digest 75418dee4ddb. |
| 2026-09-11 | Currency review at commit 2eef2024: decision unchanged. Both drift commits (`7cf26dea`, `9b3e1d3f`) only reworded explanatory comment text in `scripts/nightly-wrapper.sh` describing the release-publication authority boundary ("It does NOT publish or dispatch a publisher..."); zero executable lines changed in either diff, and neither touches `scripts/corpus-qa.mjs`, `scripts/self-update.mjs`, or either test file. | Reviewed `scripts/nightly-wrapper.sh` (the only governed path that moved: `7cf26dea`, `9b3e1d3f`), `scripts/corpus-qa.mjs`, `scripts/self-update.mjs`; read both diffs in full, both comment-only. reviewed_digest 7d8b119122a9. |
| 2026-08-31 | Reconciled the remaining #193 reader asymmetry: `learn-flush.mjs` now explicitly uses the same containment-checked `projectDirectory({ env: process.env })` fallback as the capture writer. | `plugin/scripts/learn-flush.mjs`; `plugin/scripts/learn-capture.sh`; issue #193. |
| 2026-08-31 | Re-read after the release-control cutover; nightly convergence is now report-only and cannot dispatch a publisher, so it cannot bypass the signed review coordinator. Corpus-QA behavior is unchanged. | `scripts/nightly-wrapper.sh`; `scripts/release-convergence-watchdog.mjs`; `.github/workflows/release-cycle.yml`. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-22 | **Retired the primary-checkout nightly and moved corpus mutation behind a structural worktree boundary.** | The 2026-08-20 actuator was real but was wired to `com.ruvnet.brain-nightly`, whose working directory was the primary developer checkout. That job accumulated generated source alongside active work. The plist is retired and removed. Both `self-update.mjs --apply` and `ingest-new-repos.mjs --apply` now refuse primary, nested, non-linked, and dirty worktrees. The manual wrapper seals the primary HEAD, staged diff, tracked working diff, and non-ignored untracked set around a run. The prior row remains history, not current scheduling guidance. |
| 2026-08-20 | **Corpus coverage now closes on its own instead of being measured and left.** | `nightly-wrapper.sh` gained daily ingestion via the new `scripts/ingest-new-repos.mjs`. Nothing had ever loaded new rUv repos — measured 181 live, 69 ingested, 125 missing — while `brain-stamp.mjs` computed that gap every night and nothing consumed it. The QA machinery this ADR governs was never wrong about the number; it had no actuator. The new script ingests newest-first, bounded per night, and refuses to invent capability cards for what it ingests, because a card written from a repo NAME would route real questions to a corpus nobody grounded in the source. It also exits 1 on a failed org listing rather than reporting "0 new repos" — a list you could not fetch is not an empty list. |
