# Enforcement Integrity SOTA Report — 2026-09-07

## TL;DR

`plugin/scripts/lesson-presentation.mjs`'s cross-trigger merge could silently drop a user's own
opted-in `enforcement:block` lesson from the rendered presentation when a *different*, non-blocking
lesson on another trigger was ranked ahead of it by raw `repeatCount` and its rendered text alone
exceeded the 1200-character nudge budget. Because `lesson-gate.mjs` reads its refusal decision
(`blocking.length ? EXIT_BLOCK : EXIT_ALLOW`) directly from the same `inForce` array the budget
truncates, this converted a real, user-consented refusal into a silent full ALLOW — the exact
"guard that cannot fail" class this repository's own `lesson-store.mjs` already fixed once, one
layer down, for the single-trigger case. Fixed by exempting every `isBlocking()` candidate from the
budget: a refusal is now assembled first and unconditionally, before the (unchanged) budget governs
the advisory lessons layered around it.

## What's new

- **Rotation.** SLOT 2 of 5 (`20260907 % 5 == 2`) → DEEP=`enforcement-integrity`,
  SCAN=`lesson-delivery`,`gate-teeth`. No bonus modulus tonight (`%25`=7, `%75`=32).
- **Ledger check.** `docs/dream-cycle/LEDGER.md` on `main` is stale at 2026-08-31 even though 24
  `dream/*` PRs (#157–#261) have opened since — re-checked via GitHub MCP `pull_request_read`:
  only **#178** and **#215** ever merged; several others (#176, #186, #188, #213) closed *unmerged*
  (superseded/rebuilt), the rest remain open drafts. Learning signal applied: tonight's candidate is
  deliberately tiny — one file, one conceptual change, ~13 changed production lines.
- **The finding.** See below — a real refusal, silently downgraded to an allow, by budget accounting
  that had no exemption for consent.

## Competitors (context only, grade C — general design knowledge, not benchmarked against this repo)

| System | How it handles "advisory vs. binding" conflicts |
|---|---|
| Sakana AI Scientist | No user-facing block/advisory distinction; review is entirely human, out-of-band. |
| OpenHands | Tool-permission allow/deny lists are static config, not merged/ranked at runtime. |
| DSPy/GEPA | Optimizes prompts against a metric; no analogous per-decision-point consent gate. |
| SWE-agent | Action space is fixed by config; no dynamic advisory/block merge across triggers. |
| Cursor background agents | Permission prompts are per-action, not merged across multiple concurrent triggers. |

None of the five need to solve "rank several lessons across several simultaneous decision points
into one bounded message" — this repo's own multi-trigger merge (`--trigger` is repeatable because
one real event, e.g. Stop, is simultaneously several decision points) is what created the surface
this bug lived on. Informs framing only; not a benchmarked comparison.

## Hypothesis (frozen before implementation; unchanged since)

> Given a `lesson-gate.mjs` event carrying two or more `--trigger` values, where one trigger's
> candidate is an opted-in `enforcement:block` lesson (low `repeatCount`) and a different trigger's
> candidate is a non-blocking advisory (high `repeatCount`, rendered text alone ≥ `nudgeBudget`),
> when `buildLessonPresentation`'s truncation loop is changed to admit every `isBlocking()` candidate
> unconditionally before the budget applies to the rest, then `blocking.length` — and therefore the
> gate's exit code — should be deterministically correct regardless of the `repeatCount`/text-length
> of any co-occurring advisory, subject to: zero behavior change when no blocking lesson is present
> in the merge, and the nudge budget continues to bound total advisory output size exactly as before.

## Benchmark / Evaluation

Real evaluator: `tests/unit/lesson-gate.test.mjs` (process-boundary tests — exit code + both
streams, from a real spawned process; this file's own header explains why anything weaker missed
the 2026-07-22 "printed BLOCKED, allowed anyway" defect).

**Guard proven to fail first.** `git stash` isolating the fix, re-ran the new test:
`AssertionError: expected +0 to be 2` (gate exited 0/ALLOW despite the opted-in block). Restored
the fix: same test green. Full file: 67/67 pass (was 65/65 before the 2 new tests).

