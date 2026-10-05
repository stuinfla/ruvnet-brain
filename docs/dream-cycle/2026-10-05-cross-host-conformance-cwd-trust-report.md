# Cross-Host-Conformance SOTA Report — 2026

**Dream Cycle 2026-10-05 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## TL;DR

`session-snapshot-hook.mjs`'s per-tool-call "compatibility" entrypoint — the code path registered
identically on both hosts for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
and `SubagentStop` — resolved the project directory as `payload.cwd || projectDirectory()`, trusting
any truthy value from the host payload with no type or absoluteness check. The file's own sibling
branch (`Stop`/`PreCompact`/`SessionEnd`) already guards the identical input with
`typeof cwd === 'string' && path.isAbsolute(cwd)`. A relative `payload.cwd` naming a nested "stranger"
project (e.g. a vendored dependency living under the real project) gets resolved by
`resolveProjectStore()` against `process.cwd()` instead of against the real project, redirecting the
capture — and its consent check — into that nested project's own `.swarm` store. Measured directly: a
`PreToolUse` capture fired with a relative `payload.cwd` landed its queue file, lock and stop-notices
entirely inside the stranger directory's `.swarm`, with nothing written to the real project's.

Fix: factor the sibling branch's existing validation into one shared helper,
`resolveHostProjectDir()`, in `project-identity.mjs` — the file whose stated purpose is already "ONE
answer to which directory is this" (born from #85/#107) — and call it from both
`session-snapshot-hook.mjs` sites plus `project-transition-hook.mjs`'s identical (currently
unregistered) CLI entrypoint. No new resolver invented; the fix reuses the exact idiom this codebase
already reviewed and shipped for the same input shape.

## What's new

Nothing external — a sibling-defect closure inside this repo's own cross-host hook-dispatch layer, in
the same family as #348 (`.swarm` symlink escape) and #325 (stranger-gate wiring), but via the hook's
own unvalidated `payload.cwd` rather than a filesystem symlink, and on an entrypoint that fires on
every tool call rather than only at `Stop`.

## Competitors — how other autonomous coding/nightly-evolution harnesses handle a host-payload-trust boundary like this (grade C: general knowledge, single-source per row; informs framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No multi-host hook-dispatch surface to validate; not directly comparable. | C |
| OpenHands | Single sandboxed runtime per session; no analogous host-reported-cwd trust boundary. | C |
| DSPy/GEPA | Optimizes a program against a metric; no first-class notion of a host payload field that must be validated before being trusted as a filesystem root. | C |
| SWE-agent | Tool-call payloads are observations consumed directly; no documented validation discipline for a payload-carried working directory. | C |
| Cursor background agents | Single-host (its own remote environment); no cross-host payload-divergence concept to validate against. | C |

The recurring pattern: none of these systems document a validated boundary between "a value the host's
hook payload reports" and "the real project root," which is exactly the gap this candidate closes for
this repo's own dispatch layer.

## Hypothesis (frozen before implementation, unchanged since)

