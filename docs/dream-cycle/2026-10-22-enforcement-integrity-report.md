# Dream Cycle 2026-10-22 — enforcement-integrity SOTA report

> Local gist equivalent. `gh gist create --public` is unavailable this session (no `gh` CLI auth,
> no gist-creation MCP tool) — consistent with every documented prior night. This file is the
> authoritative, committed record; `GIST: LOCAL` in the ledger row points here.

## TL;DR

Rotation: slot 2 (`20261022 % 5 == 2`), DEEP=`enforcement-integrity`, SCAN=`lesson-delivery,gate-teeth`.
No bonus modulus tonight (`%25`=22, `%75`=72). Session commit `0020223` on `main`.

`main`'s `docs/dream-cycle/LEDGER.md` has not had a row land since 2026-08-31 (52 days), not because
the routine stopped — it fires nightly on schedule — but because the dream-cycle PR backlog has had
only 5 merges, ever, across 111 `dream/*` PRs (68 still open), none since 2026-08-26 (57 days). This is
already tracked by open issues **#410** (the backlog itself) and **#298** (an intermittent compile-time
sandbox denial); both re-verified still open tonight, not restated as new findings.

Tonight's own finding is new and distinct from both: `dream.config.json`'s `extraDisciplines`
ISSUE DISPOSITION OVERRIDE correctly biases this routine toward bounded local repair over backlog
growth, so before researching a new surface, this session re-ran the existing `enforcement-integrity`
ratchet tooling (PR #412's unmerged `scripts/entrypoint-guard-scan.mjs`) against current `main` and
found it had **grown a new real instance** of the exact defect class it exists to catch — 16 days after
that ratchet was proposed and left in review. Reproduced, fixed, and shipped as a 2-file, 20-line diff
plus a regression test, without touching #412's own unmerged work.

## What's new

- **Not new, re-confirmed still live:** PR #416 (2026-10-07, `scripts/lesson-ratify.mjs`'s unlocked
  read-modify-write race) — `main` still shows the exact pre-fix pattern (`loadLessons()` once,
  `saveLessons(next)` in `show()`, never routed through `updateLessons()`). PR #412 (2026-10-06, the
  entry-point-guard ratchet) — `scripts/entrypoint-guard-scan.mjs` and its baseline fixture still do
  not exist on `main`. Both PRs remain open, draft, `mergeable_state: dirty`. Per
  `findingPolicy.skipIf: existing-fix-pr`, neither is re-implemented tonight.
- **New:** running PR #412's own (unmerged, but real and already-reviewed) scanner against tonight's
  actual `main` shows the baseline moved: 129 files (2026-10-06) → 125 today. 5 fixed by unrelated
  direct-to-main commits; but **1 new file appeared carrying the defect**:
  `plugin/scripts/developer-update.mjs` — the module `scripts/console-suite-update.mjs`'s "update all
  tools" coordinator spawns directly as a child process, and the exact `ruvnet-brain-update` CLI
  `package.json`'s own `bin` entry points at (via a thin unguarded wrapper, `bin/developer-update.mjs`).

## Competitor landscape (evidence-graded)

| System | Relevant practice | Grade | Note |
| --- | --- | --- | --- |
| Sakana AI Scientist | Fully automated hypothesize→code→run→write loop | B | Public writeups, no reproduction run tonight; this cycle's bounded-repair-before-research discipline is the opposite emphasis — fewer novel papers, more closed regression classes. |
| OpenHands (All Hands AI) | Agent resolves GitHub issues end-to-end incl. PR | A | Official repo/docs; its issue-resolution loop assumes a reviewer merges promptly — this repo's 57-day, 5/111-merge backlog is exactly the failure mode that loop does not model. |
| DSPy / GEPA | Reflective prompt/program evolution with frozen eval sets | A | Official repo; shares this cycle's "freeze the evaluator, evolve the candidate" discipline (`eval:gate`'s frozen 120-question held-out set is the same shape). |
| SWE-agent | Benchmark-driven single-PR code fix agent | A | Official repo/SWE-bench; closer in shape to tonight's single-file ratchet-regression fix than to a research cycle. |
| Cursor background agents | Async coding agents opening PRs for human review | B | Vendor docs; same "draft PR, human merges" shape this repo uses — makes the merge-backlog problem a plausible failure mode for that whole category, not unique to this repo. |