| | Baseline (`git stash`) | Candidate |
|---|---|---|
| Opted-in BLOCK + high-repeatCount oversized advisory, 2 triggers | exit **0** (ALLOW) — bug | exit **2** (BLOCK) |
| Same, but neither candidate exceeds budget | exit 2 (already worked) | exit 2 (unchanged) |
| No blocking lesson present, budget exceeded | first item admitted regardless of cost (unchanged code path) | identical |

`npm run test:integration`: 5 failed files / 9 failed tests of 313 — `anticipate-dial`,
`anticipate`, `console-apply-timings`, `health-repair`, `reader-deadlock-regression` — byte-identical
to the documented pre-existing baseline (missing `sqlite3`/`@xenova/transformers`/headless-Chromium
binaries; none reference `lesson-presentation.mjs` or `lesson-gate.mjs`). `hook-conformance-both-hosts.test.mjs`
passed clean.

`npx vitest run tests/unit` (full, 3952 tests): 6 pre-existing failures reproduce identically on a
clean `main` checkout (`advocacy-ignored`, `advocacy-outcomes`, `convergence-manifest`,
`hook-shim-fallback-once`, `release-identity-invariants`, `user-settings` — chmod/EACCES-under-root
and version-churn artifacts, none touching this diff). A second group — `learning-replay-proof`,
`learning-replay-verdict`, `learning-replay.test.mjs` (9 assertions) — fails *only* while
`plugin/scripts/lesson-presentation.mjs` has **uncommitted** bytes: reproduced identically with a
no-op comment-only edit to the same file, and confirmed directly by `claims:verify`'s own output —
`"UNKNOWN (never a pass): load-bearing source has uncommitted changes: M plugin/scripts/lesson-presentation.mjs"`.
Committing the change on a throwaway probe branch made all 9 pass again. This is
`scripts/learning-replay-contract.mjs`'s own `LOAD_BEARING` drift guard doing exactly its documented
job (refuse to trust replay evidence against code that changed) — not a regression, and it resolves
the moment this diff is committed.

`npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior documented night.

`npm run qa:pr`: `contract`/`mesh`/`plugin`/`version`/`execution-policy`/`substitution`/`catalog`
lanes PASS (328/329 tests). `docs`/`convergence`/`wiring` lanes FAIL — all three reproduced
byte-identically on a clean `main` checkout (52 pre-existing ADR stamp-lag violations, a mechanically
stale committed manifest, and `scripts/product-integrity-contract.mjs` — built, invoked by nothing,
unrelated to this diff).

`npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (this container
never materializes a corpus; `OPENROUTER_API_KEY` absent too, so `LLM_EVAL=blocked` independently).
Not a retrieval-quality candidate regardless — no model-graded stage applies to a deterministic
selection/budget fix.

## Darwin

Not run. No continuous parameter to evolve for a boolean admission-order fix.

## Evidence

OBSERVATION (`lessonsFor()` already orders block-first *within one trigger*; the cross-trigger merge
in `buildLessonPresentation` discarded that ordering and applied a size budget with no block
exemption) → MEASUREMENT (TEETH red pre-fix / green post-fix, reproduced via `git stash`; full
regression suites diffed against a clean baseline, not assumed) → DECISION (ACCEPT, pending human
review).

## Reward-Hack Check

1. Weakened test — CLEAR (only 2 added `it()` blocks; no existing assertion changed).
2. Altered gold/threshold — CLEAR (`evals/held-out.json` untouched; not a retrieval-quality change).
3. Vacuous assertion — CLEAR (proven to flip red→green via `git stash`, twice: production fix alone,
   and production fix + test together).
4. Hidden cost — CLEAR: one extra `.filter()` + `.reduce()` over an already-small in-memory array
   (at most a handful of candidates per event); no new I/O, no new dependency.