> Given `session-snapshot-hook.mjs`'s per-tool-call compat entrypoint, when `payload.cwd` is a relative
> path naming a nested "stranger" project reachable from the real project's directory, then a capture
> fired at `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SubagentStop`/`PostToolUseFailure` should land
> in the REAL project's `.swarm` store, not the stranger project's — relative to baseline, where it lands
> in the stranger project's store instead — subject to: zero behavior change when `payload.cwd` is
> absolute (the already-trusted shape); zero behavior change to the `Stop`/`PreCompact`/`SessionEnd`
> branch's existing, already-validated behavior.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate` `EVALUATED=blocked` (`no brain at
/root/.cache/ruvnet-brain/kb`; this container never materializes a corpus, not a credentials block;
confirmed on this candidate's own branch, same pre-existing condition every night has recorded since
2026-08-19). `LLM_EVAL=blocked` is not relevant regardless — this is a filesystem-resolution fix, not
a model-graded one.

**TEETH proven RED→GREEN**, independently reproduced two ways:
1. New test `tests/unit/session-snapshot-hook-cwd-trust.test.mjs`: spawns the real
   `session-snapshot-hook.mjs` CLI with the child process's OS `cwd` set to a real project, and
   `payload.cwd` set to a RELATIVE path naming a nested stranger project with its own adopted
   `.swarm/memory.db`. On pre-candidate source: **RED** — `expected 0 to be greater than 0` (nothing
   queued in the real project). On candidate: **GREEN**, 2/2.
2. A separate manual, read-only reproduction (not the test's own claim) confirmed exactly where the
   write landed on pre-candidate source: `real/.swarm` stayed empty; `stranger/.swarm` received
   `.progression-capture-queue-000000000001.json`, `.progression-replay.lock` and
   `.continuity-stop-notices.json`.

**Targeted regression sweep** (every unit-test consumer of the three changed files, 13 files):
153 passed, 3 skipped, 1 failed — `tests/unit/entrypoint-guard-safety.test.mjs`'s
"every multi-copy fixture derives rather than names its dependencies" check, confirmed byte-identical
on baseline (reverting only the 3 production files, same branch) — unrelated to this change (names a
different file, `tests/unit/model-weekly-qualification.test.mjs`).

**Full `npm run test:integration`**, baseline vs candidate on this candidate's own base commit
(`32e1751`, current `main`), each run in isolation (not concurrently with another suite, to avoid the
load-flake class this ledger has documented before): **byte-identical — 19 failed files / 43 failed
tests / 434 passed / 23 skipped / 45 todo of 545, on both.** All 43 failures are pre-existing/
environmental (missing global `ruflo`, `sqlite3` edge cases, root-uid `chmod` fixtures) — none
reference any of the three changed files (grep-confirmed).

`npm run claims:verify`: 3 PASS / 4 SKIP, same class every prior night (brain-not-installed SKIPs; not
affected by this change).

`node scripts/doc-currency.mjs --check`: pre-existing `stamp-lags-doc`/`presumed-stale` findings, none
naming any of the three changed files or an ADR that governs them (confirmed: no ADR's `governs:`
frontmatter lists `project-identity.mjs`, `session-snapshot-hook.mjs` or `project-transition-hook.mjs`).

**Not completed tonight, honestly disclosed rather than hidden or substituted**: the full
`npm run test:unit` suite (via `test:all`/`qa:pr`, which runs it under `--coverage`) did not finish
within this session's time budget — two clean, isolated attempts (10 and 30 minutes) were both still
mid-run when stopped, well past the ~6-minute completion this ledger's 2026-08-26 row recorded for the
same suite. This looks like container-specific slowness (4 vCPU, otherwise idle) rather than a hang on
a specific file — each attempt was still progressing through new files when stopped, with no single
file stalled — but it was not reproduced to a root cause tonight. The 13-file **targeted** sweep above
covers every actual consumer of the changed files and is unaffected either way. Recorded here per
STEP 0.6: a budget-forced stop, not a skipped night.

## Baseline vs Candidate

Baseline: current `main` (`32e1751ba469142d216a175f17fdd9d0bc13bca0`) — `payload.cwd || projectDirectory()`,
unvalidated. Candidate: the same branch with only the three production files changed (+19/−5 lines) and
one new test file. Both run from the same checkout via `git checkout <rev> -- <files>` / restore, never
via two separate clones, so the comparison is exact.

## Darwin Lineage

Not run — this is a binary correctness fix (validates or it doesn't), not a tunable parameter with a
fitness landscape.

## Evidence

OBSERVATION (sibling branch in the same file already validates this exact input shape; the compat
branch doesn't) → MEASUREMENT (TEETH red on current source, reproduced two independent ways; green
post-fix; full `test:integration` byte-identical baseline vs candidate; targeted sweep byte-identical)
→ INFERENCE (the gap is real, live-registered on both hosts, and the fix closes it without changing
any already-validated behavior) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

CLEAR. No benchmark, gold answer, fixture, or threshold touched (`evals/` untouched). The new test adds
cases; it does not alter any existing assertion. The fix only ever narrows which `cwd` values are
trusted — it cannot pass by weakening a check, since the two production call sites previously accepted
MORE inputs (any truthy value) than they do now (absolute-path strings or the validated fallback).

## Security Review

This is a correctness/least-privilege fix to an existing automatic-capture feature, not new attack
surface. Before: a host-reported relative `cwd` could redirect a memory capture — and its project-level
consent check — into an unintended nested directory inside the same project tree (cross-project memory
poisoning via a "stranger" nested project, the same impact class as #348, through a different vector:
the hook's own payload trust, not a filesystem symlink). After: the fix is a pure, synchronous,
allocation-free string check (`typeof` + `path.isAbsolute`) with no I/O and no new dependency; the
fallback path (`projectDirectory()`) is the same containment-checked function already used and tested
elsewhere in this file. No credential, network, or new filesystem write path is introduced.

## Regression Analysis

See Baseline vs Candidate above: byte-identical `test:integration` failure set, zero new failures in
the 13-file targeted sweep. Blast radius independently confirmed via
`grep -rl "resolveHostProjectDir\|projectDirectory" plugin/scripts` (4 consumers: the 2 edited call
sites, `project-transition-hook.mjs`'s edited call site, and the exporting module itself) and the
targeted sweep's inclusion of every test file that imports any of the 3 changed modules.

## Scan findings (work records, Issue=NONE)

1. `project-transition-hook.mjs`'s own bottom CLI entrypoint (line ~225) carried the identical
   unvalidated-`cwd` pattern. Confirmed via repo-wide grep that no `hooks.json`/`codex-hooks.json`
   registration invokes this file directly (only `session-snapshot-hook.mjs` and
   `project-capture-queue.mjs` import it as a module) — so this was latent, not live, risk. Fixed in
   the same change since it is the same root cause and a one-line, zero-risk call-site swap.
2. `duplicate-gate.mjs:444` has a structurally similar `payload.cwd || env.CLAUDE_PROJECT_DIR ||
   process.cwd()` fallback, but its blast radius is capped: the hook bails with
   `why: 'not-this-repo'` unless the resolved root actually contains `plugin/scripts/decision-gate.mjs`,
   so a wrong resolution cannot silently succeed the way the capture path could. Left for a future,
   smaller candidate rather than widening this one.

## ADR

None. No ADR's `governs:` frontmatter lists any of the three changed files (checked via
`doc-currency.mjs` and a direct grep of every ADR's frontmatter); this is a validation-boundary bugfix
to existing hook behavior, not an architectural decision — same precedent as #325/#347/#348 on this
exact DEEP surface.

## Gist

`GIST: LOCAL` — no `gh` CLI or gist-creation MCP tool available this session. This committed report is
the durable copy.

## Issue

**NONE** — per the ISSUE DISPOSITION OVERRIDE: a new, reproduced, actionable defect that a bounded
repair resolved tonight (independently reproduced red→green two ways, full-suite regression
byte-identical) is a work record, not a GitHub issue. This PR is the work record.

## Witness

```
SESSION_COMMIT = 32e1751ba469142d216a175f17fdd9d0bc13bca0
REPORT_HASH    = <computed at push time, see PR body>
WITNESS        = <computed at push time, see PR body>
```

Verifier procedure: (1) on the PR's head commit, `sha256sum docs/dream-cycle/2026-10-05-cross-host-conformance-cwd-trust-report.md` (this file, exactly as committed, placeholders included — this Witness section is intentionally not self-hashing) reproduces `REPORT_HASH`; (2) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` reproduces `WITNESS`; (3) `git merge-base` of the PR head and `main` equals `SESSION_COMMIT`; (4) `npx vitest run tests/unit/session-snapshot-hook-cwd-trust.test.mjs` on the PR head passes 2/2; (5) reverting only `plugin/scripts/project-identity.mjs`, `plugin/scripts/session-snapshot-hook.mjs` and `plugin/scripts/project-transition-hook.mjs` and re-running the same test reproduces the RED failure above.

