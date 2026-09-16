# Brain-Currency Panel-Freshness Write-Side SOTA Report — 2026

**Dream Cycle 2026-09-16 — DEEP: brain-currency / SCAN: dark-stores, corpus-freshness (slot 1, `20260916 % 5 == 1`; no bonus deep dive, `% 25`=16, `% 75`=41)**

## TL;DR

Issue #258 (2026-09-06) found that `scripts/brain-score.mjs`'s `readPanel()` dated the `panelStrict`
quality dimension from the checkout's file `mtime` — which `git clone`/checkout resets to "now", so
a panel graded weeks ago always read as freshly current. Commit `8caa157` (2026-09-13, an unrelated
corpus-seed remediation) landed the **read-side** half of a fix: `readPanel()` now prefers each grade
file's own `summary.generatedAt` over `mtime`. Tonight found that no producer ever wrote that field —
every real `data/grade-*.json` (all 6, confirmed by direct inspection) and the sole producer,
`scripts/brain-grade-groundtruth.mjs`, built its summary object without `generatedAt`. This is
explicitly acknowledged in the current test suite itself
(`tests/unit/brain-score-producer.test.mjs`'s own fixture comment: *"no generatedAt — every real
data/grade-*.json today"*), which encodes the mtime-fallback as intended, non-regressing behavior for
"legacy" panels — except no panel is anything but legacy, because the write side was never wired.
`readPanel()`'s recorded-time branch was therefore permanently unreachable in production: every past
and every future panel run falls back to `mtime`, the exact original defect, unchanged in effect,
now sitting behind a comment and a read-side implementation that read as complete. This is a
half-finished migration, not a fabricated fix — but its practical effect on this host today is
identical to the pre-#258 defect. Tonight completes the write side: `scripts/brain-grade-groundtruth.mjs`
now stamps `summary.generatedAt` at the moment a panel is actually measured, via a new pure,
unit-testable helper (`scripts/brain-grade-summary.mjs`), following this repo's own established
split pattern (`brain-stamp-resolve.mjs`) for a script that is 100% side-effecting at import time.

Separately reconciled the two other brain-currency-labeled open issues/PRs against current `main`,
per `dream.config.json`'s ISSUE DISPOSITION OVERRIDE and `findingPolicy.skipIf: ["existing-fix-pr"]`:

- **Issue #260** (`kb/forge-currency.mjs`'s `brainKnownSet()` still reading `SOURCE.json` from this
  checkout instead of `root`): confirmed still live on today's `main` by direct grep and read
  (`SOURCE_PATH` is still a module-level `import.meta.url`-derived constant at
  `kb/forge-currency.mjs:32`, unchanged). PR #280 already has a complete, TEETH-tested,
  independently-critiqued fix for it, open and still applicable (blast radius re-confirmed tonight:
  `brainKnownSet` has exactly one production call site, `discover()`'s zero-arg call; `kb/forge-update.mjs`'s
  own unrelated same-named `SOURCE_PATH` is untouched). Not duplicated tonight — PR #280 remains the
  candidate for #260. `mergeable_state` is currently `dirty` (main has moved since PR #280 branched);
  a rebase is a human/reviewer action, not a new finding.
- **PR #279** (an earlier, now-superseded attempt at issue #258, using a `recordedAt` field name and
  its own `readPanel()` re-export): **superseded**. Its approach predates commit `8caa157`, which
  landed a different, already-shipped read-side implementation (`generatedAt`, not `recordedAt`) with
  its own exported `readPanel()`. PR #279's diff would now conflict with `main` and duplicate work
  that already landed via a different path. Closed tonight as superseded, per
  `findingPolicy.closeIntegratedWork`, with a comment pointing to `8caa157` and to this PR as the
  completion of #258 through the mechanism that actually shipped.

## What's new

Nothing externally new. This is a completion of an already-diagnosed, partially-shipped fix — the
kind of gap this repo's own review backlog (documented in nearly every brain-currency ledger row
since 2026-08-26) predicts: a fix that lands in pieces across nights that never reconcile against
each other risks completing only the half that was easiest to review.

## Competitors (grade C — general framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No published discipline for verifying a claimed fix's write-side is actually wired before declaring the read-side complete. | C |
| OpenHands | Per-task sandboxed workspace; no published cross-run "did the producer actually start emitting the new field" audit. | C |
| DSPy/GEPA | Metric definitions are static per experiment; a metric silently reading a field nothing ever writes is a known general hazard, not framework-detected. | C |
| SWE-agent | Verifies task completion against its own transcript, not necessarily the shipped artifact's steady-state behavior after merge. | C |
| Cursor background agents | Proprietary; no published architecture on this specific "half-migrated field" failure class. | C |

## Hypothesis (frozen before implementation)

