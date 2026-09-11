# Brain-Currency SOTA Report — 2026

## TL;DR

`scripts/brain-score.mjs`'s `readPanel()` derived the `panelStrict` quality dimension's freshness
(`at`) from the grade file's on-disk `mtime` instead of a recorded grading time. `git clone`/`checkout`
resets every tracked file's mtime to the checkout instant, so a panel graded weeks or months ago always
reads as freshly measured, on any host — a structural inability to ever report STALE, independent of
true age. Fixed by having the producer (`scripts/brain-grade-groundtruth.mjs`) stamp `summary.recordedAt`
at grading time, and having `readPanel()` read that field instead of mtime, falling back to an honest
`at: null` ("no timestamp recorded") for the legacy files that predate this fix.

This is a **revival of an already-fully-vetted candidate** (issue #258, PR #259, opened 2026-09-06,
closed unmerged 2026-09-07 in the mass-closure of the stale-PR backlog) — not a new hypothesis. Tonight's
session independently re-verified the defect still reproduces on current `main` (2eef202) before reusing
the diff, rather than trusting the historical claim.

## What's new

Nothing novel in mechanism — this is the same "clone freshness is not artifact freshness" class already
fixed for `restore-local-ingests.mjs` (#142/#143), `brain-score.mjs`'s `readCoverage()` (#154/#155,
#177/#178), `brain-stamp.mjs`'s `builtFromSha` (#175/#176), and `source-coverage.mjs`'s alias resolution
(#212/#213). What's new tonight is closing the loop on a previously-diagnosed-but-abandoned instance of
that same class, rather than manufacturing a sixth sibling finding while two known-good fixes (#258/#259,
#260/#261) sit idle.

## Competitors (C-grade, sizing only)

| Competitor | Freshness provenance approach |
|---|---|
| Sakana AI Scientist | Explicit run/event timestamps in its own experiment artifacts |
| OpenHands | Session-scoped state; no persisted cross-run "when was this true" claim |
| DSPy/GEPA | Optimizer trace carries its own iteration metadata, not filesystem state |
| SWE-agent | Per-task ephemeral sandbox; no long-lived cached-score staleness concept |
| Cursor background agents | Platform-owned run history, not local clone mtime |

All avoid this class by construction (explicit provenance in the artifact itself), never by relying on
a local clone's filesystem mtime as a fact about when content became true. Grade C — sizing only, no
competitor source read tonight (this is a revival, not new research).

## Hypothesis (frozen before evaluation)

> Given a git checkout of this repo with one or more committed `data/grade-*.json` panel-grade
> artifacts, when `readPanel()` sources each file's `at` timestamp from a new `summary.recordedAt`
> field embedded by the producer instead of the file's on-disk `mtime`, then a fixture panel recorded
> 40+ days ago reports STALE (never falsely fresh from a just-checked-out mtime), a panel recorded
> within its 30-day budget still reports CURRENT, and legacy grade files predating this fix (no
> `recordedAt`) honestly report "no timestamp recorded" — subject to: `test:unit`/`test:integration`
> show no regression, and `composite()`'s structural guard is unaffected.

## Benchmarks / Evaluation

- **TEETH**: `git checkout HEAD~1 -- scripts/brain-score.mjs scripts/brain-grade-groundtruth.mjs` (test kept) reproduces `TypeError: readPanel is not a function`, 5/5 fail. Restoring → 5/5 pass.
- Live `node scripts/brain-score.mjs` before/after on this real container: `panelStrict 52.5 ... 0d old` (fabricated) → `panelStrict 52.5 ... STALE (no timestamp recorded)` (honest).
- `test:unit` (385 files/4618 tests): candidate 8 failed files/9 failed tests (`convergence-manifest` now PASSES, fixed by this PR's manifest regeneration). Independently re-verified the 8 remaining failures are byte-identical to pristine `main`@2eef202 by temporarily reverting just the 3 changed files and re-running — same 8 files, same assertions, same messages (advocacy-ignored, advocacy-outcomes, doc-currency, forge-ask-all×2, hook-shim-fallback-once, no-restated-truth, publication-receipt-wiring, user-settings — all pre-existing chmod/EACCES-under-root, release-identity, or unrelated-subsystem artifacts, none referencing the 2 changed files).
- `test:integration` (43 files/374 tests): candidate 7 failed files/20 failed tests. The 2 files not previously documented in this ledger's baseline signature (`card-lane-hot-path`, `unprompted-speech-registry`) were independently re-verified in a clean worktree at pristine `main`@2eef202: identical 7/31 failures, same messages — confirmed pre-existing/environmental, unrelated to hooks/card-lane subsystems this candidate never touches.
- `claims:verify`: 4 PASS/3 SKIP, unchanged from pre-candidate baseline run on this container.
- `qa:pr`: `version`/`convergence`/`execution-policy`/`architecture`/`wiring`/`substitution`/`catalog`/`mesh`/`plugin` lanes PASS. `docs` FAIL (152 pre-existing violations across dozens of ADRs unrelated to the 2 changed files, which no ADR governs — confirmed by frontmatter grep). `coverage`/`claims-source` FAIL/BLOCKED — grepped `scripts/source-coverage.mjs` and `scripts/claims-verify.mjs` for any import of `brain-score.mjs`/`brain-grade-groundtruth.mjs`: only one hit, a comment, no functional coupling; both lanes are structurally blocked by "no brain installed on this container" (same condition `claims:verify`'s own SKIPs report), independent of this diff.
- `eval:gate`: EVALUATED=blocked (`no brain at /root/.cache/ruvnet-brain/kb`, confirmed `stores 0 dark 0` independently). `LLM_EVAL` also blocked (no `OPENROUTER_API_KEY` this session) — this candidate needs no model call at all (fully deterministic).
- `npx @metaharness/darwin evolve --sandbox mock`: ran, generic canned leaderboard unrelated to a deterministic timestamp-source fix — recorded available-but-inapplicable, consistent with every prior night on this same fix-class.
- **Independent adversarial critic** (separate subagent, fresh context, not this candidate's author): verdict **CLEAR**. Confirmed `readPanel` has exactly one production call site (zero-arg, real default path); the `dir` param exists solely for test injection; no `evals/`/gold-answer/threshold file touched; the fix's error direction is one-way safe (can only correct fabricated-fresh toward honest-stale/null, never the reverse — a currently-honest-current reading cannot become falsely stale under this diff); `recordedAt` is purely local wall-clock, no attacker-controlled input; test assertions are non-tautological (verified via `fs.utimesSync` forcing a just-touched mtime against old/absent `recordedAt`). One disclosed, non-blocking consequence: the 6 pre-existing `grade-*.json` files will read `stale` until a real panel re-run happens (needs `OPENROUTER_API_KEY`) — intentional, not scope creep, no downstream consumer of `panelStrict` outside `brain-score.mjs` itself.

## Evidence classification

- OBSERVATION: PR #259's diff, re-read; `readPanel()` on current `main` still uses `fs.statSync(...).mtime`, confirmed unfixed by direct grep before writing a line of code.
- MEASUREMENT: TEETH RED→GREEN reproduced independently this session (not merely re-asserting the historical PR's claim); live before/after `brain-score.mjs` output diff; full `test:unit`/`test:integration`/`qa:pr`/`claims:verify` baseline-vs-candidate comparison, with the 2 previously-undocumented integration failures independently re-verified against a clean pristine-`main` worktree rather than assumed pre-existing.
- DECISION: ACCEPT, pending human review. Never self-promoted. Independent critic verdict CLEAR.

## 3 concrete next steps

1. Revive #260/#261 (`forge-currency.mjs`'s `SOURCE_PATH` still checkout-relative, independently re-confirmed unfixed on `main` tonight) the same way — a second small, already-vetted fix idle in this exact rotation slot.
2. Once `OPENROUTER_API_KEY` is available and a real panel re-run happens, the 6 legacy `grade-*.json` files will finally carry a real `recordedAt` and stop reading as "no timestamp recorded".
3. The owner has begun manually closing the backlog (issue #226 closed today, 2026-09-11, by `stuinfla`) — worth checking whether #258/#260 should be closed the same way once their revived PRs are reviewed, rather than accumulating a third generation of open issues for the same two findings.

## Security Review

Read-only reporting-script change. `recordedAt` is `new Date().toISOString()`, produced locally at
grading time — no external/user-controlled input, no network/credential surface touched. `readPanel(dir)`
gained a parameter but the production call site (`brain-score.mjs:220`) is unchanged (zero-arg call, same
default `path.join(ROOT, 'data')`). No new attack surface.

## Reward-Hack Check

No file under `evals/` touched, no threshold changed (`maxAgeDays: 30` unmodified), no test weakened —
independently confirmed by the adversarial critic. The fix is one-way safe: it can only ever correct a
false-fresh reading toward honest-stale/null, never the reverse (proven by the dedicated "still reads
current inside budget" test guarding against over-correction).

## Witness

```
SESSION_COMMIT = 2eef2024cd596e3e6f11523f1b7603306bee5dd9
REPORT_HASH    = <computed after this file is finalized, see PR/ledger>
WITNESS        = sha256(REPORT_HASH ++ SESSION_COMMIT)
```

**Verifier procedure** (anyone can reproduce):
1. `git -C ruvnet-brain checkout 2eef2024cd596e3e6f11523f1b7603306bee5dd9` — the session-start commit.
2. `sha256sum <this file>` → must equal `REPORT_HASH` above.
3. `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` → must equal `WITNESS` above.
4. `git -C ruvnet-brain diff 2eef202 dream/2026-09-11-brain-currency-panel-freshness -- scripts/brain-score.mjs scripts/brain-grade-groundtruth.mjs tests/unit/brain-score-panel-freshness.test.mjs` → confirm it matches the candidate described here.
5. `git -C ruvnet-brain checkout HEAD~1 -- scripts/brain-score.mjs scripts/brain-grade-groundtruth.mjs && npx vitest run tests/unit/brain-score-panel-freshness.test.mjs` → 5/5 RED (`readPanel is not a function`); `git checkout HEAD -- <same files>` → 5/5 GREEN.
