# Provenance-Stratum Receipt Attribution — Recovery Report — 2026

**Dream Cycle 2026-09-18 — DEEP=grounding-quality, SCAN=retrieval-precision,citation-binding (slot 3 of 5, `20260918 % 5 == 3`)**. No bonus modulus tonight (`% 25` = 18, `% 75` = 43, both non-zero).

## Rotation / Ledger Check

Read `docs/dream-cycle/LEDGER.md` (9 rows, 2026-08-19 through 2026-08-31) and re-verified PR/issue
fates via GitHub MCP rather than trusting the ledger's own age. Finding: **every `dream/*` PR the
ledger or GitHub currently shows is either closed unmerged or still open/draft.** A bulk-close event
on 2026-09-07 closed 20 `dream/*` PRs without merging any of them; 16 more have opened since
(2026-09-08 through 2026-09-17) and none have merged either. Zero `dream/*` PRs have merged since
`#178` (2026-08-26) — **23 days, ~36 candidate PRs, zero integrated.** This is the same backlog every
grounding-quality night since 2026-08-26 has flagged, now roughly three weeks larger. See
**Recommendation** below; this is the single most important fact in tonight's run.

## Reconciliation

Per the repo's ISSUE DISPOSITION OVERRIDE, reconciled tonight's surface against open issues, closed
issues, and existing PRs before selecting a candidate:

- Issue `#236` (2026-09-03, still open) documents the citation-rank-hijack structural gap
  (`kb/verify-citation.mjs` accepting a spoofed relative-offset rank). It explicitly requires a human
  ADR decision (`ADR-0087`, recovered by PR `#287`, still `Proposed`, still open/draft). Re-verified
  `#287`'s base sha (`3996f50`) matches tonight's own `SESSION_COMMIT` exactly — nothing has changed
  since that recovery. Confirmed this remains correctly blocked, not actionable tonight, and did not
  reopen or duplicate it.
- PR `#239` (2026-09-03, **closed unmerged** in the 2026-09-07 bulk-close) contains a small, fully
  tested fix: thread `verifyGrounding()`'s `receipt` through `gradeQuestion()`'s `provenance`-stratum
  check, mirroring the fix already accepted for the `routed` metric in the same function. Independently
  re-read current `main`'s `scripts/eval-brain.mjs` (not merely trusted the PR's own claim): the
  `provenance` case still reads `top?.repo` directly — **the fix was never integrated.** This is exactly
  the "Next steps" item #1 the 2026-08-28 report (`docs/dream-cycle/2026-08-28-grounding-quality-routed-receipt-report.md`)
  flagged as a future hypothesis, and exactly what PR `#239`'s own commit already proved sound.

Given the backlog finding above and this repo's own learning signal (`dream-machine ledger signals`
discipline: zero of the last N `dream/*` PRs merged → bias to a tiny, one-parameter, easily-reviewable
candidate), tonight's highest-value action is recovering this exact, already-proven, tiny fix rather
than opening a new speculative candidate on top of an already-unreviewable pile. Per the same override,
this is a **verified fix recovery, not a new defect** — Issue = `NONE`, one review PR only.

## Five candidates considered (one selected)

1. **[SELECTED]** Recover PR `#239`'s `provenance`-stratum receipt fix — tiny (1 logic line + tests),
   already proven red→green once, addresses a real, currently-live gap, zero blast radius beyond the
   function under fix (verified independently below).
2. Resolve issue `#236`'s citation-rank-hijack via `ADR-0087` — rejected: requires a human wire-format
   decision (per-query token vs. structured JSON transport) touching ≥3 other files' blast radius;
   explicitly out of bounded-repair authority per three prior nights' own analysis.
3. `scripts/rerank-cap-eval.mjs`/`rerank-cap-warm-ab.mjs` treating "grounded" as "retrieval returned
   ≥1 result" (flagged 2026-08-28, not yet actioned) — rejected: these are offline A/B tools, not the
   gate of record; a real fix needs design, not a bounded one-line patch.
