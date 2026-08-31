# Citation-Binding-in-the-Gate-of-Record SOTA Report — 2026

**Dream Cycle 2026-08-28 — DEEP=grounding-quality, SCAN=retrieval-precision,citation-binding (slot 3)**

**Concurrent-run note, read this first**: a separate firing of tonight's same scheduled routine (same
SLOT=3, same DEEP=grounding-quality) landed first on branch `dream/2026-08-28-grounding-quality`
(issue #185, draft PR #186) — a `kb/verify-citation.mjs` `parseCitations()` fix closing a citation-block
look-alike/spoofing gap. That candidate is a **different, non-overlapping finding** — disjoint files
(`kb/verify-citation.mjs`, `tests/unit/verify-citation.test.mjs`, plus its own copy of this same-named
report path, since it also wrote `docs/dream-cycle/2026-08-28-grounding-quality-report.md` — this
report was renamed with a `-routed-receipt` suffix specifically to avoid that path collision). This
candidate touches `scripts/eval-brain.mjs` and `tests/unit/eval-brain-gate.test.mjs` only. This branch
is rebased onto that firing's tip (`cd4ccdc`) so ledger rows append in order, same protocol as PR #150
(2026-08-20), PR #155 (2026-08-21), and PR #164 (2026-08-23).

## TL;DR

`kb/verify-citation.mjs`'s `verifyGrounding()` walks an answer's citations in rank order and returns
`grounded: true` on the **first citation that resolves on disk**, naming the actually-resolving one in
`receipt.repo` (already covered by its own test, `tests/unit/verify-citation.test.mjs`'s "accepts a
lower-ranked citation when the top hit does not resolve"). But `scripts/eval-brain.mjs`'s
`gradeQuestion()` — the scoring function behind the frozen 120-question held-out gate `npm run
eval:gate` runs — computed the `routed` credit ("does a by-description query reach the store that
actually holds the answer," `brain-score.mjs`'s own wording for this metric) from `citations[0]`, the
raw top-ranked citation, completely ignoring which citation `verifyGrounding` actually verified. The
call site threaded `v.grounded` and `v.citations` into `gradeQuestion` but never `v.receipt`, discarding
exactly the information that answers the question `routed` claims to measure.

## What's new

Nothing external — a sibling-defect closure inside this repo's own evaluation harness, in the same
family as PR #143/#155/#178's "the check used the wrong signal for the state it claims to detect"
pattern, applied here to the gate of record (ADR-0011) rather than a diagnostic script.

## Competitors — how other autonomous nightly/self-improvement harnesses treat "which retrieved item gets credited" (grade C: general knowledge, single-source per row; informs framing only, does not justify the implementation — the implementation is justified by this repo's own measurement above)

| System | Relevant stance on crediting which retrieved/cited item actually grounded an answer | Grade |
|---|---|---|
| Sakana AI Scientist | Evaluates final paper/experiment outputs against reviewer-style rubrics; no first-class notion of "which citation among several actually backs this claim" distinct from citation presence. | C |
| OpenHands | Tool-use trajectories are scored on task success; when multiple file/tool results are returned, provenance-of-the-winning-result is not a tracked first-class signal in the harness itself. | C |
| DSPy/GEPA | Retrieval-augmented pipelines optimize an end metric (e.g. exact-match); a metric that credits the wrong retrieved passage while getting the right answer for unrelated reasons is a known general RAG-evaluation failure mode, not specifically solved by the framework. | C |
| SWE-agent | Localization/patch-correctness metrics generally check the produced diff, not which retrieved context snippet the agent actually used to produce it. | C |
| Cursor background agents | Background-agent evaluation is typically end-task-success-based; multi-citation attribution is not a documented first-class concept. | C |

The pattern across all five: crediting "was the right context reached" against the top-ranked/first
result rather than the one actually used/verified is a common, usually-invisible RAG-evaluation gap.
This repo already has the correct primitive (`verifyGrounding`'s `receipt`) — tonight's fix is wiring
the gate's own scoring to use it, not importing a new idea.

## Hypothesis (frozen before implementation, unchanged since)

> Given the frozen 120-question held-out eval set scored via `scripts/eval-brain.mjs`, when
> `gradeQuestion`'s `routed` determination is computed from the citation that `verifyGrounding` actually
> verified as resolving on disk (`v.receipt.repo`) rather than from the unconditional first-ranked
> citation (`citations[0].repo`), then the `routed` metric's per-question pass/fail should correctly
> track which store's evidence genuinely grounds the answer — measured directly on synthetic
> multi-citation cases where the top-ranked citation does not resolve but a lower-ranked one does (and
> the mirror case, where the top-ranked citation coincidentally names the expected repo but never
> resolves) — subject to: zero behavior change for every existing single-citation test case, the
> `grounded`/`abstained`/`provenance` rules must not change, `ABSTAIN_CE` must not change, and the frozen
> `evals/held-out.json` hash must not change.

## Benchmarks / Evaluation Receipt

Not a corpus/ranking-tuning candidate — `npm run eval:gate` is blocked identically baseline vs
candidate (`eval-brain: no brain at /root/.cache/ruvnet-brain/kb` — this container's store root has
never been materialized, the same pre-existing condition every recent Dream Cycle night has recorded;
the gate never gets far enough to exercise the changed code either way). `OPENROUTER_API_KEY` is
present (`LLM_EVAL` not blocked) but no model-graded stage applies to this deterministic scoring-logic
fix.

**Guard proven to fail first (TEETH), independently reproduced by the orchestrating session, not just
asserted by the candidate's author:**

```
$ git stash push -- scripts/eval-brain.mjs
$ npx vitest run tests/unit/eval-brain-gate.test.mjs
 FAIL  ... routed credits the citation verify-citation.mjs actually resolved (`receipt`) ...
 AssertionError: expected false to be true
 Test Files  1 failed (1)
      Tests  1 failed | 15 passed (16)
$ git stash pop
$ npx vitest run tests/unit/eval-brain-gate.test.mjs
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

**Regression analysis**, baseline vs candidate via `git stash`/`pop` (candidate author's run, numbers
match this repo's own documented 2026-08-26 ledger-row baseline exactly):

- `npm run test:unit`: baseline (stashed) `4 failed | 3403 passed | 24 skipped | 161 todo` (3592 total,
  277 files); candidate `4 failed | 3404 passed | 24 skipped | 161 todo` (3593 total) — the +1 is exactly
  the one new `it()` added. **Byte-identical failing-file set both sides**:
  `advocacy-ignored`, `advocacy-outcomes`, `hook-shim-fallback-once`, `user-settings` — all pre-existing
  chmod/EACCES-simulation fixtures that don't enforce under this container's root user.
- `npm run test:integration` (candidate only; not re-run under `git stash` given the grep-proven narrow
  blast radius below — the ADR-permitted exception for a provably closed change): `5 failed files / 9
  failed tests / 240 passed / 11 skipped / 53 todo` of 313 — numbers match the 2026-08-26 ledger row's
  own recorded baseline exactly (`anticipate`, `anticipate-dial`, `console-apply-timings`, `health-repair`
  ×4, `reader-deadlock-regression` — all pre-existing environmental gaps: missing ONNX/CE cache,
  root-permission simulation, headless-browser timing).
- `npm run claims:verify` (orchestrating session's own independent run): `claims:verify OK — 3 verified,
  4 skipped (loudly)` — identical composition to this repo's documented baseline (skips are pre-existing
  environmental: brain not installed, coverage run absent).

**Blast radius** (orchestrating session's own independent grep, not reused from the candidate's):
`gradeQuestion` has exactly 3 call sites repo-wide — the fixed one in `scripts/eval-brain.mjs`, and
`scripts/rerank-cap-eval.mjs`/`scripts/rerank-cap-warm-ab.mjs` (manual A/B tools, not run in CI/test
suites). Neither external caller constructs a `receipt` key, so `routedRepo = receipt?.repo ?? top?.repo
?? null` falls back to the exact prior behavior for both — zero behavior change for either. No other
`.receipt` usage in the repo shares this namespace (release-transaction/install-smoke receipts are an
unrelated concept with no shared code path).

## Darwin Lineage

Not run — no continuous parameter to evolve for a scoring-attribution fix.

## Evidence

OBSERVATION (`verifyGrounding` already computes and names the actually-resolving citation in `receipt`,
but the gate's own scoring function never reads it) → MEASUREMENT (TEETH red pre-fix / green post-fix,
independently reproduced twice; full-suite regression byte-identical modulo the one new test) → DECISION
(ACCEPT, pending human review).

## Reward-Hack Check

1. **Weakened test** — CLEAR: `git diff` on the test file shows only one added `it()` block; every
   pre-existing assertion is byte-identical.
2. **Altered gold data/threshold** — CLEAR: `evals/held-out.json`, `evals/baseline.json`, `ABSTAIN_CE`
   untouched (`git status` shows only the two files listed above modified).
3. **Vacuous assertion** — CLEAR: both new assertions proven to flip via real `git stash`/pop, reproduced
   independently by the orchestrating session (not merely asserted by the candidate's author).
4. **Hidden cost** — CLEAR: a single nullish-coalescing lookup on an object already computed by the
   existing call; no new I/O, dependency, or subprocess.
5. **Cherry-picked corpus** — CLEAR: `evals/held-out.json` untouched, not filtered or reordered; the fix
   is exercised by synthetic unit-test citations, not a hand-picked subset of real questions.
6. **General reward-hacking / one-directional score inflation** — CLEAR: the fix corrects the metric in
   *both* directions (raises a previously-undercounted true-positive, lowers a previously-overcounted
   false-positive), so it cannot manufacture a one-directional score improvement, and was never run
   against a live held-out set in this container (no local KB) — only against synthetic fixtures.

## Security Review

Pure, offline scoring-logic change inside an evaluation script that only ever consumes this repo's own
already-generated subprocess output (`forge-ask-all.mjs`'s stdout) and its own frozen
`evals/held-out.json`. `receipt` is produced by the same already-trusted `kb/verify-citation.mjs`
disk-verification path already being invoked on the same call, threaded one function-call deeper into a
pure function. No new network call, credential, write path, or untrusted-input path. Attack surface
unchanged.

## Next steps

1. `gradeQuestion`'s `provenance` stratum (`top?.repo !== 'ruv-gists'`) has the same category of
   top-vs-receipt ambiguity, but that rule is conceptually about which chunk ranks first, not which one
   grounds the answer — left as a separate, not-yet-proven hypothesis rather than folded into this diff.
2. `scripts/rerank-cap-eval.mjs` and `scripts/rerank-cap-warm-ab.mjs` never call real `verifyGrounding()`
   at all — they treat "grounded" as "retrieval returned ≥1 result," a materially weaker definition than
   the held-out gate's. Not evaluated tonight; flagged for a future night.
3. Governance, not code: as of tonight, 11 Dream Cycle PRs (#157, #159, #162, #164, #167, #168, #172,
   #174, #176, #182, #184) opened 2026-08-22 through 2026-08-27 are open/draft and unreviewed; only one
   Dream Cycle PR (#178) has merged since 2026-08-21. This is the same backlog flagged in #175 and the
   2026-08-26 ledger row, now roughly 40% larger — not this candidate's problem to fix, but the single
   highest-value action available to the human owner right now is triage of that queue, not more nightly
   candidates landing on top of it.

## Witness

```
SESSION_COMMIT = 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f
REPORT_HASH    = 6f3b20366effb3bbb440db2f947eaa68b516524c323a283fc46f36be5ad1a982
WITNESS        = f9910b34d073f887d0354af981ae04d697f5f4b9710e7440cd21b633424dd1c8
```

Note on `REPORT_HASH`: it is the sha256 of this report's content as it stood through the "Next steps"
section, computed BEFORE this Witness section was rewritten with the stamp (the standard
chicken-and-egg order STEP 16 specifies). It will therefore NOT match a fresh `sha256sum` of this file
as it now reads, since rewriting this section changed the bytes — expected by construction, not evidence
of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. Re-run the guard-proof: `git stash push -- scripts/eval-brain.mjs`, run
   `npx vitest run tests/unit/eval-brain-gate.test.mjs` (must show 1 failed/15 passed with the message
   quoted above), `git stash pop`, re-run (must show 16/16 passed).
5. Run `npm run test:unit` and `npm run test:integration`; confirm the same failing-file/test counts
   reported above (all pre-existing/environmental, none touching `scripts/eval-brain.mjs` or
   `tests/unit/eval-brain-gate.test.mjs`).