## Recommendation

1. This candidate (+19/−5 production lines, 1 new test file, 1 report) is small and independently
   reproducible; recommend merge after review.
2. **Standing finding this PR does not fix, flagged again**: as of tonight, 47+ `dream/*` branches are
   open on `origin` with zero merges since #178 (2026-08-26) — now 40 calendar days. A SEPARATE,
   concurrent firing of tonight's own routine independently measured and flagged the identical number
   in PR #396 (opened ~27 minutes before this one, same DEEP/SCAN slot, a genuinely different and
   non-overlapping finding — the both-hosts hook-conformance test's lost subprocess coverage). Two
   independent sessions landing on the same backlog figure the same night, on top of at least four
   prior reconciliation nights naming it (#269, #321, #358, #371) and multiple cross-host-conformance
   nights flagging it specifically (2026-08-26, 2026-08-30, 2026-09-20, 2026-09-25, 2026-09-30), is not
   this candidate's authority to fix, but is the single most actionable thing for the owner to see
   before anything else in this run.

## Concurrent night

A separate firing of this same routine landed first tonight as PR #396 (`dream/2026-10-05-cross-host-conformance`,
base `32e1751`, same DEEP=cross-host-conformance/SCAN=codex-parity,stranger-project-behaviour slot):
the both-hosts hook-conformance integration test lost every real hook-subprocess invocation in commit
`00526b12` (2026-09-07) and has proven nothing about runtime hook safety since. That finding is
genuinely non-overlapping with this one (test-coverage restoration for the conformance gate itself,
vs. a production validation bug in the capture hook's own `cwd` handling) — confirmed by reading
#396's diff, which touches only `tests/integration/hook-conformance-both-hosts.test.mjs` and does not
touch `project-identity.mjs`, `session-snapshot-hook.mjs` or `project-transition-hook.mjs`. This
session's branch was named `dream/2026-10-05-cross-host-conformance-cwd-trust` (suffixed) specifically
to avoid colliding with #396's branch name, which this session discovered already existed under the
unsuffixed name.

## Merge Policy

**Human review required.** This session never self-merges and never autonomously promotes candidate
state. `autoMerge: false` per `dream.config.json` (ADR-068).