No C-grade claim is used to justify tonight's implementation; the only claim driving the candidate is
A-grade (this session's own reproduction, below).

## Hypothesis (frozen before implementation)

> Given `plugin/scripts/developer-update.mjs`'s CLI entry-point guard (`process.argv[1]` compared via
> `pathToFileURL(path.resolve(...))` against `import.meta.url`), when invoked through a symlink (an npm
> bin shim, a Homebrew-style install, or any wrapper), the guard should still recognize a direct
> invocation and run `developerUpdateCli()` — relative to the current behavior, which silently skips it
> (exit 0, zero output) — subject to: zero behavior change for the existing non-symlinked invocation
> path, and the fix reuses the already-reviewed realpath pattern in `scripts/selfcheck.mjs` rather than
> inventing a new one.

## Evaluation Receipt

Real evaluator for this surface is direct reproduction (there is no benchmark corpus for an
entry-point guard; `eval:gate`/`claims:verify` do not apply to this defect class — see Baseline).

- **Live reproduction on this container, BEFORE the fix** (`main`@`0020223`):
  ```
  $ DIR=$(mktemp -d) && ln -s "$PWD/plugin/scripts/developer-update.mjs" "$DIR/link.mjs"
  $ node "$DIR/link.mjs" --help; echo "exit=$?"
  exit=0                     # zero bytes of output
  $ node plugin/scripts/developer-update.mjs --help; echo "exit=$?"
  Usage: ruvnet-brain-update [--check|--apply] [--channel latest|alpha] [--scope ruvnet|all]
  exit=0                     # direct invocation: correct
  ```
- **New test, TEETH-verified**: `tests/unit/developer-update-entrypoint-guard.test.mjs`, 2 cases. On
  the candidate: 2/2 pass. Reverted via `git stash` to pre-candidate `plugin/scripts/developer-update.mjs`
  only (test file kept): 1/2 pass, the symlink case fails exactly as predicted —
  `expected '' to contain 'Usage: ruvnet-brain-update'`.
- **After the fix**, same manual reproduction: symlinked invocation now prints the usage line, exit 0.
- **Targeted regression**: `tests/unit/developer-update.test.mjs`, `tests/unit/developer-update-scheduled-receipt.test.mjs`,
  `tests/unit/plugin-artifact-proof.test.mjs`, `tests/unit/entrypoint-symlink.test.mjs` — 99/99 pass,
  unchanged.
- `npm run test:integration` (full, 420 tests / 55 files): 40 files passed / 10 failed / 5 skipped;
  324 passed / 33 failed / 18 skipped / 45 todo. **Both-hosts hook-conformance gate run in isolation:
  10/10 green.** Spot-checked the two named failing files (`model-managed-checker-native.test.mjs`,
  `reader-deadlock-regression.test.mjs`) against a true pre-candidate baseline via `git stash` —
  byte-identical failure on unmodified `main` (missing native checker binary; CE-model network
  download), confirmed environmental and pre-existing, matching the exact pattern 2026-10-16 through
  2026-10-21's nights already documented.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every documented night since
  2026-08-28.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (store root
  never materialized on this container: `stores 0 dark 0`, confirmed via `kb/store-root.mjs`).
  `LLM_EVAL=blocked` too — no `OPENROUTER_API_KEY` present. Not the relevant evaluator for this surface
  regardless (no retrieval/grounding/corpus code touched).
- `node scripts/brain-score.mjs`: all 4 quality dimensions STALE (42.5d old), both coverage dimensions
  UNMEASURED (store root absent) — reported separately, never averaged into one number, per the
  script's own stated invariant.
- `node scripts/restore-local-ingests.mjs`: read-only pass, exit 0, no false-wipe alarm (the 2026-08-19
  fix still holds).