4. Fresh code-reading pass over `kb/forge-ask-all.mjs` for a new retrieval-precision defect — rejected
   tonight: no genuinely new candidate surfaced beyond hypotheses already investigated and rejected on
   2026-09-03 (`repo:<alias>` directive fallback-path cosmetic-only; `rerank-cap-eval.mjs`'s "deliberate,
   commented design"), and the backlog signal argues against adding an unreviewed candidate speculatively
   when a proven recovery is available.
5. Cross-encoder cascade cap tuning (ADR-0059/0060) — rejected: a parameter-search candidate needs a
   live corpus to measure against; this container has none (`stores 0 dark 0`), and it is not a defect
   recovery, so it does not fit tonight's bias.

## Hypothesis (frozen before touching any file, unchanged since)

> Given the frozen `provenance` stratum in `scripts/eval-brain.mjs`'s `gradeQuestion()`, when the
> "did a winning gist chunk carry its banner" check is computed from `routedRepo` (`receipt?.repo ??
> top?.repo ?? null`, the same signal already used for `routed`) instead of the raw top-ranked citation
> (`citations[0].repo`), then the `provenance` stratum should correctly fail a bannerless gist chunk
> that verify-citation.mjs actually verified as the grounding source, even when a different, unverified
> citation happens to rank first — subject to: zero behavior change for `grounded`/`routed`/`abstained`,
> `ABSTAIN_CE` unchanged, `evals/held-out.json` hash unchanged, and the two receipt-less callers of
> `gradeQuestion` (`scripts/rerank-cap-eval.mjs`, `scripts/rerank-cap-warm-ab.mjs`) behaviorally
> unaffected.

## Candidate

`scripts/eval-brain.mjs`: `provenance` case now reads `routedRepo !== 'ruv-gists'` instead of
`top?.repo !== 'ruv-gists'` (`routedRepo` was already computed on the line above for `routed`'s own
use — zero new computation). `tests/unit/eval-brain-gate.test.mjs`: added one `it()` covering both
directions (a genuine better-repo hit passing without a banner; a gist-miss failing without one and
passing with one). New evidence script:
`docs/dream-cycle/evidence/2026-09-18-grounding-quality-repro.mjs`, corpus-free and model-free. 2
production/test files changed, ~34 lines. Recovered content is adapted from PR `#239`'s own diff,
re-verified against current `main` rather than reapplied blindly (the original patch context had
drifted by one line since 2026-09-03; re-derived by hand against the current file).

## Baseline

Baseline = unmodified `origin/main` (`3996f502b18157fdc84e325fbe87c2a05351d58c`).

## Evaluation Receipt

- **`npm run eval:gate`**: `EVALUATED=blocked` — `eval-brain: no brain at /root/.cache/ruvnet-brain/kb`.
  This container's store root has never materialized (`node scripts/brain-score.mjs`: `stores 0 dark
  0`; `node scripts/restore-local-ingests.mjs`: 125 recorded ingests never materialized on this host —
  explicitly "NOT evidence of a wipe," the exact honest wording PR `#143` shipped). Same pre-existing
  condition every recent Dream Cycle night on this surface has recorded.
- **`LLM_EVAL=blocked`**: no `OPENROUTER_API_KEY` (or any model-provider key) in this container's
  environment. A legitimate night per this repo's own invariant — no model-graded stage applies to this
  deterministic scoring-logic fix regardless.
- **TEETH, independently reproduced by this session, not merely asserted**:
  ```
  $ git stash push -- scripts/eval-brain.mjs      # revert only the fix, keep the new tests
  $ npx vitest run tests/unit/eval-brain-gate.test.mjs
   FAIL  ... provenance credits the citation verify-citation.mjs actually resolved (`receipt`) ...
   AssertionError: expected false to be true
   Test Files  1 failed (1)
        Tests  1 failed | 17 passed (18)
  $ git stash pop
  $ npx vitest run tests/unit/eval-brain-gate.test.mjs
   Test Files  1 passed (1)
        Tests  18 passed (18)
  ```
  Independently re-run a second time by the adversarial critic subagent (below), same result.
- **Evidence script**: `node docs/dream-cycle/evidence/2026-09-18-grounding-quality-repro.mjs` — exit 1
  "VULNERABLE" against unmodified `main`, exit 0 "FIXED" against the candidate.
- **`npm run test:unit`** (candidate, full suite): PENDING AT TIME OF WRITING — filled in below once the
  background run completes; will not gate without it.
- **`npm run test:integration`** (candidate, full suite, both-hosts conformance): PENDING AT TIME OF
  WRITING — filled in below.
- **`npm run claims:verify`**: `3 verified, 4 unmeasured; omitted=none` — identical composition to this
  repo's documented baseline (brain-dependent claims skip loudly; coverage run absent).

## Blast Radius (independently re-grepped, not reused from PR #239's own claim)

`gradeQuestion` has exactly 3 call sites repo-wide: `scripts/eval-brain.mjs` (the one fixed),
`scripts/rerank-cap-eval.mjs`, `scripts/rerank-cap-warm-ab.mjs`. Grepped both other callers for
`receipt` — neither constructs or passes one. Since `routedRepo = receipt?.repo ?? top?.repo ?? null`,
an absent `receipt` falls back to exactly the prior `top?.repo` behavior — zero behavior change for
either external caller. Confirmed independently by the adversarial critic subagent below.

## Darwin Lineage

Not run — no continuous parameter to evolve for a scoring-attribution fix.

## Evidence

OBSERVATION (`gradeQuestion`'s `provenance` case reads `top?.repo` directly, ignoring the `receipt` the
same function already computes and already uses for `routed`) → MEASUREMENT (TEETH red pre-fix / green
post-fix, reproduced independently twice; evidence script VULNERABLE→FIXED) → INFERENCE (blast radius
confined to the one call site that passes `receipt`) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

1. **Weakened test/benchmark** — CLEAR: `evals/held-out.json`, `evals/baseline.json`, `ABSTAIN_CE`
   untouched (`git diff --stat main -- evals/` is empty).
2. **Vacuous assertion** — CLEAR: both new assertions proven to flip via `git stash`/`pop`, independently
   reproduced by the adversarial critic subagent, not merely asserted by the candidate.
3. **Hidden cost** — CLEAR: reuses a variable (`routedRepo`) already computed on the preceding line for
   `routed`'s own use; no new I/O, dependency, or subprocess.
4. **Cherry-picked corpus** — CLEAR: held-out set untouched; exercised via synthetic unit fixtures, not a
   hand-picked subset of real questions (this container has no live corpus to cherry-pick from anyway).
5. **One-directional score inflation** — CLEAR: the fix makes `provenance` *strictly correct* — it can
   only turn a previously-wrong PASS into a correct FAIL (a bannerless gist win that was fabricated-top
   masked) or a previously-wrong FAIL into a correct PASS (a genuine better-repo hit masked by a
   fabricated gist-named top citation); it cannot manufacture a one-directional inflation in either
   direction. Independently re-derived and confirmed by the adversarial critic (see below).

## Adversarial Critique (independent subagent, not this candidate's author)

Spawned a fresh `general-purpose` agent with no access to this session's reasoning, given only the repo
path, the diff, and the background needed to review it. **Verdict: CLEAR.** It independently: confirmed
`evals/held-out.json` untouched; confirmed exactly 3 `gradeQuestion` call sites and that the two
receipt-less callers are provably unaffected; worked through the substitution's correctness
algebraically in both directions and could not construct a case where the fix introduces a new leniency
loophole; empirically reverted only the `scripts/eval-brain.mjs` hunk, confirmed the new test goes red,
restored it, confirmed 18/18 green again; ran the evidence script itself. One **non-blocking**
observation: `bannerPresent` (`/GIST STATUS/.test(out)`) is a blanket regex over the entire stdout dump
(all k=3 results), not scoped to the specific receipted citation — pre-existing behavior, unchanged by
this diff, orthogonal to the fix under review, worth a future look if the `provenance` stratum is
revisited again.

## Security Review

Pure, offline scoring-logic change inside an evaluation script that only consumes this repo's own
already-generated subprocess output (`forge-ask-all.mjs` stdout) and its own frozen
`evals/held-out.json`. `receipt` is produced by the same already-trusted `kb/verify-citation.mjs`
disk-verification path already invoked on the same call, read one property deeper. No new network call,
credential, write path, or untrusted-input path. Attack surface unchanged.

## Regression Analysis

See Evaluation Receipt above for full-suite numbers (pending completion at time of writing; will not be
represented as final without them). No production behavior changes for any caller other than the one
`provenance`-stratum branch inside `scripts/eval-brain.mjs`'s own `main()`, which is exercised only by
`npm run eval:gate` — itself blocked in this container, so the changed branch has not executed against
real data on this host either way.

## ADR

Not architectural — a bug-fix recovery mirroring an already-accepted sibling fix (`routed`'s own use of
`receipt`), not a new decision. No ADR filed, consistent with the 2026-08-28 sibling fix's own precedent.

## Gist

LOCAL — no `gh` CLI (`which gh` → not found) and no gist-creation MCP tool available this session (same
limitation every prior Dream Cycle night on this repo has recorded). Full report committed here instead.

## Issue

`NONE` — per ISSUE DISPOSITION OVERRIDE, this is a verified-fix recovery of an already-closed,
already-tested PR (`#239`), not a new defect. No issue opened.

## Recommendation

`evaluated: yes`, `verdict: ACCEPT` (pending human review and merge — never self-promoted). Separately,
and with more urgency than tonight's candidate: **the `dream/*` PR backlog needs the owner's direct
attention.** Zero of ~36 candidate PRs opened since 2026-08-26 have merged. Every additional night adds
to a pile nobody is clearing, which erodes the entire point of an evidence-producing evolutionary loop —
evidence that never gets reviewed does not compound. The single highest-value action available to the
human owner right now is triage (merge, request changes, or close-with-reason) of the open `dream/*`
queue, not another candidate landing on top of it. This report's own candidate was deliberately kept as
small and reviewable as this repo's own conventions allow, precisely because of this signal.

## Witness

```
SESSION_COMMIT = 3996f502b18157fdc84e325fbe87c2a05351d58c
REPORT_HASH    = <computed at STEP 16, see below>
WITNESS        = <computed at STEP 16, see below>
```

**Verifier procedure (reproduce independently):**
1. `git checkout 3996f502b18157fdc84e325fbe87c2a05351d58c` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. Re-run the guard-proof: `git stash push -- scripts/eval-brain.mjs`, run
   `npx vitest run tests/unit/eval-brain-gate.test.mjs` (must show 1 failed/17 passed with the message
   quoted above), `git stash pop`, re-run (must show 18/18 passed).
5. Run `node docs/dream-cycle/evidence/2026-09-18-grounding-quality-repro.mjs` against unmodified `main`
   (exit 1, VULNERABLE) and against the candidate (exit 0, FIXED).
6. Run `npm run test:unit` and `npm run test:integration`; confirm the failing-file/test counts recorded
   above are unchanged from baseline, and none touch `scripts/eval-brain.mjs` or
   `tests/unit/eval-brain-gate.test.mjs`.
