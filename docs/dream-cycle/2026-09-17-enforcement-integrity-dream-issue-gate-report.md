# Enforcement-Integrity SOTA Report — 2026

Dream Cycle 2026-09-17 — DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth` (slot 2 of 5).

## TL;DR

`scripts/dream-issue-gate.mjs` — the meta-gate that decides whether THIS nightly engine may call
`gh issue create` — carries the exact "silent exit-0 entrypoint guard" defect class that commit
`43bf391` (2026-09-14) closed across 13 sibling files, via a **4th, previously-unmatched idiom**
(`new URL(import.meta.url).pathname`, no `fileURLToPath`, no `realpathSync`). The file was created/
modified by `7d3ecf0` (a corpus-seed commit), landing *after* `43bf391`'s repo-wide sweep, so it was
never in scope for that grep. Invoked through a symlink or a path containing a URL-reserved
character, the CLI wrapper never runs: 0 bytes of stdout, exit 0 — indistinguishable from "ran,
found nothing," on the one control that gates the Dream Machine's own issue-creation authority.

## What's new

Not a new defect *class* — the class is well-documented in this repo (ADR-adjacent commit `43bf391`,
`tests/unit/entrypoint-symlink.test.mjs`, `entrypoint-guard-safety.test.mjs`). What's new is a
previously-invisible *instance*, found because the historical grep matched three known-bad string
shapes and this file uses a fourth. This is itself evidence for a systemic point: a fix expressed as
"grep for these literal strings" has a shelf life bounded by whoever writes the next entry point.

## Competitor comparison (grading: A=reproducible/official, B=vendor cross-checked, C=single-source)

| System | Relevant mechanism | Grade | Note |
|---|---|---|---|
| Sakana AI Scientist | Fully autonomous idea→paper loop, no human promotion gate documented | B | No public evidence of an entrypoint-guard-class regression detector; not directly comparable (research-paper output, not shipped CLI tooling) |
| OpenHands | Agent-driven PR generation against real repos | B | Relies on CI/lint as the correctness backstop, not a bespoke silent-failure detector for its own control-plane scripts |
| DSPy/GEPA | Prompt/program evolution with metric-driven selection | B | No entrypoint/CLI-safety concern — Python import model doesn't have the JS `import.meta.url`/symlink pathology this repo hit three separate times |
| SWE-agent | Issue-to-patch agent loop over real repos | B | Same class of problem (agent tooling invoked in varied environments) is generic to CLI shims; no public evidence this repo's specific defect was independently found elsewhere |
| Cursor background agents | Background coding agents with sandboxed execution | C | Marketing-level description only; no visibility into internal entrypoint-safety practices |

None of the five competitors is documented (A/B grade) to have this repo's specific defect or its
specific fix. This is a narrow, repo-internal finding, not a claim about the field.

## Hypothesis (frozen before implementation)

Given `scripts/dream-issue-gate.mjs` invoked through (a) a symlink (the same real-world trigger
`43bf391`'s commit message cites — "on macOS EVERY `os.tmpdir()` path is symlinked") or (b) a path
containing a URL-reserved character, when the CLI wrapper guard
`process.argv[1] === new URL(import.meta.url).pathname` is replaced with the repo's own established
`isDirectInvocation()` pattern (`fileURLToPath(import.meta.url)` + `fs.realpathSync` on both sides,
wrapped in `try/catch`), then the CLI should run and emit its JSON disposition (>0 bytes stdout)
under both trigger conditions, with **zero change** to `assessFinding()`'s decision logic, zero
change to any other file, and no new failing test anywhere else in the suite.

## Evaluation Receipt

- **TEETH, reproduced twice independently** (this session, then a fresh critic agent with no shared
  context): `tests/unit/entrypoint-symlink.test.mjs`'s new `dream-issue-gate.mjs` case, run via
  `npx vitest run tests/unit/entrypoint-symlink.test.mjs -t dream-issue-gate` against unmodified
  `main` (`git stash` isolation) — **RED**, `expected 0 to be greater than 0` (0 bytes stdout+stderr,
  exit 0, through a symlink). Restored the fix — **GREEN**, 9/9 in the file. Manual confirmation on
  both sides: direct invocation and a hand-built symlink both now print
  `{"fingerprint":null,"action":"report","reason":"missing-stable-fingerprint"}` where the symlinked
  case previously printed nothing.
- `npx vitest run tests/unit` (448 files / 5618 tests): candidate 12 failed files / 39 failed tests,
  **byte-identical** to a same-session `git stash` baseline (12/39) plus one new passing test — zero
  regression. (`data/convergence-manifest.json` regenerated via `npm run convergence:write`, this
  repo's own documented convention for any tracked-source change; without it, one net-new failure
  appears and disappears again once regenerated.)
- `npx vitest run tests/integration` (49 files / 400 tests): 9 failed files / 23 failed tests / 309
  passed — grep-confirmed none of the 9 failing files reference `dream-issue-gate.mjs`,
  `lesson-presentation.mjs`, or `entrypoint-symlink.test.mjs`; all are pre-existing native-module/
  sqlite3/health-repair container-infra gaps matching the pattern documented in every prior night's
  ledger row.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition to every prior night.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`. Confirmed via
  `node scripts/brain-score.mjs`/`restore-local-ingests.mjs`/`store-root.mjs`: `stores 0 dark 0` on
  this container. Not a credentials block — `OPENROUTER_API_KEY` is present. Not applicable to this
  candidate regardless: the guard is a deterministic entrypoint-detection mechanism, not a retrieval
  surface.
