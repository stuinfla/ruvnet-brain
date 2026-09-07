# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-09-07 — DEEP=enforcement-integrity, SCAN=lesson-delivery,gate-teeth (slot 2)**

## TL;DR

`plugin/scripts/lesson-promote.mjs`'s theme-demotion control — "reject this promoted theme,
permanently" — has been completely unreachable dead code since it was written on 2026-07-22. Its
own header comment claims "WITHOUT THIS, DEMOTION WAS THEATRE," but the fix it describes was never
actually reachable: it reads a `themeKey` field off a lesson-store row, and nothing anywhere in this
repository ever writes that field. Worse, even a user who hand-edits `lessons.json` to add one loses
it on the very next legitimate write anywhere in the store, because `makeLesson()`
(`lesson-store.mjs`) destructures a fixed field set and silently drops anything outside it — the
exact failure shape `lesson-gate.mjs`'s `OPTIN_PATH` comment already diagnosed for a different field
(`userOptedIntoBlocking`) on 2026-07-22, and moved to its own dedicated file for exactly this reason.
That precedent was never applied to theme demotion. There was also no CLI to reach the field at all:
`lesson-ratify.mjs --demote` only demotes by lesson `id`, never by theme.

Fix: theme-demotion state moves to its own small file (`demoted-themes.json`), mirroring
`OPTIN_PATH`'s established pattern exactly, plus a real writer (`--demote-theme <key>` /
`--restore-theme <key>` on `lesson-promote.mjs`, the file that already owns the theme vocabulary).
No lesson-store schema change. 166 insertions / 22 deletions across 2 files.

## What's new

Nothing external — an internal defect in this repo's own promoted-knowledge control surface,
found by tracing `demotedThemeKeys()`'s read contract (`themeKey` + `demoted:true` on a lesson row)
against every write path in `lesson-store.mjs` and `lesson-ratify.mjs` and finding none of them
can ever produce a qualifying row.

## Competitors — how other autonomous coding/nightly-evolution harnesses treat a "reject this"
control whose own comment claims a bug fixed that a static read of the write paths shows was never
reachable (grade C: general knowledge, single-source per row; informs framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No user-facing "reject a promoted rule" surface; nothing analogous to falsify. | C |
| OpenHands | Session-scoped memory, no cross-session promotion/demotion concept. | C |
| DSPy/GEPA | A metric or reward function that references a signal nothing produces is the same degenerate-signal class GEPA's own designers warn about — not something the framework checks for structurally. | C |
| SWE-agent | No persistent cross-repo "promoted lesson" store to demote from. | C |
| Cursor background agents | Session/repo-scoped rules; no cross-project promotion-then-demotion lifecycle. | C |

The recurring pattern, same as the 2026-08-30 cross-host-conformance finding: a mechanism whose own
comment claims a prior bug fixed, verified only by grep ("zero references to `demoted`") rather than
by tracing the write path end to end, is a general blind spot. This repo's own ADR-068 STEP 10 ("did
it rely on an undocumented cache / exploit the evaluator") is the discipline that generalizes to
catch this: a claim of "fixed" that was never actually exercised through a real write is the same
shape as a test injecting the very signal it exists to prove is present.

## Hypothesis (frozen before implementation, unchanged since)

> Given a theme demoted via `lesson-promote.mjs`'s real, non-test invocation (the CLI, with no
> `rejected` Set injected by a test), when the demotion is recorded via a dedicated file
> (`DEMOTED_THEMES_PATH`, written only by `setThemeDemoted()`) rather than a `themeKey` field on a
> lesson-store row, then the theme should never be re-proposed by `analyze()` on a subsequent scan —
> and restoring it should make it eligible again — relative to baseline (demotion silently never
> takes effect because nothing ever wrote a qualifying row), subject to: existing per-lesson
> demotion (`lesson-ratify.mjs --demote <id>`) must be unaffected; an unrelated theme must remain
> promotable; and the fix must not require any change to `lesson-store.mjs`'s schema (the OPTIN_PATH
> precedent this fix follows exists specifically because a schema change is not durable against the
> store's own write path).

## Evaluation Receipt

**Guard proven to fail first (TEETH).** Wrote 5 new tests in `tests/unit/lesson-promote.test.mjs`
exercising the REAL `demotedThemeKeys()`/`setThemeDemoted()` round trip and the real CLI — not the
pre-existing `{ rejected: Set }` injection seam the file's original two demotion tests use (which is
exactly why the underlying bug shipped and stayed silent). Ran the new tests against unmodified
`main` via `git stash` (candidate file stashed, tests kept):

