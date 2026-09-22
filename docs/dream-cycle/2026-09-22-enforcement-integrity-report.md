# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-09-22** — DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth` (slot 2 of 5, `20260922 % 5 == 2`). No bonus deep dive (`% 25` = 22, `% 75` = 47).

`SESSION_COMMIT = 5f39481ff7190d8d40ad4ff5273b68c15b9e3841`. `OPENROUTER_API_KEY` absent — `LLM_EVAL=blocked`. Irrelevant to tonight's candidate: no stage needs a model call (a deterministic CLI entry-point guard).

## TL;DR

`scripts/development-push-check.mjs` — the repo's pre-push credential scanner (`scripts/git-hooks/pre-push` → `exec node "$ROOT/scripts/development-push-check.mjs"`, `$ROOT` from `git rev-parse --show-toplevel`) — used the OLD, previously-retired CLI entry-point guard idiom (`process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`). That comparison does not resolve symlinks on the `argv[1]` side while Node's `import.meta.url` IS symlink-resolved, so through a symlinked invocation the guard silently fails to match: the CLI body never runs, and the process still exits 0 with zero bytes of output — indistinguishable from "scanned, found nothing." Reproduced live tonight, not assumed: a symlinked invocation printed nothing and exited 0; the un-symlinked control printed the real JSON scan result.

This is the exact defect class commit `43bf391` (2026-07-27) fixed across 13 sibling files, and the SAME class a concurrent night's PR #295 (2026-09-17, still unmerged) found as a 4th unmatched instance in `scripts/dream-issue-gate.mjs`. Tonight is a 5th instance, in a file neither sweep covered, on the repo's own pre-push safety net — the mechanism whose entire job is to stop a credential from leaving a developer's machine, on the exact host-layout condition (a checkout reached through a symlinked ancestor directory — a symlinked home dir, mount, or worktree layout) that would silently defeat it with no error, no log, nothing that looks different from a clean push.

## What's new

Nothing architecturally new — this is the established `isDirectInvocation()` remediation (realpathSync both sides, wrapped in try/catch, fail-closed) applied to a 5th file. What's new is the finding: this specific file, this specific gate, was never covered by either prior sweep.

## Hypothesis (frozen before implementation)

> Given `scripts/development-push-check.mjs`'s CLI entry-point guard, when the script is invoked via `process.argv[1]` pointing at a symlink to the real file (the shape every prior instance of this defect class was proven vulnerable to), then the OLD guard (`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`) fails to match and the credential scan silently never runs (exit 0, zero output) — replacing it with this repo's own established `isDirectInvocation()` pattern (`fs.realpathSync` on both sides, try/catch) should make the symlinked invocation run the scan identically to a direct invocation, subject to: the guard must fail closed on any resolution error (never accidentally RUN on an error), and the scan body itself must remain read-only (no new write/network surface).

Unchanged since freeze; not modified after evaluation began.

## Candidate

One production file (`scripts/development-push-check.mjs`, guard swap, `path` import removed since it's no longer used), one test file (`tests/unit/entrypoint-symlink.test.mjs`, added `'development-push-check.mjs'` to the existing `PIPELINE_ENTRY_POINTS` array — the repo's own regression-pinning mechanism for this exact defect class, reusing its established symlink-spawn-and-assert-non-empty-output harness rather than writing a new one). ~20 changed lines across 2 files, one conceptual change.

## Evaluation Receipt