- `npm run qa:pr`: `version`/`convergence`/`execution-policy`/`architecture`/`substitution`/`catalog`/
  `mesh`/`plugin` lanes PASS. `docs` FAIL and `wiring` FAIL both independently confirmed
  **pre-existing** via `git stash` isolation on this exact container (`wiring`'s 2 UNWIRED oracle
  files predate this diff by two days, commit `a7342a0`; `docs`'s blocking-finding count is unchanged
  by this diff, no ADR governs `dream-issue-gate.mjs`). `coverage` TIMEOUT / `claims-source` BLOCKED
  are the same pre-existing container conditions documented in every recent ledger row.

## Baseline

Unmodified `main` @ `3996f502b18157fdc84e325fbe87c2a05351d58c` (this session's start-of-night HEAD).
All comparisons above ran via `git stash` isolating the two changed files against this identical
commit, not assumed from memory.

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean entrypoint-detection mechanism swap.

## Reward-Hack Check

Independent critic agent (fresh context, no shared history with this session) verdict: **CLEAR**.
`assessFinding()`/`buildIssueBody()` are byte-identical before and after; the diff touches only the
entrypoint guard. No benchmark, gold answer, or threshold touched. The new test uses the same strict
"must produce non-empty output through a symlink" assertion as every sibling entry point in the same
file — not weakened, not newly invented for this one case.

## Security Review

No new attack surface. `process.argv[1]` was already read by the old (broken) guard; the fix only
changes how it is *compared*, via `fs.realpathSync` on both sides inside a `try/catch` that fails
closed (returns `false`, i.e. "not the entrypoint") on any resolution error, including a
non-existent path — verified this does not regress the case where the module is merely *imported*
(e.g. by `tests/unit/dream-issue-gate.test.mjs` inside vitest, where `process.argv[1]` is vitest's
own real entry script: `realpathSync` succeeds, the comparison correctly evaluates `false`, and the
CLI body correctly does not run). No filesystem write, no network call, no credential exposure, no
path used in a shell/spawn context — `dream-issue-gate.mjs` remains a pure decision function plus a
stdin-JSON-in/stdout-JSON-out adapter that itself never calls `gh` or mutates GitHub state.

## Regression Analysis

Blast radius: repo-wide grep for `dream-issue-gate` finds exactly 3 non-self referrers —
`scripts/wired-check.mjs` (a wiring-map STANDALONE label, "invoked by the external issue adapter,
never a GitHub writer" — unaffected, does not import the file), and the file's own two test files
(`tests/unit/dream-issue-gate.test.mjs`, which imports only the pure exports and never touches the
CLI guard; `tests/unit/entrypoint-symlink.test.mjs`, this diff's own addition). Nothing in the repo
constructs a `new URL(...)` against this file or otherwise depends on the old guard's silent-no-op
behavior. Independently re-confirmed by the critic agent.

## ADR

None — bug fix to an already-established pattern (the `isDirectInvocation()` idiom from commit
`43bf391`), not a new architectural decision. `node scripts/doc-currency.mjs --check --changed main`
confirms no ADR governs `scripts/dream-issue-gate.mjs`.

## Concurrent night

A separate firing of tonight's same routine (same SLOT=2/DEEP=`enforcement-integrity`) landed first
on branch `dream/2026-09-17-enforcement-integrity` as PR #294 (recovering PR #263's theme-demotion
fix for issue #262, orphaned by the 2026-09-07 bulk-close). Confirmed non-overlapping by direct file
diff — PR #294 touches `plugin/scripts/lesson-promote.mjs` and its test; this candidate touches
`scripts/dream-issue-gate.mjs` and `tests/unit/entrypoint-symlink.test.mjs`, disjoint file sets. This
branch is pushed under a suffixed name to avoid the collision, based on plain `main` (not rebased
onto PR #294's tip) since there is no file overlap to reconcile.

## Witness

```
SESSION_COMMIT = 3996f502b18157fdc84e325fbe87c2a05351d58c
REPORT_HASH    = 897090ab7c3b077fb33eec9d5a2fab1a4317cb2eb2aa38621d7a9136b69be4a7
WITNESS        = 47cc4a71f61cae486af7e9168837cc4f090bd7a6ceadbc1ea48a60763cd9d8c5
```

Verify: (1) checkout `3996f502b18157fdc84e325fbe87c2a05351d58c`; (2) obtain this report from the
candidate PR body or `docs/dream-cycle/2026-09-17-enforcement-integrity-dream-issue-gate-report.md`;
(3) `sha256sum` it before this Witness section's hash values were filled in, confirm
`897090ab7c...`; (4) `printf '%s%s' <report-sha256> 3996f502b18157fdc84e325fbe87c2a05351d58c | sha256sum`,
confirm `47cc4a71f6...`; (5) `git stash` this PR's diff, confirm the symlink test fails, `git stash
pop`, confirm it passes.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session; not fabricated. Full report
committed at `docs/dream-cycle/2026-09-17-enforcement-integrity-dream-issue-gate-report.md`.

## Issue

NONE — per `findingPolicy`/the ISSUE DISPOSITION OVERRIDE: this is a new, reproduced, actionable
defect that a bounded repair *did* resolve tonight (TEETH-verified, independently critiqued CLEAR).
A verified local/integrated fix is a work record, not a GitHub issue. This PR is the work record.

## Merge Policy

Human review required. `autoMerge: false` per `dream.config.json` — the decision, not a default
(ADR-068). This session never self-merges and never autonomously promotes candidate state.

## Next steps (concrete, for a future night or a human)

1. Check the other two `new URL(import.meta.url).pathname` sites the same research pass surfaced —
   `scripts/release-abort-stale.mjs:94` and `scripts/release-convergence-watchdog.mjs:30` — both use
   the idiom for root-path resolution (not an entrypoint guard), so the blast radius and fix shape
   differ; flagged as a work record, not fixed tonight (different scan surface: release-integrity,
   not lesson-delivery/gate-teeth).
2. Consider whether `entrypoint-guard-safety.test.mjs`'s permanent regression sweep (currently scoped
   to `SHIPPED_DIRS = ['bin','plugin/scripts','plugin/mcp','kb']`, deliberately excluding
   maintainer-only `scripts/`) should gain a second, separate assertion for maintainer-only automation
   scripts specifically — this repo's own nightly engine is exactly the kind of consumer that needs
   its control-plane scripts held to the same standard, even though they never ship to an end user.
   Not attempted tonight: widening that sweep's scope is a policy change with its own blast radius
   (an unknown number of pre-existing `scripts/*.mjs` files could newly trip it), outside a single
   night's bounded-fix budget.
3. The Dream Cycle draft-PR review backlog (see ledger row, Prior-night fates) remains the largest
   uninvestigated "enforcement" gap in this repo: a promotion gate that a fix cannot pass through in
   practice is not exerting authority over anything. Out of this engine's authority to fix (never
   merge, never force review) — recorded as an observation for the repo owner, not a code candidate.
