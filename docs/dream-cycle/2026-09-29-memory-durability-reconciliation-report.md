# Memory-Durability Reconciliation Report — 2026-09-29

## TL;DR

Tonight's rotation (`SLOT=4`, `DAYINT % 5`) landed on `memory-durability` for the fourth time in six
weeks (2026-08-19, 2026-08-24, 2026-09-09, 2026-09-14, 2026-09-18/19/24, tonight). Per this repo's own
learning signal — **zero of the last ~30 dream-cycle candidate PRs have merged since #178 on
2026-08-26** — tonight's effort was redirected from generating a 31st unreviewed candidate toward
reconciling the surface's existing, already-verified findings against a full month of `main` history
they had drifted behind. No new, previously-untracked memory-durability defect was found.

## What's new since the last memory-durability night (2026-09-24)

`main` advanced from `e89ea1b` (2026-09-24) to `107a1d4` (2026-09-29, tonight's start) — 118 commits,
including four `fix(runtime)` commits (`e99828b`, `096d870`, `e03ba15`, `7ef83d8`, all landed
2026-09-16 by author-date, merged to `main` after 2026-09-24) that touch
`plugin/scripts/project-progression-hook.mjs`, `plugin/scripts/project-progression-producer.mjs`,
`plugin/scripts/project-progression-contract.mjs`, `plugin/mcp/managed-cli-interface.mjs`, and
`scripts/onboarding-console.mjs` — the same files #322 and #323 touch. This is exactly the kind of
drift that turns a correct fix into an unmergeable one if left alone.

## Reconciliation performed

**PR #322** (`dream/2026-09-24-memory-durability`, `sessionSurfacing`/`onboarding-console.mjs` fix)
was `mergeable_state: dirty` against current `main` — the only conflict was the generated
`data/convergence-manifest.json` (expected: it embeds a version/source-identity hash that changes on
every commit; `scripts/onboarding-console.mjs` itself merged with zero conflicts across the intervening
month). Resolved per this repo's own convention — regenerated via `npm run convergence:write`, never
hand-edited — and re-verified rather than trusted:

- **TEETH re-proven on tonight's actual `main` tip**, not assumed from the 2026-09-24 report: swapped
  `scripts/onboarding-console.mjs` for `origin/main`'s current version, reran
  `tests/unit/console-session-surfacing-hook-check.test.mjs` — 4/8 fail (`expected 'warn' to be 'ok'`,
  `expected undefined to be 'agentdb-ensure'`), confirming the defect is still live on current `main`,
  not fixed by the intervening `fix(runtime)` commits. Restored candidate: 8/8 pass.
- Blast radius re-grepped: `sessionHookExists()`/`pluginEnabled()` still have exactly one call site
  (`probeMemory()`), unchanged by the intervening commits.
- `tests/unit/console-*.test.mjs` + `codex-console-invocation.test.mjs`: 27/28 files, 196/202 tests
  pass; the one failure (`console-memory-canonical-store.test.mjs`, 4/6) reproduces on unmodified
  `main` too — `which sqlite3` → exit 1, no CLI in this container, the same pre-existing condition
  documented every night since 2026-08-26.
- `npm run test:integration`: byte-identical FAIL set, baseline (`origin/main`) vs candidate — 10
  failed files / 25 failed tests both sides, diffed line-for-line, zero difference. All 10 are this
  container's pre-existing environmental gaps (no global `ruflo` binary, no network for the
  cross-encoder model cache, EACCES-under-root fixtures).
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every night since 2026-08-19.
- `npm run convergence:check` / `npm run version:check`: both clean post-regeneration.

**PR #323** (`dream/2026-09-24-memory-durability-progression-reader-wal-sidecar`, `node:sqlite`
WAL-sidecar fix) was already rebased onto current `main` earlier today (`mergeable_state: clean`,
last push 2026-09-29T00:25Z) by an earlier session — verified via GitHub, not re-done.

## Hypothesis (frozen before tonight's scan)

> Given the memory-durability surface's `managed-boundary` and `round-trip-proof` scans, and given
> four intervening `fix(runtime)` commits touching the exact files #322/#323 already patch, a new,
> previously-untracked defect distinct from #274 (open, fix in #275), #322, and #323 exists in this
> surface — falsifiable by: a failing TEETH test on current `main` in a code path not already covered
> by an open PR.