- **TEETH, reproduced twice** — once manually (raw symlink + `node`, before touching the test suite: post-fix symlinked invocation prints the real JSON; pre-fix prints nothing, exit 0 both times) and once via the regression suite: `git stash push -- scripts/development-push-check.mjs` (keeping the new test) → RED, `expected 0 to be greater than 0` (exit 0, zero output through the symlink) — reverting only the production fix reproduces the exact predicted defect. `git stash pop` → GREEN, 9/9 in `tests/unit/entrypoint-symlink.test.mjs`.
- `tests/unit/development-push-boundary.test.mjs` (the pure-function `inspectPush()` suite, untouched by this diff): 3/3 pass, unaffected.
- `tests/unit/pre-push-worktree-root.test.mjs` + `tests/unit/development-maintenance.test.mjs` (both copy this script into fixture repos and invoke it directly, exercising related pre-push/worktree logic): 7/7 pass, unaffected.
- **Independent critic** (fresh general-purpose agent, no shared context with this session) re-verified the fix end to end: guard correctness, fail-closed try/catch semantics, the added test's safety (confirmed empirically that `spawnSync` with no `input` closes the child's stdin immediately, so the scan never runs real `git log -p` in the test — it only proves the JSON success object prints, i.e. that `main()` ran), blast radius (only 2 other test files touch this script, both direct-invocation, neither depends on the old guard's symlink-blindness), and ADR governance (read ADR-0034 and ADR-0056 frontmatter directly: both `govern: scripts/git-hooks/pre-push`, neither governs `scripts/development-push-check.mjs` itself — confirmed independently, not trusted from this session's own claim). **Verdict: CLEAR.**
- `npm run test:integration` (51 files/407 tests): 9 failed files/23 failed tests/323 passed/16 skipped/45 todo — grep-confirmed none of the 9 failing files reference `development-push-check.mjs` or `entrypoint-symlink.test.mjs`; failure signature (`sqlite3`/`@xenova/transformers`/native-module/ruflo-global container gaps: `anticipate-dial`, `anticipate`, `console-apply-timings`, `health-repair` ×7, `project-progression-checkpoint` ×2, `project-progression-concurrent-sessions` ×2, `project-progression-reader-identity` ×2, `project-progression-restore-semantics` ×4, `reader-deadlock-regression`) matches the exact byte-count (9 files/23 tests) PR #294 documented on this same container class 5 days ago.
- `npx vitest run tests/unit` (460 files/5795 tests): 16 failed files/51 failed tests/5559 passed/47 skipped/138 todo — grep-confirmed zero of the 16 failures reference either changed file; spot-checked the two closest-sounding ones directly: `doc-currency.test.mjs`'s failure is a real, pre-existing ADR-0013 stamp-lag against current `main` (unrelated ADR, unrelated file), `no-restated-truth.test.mjs`'s failure flags `host-install-matrix-concurrency.test.mjs`/`sync-version-drift.test.mjs` restating a version literal (pre-existing repo hygiene gap, unrelated). `data/convergence-manifest.json` regenerated (required — tracked source changed; this repo's own documented convention), confirmed `convergence:check` green after.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition to every prior documented night.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (this container never materializes a corpus; confirmed independently via `brain-score.mjs`/`restore-local-ingests.mjs`/`store-root.mjs`, all `stores 0 dark 0`). Not applicable regardless — deterministic CLI-guard mechanism, not a retrieval surface.
- `npm run qa:pr`: `version`/`execution-policy`/`architecture`/`wiring`/`substitution`/`catalog`/`mesh`/`plugin`/`convergence` (after regeneration) all PASS. `docs` lane FAIL — confirmed via direct `node scripts/doc-currency.mjs --check` that every blocking finding names an unrelated ADR (0072, 0074, 0076–0083, 0086), none referencing `scripts/development-push-check.mjs` or any path this diff touches; pre-existing. `coverage` TIMEOUT / `claims-source` BLOCKED match every recent night's documented container condition.

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean entrypoint-detection mechanism swap (same precedent as PR #295, the prior instance of this exact defect class).

## Evidence

OBSERVATION (`development-push-check.mjs` carries the pre-`43bf391`, pre-`#295` guard idiom, on the repo's own pre-push credential-leak safety net, never covered by either prior sweep) → MEASUREMENT (symlinked invocation reproduced silent exit-0 manually and via TEETH, twice; full regression suites diffed, zero overlap with changed files; independent critic re-verified end to end) → DECISION (ACCEPT — this is a verified, integrated fix, not a promotion; human review of the draft PR is still required).

## Reward-Hack Check

Independent critic verdict: CLEAR (see Evaluation Receipt). No benchmark, gold answer, or threshold touched. `tests/unit/development-push-boundary.test.mjs` (the pre-existing suite) is untouched — confirmed via diff, not merely claimed. The new test entry uses the same "must say something, non-empty output" assertion as every sibling `PIPELINE_ENTRY_POINTS` entry — not a new, weaker bar.

## Security Review

`isDirectInvocation()`'s `try/catch` fails CLOSED: any resolution error (a non-existent path, a permission error) returns `false`, meaning the CLI body simply does not run — it can never cause the guard to run when it previously correctly did not. The fixed guard makes the script MORE likely to run its (read-only: `git rev-parse`, `git log -p`, `console.log`/`console.error`) body in exactly the cases the old guard silently skipped — no new write path, network call, or credential surface is introduced. Current 2026 guidance for agent-adjacent tooling handling a cloned repository (Snyk, "Symlinks Are Still Scary — And Yes, Git Supports Them," 2026) independently corroborates the general remediation direction here: resolve every path to its canonical form before trusting it, rather than comparing un-resolved paths — grade B, vendor security-research source, informs framing, not implementation (the implementation itself is this repo's own pre-existing, already-reviewed `isDirectInvocation()` pattern, copied verbatim in style from `scripts/doc-currency.mjs`).

## Scan Findings

**gate-teeth** (tonight's Deep Dive finding IS the gate-teeth finding): a guard whose own path comparison could silently never fire is exactly "a guard that cannot fail is not a guard" (this repo's own `extraDisciplines` line) — here inverted: a guard that can silently never RUN is equally not a guard. Fixed, verified, integrated tonight.

**lesson-delivery**: reconciled, not duplicated. Issue #264 (opted-in BLOCK lesson silently dropped by cross-trigger nudge-budget truncation in `plugin/scripts/lesson-presentation.mjs`) remains live on current `main` — re-confirmed by reading the live source tonight (the unconditional-admission-for-`isBlocking()` fix described in PR #281 is NOT present in the checked-out `buildLessonPresentation()`). Its fix, PR #281, has sat open and unmerged since 2026-09-12 (10 days, multiple rebase cycles, zero human review) per `findingPolicy.skipIf: ["existing-fix-pr"]` and the ISSUE DISPOSITION OVERRIDE. Not re-fixed, not re-issued tonight.

## Competitors

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Software Agent SDK / CLI) | 2026 guidance for agent-adjacent tooling treats a cloned repo as untrusted input specifically because of symlink-based attacks (e.g. a malicious symlink writing into `~/.ssh/authorized_keys`); the documented remediation is "resolve every path to its canonical location before trusting it" — the same direction as tonight's fix, applied here to a comparison rather than a write-boundary check. | B (Snyk vendor security research, cross-checked against the general Node.js symlink-resolution semantics this repo's own prior fixes already established) |
| DSPy / GEPA | No public claims on CLI entry-point/symlink handling surfaced tonight. | C |
| SWE-agent | No public claims on CLI entry-point/symlink handling surfaced tonight. | C |
| Cursor background agents | No public documentation on this specific mechanism surfaced tonight. | C |
| Sakana AI Scientist | No public documentation on this specific mechanism surfaced tonight. | C |

