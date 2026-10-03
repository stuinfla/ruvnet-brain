# Dream Cycle 2026-09-23 — grounding-quality reconciliation

DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5,
`20260923 % 5 == 3`). No bonus deep dive tonight (`% 25` = 23, `% 75` = 48, both non-zero).

## Rotation / Ledger Check

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31 — expected, not a gap: the ledger
row ships in the candidate PR by convention and nothing on this surface has merged since #178
(2026-08-26). Re-checked recent fates directly rather than assuming:

- **#142/#143, #147/#148, #149/#150** (2026-08-19/20): MERGED.
- **#178** (2026-08-26): MERGED — the last dream-cycle merge of any kind, 28 days ago.
- **#154/#155**: PR closed unmerged, change landed on `main` directly via `420854b`.
- Every `dream/*` PR opened 2026-09-01 through tonight — 25 PRs (#269 through #317) — remains open
  and draft. Confirmed via GitHub MCP `search_pull_requests` against `head:dream/*`, not assumed.

### This surface specifically (grounding-quality), last 4 prior nights

| Date | PR | Finding | Status on `main` today |
|---|---|---|---|
| 2026-09-03 | #237 (closed unmerged) | Citation-header rank hijack (relative +1 offset); filed issue #236, ADR-0076/0087 Proposed | **Still live** — `kb/verify-citation.mjs:38-39`'s own comment still says "not airtight against a document engineered to predict and spoof the exact next rank"; ADR-0087 not on `main`; issue #236 still open |
| 2026-09-08 | #270 | `gradeQuestion()`'s `routed` metric blind to right-repo-wrong-file citations; adds `expectPath` | Integrated — `scripts/eval-brain.mjs:85-87` uses `routedRepo` for `routed` today |
| 2026-09-13 | #287 | Recovers ADR-0076 as ADR-0087 (byte-for-byte, after a renumbering collision) | **Not integrated** — `docs/adr/0087-*.md` absent from `main`; #287 still open |
| 2026-09-18 | #297 | Recovers PR #239: `provenance`/`pass` case still read `top?.repo` instead of `routedRepo` | **Not integrated** — verified live tonight, see below |

## Verification performed tonight (not re-derived from memory)

```
$ grep -n "routedRepo\|top?.repo !== 'ruv-gists'" scripts/eval-brain.mjs
85:  const routedRepo = receipt?.repo ?? top?.repo ?? null;
86:  const routed = !!(grounded && q.expectRepo?.length && routedRepo
87:    && repoMatchesExpected(routedRepo, q.expectRepo, repoAliases));
95:      return { grounded, routed: null, abstained, pass: !!grounded && !abstained && (top?.repo !== 'ruv-gists' || bannerPresent) };
```

Line 95's `provenance` stratum `pass` computation still reads the raw top-ranked citation
(`top?.repo`) instead of the same `routedRepo` the function already computes at line 85 — exactly
the defect PR #297 (2026-09-18) already fixes, TEETH-verified, adversarially critiqued CLEAR, and
confirmed rebased onto current `main` (`git merge-base --is-ancestor origin/main origin/dream/2026-09-18-grounding-quality-provenance-receipt`
→ true, zero commits behind). **This is not a new finding** — it is issue #239's original gap,
never a tracking issue under this repo's ISSUE DISPOSITION OVERRIDE (a verified fix is a work
record), sitting unmerged for 5 days with a ready, current, non-conflicting fix.

`docs/adr/0076-memory-full-integration.md` and `docs/adr/0086-corpus-seed-pipeline-consolidation.md`
exist on `main` under those numbers (unrelated content, confirmed by reading both); ADR-0087's slot
is free on `main`, consistent with #287's own account of the two renumbering collisions.