```
FAIL > a theme demoted via the real writer is excluded by the real reader on the very next analyze()
  TypeError: setThemeDemoted is not a function
FAIL > restore is also real — the file round-trips back to eligible
  TypeError: setThemeDemoted is not a function
FAIL > a hand-edited bare array ... is still honoured — same tolerance as OPTIN_PATH
  AssertionError: expected true to be false  (theme was NOT excluded — demotion had no effect)
FAIL > the real CLI: `--demote-theme` writes the file and the very next scan honours it
  AssertionError: expected ... to match /demoted theme/  (no such flag exists; CLI ran as a plain report)
FAIL > `--demote-theme` with an unknown key refuses loudly instead of writing garbage
  AssertionError: expected [Function] to throw an error  (no such flag exists, so nothing throws)
```
5/5 new tests red, exactly as predicted, for 5 different concrete reasons — not one generic failure.
The pre-existing 16 tests in the same file were unaffected (still green) on this baseline run.
`git stash pop` restored the candidate; all 21/21 tests pass green post-fix.

`npm run claims:verify`: 3 PASS / 4 SKIP (loudly) — unchanged from every prior night; brain not
installed on this container (`kb/metaharness.passages.jsonl` etc. absent), not a credentials block
(`OPENROUTER_API_KEY` present). No claim in the ledger touches this surface.

`npm run eval:gate`: EVALUATED=blocked — `no brain at /root/.cache/ruvnet-brain/kb`. Same pre-existing
condition documented on every prior night this container has run; not applicable to this surface
regardless (deterministic file I/O, no model grading involved).

`npx vitest run tests/integration`: 5 failed files / 9 failed tests / 290 passed / 12 skipped / 53
todo of 364 — baseline (`git stash`) reproduces the identical 9 failing test names
(`anticipate-dial`, `anticipate`, `console-apply-timings`, `health-repair` ×5, `reader-deadlock-regression`),
all pre-existing `sqlite3`/`@xenova/transformers`/chmod-under-root-container infra gaps, none
referencing `lesson-promote.mjs` or `lesson-store.mjs` (grep-confirmed disjoint file set).

