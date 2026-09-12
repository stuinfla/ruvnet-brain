# Grounding-Quality / Citation-Binding SOTA Report — 2026-09-08

## TL;DR

`scripts/eval-brain.mjs`'s `gradeQuestion()` — the scoring function behind `npm run eval:gate`'s
frozen 120-question held-out set — computes the `routed` metric ("does the query reach the store
that actually holds the answer") from **repo membership only** (`q.expectRepo.includes(routedRepo)`).
It has no way to detect a citation that lands in the right repo but the wrong file. This exact gap
was identified and explicitly deferred two Dream Cycle nights ago (2026-08-23, issue #163, "Scan
Findings — citation-binding": *"cannot detect a top-1 citation pointing at the wrong file within the
correct repo... not pursued as tonight's single candidate... Recorded for a future night."*). Tonight
is that night: it is still live in current `main` (verified below), unclaimed by any other issue, and
fits the "tiny, one-parameter, reviewable" bar this repo's own learning signals call for after another
week of near-zero PR merges.

## What's new

`gradeQuestion(q, { grounded, citations, bannerPresent, receipt })` now accepts an optional
`q.expectPath` array. When present, `routed` additionally requires the resolved citation's path
(`receipt?.path ?? top?.fullPath`) to contain one of the expected path substrings. When absent — true
for every one of the 120 real questions in `evals/held-out.json` today — behavior is byte-identical
to before. This mirrors the exact successful pattern of PR #188 (2026-08-28, `receipt` threading):
extend the grading function with an optional, backward-compatible signal, prove the new behavior with
synthetic unit tests, touch zero frozen gold data.

## Competitor / prior-art context (reused from this repo's own recent nights — B/C grade, not
## re-verified tonight; cited for framing only, not as the basis for this fix)

| System | Claim | Grade | Relevance |
| --- | --- | --- | --- |
| CiteCheck (arXiv 2502.10881) | Span-level citation-support verification for LLM answers | A | Same family of problem: citation correctness is a per-span, not per-document, property |
| Beyond Document Grounding (arXiv 2607.00895) | Span-level hallucination detection over code corpora | A | Directly analogous to "right repo, wrong file" — file-level is a coarser instance of span-level |
| FACTUM (arXiv 2601.05866) | Fact-level attribution scoring | A | Motivates path-level (not just repo-level) attribution as the next granularity |
| ADR Aggregator / adrkit | Automated code-ADR mismatch detection via fitness functions | B (vendor, cross-checked) | This repo's own `heldOutHash`/TEETH pattern already follows this fitness-function style |
| Sakana AI Scientist / OpenHands / DSPy-GEPA / SWE-agent / Cursor background agents | General autonomous-eval agents | C (no found evidence of a built-in repo-vs-file attribution axis) | Not the basis for tonight's fix — internal repo inconsistency only |

## Candidates considered tonight (5, scored 1-5 on fit/novelty/testability/measurability/
## production-value/reviewability; total /30)

1. **routed metric is path-blind within the correct repo** (selected) — 5/3/5/5/4/5 = 27. Deferred,
   reproduced live, deterministic, no LLM/API key needed, backward-compatible by construction.
2. Citation rank-hijack structural fix (issue #236 / ADR-0076) — 5/2/2/3/5/1 = 18. Already
   exhaustively investigated 2026-09-03; concluded architectural, blast radius spans 3+ consumer
   files of `forge-ask-all.mjs`'s wire format, no bounded nightly patch exists. Re-litigating this
   without new information would waste tonight's budget; the open issue and ADR already carry the
   full record and need a human direction decision, not another candidate.
3. `forge-rerank.mjs`'s ADR-query cross-encoder bypass (issue #163 scan finding) — 4/3/2/2/3/3 = 17.
   Requires re-running an interrupted n=120 cascade confirmation (ADR-0060); `LLM_EVAL=blocked`
   tonight (no `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`), disqualifying it outright.
4. Re-audit `kb/self-retrieval-bench.mjs`'s HYBRID-mode labeling (issue #161, fixed 2026-08-23) —
   3/1/4/4/1/4 = 17. Verified still fixed on current `main` (`KB_HYBRID` guard intact); nothing to do.
5. Bind `heldOutHash()`'s tamper-evidence to a hypothetical future `expectPath` field — 2/2/3/2/1/3 =
   13. Speculative (no real question uses the field yet); premature to gate on a field that does not
   exist in gold data. Rejected as not-yet-actionable.

Candidate 1 wins on every axis except novelty (it is a known, previously-scoped gap, not a fresh
discovery) — explicitly acceptable, since STEP 3 only requires explaining an override of the raw
top score, and 27/30 vs 18/30 is not close.

## Frozen hypothesis (unchanged since freezing, before implementation)

> Given `scripts/eval-brain.mjs`'s `gradeQuestion()`, when a synthetic question carries an optional
> `expectPath` array and the resolved citation (`receipt?.path ?? top?.fullPath`) does NOT contain any
> of those path substrings, then `routed` (and therefore `pass`, for named/described/scenario strata)
> should be `false` even when the resolved citation's `repo` matches `expectRepo` — subject to: (a)
> zero behavior change for any question without `expectPath` (all 120 real held-out questions today),
> (b) `grounded`/`abstained`/`provenance`/`adversarial` rules unchanged, (c) `ABSTAIN_CE` unchanged,
> (d) the frozen `evals/held-out.json` file and its pinned hash unchanged.

## Evaluation

See the draft PR body for the full receipt (TEETH red→green, `test:unit`/`test:integration` diffed
byte-for-byte against baseline, `eval:gate` evaluated=blocked — this container never materializes a
corpus, independent of tonight's candidate).

## Witness

```
SESSION_COMMIT = 80c5322e6eaf87dd93cdeaac9fd12b49811cf034
REPORT_HASH    = 8a25813a4c4ee3fb7002892bd579ff4a7346cd8854e4f5d8020c131c5da42749
WITNESS        = 74ce5ef762c0de6c558f6e1e37548c4f9602805f5ba53de3c817948b064fdeb8
```

Verifier (5 steps, reproducible by anyone):
1. Checkout branch `dream/2026-09-08-grounding-quality` at its head commit.
2. Confirm the night began from `SESSION_COMMIT = 80c5322e6eaf87dd93cdeaac9fd12b49811cf034`
   (`git log main --oneline` on the base this branch forked from).
3. `sha256sum` this gist file (as committed at `docs/dream-cycle/2026-09-08-grounding-quality-report.md`)
   equals `REPORT_HASH` above (note: the hash was computed before this Witness section's final
   rewrite, per Step 16's own procedure — the committed report file's hash will differ from
   `REPORT_HASH` by construction, since the witness necessarily post-dates the content it stamps;
   this is the same documented behavior every prior night's report has had).
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` equals `WITNESS` above.
5. `npx vitest run tests/unit/eval-brain-gate.test.mjs` → 17/17 pass; `git stash push -- scripts/eval-brain.mjs && npx vitest run tests/unit/eval-brain-gate.test.mjs; git stash pop` → 1 failure (`expected true to be false`) reproducing the pre-fix defect, then 17/17 again after the pop.

## Next steps

1. Promote a real per-question `expectPath` onto a handful of `evals/held-out.json` rows where a
   wrong-file-right-repo answer is a plausible failure mode — a deliberate, reviewed, ADR-0011-grade
   change to gold data, out of scope for an automated nightly candidate.
2. Human direction decision on ADR-0076 (citation rank-hijack) — still the single highest-value open
   item on this surface, blocked on a human choosing per-query-token vs. structured-transport.
3. Triage the `dream/*` PR backlog: as of tonight, 0 open PRs (a mass close-without-merge swept ~15
   candidates on 2026-09-07) but 19 open `dream-cycle` issues — the underlying findings are still
   unresolved even though their draft PRs are gone. Worth the owner's attention before more nightly
   candidates accumulate against issues with no live PR.