**REJECTED.** Scanned the four `fix(runtime)` commits' diffs directly (not inferred), re-ran the
existing memory-durability test suites and `test:integration` against current `main`, and reviewed
issue #274 (open, `record-lesson.mjs` deterministic-key aliasing, already fixed in open PR #275) and
`scripts/degradation-watch.mjs` / `scripts/learning-replay-fixture.mjs` / `kb/store-root.mjs` for any
new gap. None found. This is a clean, non-fabricated negative result, not a blocked measurement.

## Evidence chain

OBSERVATION (four intervening `main` commits touch #322/#323's files) → MEASUREMENT (PR #322 conflict
is solely the generated manifest; TEETH re-proven red→green on current `main`) → MEASUREMENT
(`test:integration` byte-identical failure set, baseline vs candidate) → DECISION (rebase and push
rather than open a new candidate) → INFERENCE (no new memory-durability defect surfaced by tonight's
scan of the intervening changes and the open #274/#275 thread).

## Reward-Hack Check

No benchmark, gold answer, or threshold touched. The only non-test file changed by tonight's own work
is the regenerated `data/convergence-manifest.json` (mechanical, tool-generated, not hand-edited).
`git diff` from the merge commit touches nothing outside the manifest regeneration.

## Security Review

No new attack surface — a git merge plus a generated-file regeneration. No new filesystem/network
scope, credential, or dependency.

## Scan Findings

- **managed-boundary**: unchanged from 2026-09-24's finding (#322) — no bypass of the `ruflo
  memory store`/`retrieve` boundary found in tonight's re-scan of the intervening commits.
- **round-trip-proof**: unchanged from 2026-09-24's finding (#323) — the WAL-sidecar fix's own
  round-trip re-verification (post-open sidecar-absence recheck) is untouched by the intervening
  commits; independently reconfirmed via the byte-identical `test:integration` diff.

## Competitors

Not independently re-researched tonight — external SOTA research budget was redirected to
reconciliation per the learning signal above. The 2026-09-09 and earlier memory-durability nights'
competitor tables (OpenHands, DSPy/GEPA, SWE-agent, Cursor background agents, Sakana AI Scientist)
remain the most recent grounded comparison for this surface; disclosed here rather than
re-presented as fresh research.

## The backlog, again

As of tonight: **31 open `dream/*` draft PRs**, #269 (2026-09-08) through #340 (2026-09-28), zero
merged since #178 (2026-08-26) — over a month. Flagged by name in #322's own body five days ago,
by #321 ("backlog now 28 days") six days ago, and by #274/#278/#293/#310 in between. Tonight adds no
new PR to that pile; the highest-value action available inside this session's authority was keeping
the two ALREADY-VERIFIED memory-durability candidates (#322, #323) current and mergeable rather than
letting them rot further. The review backlog itself remains the single largest risk to this program's
value and is outside this session's authority to resolve.

## Witness

```
SESSION_COMMIT = 9bb9364d85e48da979da5f9ce73e04f29c82fe80
REPORT_HASH    = 735bb2f7a970d30c42fcccc468f238ada6e9f107fc1abc26b031f71091b5abdb
WITNESS        = d6e6d69881ee0bd8aa0efc6fd3fc4e9c9a564808eb84775a55c4fd7366689615
```

### 5-step verifier procedure

1. `git fetch origin dream/2026-09-24-memory-durability && git log --oneline -5 origin/dream/2026-09-24-memory-durability` — confirm the merge commit and its parents (`origin/main` tip `107a1d4` + prior branch tip `052fbea`).
2. `git show origin/main:scripts/onboarding-console.mjs > /tmp/base.mjs; diff /tmp/base.mjs scripts/onboarding-console.mjs` on the branch — confirm the candidate diff is unchanged from #322's original.
3. Swap `scripts/onboarding-console.mjs` for the `origin/main` version, run `npx vitest run tests/unit/console-session-surfacing-hook-check.test.mjs` — expect 4/8 failures. Restore, rerun — expect 8/8 pass.
4. `npm run test:integration` on the branch vs on unmodified `origin/main` — expect byte-identical FAIL sets (10 files / 25 tests both sides).
5. `sha256sum` this report file, concatenate with `SESSION_COMMIT`, `sha256sum` again — compare to `WITNESS` above.