5. Cherry-picked corpus — N/A, no benchmark corpus involved.
6. One-directional inflation — CLEAR in the relevant sense: the fix can only make a genuine,
   user-consented refusal *more* likely to actually refuse; it cannot manufacture a refusal the user
   never opted into (`isBlocking` itself is unchanged — opt-in file + `enforcement:block` +
   `ratified/active` + `origin:user-stated`, all four still required).

## Security Review

No new attack surface. `isBlocking()` — the four-condition trust boundary (opt-in file membership,
`enforcement:block`, `ratified`/`active` status, `origin:user-stated`) — is completely unchanged;
this diff only changes *whether an already-qualifying block survives the budget*, never who
qualifies. It cannot be used to force a block that wasn't already opted into by the user in their own
words. The one edge case a critic should see named rather than hidden: a user who opts *many* large
`enforcement:block` lessons in at once could now produce an unbounded-length stderr refusal message
(previously implicitly size-capped by the same bug this PR fixes). Since reaching `isBlocking` at all
requires `origin:user-stated` — the model cannot construct or expand this set — this is a
self-inflicted verbosity a user could hit only by opting many long statements into blocking
themselves, not a new externally-reachable attack surface. Not fixed here; noted as a fast-follow
if it's ever observed in practice.

## ADR

None. This is a bug fix to existing, already-decided budget/ranking logic (ADR-030's "a lesson must
interrupt or it is prose", ADR-066 §"the trust boundary is not widened" — both already-shipped
decisions), not a new architectural decision, new component, or new default. No ADR's `governs:`
frontmatter lists `plugin/scripts/lesson-presentation.mjs` or `plugin/scripts/lesson-gate.mjs`
(grep-confirmed across `docs/adr/*.md`), so no Currency-log obligation exists either.

## Gist

LOCAL — no `gh` CLI and no gist-creation MCP tool available this session (same limitation as every
prior Dream Cycle night on this repo). Full report content is this file, committed at
`docs/dream-cycle/2026-09-07-enforcement-integrity-report.md` in the candidate branch, and
reproduced in the issue body.

## Witness

```
SESSION_COMMIT = 282c66c0467cf11d1fdd5f9850d61e9b27ce579f
REPORT_HASH    = 868612684ce1925cdbedf9eb20bbba2f1ad5312809f6d05eca295518b854c287
WITNESS        = b8b16d329743409e14f93d203d666a43eaf2f94e20079ca78a2050548df03707
```

Verify: (1) checkout `282c66c0467cf11d1fdd5f9850d61e9b27ce579f`; (2) obtain this report from the
issue body (no gist this session); (3) `sha256sum` it, confirm it starts `868612684c...`; (4)
`printf '%s%s' <report-sha256> 282c66c0467cf11d1fdd5f9850d61e9b27ce579f | sha256sum`, confirm it
starts `b8b16d3297...`; (5) `git stash` this PR's diff to `plugin/scripts/lesson-presentation.mjs`,
confirm the two new tests in `tests/unit/lesson-gate.test.mjs` fail (one of them), `git stash pop`,
confirm both pass.

## Next steps (3, concrete)

1. **Extend the same exemption to the frequency cap's cousin, if one exists elsewhere.** Grepped for
   other budget/truncation loops over merged lesson candidates (`lesson-command-scope.mjs`,
   `lesson-store.mjs`) — none found; this appears to be the only site. Worth a repo-wide grep for
   `nudgeBudget`-shaped patterns again after any future refactor of the presentation layer.
2. **A dedicated `tests/unit/lesson-presentation.test.mjs`.** Tonight's tests exercise the fix through
   the real `lesson-gate.mjs` process boundary (this repo's own stated preference, and correctly so
   for the exit-code/stream contract) but the pure ranking/truncation function itself has no direct
   unit coverage of its own. Not blocking — the process-boundary tests are the stronger evidence —
   but a pure-function suite would make future truncation-order regressions cheaper to localize.
3. **Triage the 24-PR dream-cycle backlog.** Restated from every ledger row since 2026-08-26: only 2
   of the last ~26 dream-cycle PRs have merged. Tonight's candidate was kept deliberately tiny in
   response, per the learning signal, but the backlog itself remains the single highest-leverage
   action available to the repo owner.
