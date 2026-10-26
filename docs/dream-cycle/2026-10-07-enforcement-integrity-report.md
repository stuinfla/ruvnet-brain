# Dream Cycle 2026-10-07 — enforcement-integrity

**Rotation**: `20261007 % 5 == 2` → SLOT 2, DEEP=`enforcement-integrity`, SCAN=`lesson-delivery,gate-teeth`. No bonus modulus tonight (`%25`=7, `%75`=57). Session commit `b4590d469f52937550d8d89afa86a394a1d72875` on `main` (fresh checkout, `HEAD` detached at that commit). Build: `npm ci` clean (110 packages, 0 vulnerabilities).

## Ledger check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` has not had a row since 2026-08-31 — not because nothing ran: **47+ open `dream/*` PRs** exist (#269 through #412 and beyond, sampled via GitHub MCP `list_pull_requests`), zero merged since #178 (2026-08-26). This was already found, measured, and filed by last night's run as **issue #410** ("the ledger itself has gone stale — 5+ weeks, 60+ unreviewed draft PRs, zero merges since #178"), which also closed three already-integrated issues (#258, #260, #264) as a bounded reconciliation. That issue's own recommendation — a human triage pass over the backlog — is outside this session's authority and is not repeated here as a new finding; it is flagged again only in the final report below, for the owner.

PR #396 (2026-10-05, cross-host-conformance) is specifically called out: it restores real-firing test coverage for the both-hosts hook-conformance gate, which silently fired zero hook subprocesses since commit `00526b12` (2026-09-07) while the hooks it's supposed to be testing came back live on both hosts. It is a safety-relevant finding sitting in the open-PR backlog.

## Learning signals (STEP 1.1)

- The `gate-teeth` scan's own recurring finding — an entrypoint guard that silently no-ops (`.pathname`/unguarded `realpathSync`/missing guard entirely) — has now repeated across 5+ prior nights (#295, #317, #333, #367, #412, the last of which widened it to 129 files). Per the learning signal ("a finding repeated in ≥3 prior nights → rotate"), tonight did **not** hunt for another instance of that same defect class on `gate-teeth`. Instead it worked the sibling scan, `lesson-delivery`, which had not been independently exhausted.
- Zero of the last 14+ candidate PRs have merged (see Ledger check above). Per the learning signal, tonight's candidate was deliberately kept tiny: one source file (+89/−40 lines) plus one new test file.

## Hypothesis (frozen before implementation)

> Given `scripts/lesson-ratify.mjs` — the only CLI through which a human ratifies or demotes a personal lesson — when a second ratify/demote invocation's write lands on disk between this invocation's read and its own write, then the first invocation's save should **not** silently discard the second invocation's change, relative to the current `loadLessons()` + transform + `saveLessons()` pattern (which has no lock across the read), subject to: zero change to observable CLI output text/exit codes, and the fix must reuse `lesson-store.mjs`'s own existing `updateLessons()` primitive (already written for exactly this purpose) rather than invent a new locking scheme.

## Finding

`scripts/lesson-ratify.mjs` read `lessons` once at module load via `loadLessons()` (unlocked), then later wrote the transformed copy back via `saveLessons(next)` directly from `show()` and the `--ratify-all-user-stated` branch. `plugin/scripts/lesson-store.mjs`'s own header (lines 314–332) documents this *exact* unlocked read-modify-write destroying three of the owner's ratified rules on 2026-07-22, and documents (lines 397–409) that `updateLessons(transform, file)` was written specifically to hold the lock across read → transform → write and close this race. `saveLessons()` taking a lock protects only the write step — never the read that preceded it. `lesson-ratify.mjs` never adopted `updateLessons()`, so the exact race its sibling module's header warns about was still live in the one CLI whose entire purpose (per its own header) is to be the human's trustworthy, never-ask-twice control surface. This is `lesson-delivery`: a human's own ratify/demote decision — not a machine-authored one — silently lost under concurrent invocation.