Targeted regression check (both grounding-quality-surface test files, current `main`,
zero diff applied): `npx vitest run tests/unit/eval-brain-gate.test.mjs
tests/unit/verify-citation.test.mjs` → **45/45 pass**. `npm run claims:verify`: 3 PASS / 4 SKIP
(brain-dependent claims skip loudly — standard composition, unchanged from every prior night).
`npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (container
never materializes a corpus; not a credentials block, `OPENROUTER_API_KEY` is present).

No new grounding-quality defect was found tonight distinct from the three already tracked above.

## Hypothesis

None reached the freeze-then-evaluate stage — this is a reconciliation night (same precedent as
PR #269, 2026-09-08). Per STEP 5-9: `EVALUATED=no / VERDICT=INCONCLUSIVE / reason=no new testable
hypothesis; the surface's known findings are already tracked in open, currently-mergeable PRs
(#270 integrated, #287 and #297 still open) awaiting human review, and re-deriving them again
tonight would be pure duplicate work`.

## Darwin Lineage

Not run — no candidate diff, no continuous parameter to evolve.

## Evidence

OBSERVATION (re-read `scripts/eval-brain.mjs`, `kb/verify-citation.mjs`, ADR namespace on current
`main`) → MEASUREMENT (grep + targeted test run, both reproduced live tonight, not assumed from
prior nights' reports) → INFERENCE (#297's fix still applies cleanly; #287's ADR slot is still
free) → DECISION (no new work; reconcile and record).

## Reward-Hack Check

N/A — no benchmark, threshold, or gold answer touched; no candidate code shipped tonight.

## Security Review

No new attack surface. Reconfirms, rather than newly discloses, the citation-rank-hijack gap
tracked in issue #236 / ADR-0087: `kb/verify-citation.mjs`'s own docstring still names it unresolved
line-for-line as it did on 2026-09-13. Nothing in tonight's read-only verification touched the
evaluator, the held-out set, or any gold answer.

## Recommendation (read this first — unchanged from the last several nights, now more urgent)

This engine never merges and this session has no authority to change that. Recorded, not acted on:

1. **25 open `dream/*` PRs (#269–#317), 100% draft, zero merged since #178 (2026-08-26) — 28 days.**
   Ordinary `fix/`/`release/` PRs from the same window (#302, #306, #307, #309, #310, #315) merged
   normally, so this is specific to the dream-cycle track, not general review capacity.
2. **Issue #236** (2026-09-03, citation-header rank hijack) needs a human Option A/B decision on
   ADR-0087 — itself sitting unmerged in PR #287 for 10 days, so the decision document a reviewer
   would need to read isn't even visible on `main`.
3. **PR #297** is a ready, TEETH-verified, zero-conflict fix for a real scoring-attribution bug
   still live on `main` tonight (confirmed above) — the single lowest-effort, highest-confidence
   merge available on this surface right now.

## ADR

None created — no architectural decision reached tonight.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation every prior
Dream Cycle night on this repo has recorded).

## Issue

`NONE` — per this repo's ISSUE DISPOSITION OVERRIDE: nothing new, reproduced, and unresolved
surfaced tonight; every finding above already has an open issue (#236) or an open, verified,
non-duplicate fix PR (#287, #297). A run without a new issue is a valid completed run.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
REPORT_HASH    = f909c798b8f6099d4fd6a8bd7650fcf43b1cef6bd3337a736b216fa5521ae7fc
WITNESS        = 7c152e1df8480839c4b5d2e7627a7912fe9cc8f1dd196747d761dd9cd41dd263
```

Verifier procedure: (1) check out commit `e89ea1b`; (2) `sha256sum` this report file at the state
before this section was filled in and confirm it matches `REPORT_HASH` (the hash covers the
pre-stamp bytes, per this pipeline's STEP 16 ordering); (3) `printf '%s%s' "$REPORT_HASH"
"$SESSION_COMMIT" | sha256sum` and confirm it matches `WITNESS`; (4) re-run
`grep -n "routedRepo\|top?.repo !== 'ruv-gists'" scripts/eval-brain.mjs` against that commit and
confirm line 95 still reads `top?.repo`; (5) re-run `npx vitest run tests/unit/eval-brain-gate.test.mjs
tests/unit/verify-citation.test.mjs` and confirm 45/45 pass.

## Merge Policy

**Human review required.** `autoMerge: false` per `dream.config.json` (ADR-068) — the decision, not
a default. This session never self-merges and never autonomously promotes candidate state. Draft,
by design.
