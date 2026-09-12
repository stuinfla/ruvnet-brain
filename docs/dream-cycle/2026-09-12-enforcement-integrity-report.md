# Dream Cycle 2026-09-12 — enforcement-integrity: reconciling an orphaned fix (#264)

## Rotation

DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth` (slot 2 of 5, `20260912 % 5 == 2`). No bonus modulus tonight (`%25`=12, `%75`=37).

## Ledger check

`docs/dream-cycle/LEDGER.md` on `main` is stale at 2026-08-31. Checked GitHub directly rather than assuming: on 2026-09-07 at ~18:48 UTC, a large batch of open `dream/*` PRs (at least 20, spanning 2026-09-01 through 2026-09-07) was closed **without merging**, in a tight ~10-second window — a bulk cleanup, not organic one-by-one review. A separate, huge release-consolidation PR (#267, "ship 4.3.10 through one reviewed qualification", +16991/-4636 across 333 files) merged ~2 hours earlier the same day.

Sampling confirmed the consolidation folded some of the orphaned fixes into `main` directly even though their own PRs closed unmerged:
- PR #229 (`wired-check.mjs` `callerPattern` boundary fix): **present** in current `main` (`(?<![\w.-])` bounded pattern).
- PR #233 (`version-bump-gate.sh` `field()` escape-aware regex): **present** in current `main`.
- PR #231 (`lesson-gate.mjs`/`lesson-presentation.mjs` MAX_SHOWS counts `compactExtras`): **present** in current `main` (`shown: [...inForce, ...compactExtras]`, with the exact rationale comment from the PR).

But two 2026-09-07 findings, both from tonight's own surface (enforcement-integrity), did **not** make it in:
- Issue #262 / PR #263 (`lesson-promote.mjs` theme-demotion dead code): issue **closed as `completed` by the owner today, 2026-09-12T08:39:47Z** (hours before this run) — a deliberate, recent disposition. Per this repo's own ISSUE DISPOSITION OVERRIDE ("never reopen resolved work solely because its historical ledger row names a finding"), **left untouched** tonight.
- Issue #264 / PR #265 (`lesson-presentation.mjs` budget truncation can drop an opted-in BLOCK): issue **still open**, unresolved, and the code fix confirmed absent from `main` (verified by reading the live source, not by trusting the PR's own claim). This is the actionable one.

Today (`20260912 % 5 == 2`) is the first enforcement-integrity slot since 2026-09-07, so no later night has already covered this ground.

## Deep dive / defect (reconciled, not newly discovered — full credit to issue #264)

`plugin/scripts/lesson-presentation.mjs`'s `buildLessonPresentation()` merges lesson candidates from every requested `--trigger` into one list, ranks by `repeatCount`, then truncates to a `nudgeBudget` (1200 chars) with no exemption for a lesson the user has opted into as a hard BLOCK. A large, high-repeatCount advisory on one trigger can consume the whole budget and `continue` a lower-ranked opted-in BLOCK on a different trigger straight out of `inForce`. `lesson-gate.mjs` reads `blocking = inForce.filter(isBlocking)` and only exits with a refusal code when non-empty — so the excluded block silently becomes a full ALLOW, defeating a real user consent.

## Reproduction (independent, before any repair)

Added the two TEETH tests from PR #265 verbatim to `tests/unit/lesson-gate.test.mjs`, then ran them against unmodified `main` (`7aa8ab2`, before any candidate change):

```
FAIL exits 2, not 0, when a co-occurring advisory alone exceeds the nudge budget
  AssertionError: expected +0 to be 2
```

Confirmed the defect is live on current source, not merely a historical claim.

## Candidate (bounded repair)

`plugin/scripts/lesson-presentation.mjs`: every `isBlocking()` candidate is now admitted into `inForce` first, unconditionally; the budget then governs only the remaining advisories. Identical to prior behavior whenever no block is present. 1 production file, 9 net changed lines, one conceptual change — re-applying the already-verified fix from PR #265/#264, not a new design.

## Independent critic (fresh agent, no shared context)

Verdict: **CLEAR**, with one real, concrete finding: the second inherited TEETH test ("the block is present even when it is the lowest-repeatCount candidate…") was **vacuous** — it passed identically on pre-fix code, because none of its statements were long enough to actually exceed `nudgeBudget`. This flaw pre-dates tonight (it shipped in the original, closed PR #265) and had never been independently verified until now.

**Fixed tonight, not carried forward**: rewrote the second test so both "loud" lessons individually exceed `nudgeBudget` (matching the load-bearing first test's construction), forcing genuine budget contention against the block. Re-verified red on pre-fix code (`expected +0 to be 2`), green post-fix. This is retained as the concrete value of re-running STEP 10 rather than trusting an orphaned PR's own self-review.

## Evaluation receipt

- **TEETH**: both tests in the new `describe('BUDGET: ...')` block proven RED on `git stash`-isolated pre-candidate code, GREEN restored. `tests/unit/lesson-gate.test.mjs` full file: 68/68 pass.
- `npx vitest run tests/unit` (4896 tests): 6 failed files / 9 failed tests — confirmed **byte-identical** to a `git stash` baseline (advocacy-ignored, advocacy-outcomes, hook-shim-fallback-once, user-settings, plus 2 more chmod/EACCES-under-root-container artifacts). `data/convergence-manifest.json` regenerated via `npm run convergence:write` (required — this diff touches a tracked source file) and its own test passes on both sides post-regeneration.
- `npx vitest run tests/integration` (397 tests): 11 failed files / 26 failed tests — this container's environment baseline has genuinely widened since the 2026-08-31 ledger row (native-module/timing gaps in `card-lane-hot-path`, `project-progression-*`, `unprompted-speech-registry`, none touching the changed files); confirmed **byte-identical** failing-test-name set on a `git stash` baseline run in this same session. Zero regression.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition to every prior documented night (brain not installed on this container; `LEARNING-REPLAY` correctly SKIPs while the diff is uncommitted, per `learning-replay-contract.mjs`'s own `LOAD_BEARING` drift guard).
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`, the same pre-existing condition documented every prior night; not a retrieval-quality candidate regardless.
- `npm run qa:pr`: `version`/`convergence`/`execution-policy`/`architecture`/`wiring`/`substitution`/`catalog`/`mesh`/`plugin` lanes PASS. `docs` lane FAILs — confirmed **byte-identical** (788/788 lines) against a `git stash` baseline via direct `node scripts/doc-currency.mjs --check` diff; no ADR's `governs:` frontmatter lists `plugin/scripts/lesson-presentation.mjs` (confirmed by grep — ADR-0055 governs `lesson-gate.mjs`/`lesson-hooks.sh`/`lesson-store.mjs`/`lesson-bridge.mjs` but not this file), so no currency-log row is owed. `coverage` TIMEOUT and `claims-source` BLOCKED are pre-existing container conditions (no brain installed), not this diff's doing.

## Blast radius

`grep -rln "buildLessonPresentation\|lesson-presentation"` repo-wide: `plugin/scripts/lesson-gate.mjs` (the one functional importer), `scripts/learning-replay-contract.mjs` and `tests/unit/learning-replay-verdict.test.mjs` (path-string `LOAD_BEARING` references only, not functional imports — `learning-replay-verdict.test.mjs` re-run directly: 22/22 pass, unaffected). Independently re-confirmed by the critic agent.

## Reward-Hack Check

No benchmark/threshold touched, no existing test weakened (2 tests added, 1 of which was rewritten tonight to stop being vacuous — strictly stronger, never weaker). `isBlocking()`'s four-condition opt-in trust boundary is completely unchanged — the fix can only let an already-qualifying, user-consented refusal survive; it cannot manufacture a new one.

## Security Review

No new attack surface. The opt-in trust boundary is untouched; this diff only changes whether an already-qualifying block survives the nudge budget. Same disclosed non-blocking edge case as PR #265: a user who opts many large block lessons in at once could now produce an unbounded-length refusal message — reachable only by the user's own opt-in action, not model- or externally-controlled.

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean admission-order fix; same precedent as every prior enforcement-integrity night.

## Evidence

OBSERVATION (cross-trigger merge applies a size budget with no block exemption) → MEASUREMENT (TEETH red pre-fix / green post-fix, independently reproduced by a fresh critic agent via a second isolation method) → DECISION (ACCEPT, pending human review) → correction to a vacuous test, itself independently re-verified.

## Competitors

Sakana AI Scientist, OpenHands, DSPy/GEPA, SWE-agent, Cursor background agents — grade C, general design knowledge only; none of the five publish an analogous cross-decision-point budget/consent-priority mechanism to compare against.

## Recommendation

The 2026-09-07 mass PR closure destroyed the direct merge path for several verified fixes without integrating all of them; this repo's own `dream-config`-driven nights have since adapted by doing reconciliation passes (see #269, #276, #278, #279/#280) rather than blind rediscovery — tonight continues that pattern for the one enforcement-integrity finding still open and unresolved. The owner's review attention on the resulting draft PR remains the highest-leverage action; a second, smaller recommendation: consider whether future bulk-close events should first check each PR's diff against `main` (as tonight did) to avoid silently losing verified, TEETH-proven fixes.

## Gist

LOCAL — no `gh` CLI or gist-creation tool available this session; not fabricated. Full report committed here.

## Issue

#264 (pre-existing, reconciled — not reopened, not duplicated)

## PR

#281

## Witness

```
SESSION_COMMIT = 7aa8ab2ecb589a1c4b8c779a92edbf42897e127c
REPORT_HASH    = 651f70270234c5613b85d624790796c3812a362dc32c5db60dea3d2f1d4c186f
WITNESS        = d6f24109128567cfc63e98f038e2b6bd8baeeaa9bf7475ec048edb8cc40dea63
```

Verify: (1) checkout `7aa8ab2ecb589a1c4b8c779a92edbf42897e127c`; (2) obtain this report from the candidate branch/PR; (3) `sha256sum` it, confirm it starts `651f702702...`; (4) `printf '%s%s' <report-sha256> 7aa8ab2ecb589a1c4b8c779a92edbf42897e127c | sha256sum`, confirm it starts `d6f2410912...`; (5) `git stash` this PR's diff to `plugin/scripts/lesson-presentation.mjs`, confirm both new tests in `tests/unit/lesson-gate.test.mjs`'s `BUDGET` block fail, `git stash pop`, confirm both pass.

## Merge Policy

Human review required. `autoMerge: false` per `dream.config.json` — the decision, not a default. This session never self-merges and never autonomously promotes candidate state.