Zero test coverage existed for `scripts/lesson-ratify.mjs` before tonight.

## Candidate

`scripts/lesson-ratify.mjs`: routes `--ratify`, `--demote`, and `--ratify-all-user-stated` through two new exported functions, `applyMutation(id, mutate, file)` and `applyRatifyAllUserStated(file)`, both backed by `updateLessons()`. Adds an `isEntrypoint()` guard (`fileURLToPath` + try/catch-wrapped `realpathSync`, the exact pattern already used safely in `scripts/selfcheck.mjs:742`) so the file is safe to `import` for testing without executing its CLI body or calling `process.exit()`. No change to observable CLI output (verified by the independent critic's manual smoke test, see below). **+89/−40 lines, one file.**

`tests/unit/lesson-ratify-concurrent-write.test.mjs` (new, zero coverage existed before): one CONTROL case reproduces the old pattern losing a concurrent writer's change using real file I/O through the real primitives (not a mock); three CANDIDATE cases prove `applyMutation`/`applyRatifyAllUserStated` read fresh under the lock and never lose a concurrent write.

`data/convergence-manifest.json`: regenerated (`npm run convergence:write`) — adding the new test file made the committed manifest stale; this is the same mechanism PR #215 (2026-08-31) hit and fixed the same way.

## Evaluation Receipt

- **New test, red→green**: `npx vitest run tests/unit/lesson-ratify-concurrent-write.test.mjs` — 4/4 pass on the candidate. Stashing the candidate's `scripts/lesson-ratify.mjs` change and re-running: the test file fails to even load — `Error: process.exit unexpectedly called with "0"`, thrown from the pre-fix file's own unguarded top-level `process.exit(0)` on this container's empty default lesson store. That is itself evidence for the fix (the pre-fix file is unsafe to import at all), on top of the logical race the CONTROL case demonstrates.
- **Full `test:unit`** (candidate, this branch): 575 passed / 38 failed files (8191/8492 tests passed) in 923s.
- **Full `test:integration`** (candidate): 39 passed / 21 failed files (437/551 tests passed) in 351s.
- **Targeted baseline comparison**: built a separate git worktree at the session's starting commit (`b4590d4`, pre-candidate) and ran exactly the 59 files that failed in the candidate's full runs. Baseline: 57 failed files. The 2-file delta (`tests/integration/advocacy-dial-levels.test.mjs`, `tests/unit/convergence-manifest.test.mjs`) was run down individually: `advocacy-dial-levels` passed cleanly in isolation (one-off flake under full-suite contention, not reproducible); `convergence-manifest` failed for a real but expected reason — the new test file made the manifest stale — and passes after `npm run convergence:write` (now committed). After that regeneration, the candidate's failure set is the same 57 pre-existing files as baseline. **None of the 57 pre-existing failures touch `lesson-ratify.mjs`, `lesson-store.mjs`, or any lesson-related file.**
- **`npm run claims:verify`**: 3 PASS / 4 SKIP — identical to every prior night's documented baseline (brain not installed in this container; not a credentials block, `OPENROUTER_API_KEY` is present).
- **`npm run eval:gate`**: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (container never materializes a corpus; pre-existing condition, confirmed independently via `restore-local-ingests.mjs`/`store-root.mjs`, `stores 0 dark 0`).
- **`npm run qa:pr`**: overall FAIL, lanes: `version/convergence/execution-policy/architecture/wiring/substitution/catalog/plugin` = PASS; `docs` = FAIL (dozens of pre-existing ADR currency BLOCK/warn rows across the whole repo, none governing the changed files); `coverage` = TIMEOUT (needs the uninstalled brain corpus); `claims-source` = BLOCKED (same); `mesh` = FAIL (`tests/mesh/coexistence.test.mjs`'s installer-mutant fixture: `Cannot find module '../kb/download-retry.mjs'` — a pre-existing test-infra path gap, unrelated to any changed file). `convergence` lane specifically **passes** after the manifest regeneration above.

## Baseline

Session's starting commit `b4590d4` (pre-candidate), checked out in a separate worktree for the targeted comparison above.

## Darwin Lineage

Not run — this is a lock-correctness fix (the race either exists or it doesn't), not a tunable parameter with a fitness landscape.

## Evidence

OBSERVATION (unlocked read-modify-write pattern, found by reading `lesson-ratify.mjs` against `lesson-store.mjs`'s own documented history) → MEASUREMENT (CONTROL test reproduces data loss; pre-fix file crashes on import) → DECISION (route through `updateLessons()`). Full chain in this report.

## Reward-Hack Check

**Independent critic (separate agent, not this candidate's author) verdict: CLEAR.** The critic specifically checked: `applyMutation`'s `mutate(id, fresh)` call signature against `ratify(id, lessons, opts)`/`demote(id, lessons)` (no arity/order mismatch); observable CLI behavior byte-for-byte unchanged (manual smoke test: `--list`, `--ratify`, bad-id path, `--ratify-all-user-stated` summary, empty-store exit); the `isEntrypoint()` guard matches the known-good pattern in `scripts/selfcheck.mjs:742` exactly; `updateLessons`'s shrink-guard is structurally unreachable here since `ratify`/`demote` only `.map()`, never remove elements; the CONTROL test genuinely exercises real file I/O, not a mock; blast radius is zero because the pre-fix file had no exports at all and was never imported anywhere in the repo (confirmed by grep) — it was purely a human-run CLI. One non-blocking observation: an unknown `--ratify <id>` now still performs a full locked write (backup rotation, timestamp bump) even though content is unchanged, where the old code was a pure no-op on a bad id; this matches an existing pattern already used unconditionally elsewhere in this codebase (`plugin/scripts/lesson-bridge.mjs`, `scripts/onboarding-console.mjs`) and is not novel or dangerous.

## Security Review

No new file writes, credential handling, or external input handling. The diff adds only read-only path resolution (`fileURLToPath`, `realpathSync`) for the entrypoint check, plus routing through an existing, already-audited locking primitive. No benchmark, gold-data, or threshold touched.

## Regression Analysis

Zero importers of `scripts/lesson-ratify.mjs` anywhere in the repo besides itself (confirmed by grep — it is referenced only in prose/console-output strings in `wired-check.mjs`, `lesson-lifecycle.mjs`, `lesson-presentation.mjs`, `capability-registry.mjs`, none of which import it as a module). Candidate's post-regeneration failure set is byte-identical to a true pre-candidate baseline (57 files, run from a separate worktree at the session's starting commit) across the exact 59 files that failed in the candidate's full suite runs.

## ADR

None created — this is a bug fix to a human CLI's write-safety, not an architectural decision. No ADR governs `scripts/lesson-ratify.mjs` specifically.

## Gist

LOCAL — no `gh` CLI session auth available for public gist creation this run; not fabricated. This report is the full committed record.

## Issue

NONE — per `dream.config.json`'s ISSUE DISPOSITION OVERRIDE: a verified, integrated fix ships in this same PR with passing evidence and an independent critic's CLEAR verdict; it is a work record, not a tracking issue.

## Witness

```
SESSION_COMMIT = b4590d469f52937550d8d89afa86a394a1d72875
```
(REPORT_HASH and WITNESS computed over this file's final committed bytes — see the PR body's Witness section for the exact values and the 5-step reproduction.)

## Recommendation

`evaluated: accepted`. Candidate fixes a real, reproduced, previously-uncovered concurrency defect in the one CLI this repo's own `lesson-store.mjs` header calls "the one file whose loss is unrecoverable." Human action recommended, separate from this candidate: the open-PR backlog (issue #410) is the single highest-leverage item for the owner right now — tonight's own candidate adds to that backlog by necessity (draft PR, human review required), which is itself part of what #410 is about.