No competitor claim justifies the implementation — the implementation is this repo's own, already-reviewed, five-times-independently-applied `isDirectInvocation()` pattern extended to a 5th file.

## Gist

LOCAL — gist writes return `403 Gist writes are not permitted through this proxy` from this session's outbound proxy (confirmed by direct probe against `api.github.com/gists`, both without and with an explicit `Content-Type: application/json` header; not assumed, not fabricated). Full report committed at `docs/dream-cycle/2026-09-22-enforcement-integrity-report.md`.

## Witness

```
SESSION_COMMIT = 5f39481ff7190d8d40ad4ff5273b68c15b9e3841
REPORT_HASH    = 9223b923a6da55aba32a17ec02378e269810611d9c4040aba273224086d74410
WITNESS        = c342cad04a4ac0822d584425c95199448179e7a3ab687e5f24eb08fc1c740cc2
```

5-step verifier procedure, reproducible by anyone with this repo checked out at `5f39481f`:

1. Check out commit `5f39481ff7190d8d40ad4ff5273b68c15b9e3841`.
2. Retrieve this report as committed at `docs/dream-cycle/2026-09-22-enforcement-integrity-report.md` (byte-identical to this gist except this Witness section, which is filled in after the hash is computed, per STEP 16).
3. `sha256sum` the report file *as it existed before this Witness section was filled in* (i.e. with the placeholder text) — reproduces `REPORT_HASH` above. (Anyone re-verifying from the committed file should instead diff against the PR's first commit, which carries the pre-stamp version; the ledger row's own Witness column is the authoritative published value.)
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` — reproduces `WITNESS` above.
5. Confirm `SESSION_COMMIT` is reachable from `origin/main` (or is `origin/main`'s own tip at the time this ran): `git merge-base --is-ancestor 5f39481ff7190d8d40ad4ff5273b68c15b9e3841 origin/main` (or equal).

## Recommendation

`evaluated: accepted`. Human review of the draft PR requested — this session never self-merges or self-promotes. Separately, worth the owner's attention (not a new issue, per the ISSUE DISPOSITION OVERRIDE and the standing observation repeated across ~8 prior nights since 2026-08-26): as of tonight, dream-cycle PRs opened since 2026-09-01 (#227 through #313, roughly 40+) remain almost entirely open/draft with zero merges since #178 (2026-08-26) — nearly four weeks. PR #281 (issue #264, this exact surface, a verified TEETH-proven fix) has been open 10 days across multiple rebase cycles with zero human review. Ordinary `fix/`/`release/` PRs from the same window merge normally (#302, #306, #307, #309, #310, #315), so the gap is specific to the dream-cycle track, not general review capacity.
