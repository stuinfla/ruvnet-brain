# Cross-Host Conformance SOTA Report — 2026

**Dream Cycle 2026-09-30 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**
Source identity: `origin/main` @ `6e0f9623b44183ee899aa64a0123cdb9f37e5451` (release 4.3.37 + census fix).

## TL;DR

Release 4.3.37 (commit `2229745`, merged 2026-09-30 as #346) added `plugin/scripts/turn-outcome-capture.mjs`
and wired it into the shared `session-snapshot` Stop/PreCompact/SessionEnd boundary on **both hosts**
(Claude `hooks.json`, and newly Codex `codex-hooks.json` Stop). It runs in every repository the user opens,
including ones that never adopted the Brain. Its `resolveTurnDb()` picked the project store with a raw
`fs.statSync(<projectDir>/.swarm/memory.db).isFile()`, which **follows symlinks**. Every other consumer of
that store goes through `plugin/scripts/project-store-resolver.mjs`, which refuses a store that symlinks
outside the project root ("store symlink escape rejected"). The Console
(`tests/unit/console-memory-canonical-store.test.mjs`) and the managed CLI
(`tests/unit/managed-cli-interface.test.mjs`) already pin that refusal in tests.

A cloned repository can carry a committed `.swarm` or `.swarm/memory.db` symlink. On baseline, a
Stop in that repository sent the detached `ruflo memory store --path` write into the symlink's target.
For a directory symlink it also sent the hook's own `agentdb-turns.jsonl` breadcrumb append there.
Measured: **3 foreign-directory writes across the 2 escape shapes → 0 on the candidate**. The two
control shapes did not change.

The fix is one function. `resolveTurnDb()` now asks `resolveProjectStore()`, which the repo already
ships, for the project store. The resolver's refusal is treated as "no project store", so the turn is
still recorded, to the machine-wide db outside every repository. Nothing new was hand-rolled.

## What's new

This is a new-code finding. `turn-outcome-capture.mjs` is one day old, and no prior Dream Cycle night
has examined it (reconciled against the ledger, every `dream/*` PR, and issue search). It is the only
Brain writer of a project's `.swarm/memory.db` that bypasses the canonical resolver.

## Competitors (grade C: general knowledge, one source per row; this informs framing only)

| System | Stance on a workspace-supplied symlink redirecting an agent's own bookkeeping writes | Grade |
|---|---|---|
| Sakana AI Scientist | Runs in its own experiment directory. It has no "foreign repository" hook surface. | C |
| OpenHands | Sandboxed runtime. Host-side writes are mediated by the runtime, not by per-hook path checks. | C |
| DSPy/GEPA | A library with no install-into-every-repo hooks. Not comparable. | C |
| SWE-agent | Works inside a container copy of the repository, so symlink escapes stay inside the sandbox. | C |
| Cursor background agents | Remote VM per task. The host filesystem is not exposed to repository-carried symlinks. | C |

None of the five installs machine-wide lifecycle hooks into arbitrary local repositories the way this
plugin does, so none of them has this exposure. This repo's defence is its own single resolver, and
tonight's fix applies that resolver to the one writer that skipped it.

## Hypothesis (FROZEN 2026-09-30, before any candidate code was written; unchanged)

> Given a project whose `.swarm/memory.db` is a symlink resolving OUTSIDE the project root (the
> exact shape `project-store-resolver.mjs` rejects as "store symlink escape rejected", and
> `tests/unit/console-memory-canonical-store.test.mjs` / `managed-cli-interface.test.mjs` already
> pin for the other store consumers), when `turn-outcome-capture.mjs`'s `resolveTurnDb()` resolves
> the project store through the repo's own `resolveProjectStore()` instead of a raw,
> symlink-following `fs.statSync(...).isFile()`, then the number of turn-capture write targets
> landing in the foreign directory (the `ruflo memory store --path` target and the
> `agentdb-turns.jsonl` breadcrumb) on a Stop should drop from 2 (baseline) to 0, subject to:
> (a) an in-root regular `.swarm/memory.db` still resolves to scope `project` at the same path;
> (b) no `.swarm` still resolves to the machine-wide db; (c) the existing
> `tests/unit/turn-outcome-capture.test.mjs` cases stay green; (d) `test:integration` failure set
> is unchanged vs the unmodified parent.

**Correction on measurement (not a change to the hypothesis):** the baseline was **1** foreign write for
a `memory.db` file symlink (the ruflo target only, because the breadcrumb lands in the project's real
`.swarm/`) and **2** for a `.swarm` directory symlink. The frozen "2" is right for the directory shape only.
The direction and the 0 target held for both shapes.

## Benchmarks / Evaluation (MEASUREMENT, real commands, same container, same corpus)

| Evaluator | Baseline (parent `6e0f962`) | Candidate | Verdict |
|---|---|---|---|
| Metric probe `measure.mjs` (4 shapes; drives the real `captureTurnOutcome`, and only `launch` is faked) | db-file-symlink 1, swarm-dir-symlink 2, in-root 0 (scope project), no-swarm 0 (scope global). **TOTAL 3** | 0, 0, 0 (project), 0 (global). **TOTAL 0** | effect positive, controls unchanged |
| New TEETH test `(7)` × 2 shapes | **RED**: 2 failed / 9 passed (`expected '/tmp/turn-project-…/.swarm/memor…' to be '/tmp/turn-home-…/.claude/global-…'`; `expected true to be false`) | 11/11 pass | guard proven able to fail |
| `npx vitest run tests/integration` (`test:integration`) | 10 files / 25 tests failed, 335 passed of 422 | 10 / 25 failed, 335 passed of 422. `diff` of the sorted FAIL lines: **IDENTICAL** | no regression |
| `npx vitest run tests/unit` (`test:unit`, full) | the 13 failing files re-run on baseline: 51 failed / 267 passed | 51 failed / 6001 passed of 6237. The same 13 files, and `diff` of FAIL lines is **IDENTICAL** | no regression |
| Affected-unit sweep (9 files: turn-capture, codex-lifecycle, entrypoint-guard-safety, project-store-resolver, session-snapshot-health, hook-contract, codex-blocking-hooks-parity, plugin-generation-prune, ruflo-daemon-autostart-guard) | n/a | 113 passed / 10 skipped | green |
| `npm run qa:pr` | n/a | version, execution-policy, architecture, wiring, substitution, catalog, mesh, plugin PASS. convergence FAIL (stale manifest, regenerated and committed). docs FAIL (pre-existing `stamp-lags-doc` on ADR-0026/0080–0084, none touched here). coverage TIMEOUT (8-min lane budget in this container). claims-source BLOCKED | the candidate caused none of the failures |
| `npm run eval:gate` | **EVALUATED=blocked**: `eval-brain: no brain at /root/.cache/ruvnet-brain/kb` (the container never materializes a corpus: `stores 0 dark 0`) | same | not applicable to this surface |
| `npm run claims:verify` | 3 verified, 4 unmeasured (SKIP: brain not installed / coverage absent / LEARNING-REPLAY source not an ancestor) | not re-run. The candidate touches no claim source | n/a |
| Critic latency probe (`critic.mjs`, git project, 20 calls) | not measured | `resolveTurnDb` p50 7.24 ms, max 10.72 ms (two `git rev-parse` spawns, run while the unit suite ran concurrently) | acceptable on a Stop hook that already spawns a detached worker |

Pre-existing failure causes (OBSERVATION, from the logs): `spawnSync sqlite3 ENOENT`, `global Ruflo is
required`, `spawnSync ruflo ENOENT`, chmod/EACCES fixtures that do not apply under uid 0, a missing `kb/node_modules`
in the worktree, and the CE model not primed. All are environmental, and none reference the changed file.

Significance: the probe is deterministic (a fixed filesystem shape and a pure function), so one run is
exact rather than sampled. There is no stochastic component, so a p-value does not apply.

## Adversarial critique / reward-hack check

- No gold data, frozen fixture, threshold, or evaluator was touched. The only test change **adds** two cases.
  No existing assertion was edited.
- The fix is strictly narrowing. It can only move a write from a project store to the machine-wide store,
  and only when the resolver refuses. It never writes to a new location.
- **Disclosed behaviour change (INFERENCE→MEASUREMENT):** in a git **worktree**, the resolver's canonical
  store is the *primary checkout's* `.swarm/memory.db`. `critic.mjs` measured
  `{"worktree":{"scope":"project","db":"PRIMARY/.swarm/memory.db"}}`. On baseline, a worktree's own
  `.swarm/memory.db` would have been used. This matches the store that `session-snapshot-hook.mjs`'s progression
  capture already uses in the same hook invocation (`resolveProjectStore`, and the #85 "same derivation" lesson).
  A reviewer should still confirm it is wanted.
- The resolver runs `git` (about 7 ms), and any throw is caught, so the capture stays advisory and fail-open.
- An independent critic sub-agent was not spawned. This session did the self-critique, and the ledger
  records that.

## Security review

The finding is itself a (low-severity) **filesystem-scope** defect: a repository-carried symlink could
redirect a machine-wide hook's writes outside the repository. The breadcrumb filename was fixed and the
content was assistant output (never user text), so there was no arbitrary-path write and no code execution.
The realistic harm was **cross-project memory poisoning**: `turns` rows inserted into whatever sqlite db the
link named (MEASUREMENT: the `--path` target resolved into the foreign dir), plus, by INFERENCE from
`runSteps`' own comment that ruflo writes side files relative to its cwd, `hnsw.index`/`ruvector.db`
planted in that directory, since `runSteps` pins cwd to the db's directory. ruflo is absent here, so this is unmeasured. After the fix, the write follows the same least-privilege rule
as every other store consumer. No credentials, network, MCP authority, or CI trust boundary is touched.

## Scan findings (work records, Issue=NONE)

1. **codex-parity:** `plugin/hooks/hook-contracts.json`'s Codex `measurement` block still says, under
   `notObserved.Stop`, "Stop keeps only the pre-existing continuation gate; no capture handler was added…".
   Its `consequence` also opens with "Codex captures at SessionEnd only", yet the same object's 2026-09-29 amendment and the
   `contracts[]` entry register `session-snapshot` on Codex Stop. This is internal documentation drift (OBSERVATION),
   with no behaviour effect. Left for the owner rather than broadening tonight's diff.
2. **stranger-project-behaviour:** `turn-outcome-capture.mjs`'s `runSteps()` runs ruflo with cwd set to the db's own
   directory (`<project>/.swarm`) and pins `CLAUDE_FLOW_MEMORY_PATH`. That is option 2 of open issue **#329**, which its reporter
   measured as still creating `ruvector.db` inside `.swarm/`. This is a new call site of an open, reported defect,
   not a new defect. ruflo is absent from this container, so it is **not reproduced** here (HYPOTHESIS). It is recorded
   for #329's eventual fix to include.
3. (budget note, INFERENCE, unmeasured) The Codex wrapper budgets `session-snapshot` at the default 4000 ms
   (`codex-hook-wrapper.mjs` `timeoutFor`), while the body self-bounds at 8000 ms (`CAPTURE_BUDGET_MS`).
   Because `spawnSync`'s SIGKILL reaches only the adapter process, the body likely continues as an orphan. Not measured.

## Darwin

`node_modules/.bin/metaharness-darwin` is present. **Not attempted:** the candidate is a
correctness/containment invariant with no tunable parameter, so mock-sandbox evolution has nothing to optimise
on this metric.

## Recommendation

ACCEPT, meaning *recommend for human review* only. The PR is a draft and is never self-merged. The candidate is tiny (1 source function, 2 added
test cases, and a regenerated convergence manifest), consistent with the 14+-PR unmerged dream backlog.

## Next steps

1. Reviewer: confirm the worktree→primary-store routing is desired (see critique). If it is not, the alternative is
   a containment-only check, which would hand-roll resolver logic.
2. Owner: fold scan finding 2 into the #329 fix (the turn-capture worker has the same cwd shape as the progression store).
3. Owner: correct the stale `notObserved.Stop`/`consequence` text in `hook-contracts.json` (scan finding 1).

## Witness

- Session commit (parent source): `6e0f9623b44183ee899aa64a0123cdb9f37e5451`
- Report sha256 (pre-stamp copy, committed verbatim as `docs/dream-cycle/evidence/2026-09-30-cross-host-conformance-prestamp.md`): `3000ec68da7b33bb2f0af232dbafdeb4629cb337cd9c4d568a71a700f0fde75e`
- Witness = sha256(REPORT_HASH ‖ commit): `6fe30178bdcf25585c964960808fc1f9ff39960031ea270e35df569f80a52198`

Verifier (5 steps):
1. `git checkout dream/2026-09-30-cross-host-conformance-turn-db-symlink-escape`
2. `sha256sum docs/dream-cycle/evidence/2026-09-30-cross-host-conformance-prestamp.md`, which must print `3000ec68…fde75e`.
3. `printf '%s%s' 3000ec68da7b33bb2f0af232dbafdeb4629cb337cd9c4d568a71a700f0fde75e 6e0f9623b44183ee899aa64a0123cdb9f37e5451 | sha256sum`, which must print `6fe30178…a52198`.
4. Replay the metric on the candidate: `node docs/dream-cycle/evidence/2026-09-30-cross-host-conformance-measure.mjs "$PWD"`, which must print `TOTAL_FOREIGN_WRITES 0`. Then `git checkout 6e0f962 -- plugin/scripts/turn-outcome-capture.mjs` and re-run it, which must print `TOTAL_FOREIGN_WRITES 3`. Restore with `git checkout HEAD -- plugin/scripts/turn-outcome-capture.mjs`.
5. With the baseline file restored as in step 4, `npx vitest run tests/unit/turn-outcome-capture.test.mjs` must show 2 failing `(7)` cases. With the candidate, it must show 11/11 passing.

Concurrency note (added after stamping, outside the hashed pre-stamp copy): a separate firing of this
routine pushed draft PR #347 first to `dream/2026-09-30-cross-host-conformance` (Codex Stop schema
citation drift). Its finding does not overlap this one, so this branch carries a suffix.
