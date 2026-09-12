# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-09-12** · SLOT=2 · DEEP=`enforcement-integrity` · SCAN=`lesson-delivery`,`gate-teeth`

## Rotation

DATE=2026-09-12, DAYINT=20260912, `DAYINT % 5` = 2 → DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth`. No bonus deep dive (`DAYINT % 25`=12, `DAYINT % 75`=37, neither 0). SESSION_COMMIT at start: `7aa8ab2ecb589a1c4b8c779a92edbf42897e127c` (origin/main, freshly fetched).

## Concurrent night — read this first

A separate firing of tonight's same routine (same SLOT=2/DEEP) landed first as **PR #281**, `dream/2026-09-12-enforcement-integrity`, before this session attempted to push. Discovered only at push time (`git push` rejected — the branch name already existed on `origin` with different history), not predicted in advance.

Diffed PR #281's production change against this session's own independently-written fix to `plugin/scripts/lesson-presentation.mjs`: **byte-identical** (`git diff origin/dream/2026-09-12-enforcement-integrity -- plugin/scripts/lesson-presentation.mjs` produced no output). Both sessions independently revived the same pre-existing diagnosis (issue #264 / PR #265, 2026-09-07, closed unmerged in the 09-07 bulk sweep and never re-integrated). Per this repo's dedup discipline (`dream.config.json`'s `findingPolicy.dedupeBy`/`skipIf: existing-fix-pr`), this session does **not** open a second, redundant PR for an identical candidate — that would add to the exact review-backlog problem flagged continuously since 2026-08-26. PR #281 stands as the candidate for #264; this row instead records this session's own independent confirmation plus the reconciliation work PR #281's own body did not cover.

PR #281 also independently confirmed #228's fix (via PR #229, folded into the #267 release consolidation) and #262 (closed by the repo owner directly, 2026-09-12T08:39:47Z, hours before this run). It did **not** check #156, #158, #181, or #183 — this session's reconciliation of those four is new, non-overlapping work.

## Ledger Check

`docs/dream-cycle/LEDGER.md` on `main` last row is 2026-08-31 — 12 calendar days stale — even though the routine fired every night since (7 still-open `origin/dream/2026-09-08..11` branches/PRs #269–#280, plus tonight's #281). Already diagnosed by PR #269 (2026-09-08): a 2026-09-07T18:48Z bulk close landed on ~15-20 `dream/*` PRs unmerged in one minute, so their ledger rows never reached `main`; the findings instead reach `main` independently through a separate release-reconciliation path (PR #281's own investigation independently reconfirmed this mechanism tonight, citing the #267 consolidation PR by name). Not this night's surface to backfill those other rows.

**This is the fifth `enforcement-integrity` (slot 2) night**: 2026-08-22 (#156/#158), 2026-08-27 (#181/#183), 2026-09-01 (#228), 2026-09-02 (#230), 2026-09-07 (#262/#264). Checked all eight resulting issues directly against current `main` (grep + targeted `npx vitest run` on the 4 relevant test files, 131/131 pass on unmodified `main`) rather than assumed from history:

| Issue | Finding | Status on `main` tonight | Checked by |
|---|---|---|---|
| #156 | `sync-version-ignore` marker never read by `no-restated-truth.test.mjs`'s `isDebt()` | **Integrated** — `SYNC_VERSION_IGNORE` regex present, line-stripping active | this session (closed) |
| #158 | `wired-check.mjs` lesson-trigger audit blind to dynamic dispatch | **Integrated** — `lessonHooksRequestedTriggers()` recognizes it | this session (closed) |
| #181 | Two "is this a ship?" definitions disagreed on whitespace | **Integrated** — `lesson-hooks.sh` now uses `[[:space:]]+` | this session (closed) |
| #183 | `isHome()`'s bare suffix match leaked lessons across projects | **Integrated** — `segmentSuffixMatch()` wired into `isHome()` | this session (closed) |
| #228 | `wired-check.mjs`'s `callerPattern()` phantom-wired `gate.sh` | **Integrated** — boundary lookarounds present, `gate.sh` now `○ exempt` | this session (closed) + PR #281 (independently, via #267) |
| #230 | Compact-overflow lessons bypass `MAX_SHOWS` | **Integrated** — persist loop charges `shownThisCall` | this session (closed) |
| #262 | Theme demotion in `lesson-promote.mjs` was dead code | **Integrated** — real `DEMOTED_THEMES_PATH`-backed writer | owner (closed directly, 08:39:47Z today) |
| #264 | Opted-in BLOCK dropped by cross-trigger nudge-budget truncation | **STILL LIVE on `main`** — candidate is PR #281 (this session's independent fix is byte-identical, not duplicated) | PR #281 |

Closed #156, #158, #181, #183, #228, and #230 tonight with source-citing evidence comments + `state_reason: completed`. #262 was already closed by the owner before this session started — left untouched, per this repo's own "never reopen resolved work" rule. #264 stays open, tracking PR #281.

## Why no new code candidate

The one surviving, unresolved defect on this surface (#264) already has an open, draft, evidence-backed candidate PR (#281) from tonight's concurrent firing, with a byte-identical production fix and, per its own body, an independent adversarial critic that caught and fixed a vacuous test in its second TEETH case — a stronger evaluation receipt than this session could add without touching the same two files a second time. Per `dream.config.json`'s `findingPolicy.skipIf: ["existing-fix-pr"]`, this session stands down from opening a second PR for the same fix. This session's distinct contribution is the reconciliation of #156/#158/#181/#183 — four issues PR #281 did not check — plus this report as an independent cross-validation record.

## Evidence

- OBSERVATION: all 8 open enforcement-integrity issues predate tonight; 6 have integrated fixes on `main` already, confirmed by source inspection plus a live test run (131/131 pass), not by trusting PR history.
- MEASUREMENT: `git diff origin/dream/2026-09-12-enforcement-integrity -- plugin/scripts/lesson-presentation.mjs` against this session's own independently-written fix — empty diff, proving true duplication rather than assumed overlap.
- INFERENCE: two independent sessions converging on an identical diff for the same pre-existing, previously-diagnosed defect is strong confirmation the fix is correct, not merely evidence of redundant effort.
- DECISION: close 6 reconciled issues with evidence; stand down from a duplicate PR; record this row.

## Reward-Hack Check / Security Review

N/A to this row — no new production code was introduced by this session. The 6 reconciliation closures are evidence-based (each cites the specific current-source symbol confirming the fix, and a passing targeted test run), not assumed.

## Scan: lesson-delivery / gate-teeth

Both scans are satisfied by the reconciliation above — all 8 findings on this surface are either integrated (6, tonight and historically) or carry a live, evidence-backed candidate (#264 → PR #281). No new lesson-delivery or gate-teeth gap found beyond what PR #281 and prior nights already identified.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session. This report is committed at `docs/dream-cycle/2026-09-12-enforcement-integrity-report.md`.

## Witness

```
SESSION_COMMIT = 7aa8ab2ecb589a1c4b8c779a92edbf42897e127c
REPORT_HASH    = d37a4017d3638374445662930cff8df165b4e5043009831e76c432187db5c7b4
WITNESS        = 867b7de620d287b99ee0c4be67c3ed240c595efd913b85747d2531e5d10d0d8d
```

`REPORT_HASH` is `sha256sum` of this report file as it stood immediately before this Witness section was filled in. `WITNESS = sha256(REPORT_HASH + SESSION_COMMIT)`. Anyone with the repo can reproduce both from this file and `SESSION_COMMIT`.

## Recommendation

`evaluated: accepted` — the underlying defect (#264) is confirmed real, confirmed fixed, and the fix is in PR #281, already open for human review. This row's own deliverable is the reconciliation (6 issues closed) and the duplicate-avoidance decision. `autoMerge: false` holds regardless; this session never merges, and deferring to PR #281 does not change that.

## Next steps

1. Human review of PR #281 (the real candidate for #264) — unaffected by this row.
2. Add `plugin/scripts/lesson-presentation.mjs` to ADR-0055's `governs:` list (flagged independently in PR #281's own body too) — it was extracted from `lesson-gate.mjs` (which IS governed) after the 2026-08-19 narrowing and never added.
3. The 2026-09-07 bulk-close sweep is now confirmed (by this session and independently by PR #281) to have discarded several verified fixes that only later resurfaced through two separate mechanisms: a release consolidation (#267) and individual revival nights. A standing pre-research step — check for closed-unmerged PRs whose issue is still open, before full research — would catch this class without waiting for slot rotation, and would have prevented tonight's duplicate-candidate near-miss from costing two full sessions' evaluation effort instead of one.