- `node scripts/doc-currency.mjs --check`: repo-wide pre-existing drift (122 docs, ~pervasive 1-BLOCK
  pattern traced to bulk commit `a8f57a08`, 2026-10-13 — present identically on unmodified `main`,
  confirmed via `git stash`) is unchanged by this diff. `node scripts/architecture-review-lock.mjs`
  — `plugin/scripts/developer-update.mjs` is governed by **ADR-103**; the stored `reviewed_digest`
  recomputes stale the moment this diff touches it. Updated frontmatter (`reviewed_digest: 988845a37f46`,
  `updated: 2026-10-22`, `version: 0.1.45`) and added a Currency-log row (same change, per CONTRIBUTING's
  rule) — re-verified `review.current: true`, `match: true` after the edit.
- `node scripts/sync-version.mjs --check`: all surfaces agree on `4.7.16`.
- `npm run convergence:write`: the new test file made `data/convergence-manifest.json` stale (same
  mechanism PRs #215/#412/#416 hit); regenerated and committed.

## Baseline

Unmodified `main`@`0020223` (session start), confirmed via `git stash` for every comparison above —
not inferred from logs.

## Darwin Lineage

Not run. This is a single reproduced-defect fix with a deterministic pass/fail test, not a tunable
parameter with a fitness surface to search.

## Evidence

- OBSERVATION: PR #412's scanner, re-run against tonight's `main`, shows 125 files (down from 129 on
  2026-10-06) — 5 fixed, 1 new: `plugin/scripts/developer-update.mjs`.
- MEASUREMENT: live symlinked-invocation reproduction, both directions (before: silent; after: correct),
  plus the new test's TEETH (red on `git stash`-restored pre-candidate file, green on candidate).
- INFERENCE: the defect is real in a live invocation path — `scripts/console-suite-update.mjs` spawns
  this exact file directly as a child process for the plugin console's "update all tools" button — not
  merely theoretical.
- DECISION: ship the fix + regression test + the ADR-103 Currency-log row the diff requires; do not
  touch PR #412's own unmerged ratchet or PR #416's unmerged lock fix (duplication risk, `skipIf`).

## Reward-Hack Check

No benchmark, gold answer, or threshold touched. The fix narrows behavior in exactly one direction
(a previously-silent symlinked invocation now runs correctly) and changes nothing for the already-
correct direct-invocation path, verified by the unchanged 99/99 targeted-test pass and the unchanged
`Usage: ...` output for direct invocation before and after. No prompt-injection or authority-expansion
shape. Blast radius: `pathToFileURL` import removed was used nowhere else in the file (grep-confirmed);
`fs`/`path`/`new URL(import.meta.url)` are all already in scope. This session authored the fix; no
second agent was run as an independent critic tonight (see Self-Critique below for why, and the
limitation this leaves disclosed).

## Self-Critique (performed by this session against its own candidate — no separate critic agent run)

- Could the new guard reject a legitimate direct invocation it used to accept? No — `fs.realpathSync`
  on an unaliased absolute path returns that same path; the direct-invocation test (`runs the CLI when
  invoked directly`) stays green.
- Could it silently accept something it should reject (false negative)? The `catch { return false }`
  fails closed — any error (file deleted mid-run, permission denial) now means the CLI does NOT run,
  same fail-closed direction as `scripts/selfcheck.mjs`'s own already-reviewed pattern.
- Disclosed limitation, not hidden: `scripts/console-suite-update.mjs`'s exact spawn chain (`RUNNER`
  derived from its own `import.meta.url` via relative `URL` join, no explicit `realpathSync` call) was
  not independently reproduced end-to-end tonight — only the direct, minimal symlink reproduction the
  existing `entrypoint-symlink.test.mjs` pattern uses. Whether `console-suite-update.mjs`'s specific
  invocation topology was ever actually exposed to the pre-fix defect (versus merely sharing the file)
  is not established either way; the fix closes the general case regardless.

## Security Review

