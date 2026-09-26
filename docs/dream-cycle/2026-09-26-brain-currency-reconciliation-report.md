# Dream Cycle 2026-09-26 — brain-currency reconciliation

DATE=2026-09-26 · DEEP=`brain-currency` · SCAN=`dark-stores`,`corpus-freshness` · SLOT=1 (`20260926 % 5`) · no bonus deep dive (`% 25`=1, `% 75`=51) · SESSION_COMMIT=`e89ea1ba167d9252ec99910304f534c8da5ca0ab`

## Ledger check

Read `docs/dream-cycle/LEDGER.md` (all 42 rows through 2026-08-31, the most recent on `main`) and
reconciled tonight's slot against every currently open PR/issue via the GitHub MCP tools (no `gh`
CLI in this session; not a FALLBACK condition — GitHub access is real, just via a different tool).

Two `brain-currency` defects are open and tracked, both with an existing, previously-validated fix
sitting in a **stale, unmergeable** draft PR:

- **Issue #258** (`readPanel()`'s freshness read from checkout `mtime`) — read side landed on `main`
  via an unrelated commit (`8caa157`, 2026-09-13); write side fix is PR **#292**
  (`dream/2026-09-16-brain-currency`), `mergeable_state: dirty`.
- **Issue #260** (`brainKnownSet()`'s `SOURCE_PATH` reads this checkout, not `root`) — fix is PR
  **#280** (`dream/2026-09-11-brain-currency`), `mergeable_state: dirty`.

Both defects were reconfirmed **still live on tonight's `main`** by direct read: `kb/forge-currency.mjs`
still computes `SOURCE_PATH` from `import.meta.url` (line 32); `scripts/brain-grade-groundtruth.mjs`
still has no `generatedAt` producer call (confirmed by grep, no match).

Also current: **29 open `dream/*` PRs**, oldest #269 (created 2026-09-08, 18 days). Zero dream-cycle
PRs have merged since #178 (2026-08-26) — a full month — even though ordinary engineering PRs
(releases, dependency bumps, infra fixes) continue to merge normally in the same window. Every
recent `brain-currency` night has flagged this; it has not changed.

## Why tonight is reconciliation, not a new finding

Given this surface has been mined for 7 distinct defects across the last 3 weeks
(`brain-stamp.mjs` builtFromSha, `brain-score.mjs` readCoverage existsSync, `source-coverage.mjs`
alias-blindness, `forge-currency.mjs` SOURCE_PATH, `corpus-freshness.mjs` versionIntent regex,
`ingest-repo.mjs` alias-blindness, `brain-score.mjs` panelStrict write-side), and given two of those
fixes are already correct, tested, and simply rotting in PRs that git can no longer fast-forward,
manufacturing an eighth new finding would not reduce uncertainty — it would add another card to a
backlog nobody is clearing. The higher-leverage action is keeping an already-accepted candidate
actually mergeable.

## Action taken: refresh PR #280 to current `main`

**Not touched:** PR #292 (dirty). Its conflict is **not mechanical** — its branch tip
(`deed53b9`, "fix(vercel): restore the working /metrics-redirect-exclusion pattern") carries an
unrelated Vercel redirect-regex change that itself conflicts with a *different* redirect-regex fix
already on `main`. Resolving that requires knowing which pattern is currently correct in production,
which is outside tonight's `brain-currency` authority and outside what a reconciliation pass should
guess at. Flagged for the repo owner instead (see Recommendation).