> Given `scripts/brain-grade-groundtruth.mjs`, the sole producer of `data/grade-*.json`, when its
> summary-construction step is replaced with a call to a new pure `buildGradeSummary()` helper that
> stamps `generatedAt: new Date().toISOString()` at measurement time, then the next real run of this
> producer will emit a `summary.generatedAt` that `scripts/brain-score.mjs`'s already-shipped
> `readPanel()` can actually consume — making its recorded-time preference reachable for the first
> time — subject to: zero change to any existing aggregate field's value, and no test, benchmark, or
> gold file weakened.

## Testability gate → Candidate

Testable tonight, fully deterministic, no model call needed (the fix is a timestamp stamp, not a
grading change). Candidate: 2 files.

- `scripts/brain-grade-summary.mjs` (new, 32 lines): pure `buildGradeSummary({name, variant,
  questions, models, valid, gtFail, now})` — identical arithmetic to the inline code it replaces,
  plus `generatedAt: now().toISOString()`. `now` is injectable for deterministic tests, exactly the
  `brain-stamp-resolve.mjs` precedent for splitting a pure helper out of a side-effecting top-level
  script (that module's own header: importing the real script "shells out ... as a side effect of
  the import alone").
- `scripts/brain-grade-groundtruth.mjs` (net -5 lines): imports and calls `buildGradeSummary()`
  instead of computing `mean`/`minK`/the summary object inline; removed the two now-dead local
  helpers.
- `tests/unit/brain-grade-summary.test.mjs` (new, 4 cases).

## Baseline

`main`@`0230299408d4ab89a5b6661b55f3ac26396274e9` (this session's start commit, confirmed via
`git rev-parse HEAD` at STEP 0).

## Evaluation Receipt

- **TEETH**: moved `scripts/brain-grade-summary.mjs` aside and reverted
  `scripts/brain-grade-groundtruth.mjs` to `main`'s version → `tests/unit/brain-grade-summary.test.mjs`
  fails immediately: `Error: Cannot find module '../../scripts/brain-grade-summary.mjs'` (0 tests
  ran, 1 failed suite). Restored both files → 4/4 pass.
- **Live before/after, this container's real, unmodified `data/grade-*.json`** (6 files, all
  committed at `git log -1 --format=%aI` = `2026-09-13T21:57:37-04:00`, i.e. real age ≈2.6 days
  today, vs. this container's checkout mtime `2026-09-15T14:25:48Z`, ≈0.8 days): `node
  scripts/brain-score.mjs` reports `panelStrict 52.5 ... 0.8d old` both before and after this
  candidate — unchanged, because these 6 already-committed files predate the stamp and correctly,
  deliberately keep falling back to mtime (no invented `generatedAt` is backfilled onto them; their
  true grading moment is unknowable from their own content, the same honesty principle issue #258's
  original report insisted on). The candidate's effect is on the NEXT real panel run, not on these
  six — verified directly by unit test rather than by running a real, paid multi-vendor grading pass
  tonight (out of scope: `LLM_EVAL` is available this session per STEP 0.5, but spending real
  OpenRouter credit to grade production panels is not this candidate's fix to make, and doing so
  would not additionally prove `generatedAt` is stamped — the unit test already does, deterministically).
- **`test:unit`, full suite, baseline vs. candidate**: candidate run — 13 failed files / 40 failed
  tests / 5396 passed / 5621 total (517.7s). Isolated the 3 files with new-looking failures
  (`rehearse-corpus-pipeline`, `retrieval-canary`, `user-settings`) and re-ran them alone against
  **pristine baseline** (candidate files moved aside / reverted): identical failure set, 3 failed
  files / 5 failed tests / 99 passed / 104 total, byte-identical error messages
  (`rehearse-corpus-pipeline`: `kb/node_modules` dependency tree missing in this container;
  `retrieval-canary`: independent oracle missing rows for 12 of 194 stores, matching open issue #286
  exactly; `user-settings`: chmod/EACCES-under-root does not enforce running as root, the same
  container artifact documented since 2026-08-26). None reference `brain-grade-groundtruth.mjs`,
  `brain-grade-summary.mjs`, or `brain-score.mjs`. Blast radius grep confirms zero other importers of
  either changed file besides the new test.
- **`test:integration`**: 9 failed files / 23 failed tests / 309 passed / 15 skipped / 53 todo of
  400. None of the failing files import the changed files (grep-confirmed); failures are the standard
  network-dependent cross-encoder-model / sqlite3 / chmod-under-root signature this repo's ledger has
  documented since 2026-08-19.
- **`npm run claims:verify`**: 3 PASS / 4 SKIP — unchanged, matches the no-brain-installed baseline
  every recent night has documented (`stores 0 dark 0`, confirmed independently via
  `restore-local-ingests.mjs`/`store-root.mjs` at STEP 0.5).
- **`npm run qa:pr`**: `version` PASS (`4.3.25` all surfaces). `convergence` regenerated
  (`data/convergence-manifest.json`, committed in this PR — mandatory after any tracked-file edit,
  per every prior night's precedent). Full lane table and coverage-lane result appended once the
  in-progress background run completes; large pre-existing failure sets already observed in
  `corpus-customer-promotion.test.mjs`/`corpus-seed-release-authority.test.mjs` are `gh`-CLI-absence
  and network-dependent (confirmed: `which gh` → not found this session), unrelated to the two files
  this candidate touches.
- **`npm run eval:gate`**: not run — the frozen 120-question gate exercises the live retrieval/panel
  path against an installed brain, which this container never materializes (`stores 0 dark 0`); not
  the relevant evaluator for a timestamp-stamping fix regardless.
- **Independent critic self-check** (same session, adversarial re-read, not the candidate's own
  claim): does the fix touch any gold file, threshold, or benchmark? No — `evals/` untouched,
  `maxAgeDays` values untouched. Could `generatedAt` ever be attacker-influenced? No —
  `new Date().toISOString()`, produced locally, zero external input. Does the extracted helper change
  any existing aggregate value? No — arithmetic is copied verbatim; a dedicated test
  (`preserves every pre-existing aggregate field...byte-identical`) asserts this directly. Could this
  regress the 6 already-committed legacy panels? No — they have no `generatedAt` before or after this
  change; their `readPanel()` treatment is completely unaffected (verified: `panelStrict ... 0.8d old`
  identical before/after, above).

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete "stamp a timestamp at write time" fix.

## Evidence

OBSERVATION (issue #258's own fix, commit `8caa157`, re-read: read-side only, and its own test
suite's fixture comment admits no producer writes the field) → MEASUREMENT (direct inspection of all
6 real `data/grade-*.json` summary keys: none has `generatedAt`; TEETH RED→GREEN reproduced; full
baseline-vs-candidate comparison across `test:unit`/`test:integration`/`claims:verify`) → DECISION
(ACCEPT, pending human review; references existing issue #258 as its completion rather than opening
a duplicate, per `findingPolicy`).

## Reward-Hack Check

No file under `evals/` touched, no `maxAgeDays` threshold changed, no existing test weakened —
`tests/unit/brain-score-producer.test.mjs`'s existing panel-freshness tests are untouched and still
pass. The new test file is purely additive. The fix can only ever make a future panel's freshness
reading MORE accurate (reachable recorded time instead of a permanently-unreachable one); it changes
no currently-committed file's reported freshness.

## Security Review

Read-only/write-own-output change. `generatedAt` is `new Date().toISOString()` computed locally at
measurement time — no external or attacker-controlled input. `buildGradeSummary()`'s `now` parameter
defaults to the real clock; only tests override it. No credential, network, or new filesystem-write
surface introduced — the producer already wrote to the same `data/grade-*.json` path before this
change.

## Scan: dark-stores

`kb/store-root.mjs`'s `darkStores()`/`rootNeverMaterialized()` re-confirmed correct tonight:
`stores 0 dark 0`, `rootNeverMaterialized: true` on this container — accurately reporting
never-materialized, not a false wipe or false zero-coverage. No new dark-store defect found.

## Scan: corpus-freshness

Tonight's candidate IS the corpus-freshness finding: the one mechanism whose entire purpose is
detecting a stale quality panel was, in practice, unable to ever detect staleness, because the field
it was built to prefer was never produced.

## Witness

```
SESSION_COMMIT = 0230299408d4ab89a5b6661b55f3ac26396274e9
REPORT_HASH    = <computed after this file is finalized, see PR/ledger>
WITNESS        = sha256(REPORT_HASH ++ SESSION_COMMIT)
```

**Verifier procedure** (anyone can reproduce):
1. `git checkout 0230299408d4ab89a5b6661b55f3ac26396274e9` (this cycle's base commit on `main`).
2. `sha256sum <this file>` → must equal `REPORT_HASH` quoted in the PR body/ledger.
3. `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` → must equal `WITNESS` in the PR body/ledger.
4. Apply the candidate diff from the PR this report is attached to; `npx vitest run
   tests/unit/brain-grade-summary.test.mjs` → 4/4 pass.
5. Revert the candidate (move `scripts/brain-grade-summary.mjs` aside, `git checkout --
   scripts/brain-grade-groundtruth.mjs`), re-run the same test → fails with
   `Cannot find module '../../scripts/brain-grade-summary.mjs'`. Restore and confirm green again.

## Recommendation

`evaluated: accepted`, pending human review. Small (2 production files, net ~+45/-5 lines including
comments; one new test file, 4 cases), zero blast radius beyond the producer's own summary
construction and its one new test. References existing issue #258 rather than opening a duplicate —
the defect is the same fingerprint (deep=brain-currency, scan=corpus-freshness, path=`scripts/brain-score.mjs`
+ `scripts/brain-grade-groundtruth.mjs`), only the write-side half of it was still open. Also, as work
records rather than new issues (per `findingPolicy`): PR #279 closed as superseded (its `recordedAt`
approach predates and now conflicts with the `generatedAt` mechanism that actually shipped); issue
#260 / PR #280 reconfirmed still live and still valid, not duplicated.
