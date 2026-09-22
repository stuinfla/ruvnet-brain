# Dream Cycle 2026-09-22 — enforcement-integrity: reconciliation, not a new finding

Rotation: DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth` (slot 2 of 5). No bonus
deep dive tonight (DAYINT % 25 = 22, DAYINT % 75 = 47, neither 0).

## TL;DR

This is a backlog-reduction night, by design. `stuinfla/ruvnet-brain`'s dream-cycle track has
~20 open, unmerged `dream/*` PRs (2026-09-07 through 2026-09-21), while ordinary `fix/`/`release/`
PRs from the same window merge normally — the gap is specific to this track. Tonight's rule
("zero of the last 14 candidate PRs merged → bias to a tiny, easily-reviewable candidate", plus
this run's own priority to *not* add PR #(N+1) to that pile) pointed at reconciliation over a
fresh finding.

The one still-open, still-live enforcement-integrity issue is **#264** (opted-in BLOCK lesson
silently dropped by cross-trigger nudge-budget truncation in `lesson-presentation.mjs`). Its
verified fix has existed since 2026-09-12 as **PR #281** — but that PR's branch had drifted from
`main` badly enough that PR #295 (2026-09-17) called it "8 merge-conflict cycles deep across 5
nights with zero human reviews." Tonight: independently re-reproduced the defect fresh (not
trusted from history), confirmed PR #281's fix is still exactly correct, rebuilt it cleanly on
current `main`, and pushed the update to PR #281's own branch — so it is finally current and
mergeable, instead of opening a new draft PR.

## What's new / what changed since the last check

- The worktree's cached `origin/main` ref was stale (`35fbe038`) relative to the true tip
  (`5f39481f`, "Stop duplicate runner polling for corpus releases (#315)") — 230 files differed.
  Refetched and rebuilt the candidate from the true tip rather than the stale snapshot.
- `plugin/scripts/lesson-presentation.mjs` is byte-identical between the stale snapshot and true
  `main`, so the defect and its fix are unambiguous either way; only `tests/unit/lesson-gate.test.mjs`
  had drifted (an unrelated test added by a later night), so the TEETH tests were reapplied onto
  the current file rather than copy-pasted blind.
- Confirmed via GitHub MCP: PR #281 (open, draft), PR #282 (its "no duplicate code, issue
  reconciliation" companion), PR #294 and PR #295 (2026-09-17, same slot, different files —
  `lesson-promote.mjs` theme-demotion recovery and `dream-issue-gate.mjs`'s own entrypoint guard,
  both independent of #264, left untouched — not this run's lineage, no overlap to reconcile).
- Issue #264 remains open, unreopened, un-duplicated — this run is its reconciliation, not a new
  issue.

## Hypothesis (frozen before evaluation, unchanged from issue #264 / PR #281)

Given a `Stop`/`PreToolUse` event carrying several simultaneous lesson-gate decision points
(several `--trigger` values merged into one ranked, budget-truncated presentation), when a
high-`repeatCount` ADVISORY lesson on one trigger is long enough to spend the entire `nudgeBudget`
on its own, then a lower-ranked, user-opted-in BLOCK lesson on a *different* trigger should still
survive into `inForce` and produce `EXIT_BLOCK`, subject to: the opt-in trust boundary
(`isBlocking()`'s four conditions) staying completely unchanged, and no existing test being
weakened to get there.

## Evaluation Receipt (real evaluator, current source, reproduced fresh tonight)

- **TEETH, reproduced independently three times tonight** (stale HEAD, then again cleanly on
  true `main` `5f39481f`, both via `git stash` isolation of `plugin/scripts/lesson-presentation.mjs`):
  `expect(code).toBe(2)` → `AssertionError: expected +0 to be 2`, all three runs, byte-identical
  failure. Fix restored → 69/69 pass in `tests/unit/lesson-gate.test.mjs` (68 pre-existing + 1 new
  `identical advisory is emitted once...` test a later night added, unaffected, + the 2 new BUDGET
  tests).
- **`test:unit`** (5796 tests / 460 files on true `main` + candidate): 17 failed files / 52 failed
  tests / 5559 passed / 47 skipped / 138 todo. **Baseline** (candidate diff stashed out, same 17
  target files run directly): 16 failed files / 51 failed tests / 694 passed of that subset. The
  **sole delta is `convergence-manifest.test.mjs`** — expected, because the candidate changes a
  tracked source file and the committed manifest hash goes stale; fixed by
  `npm run convergence:write`, re-verified 2/2 pass. Every other failing file/test is
  byte-identical baseline vs candidate: `adr-format`, `advocacy-ignored`, `advocacy-outcomes`,
  `advocacy-route`, `agentic-qe-early-public`, `candidate-retrieval-matrix`,
  `console-memory-canonical-store`, `corpus-accuracy-gate`, `corpus-customer-promotion`,
  `corpus-seed-release-authority`, `doc-currency`, `hook-shim-fallback-once`, `no-restated-truth`,
  `rehearse-corpus-pipeline`, `retrieval-canary`, `user-settings` — none reference
  `lesson-presentation`/`lesson-gate` (grep-confirmed).
- **`test:integration`** (407 tests / 51 files): 9 failed files / 23 failed tests / 323 passed /
  16 skipped / 45 todo — `anticipate`, `anticipate-dial`, `console-apply-timings`, `health-repair`,
  `project-progression-checkpoint`, `project-progression-restore-semantics`,
  `project-progression-reader-identity`, `project-progression-concurrent-sessions`,
  `reader-deadlock-regression` — grep-confirmed none reference the changed files; native-module/
  timing-class container gaps matching every recent ledger row's documented pattern.
- **`claims:verify`**: 3 PASS / 4 SKIP, identical composition to every prior night.
- **`eval:gate`**: ran for real (`OPENROUTER_API_KEY` present, not a credentials block) →
  `EVALUATED=blocked`, exact blocker `no brain at /root/.cache/ruvnet-brain/kb` (store root never
  materializes on this container). Not applicable regardless — deterministic presentation/budget
  logic, not a retrieval surface.
- **`doc-currency --check --changed origin/main`**: 0 blocking findings; no ADR governs
  `lesson-presentation.mjs` (confirmed by the tool itself, not assumed) — no currency-log row owed
  there. (ADR-068 *does* govern `docs/dream-cycle/LEDGER.md`, so its own currency log/`updated:`
  stamp was bumped in this same change, per established convention.)

## Blast radius

`grep -rln "buildLessonPresentation\|lesson-presentation"` repo-wide: `plugin/scripts/lesson-gate.mjs`
(the one functional importer), `scripts/learning-replay-contract.mjs` and
`tests/unit/learning-replay-verdict.test.mjs` (path-string `LOAD_BEARING` references only, not
functional imports), plus the file's own test. Identical finding to PR #281's own original
blast-radius check — reconfirmed fresh, not trusted.

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean admission-order fix; same precedent as
every prior enforcement-integrity night.

## Evidence

OBSERVATION (`buildLessonPresentation`'s budget loop has no exemption for an already-qualifying,
user-consented BLOCK, live on current `main` — not merely a historical claim) → MEASUREMENT (TEETH
red pre-fix / green post-fix, reproduced 3× across two different `main` snapshots; full
`test:unit`/`test:integration` suites diffed baseline vs candidate, one expected delta explained
and fixed) → DECISION (ACCEPT the underlying fix, unchanged from PR #281's own independently
critiqued design; reconcile the stale PR rather than open a new one).

## Reward-Hack Check (independent re-review, not just the candidate's own claim)

CLEAR. No benchmark, gold answer, or threshold touched. No existing test weakened — 2 tests added,
0 changed. `isBlocking()`'s four-condition opt-in trust boundary is byte-identical before and
after; the diff only changes *admission order* into `inForce`, never *what qualifies*. The fix can
only let an already-qualifying, user-consented refusal survive the budget; it cannot manufacture a
new one. Same disclosed, non-blocking edge case as the original PR #281/#265 lineage: a user who
opts many large BLOCK lessons in at once could now produce an unbounded-length refusal message —
reachable only by the user's own opt-in action, not model- or externally-controlled.

## Security Review

No new attack surface. The opt-in trust boundary (consent-file membership + `enforcement:block` +
`ratified`/`active` status + `origin:user-stated`) is unchanged. This diff only changes whether an
already-qualifying block survives the nudge budget, never who qualifies.

## Competitors

Sakana AI Scientist, OpenHands, DSPy/GEPA, SWE-agent, Cursor background agents — grade C, general
design knowledge only. None of the five publish an analogous cross-decision-point budget/consent-
priority mechanism to compare against; this remains a repo-specific enforcement-plumbing defect,
not a competitive-positioning question.

## Scan findings (lesson-delivery, gate-teeth)

Both scan surfaces converge on the same finding as issue #264 itself: a guard (`lesson-gate.mjs`'s
BLOCK path) whose *delivery* mechanism (the cross-trigger budget merge) could silently disable it
— "a guard that cannot fail" violated one layer up from where `lesson-store.mjs` already fixed the
single-trigger case. No new, distinct lesson-delivery or gate-teeth defect found tonight beyond
this reconciliation; the ~20-PR backlog itself is the dominant gate-teeth-adjacent risk right now
(verified fixes sitting unreviewed are a guard that technically "exists" but delivers nothing).

## Gist

This file. Committed at `docs/dream-cycle/2026-09-22-enforcement-integrity-report.md`. No `gh`
CLI or gist-creation MCP tool available this session — GIST=LOCAL, not fabricated.

## Witness

```
SESSION_COMMIT = 5f39481ff7190d8d40ad4ff5273b68c15b9e3841
REPORT_HASH    = 0d307f772137964c97cbfcd426b60d7a066d895f01ebdca6b729f3a350946088
WITNESS        = 6818191ff15c37af4f97a260525e7cd63df262913702c9cd533a86503c255b06
```

Verify: (1) checkout `5f39481ff7190d8d40ad4ff5273b68c15b9e3841` (true `main` tip at session start);
(2) obtain this report (`docs/dream-cycle/2026-09-22-enforcement-integrity-report.md` on the
candidate branch, or this gist file); (3) `sha256sum` it, confirm it starts `0d307f7721...`;
(4) `printf '%s%s' <report-sha256> 5f39481ff7190d8d40ad4ff5273b68c15b9e3841 | sha256sum`, confirm
it starts `6818191ff1...`; (5) `git stash` the PR's diff to `plugin/scripts/lesson-presentation.mjs`,
confirm both new tests in `tests/unit/lesson-gate.test.mjs`'s `BUDGET` block fail
(`expected +0 to be 2`), `git stash pop`, confirm both pass.

## Recommendation

1. Review and merge PR #281 (now current against `main` `5f39481f`, zero-risk per the evaluation
   above) — the single highest-leverage action available, unchanged from what PR #294/#295 already
   flagged five nights ago.
2. The ~20-PR dream-cycle backlog (2026-09-07 through 2026-09-21, zero merged) is the dominant
   finding across the last three weeks of nightly runs, larger than any single code defect. Tonight
   is deliberate evidence that continuing to add PRs to it is negative-value; reconciling an
   existing one is the correct response until the backlog itself is addressed.