No new file writes, credential handling, or external input parsing. The diff narrows an existing,
already-reviewed (ADR-103) CLI entry point's guard to the realpath-based form already used safely
elsewhere in this repo (`scripts/selfcheck.mjs`). No benchmark/threshold/gold-data touched. No new
tool authority requested or used.

## Regression Analysis

`plugin/scripts/developer-update.mjs` is imported by 7 other modules (`bin/developer-update.mjs`,
`scripts/console-suite-update.mjs`, `scripts/stack-sync.mjs`, 3 test files — grep-confirmed) and
executed directly as its own entry point only via `scripts/console-suite-update.mjs`'s spawn and manual
invocation. None of those import sites touch the removed `pathToFileURL` import or depend on the old
comparison's specific failure mode. 99/99 targeted tests pass unchanged; both-hosts conformance 10/10;
integration failure set outside those 99 tests is byte-identical to a true `git stash` baseline for the
two files sampled.

## ADR

No new ADR. `docs/adr/0103-routing-architecture-review-lock.md` — Currency-log row added,
`reviewed_digest`/`updated`/`version` bumped in the same change (it governs
`plugin/scripts/developer-update.mjs`), per CONTRIBUTING's rule and confirmed required by
`node scripts/architecture-review-lock.mjs` (`architecture-review-not-current` BLOCK before the edit,
cleared after).

## Scan findings

- **gate-teeth** (primary finding above): the entry-point-guard ratchet PR #412 proposed 16 days ago is
  still unmerged, and the defect class it targets has already grown a new instance in that window —
  live, measured evidence for exactly the argument #412's own PR body makes ("nothing stopped a 130th
  file"). Not fixed here: merging #412 itself (out of scope, duplicate authorship risk) or sweeping the
  other 124 baselined files (exceeds tonight's bounded-candidate budget, and 124 of them are PR #412's
  own unmerged work to carry, not this session's to duplicate).
- **lesson-delivery**: PR #416's `lesson-ratify.mjs` race re-confirmed still live and unintegrated on
  `main` (see What's new); no new lesson-delivery defect found beyond that already-tracked, already-fixed
  (in an open PR) one.

## Gist

LOCAL — this file. No `gh` CLI auth, no gist-creation MCP tool this session.

## Issue

`NONE`. Per `dream.config.json`'s `extraDisciplines` ISSUE DISPOSITION OVERRIDE: tonight's finding is a
verified, integrated fix shipping in this same PR with passing evidence — a work record, not a tracking
issue. The backlog (#410) and the compile-sandbox denial (#298) are both already open and re-verified
still open tonight, not restated.

## Witness

```
SESSION_COMMIT = 00202230086c5ab85dd2476a8ba0ee064aade14f
REPORT_HASH    = 6d89b8e5de552d051477a738e48a3dfb4af33e1247046fff4d0d30a9b4b05319
WITNESS        = b55f1a79ccf7fd3de8ae7c69e78e0826cb0f7a60d9d88eaff17780eb3219ba8a
```

REPORT_HASH above is computed over this file with this Witness section's two value lines holding the
literal string `PLACEHOLDER` (the only self-consistent way to stamp a file that names its own hash —
the same resolution prior nights' re-stamps use). To reproduce: take this file, replace the two
`PLACEHOLDER` tokens above back to literal `PLACEHOLDER`, `sha256sum` it — should equal REPORT_HASH;
then `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` should equal WITNESS.

## Recommendation (for the repo owner, priority order)

1. **The backlog remains the dominant structural fact** (#410): 111 `dream/*` PRs, 68 open, only 5
   ever merged, none since 2026-08-26 (57 days). This PR is deliberately tiny (2 production/doc files
   + 1 new test, ~40 lines) to make it cheap to review whenever that happens.
2. **PR #412 specifically** (the entry-point-guard ratchet): tonight's finding is live proof its thesis
   is correct and the cost of leaving it unmerged is compounding, not static.
3. **PR #416 specifically** (`lesson-ratify.mjs` race): still live and unintegrated, 15 days now.

## Merge Policy

Human review required. This session never self-merges and never autonomously promotes candidate
state. `autoMerge: false` in `dream.config.json`, unmodified.