**Refreshed:** PR #280. Merged `origin/main` (`e89ea1b`) into `dream/2026-09-11-brain-currency`
(`bb86305c`) in a scratch worktree (`/tmp/pr280-check`, never touching the session's own checkout).
One real conflict: `data/convergence-manifest.json` — mechanical, resolved by taking `main`'s side
and regenerating with the repo's own `npm run convergence:write` (never hand-edited). No other file
conflicted; ~287 file changes in the merge diff are exclusively main's own unrelated 15-day drift,
auto-merged cleanly. Merge commit: `aca4a1fc`.

## Evaluation Receipt (re-verified against today's `main`, not assumed from the original PR)

- **TEETH**, reproduced fresh: reverted only `kb/forge-currency.mjs` to `origin/main`'s current
  content → 2 of 5 `tests/unit/forge-currency-helpers.test.mjs` cases fail exactly as originally
  predicted (`known.has('totally-different-repo')` true when it must be false; `known.has('metaharness')`
  true when it must be false). Restored the fix → 5/5 pass.
- **`test:unit`** (full suite, both sides, this container): baseline (`origin/main`,
  `/home/user/ruvnet-brain`) 15 failed files / 49 failed tests / 5561 passed / 5795 total. Candidate
  (merged worktree) initially showed 15 failed / **50** failed / 5562 passed / 5797 total — one extra
  failure, `retrieval-canary.test.mjs`'s "keeps the shipping oracle bound to a real ancestor of this
  checkout". Root-caused before drawing any conclusion: the merge had been resolved and staged but
  never **committed**, so `HEAD` in the worktree still pointed at the PR's stale pre-merge commit
  (`bb86305c`) while the working tree held the resolved files — a test that shells out to
  `git merge-base --is-ancestor` against `HEAD` saw the wrong commit. Committing the merge
  (`aca4a1fc`) and re-running that single test in isolation: PASS. Full failure-set diff after the
  fix: **byte-identical** to baseline (same 15 files / 49 tests, confirmed via `diff`). None of the 49
  reference `kb/forge-currency.mjs` or the test file this candidate touches.
- **`test:integration`** (full suite, both sides): baseline 9 failed files / 23 failed tests / 323
  passed / 407 total; candidate: **byte-identical** (same 9 files / 23 tests, `diff`-confirmed). All
  are the documented pre-existing signature (sqlite3/cross-encoder model cache, chmod/EACCES-under-root,
  network-dependent fixtures) — none reference the changed file.
- **`claims:verify`**: 3 PASS / 4 SKIP on both — unchanged, matches the documented no-brain-installed
  baseline for this container.
- **`eval:gate`**: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (this container
  never materializes a corpus; `OPENROUTER_API_KEY` is present, so this is not a credentials block).
  Not the relevant evaluator regardless — no retrieval/grounding surface touched.
- **`qa:pr`**: `version` lane PASS (4.3.28 agreed across all surfaces). `coverage` lane TIMEOUT at
  400s — matches this container's own repeatedly-documented precedent (PR #280's original receipt,
  PR #313's receipt) that the coverage-instrumented lane is slow/timeout-prone here independent of
  any candidate; not re-litigated tonight.

## Reward-Hack Check

No test, benchmark, gold file, or threshold was modified — only a merge-forward and a regenerated,
tool-produced manifest. The underlying fix is unchanged from its original, independently-critiqued
form (PR #280's own receipt, 2026-09-11).

## Security Review

No new code, no new attack surface — a merge-forward plus mechanical regeneration. Not
security-sensitive.

## Evidence

OBSERVATION (both #258 and #260 confirmed still live on tonight's `main`; PR #280 and #292 both
stale/dirty) → MEASUREMENT (fresh TEETH re-proof; full baseline-vs-candidate comparison on both
`test:unit` and `test:integration`, byte-identical after fixing the worktree's own uncommitted-merge
artifact) → DECISION (PR #280 pushed current and mergeable again; PR #292 left alone and flagged,
not guessed at).

## Recommendation

`evaluated: accepted` for the refresh (PR #280 is now clean against `main` and its fix re-verified).
No new GitHub issue — per this repo's ISSUE DISPOSITION OVERRIDE, this is a bounded reconciliation
of already-tracked, already-fixed defects, not a new one. **For the repo owner:** PR #280 (issue
#260) is ready to merge as-is. PR #292 (issue #258) still needs a **substantive** decision — which
Vercel redirect-exclusion pattern is correct — before anyone can safely resolve its conflict; that
decision belongs to a human, not tonight's session. Separately: the 29-PR, 18+-day dream-cycle
backlog is now the standing risk this surface has flagged on every night since 2026-08-26 without
change; tonight converts one of those PRs from unmergeable back to mergeable, but review throughput,
not more research, remains what determines whether any of this research is ever realized.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
MERGE_COMMIT   = aca4a1fcef436379452805fe91c96378fb65d6d5
REPORT_HASH    = 352f1ce5bec49589b5332058f305084e9c6c7262abec932f2a467f2b4505022b
WITNESS        = e72956293e87c62a1d894762a9838a765456b0852fe28dbb0e9731af26341b3e
```

Verifier procedure: (1) fetch `origin/dream/2026-09-11-brain-currency`; (2) `git show
aca4a1fc:kb/forge-currency.mjs` and confirm `SOURCE_PATH` is gone, replaced by a `root`-relative
join inside `brainKnownSet()`; (3) `git stash`/revert that one file, run
`tests/unit/forge-currency-helpers.test.mjs`, confirm 2 failures; restore, confirm 5/5; (4) run
`tests/unit` and `tests/integration` on this commit vs. `origin/main` and diff the failing-test
lists — expect byte-identical; (5) `sha256sum` this file and this commit, concatenate, `sha256sum`
again, compare to the ledger row's `Witness` column.