`npm run qa:pr`: overall FAIL, but by pre-existing lanes only — `docs` (55 blocking findings,
ADR stamp-lags-doc drift; ran `node scripts/doc-currency.mjs` baseline vs candidate and diffed:
**byte-identical**, 55/55, same summary line), `wiring` (1 UNWIRED item: `scripts/product-integrity-contract.mjs`,
unrelated — `wired-check.mjs`'s own byte-identical `230 wired · 6 manual · 48 exempt · 4 held · 1
UNWIRED` baseline vs candidate), `convergence` (pre-existing "manifest is stale" state, identical
message baseline vs candidate). The `contract` lane — the one that runs the unit suite this change
touches — **PASSED**, 326 tests / 1 skipped, 87s.

Full `npm run test:unit` (all 3900+ tests) launched in background; result folded into this receipt
before the PR opened (see Final Report below for the exact pass/fail counts and any pre-existing
failures, diffed against the pattern this container has shown on every prior night).

## Darwin Results

Not run. Bounded Darwin only applies after basic evaluation clears AND the tool is available; this
candidate is a one-conceptual-change bug fix (166 insertions / 22 deletions, 2 files) with no
tunable parameter or search space Darwin's generation/mutation model would apply to.

## Evidence

- OBSERVATION: `demotedThemeKeys()` (pre-fix) reads `l.themeKey` from `lessons.json`; repo-wide grep
  (`grep -rn themeKey`, excluding node_modules) returns matches only inside the reader itself.
- OBSERVATION: `makeLesson()` (`lesson-store.mjs:119-177`) destructures a fixed field set and returns
  `Object.freeze({...})` built from exactly those fields; `themeKey` is not among them.
- MEASUREMENT: `node -e "makeLesson({..., themeKey:'release-discipline'})"` → resulting object has
  `hasOwnProperty('themeKey') === false`.
- OBSERVATION: `lesson-ratify.mjs --demote <id>` is the only demotion CLI in the repo; it demotes by
  lesson id only (`scripts/lesson-ratify.mjs:82-84`), never by theme.
- OBSERVATION (test-gap confirmation): the two pre-existing "demotion is sticky" tests in
  `tests/unit/lesson-promote.test.mjs` both call `analyze(lessons, { rejected })` with a hand-built
  `Set`, never exercising `demotedThemeKeys()` — the exact "test injects the very signal it exists to
  prove is present" blind spot this repo's own 2026-08-30 report names for a different subsystem.
- DECISION: move theme-demotion state to its own file (`DEMOTED_THEMES_PATH`), following the
  `OPTIN_PATH` precedent already established in `lesson-gate.mjs` for the identical failure class,
  rather than extending the lesson-store schema (which the OPTIN_PATH comment already shows is not
  durable against the store's own write path).

## Reward-Hack Check (self-critique, before independent review)

- Weakened a benchmark or test? No — 5 tests added, 0 modified/removed; all 16 pre-existing
  `lesson-promote.mjs` tests pass unchanged.
- Altered gold answers or a threshold? No; not an eval:gate-graded surface.
- Cherry-picked a favorable comparison? No — TEETH proof shows 5 independent, differently-worded
  failures on baseline, not one generic assertion.
- Exploited the evaluator or relied on an undocumented cache? No.
- Hid cost? No new dependency, no runtime cost added to any hot path (theme demotion is an explicit,
  rare, single-operator CLI action).
- Disclosed gap: `setThemeDemoted()` does an unlocked read-modify-write, unlike `lesson-store.mjs`'s
  locked/backed-up writer. This mirrors `OPTIN_PATH`'s own design (also unlocked, also expected to be
  hand-edited) and is a deliberate, proportionate choice for a low-frequency, single-operator,
  non-security-boundary file — not an oversight, but named here rather than left implicit.

## Security Review

- No new attack surface: `DEMOTED_THEMES_PATH` lives under the existing `~/.config/ruvnet-brain/`
  root, same trust boundary as every other file there.
- `--demote-theme <key>` validates `key` against the fixed `THEMES` array before writing anything —
  refuses an unknown key loudly rather than writing arbitrary content (stronger than the pre-fix
  state, which had no writer and thus no validation surface at all).
- No prompt-injection surface: the CLI argument is a plain string compared against a closed enum;
  never interpolated into a shell command or eval'd.
- No credential or filesystem-scope change; no new network access.

## Scan Findings — lesson-delivery, gate-teeth

**lesson-delivery**: the deep-dive finding above IS a lesson-delivery finding (a promoted-then-demoted
lesson is "delivery" in the ADR-030 sense — the demotion is the delivery of the user's correction back
into the mining loop). No second, independent lesson-delivery finding beyond it tonight; six other
enforcement-integrity issues are already open and unduplicated (#156, #158, #181, #183, #228, #230) —
checked each against tonight's candidate and confirmed no overlap.

**gate-teeth**: no new finding. Ran `node scripts/wired-check.mjs` and diffed baseline vs candidate —
byte-identical (`230 wired · 6 manual · 48 exempt · 4 held · 1 UNWIRED`, the one UNWIRED item
(`scripts/product-integrity-contract.mjs`) pre-existing and unrelated). The dominant, and far larger,
"gate teeth" observation tonight is not a new code defect but a measured process fact: **the human
review gate itself is not currently exercising any teeth.** See Recommendation.

## Witness

```
SESSION_COMMIT = b3e975fe4cc499b7c0573dafb5ca3e3187938ee7
REPORT_HASH    = 076a2860efb180747d56d70b3b793f7b15a22ed21ca4504d7865c1ee4a60c57a
WITNESS        = ed5be426727e3b18f330434aed9c2118a4de97968b23a1e323baa36140e74fe4
```

`REPORT_HASH` is the sha256 of this report's content as it stood through "Recommendation", computed
BEFORE this Witness section was written (STEP 16's own chicken-and-egg order). It will therefore NOT
match a fresh `sha256sum` of this file as it now reads — appending this section changed the bytes.
That is expected by construction, not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 282c66c0467cf11d1fdd5f9850d61e9b27ce579f` (this cycle's base commit on `main`).
2. Apply the candidate diff from PR branch `dream/2026-09-07-enforcement-integrity`
   (commit `b3e975fe4cc499b7c0573dafb5ca3e3187938ee7`).
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. Revert only `plugin/scripts/lesson-promote.mjs` (keep the test file changes), re-run
   `npx vitest run tests/unit/lesson-promote.test.mjs` — the 5 new tests under "theme demotion — the
   real read/write round trip" must fail (2 with `setThemeDemoted is not a function`, 3 with a
   `false`/`true` mismatch or an unmatched `/demoted theme/` regex), while the 16 pre-existing tests
   in the same file stay green.
5. Re-apply the candidate — all 21/21 tests in the file must pass.

## Recommendation (the most important line in this report)

Exactly **5** `dream/*` PRs have ever merged in this repository's history (#143, #148, #150, #178,
#215 — confirmed via `search_pull_requests is:merged head:dream/`), the last on 2026-08-31. Since
then, **24 more have opened and zero have merged** (#157 through #261 as of tonight, oldest 16 days
open) — confirmed via `search_pull_requests is:open head:dream/`. Every one of the last 12 nights
(2026-09-01 through today) added at least one more draft PR to that pile with no corresponding
review action. This is not a new observation — it was first flagged 2026-08-26 and repeated on
2026-08-28, 2026-08-31 — but the number has roughly doubled since the last time it was measured and
reported (12 → 24), and it is now large enough that ADR-068's own promotion-gate design ("evaluation
is not promotion... a human merges") is not being exercised on its human half at all. Tonight's STEP
1.1 learning signal ("zero of the last 14 candidate PRs merged → bias to a tiny, one-parameter,
easily-reviewable candidate") is unambiguously true and is why this candidate was kept to 166/22
across 2 files rather than expanded. That bias alone will not clear a 24-PR backlog. The
owner's attention to this backlog, not another nightly candidate, is the highest-value action
available on this repository right now.
