# Cross-Host-Conformance SOTA Report — 2026

**Dream Cycle 2026-09-25 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0). Bonus modulus hit (DAYINT % 25 == 0) but no separate bonus-surface finding was pursued tonight — see "Bonus surface" note below.**

## TL;DR

The "stranger's machine" release gate (`scripts/ci/stranger-scenario.mjs`, driven by `.github/workflows/stranger-matrix.yml` across 5 OS images — ADR-058 §D8, "FIRST, because it caps everything") builds a virgin `HOME_DIR` for every image and installs the packed npm tarball into it. Its `healthy` scenario has, since it was written, never created a `~/.codex` directory inside that virgin home. `wireCodexHost()` (`bin/install.mjs`) takes its documented `{host:false, action:'no-host'}` early return whenever `~/.codex` is absent (ADR-051 §1) — so on every one of the 5 stranger images, on every run since this gate existed, the entire Codex MCP-registration + hook-bridge wiring path (ADR-051 §1/§3/§7) has been exercised **zero times**. The gate's own `--doctor --hooks` output says so plainly ("Codex: no host detected (no ~/.codex) — nothing to wire"), but nothing in the driver ever reads that line. Proven live, not inferred: with `plugin/mcp/server.mjs` deleted from the same installed tarball (reproducing issue #43's exact failure shape — "the wiring was dead on every npm install," ADR-051's own 2026-07-26 Addendum), the unpatched driver still exits 0 and prints `PASS`. The fix seeds a virgin `~/.codex` before the `healthy` install and asserts `codexStatus()`'s own `wired`/`serverExists` facts plus the installed hook-bridge file's existence — closing the gate on the exact host this repository ships a second, first-class integration for.

## What's new

Nothing external — this is a gap in this repo's own release-verification machinery, found by tracing which directory each of the 5 "stranger" CI images' virgin `HOME_DIR` actually contains against what `wireCodexHost()`'s own early-return condition requires, then reproducing the resulting false-green locally against the real `npm pack` → `npm install <tarball>` → CI-driver invocation (not a synthetic unit test).

## Competitors — how other autonomous coding/nightly-evolution harnesses handle "does the release gate actually prove parity across every host we ship" (grade C: general knowledge, single-source per row; informs framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | Single research-execution sandbox; no second production host/IDE integration to reconcile against a release gate. | C |
| OpenHands | Runs inside one sandboxed runtime per session; no multi-host (editor A vs editor B) install-verification surface. | C |
| DSPy/GEPA | Optimizes a program against a metric it is given; a release gate that never exercises one of its own declared target hosts is the same class of "the metric doesn't measure what it claims to" problem GEPA's own designers warn reward-function authors about — not something the framework audits for you. | C |
| SWE-agent | Reports raw tool-call observations; no first-class "prove this shipped artifact wires up on every host we claim to support" release-gate concept. | C |
| Cursor background agents | Single-host (its own remote environment) by design; no second-IDE-integration parity claim to falsify. | C |

The recurring pattern: multi-host coding agents rarely ship a SECOND real host integration (an installed MCP server + hook lifecycle in another vendor's CLI) at all, so "does our stranger-machine gate prove BOTH hosts" is not a problem most of these systems' architectures can even pose. This repository is unusual in shipping that second integration (Codex) as a first-class target — which is exactly why a hole in ITS OWN proof of that integration is worth closing rather than assuming "no second host, no problem."

## Hypothesis (frozen before implementation, unchanged since)

> Given the `stranger-project-behaviour` release gate's `healthy` scenario (`scripts/ci/stranger-scenario.mjs`), when a virgin `HOME_DIR` has no `~/.codex` present, then `wireCodexHost()` (`bin/install.mjs:1622`) returns `{host:false, action:'no-host'}` at its existsSync gate and the entire Codex MCP+hook-bridge wiring path is skipped — invisible to the gate's own assertions, which only check Claude-side hook retirement (`automaticHookRetirementStatus`, `claudeInstalledHookRetirementStatus`). If the candidate seeds a `.codex` directory into the virgin `HOME_DIR` before the `healthy` install and adds assertions on `codexStatus()` (`wired`, `serverExists`) plus the installed hook-bridge file's existence, then the `healthy` scenario should newly EXERCISE and VERIFY the Codex wiring path — catching a broken Codex install (e.g. a missing `plugin/mcp/server.mjs`, reproducing issue #43's exact failure mode) that the unpatched gate silently ignores — subject to: the existing Claude-side assertions and the `seeded-broken`/`strict-ungrounded` scenarios' behavior must remain byte-unchanged; the fix must not require a real `codex` CLI binary (none exists on any stranger image or in this container) — only the file-system-level wiring `wireCodexHost()`/`codexStatus()` themselves define is checked.

## Candidate

- `scripts/ci/stranger-scenario.mjs`: seed `path.join(HOME_DIR, '.codex')` before the `healthy` scenario's install call only (`seeded-broken`/`strict-ungrounded` untouched); after the existing healthy-scenario assertions, call `installedApi.codexStatus({ codexDir, configPath })` and `installedApi.codexHookWrapperPath(codexDir)` (both from the INSTALLED tarball's own `bin/install.mjs`, matching this driver's existing pattern for `automaticHookRetirementStatus`/`claudeInstalledHookRetirementStatus`) and fail loudly if Codex is not actually wired or the hook bridge file is missing.
- `bin/install.mjs`: export the previously-private `codexHookWrapperPath` (zero behavior change — a pure path-join function, now importable by the CI driver, the same return-contract path callers already depend on per this file's own comment).
- `docs/adr/0051-codex-host-wiring.md`: Currency-log row (required — this ADR governs `bin/install.mjs`) reviewing the 5 commits that touched its governed paths since the 2026-09-19 rows (none change its decisions) and recording tonight's finding + fix; `reviewed_digest` recomputed via `scripts/doc-currency.mjs`'s own exported `computeDigest()`.
- `data/convergence-manifest.json`: regenerated (`npm run convergence:write`) — required once `bin/install.mjs`/`stranger-scenario.mjs` moved.

One conceptual change, 4 files, **34 insertions / 5 deletions** (`git diff --stat`).

## Evaluation Receipt (the REAL evaluator — the actual `npm pack` → `npm install` → CI-driver invocation `.github/workflows/stranger-matrix.yml` uses, not a synthetic unit test)

- **Baseline** (`git stash` the candidate, real `npm pack` of `main`, install into a fresh scratch project, run `node scripts/ci/stranger-scenario.mjs --scenario healthy ...`): exit 0, `PASS`. `--doctor --hooks` output for that exact run: `Codex: no host detected (no ~/.codex) — nothing to wire.`
- **Baseline against a deliberately BROKEN Codex install** (same packed tarball, `plugin/mcp/server.mjs` deleted from the installed copy — reproducing issue #43's exact failure shape): unpatched driver **still exits 0, still PASSes** — a live false-green on the gate meant to catch exactly this.
- **Candidate, genuinely healthy fixture**: exit 0, `PASS`, plus a new line: `OK — Codex host wired (server <path>/.claude/ruvnet-brain/mcp/server.mjs) and hook bridge installed at <path>/.cache/ruvnet-brain/codex-hook.mjs`.
- **Candidate, same broken-Codex fixture as above**: exit 1, `FAIL: Codex MCP server not wired: {"host":true,"wired":false,"serverExists":false,...}` — the check now catches it.
- **`seeded-broken` scenario**, candidate vs. baseline: both exit 0 (driver reports PASS — installer correctly exits non-zero for the seeded fixture), byte-identical behavior.
- **`strict-ungrounded` scenario**, candidate vs. baseline: both exit 0 (driver reports PASS), byte-identical behavior.
- `npm run test:integration` (the both-hosts hook-conformance gate): candidate vs. baseline **byte-identical** — 9 failed files / 23 failed tests / 323 passed / 16 skipped / 45 todo of 51 files / 407 tests, both runs. All 9 failing files (`anticipate-dial`, `anticipate`, `console-apply-timings`, `health-repair`, 4× `project-progression-*`, `reader-deadlock-regression`) are pre-existing/environmental — cross-encoder model priming and sqlite/native-module gaps in this container, none referencing the changed files.
- `npx vitest run tests/unit/codex-wiring.test.mjs tests/unit/npm-tarball-codex.test.mjs tests/unit/install-prune-stale-stores.test.mjs`: 66/66 passed.
- Full `npm run test:unit` (5795 tests): 17 failed files / 52 failed tests / 5558 passed / 47 skipped / 138 todo — **zero** of the 17 failing files touch `bin/install.mjs`, `stranger-scenario.mjs`, or anything Codex-related; the set is the well-documented pre-existing class (chmod/EACCES-under-root fixtures, disposable-git-repo/network-dependent corpus-release tests, this container's rewritten/disjoint git history breaking a `git merge-base --is-ancestor` check in `retrieval-canary.test.mjs`). `tests/unit/convergence-manifest.test.mjs` failed once (stale manifest, self-caused) and passed after `npm run convergence:write` — the fix is committed as part of this candidate.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical pattern to every prior night (brain-not-installed class).
- `npm run eval:gate`: **EVALUATED=blocked** — `no brain at /root/.cache/ruvnet-brain/kb` (this ephemeral container never materializes a corpus; confirmed independently via `restore-local-ingests.mjs`/`brain-score.mjs`/`kb/store-root.mjs`, all report `stores 0 dark 0`). `LLM_EVAL=blocked` too — no model-provider API key in this environment. Not applicable to this surface regardless (a CI-driver structural fix, not a retrieval-quality change) — no grounding/corpus claim is made tonight.
- `npm run version:check`: PASS, all surfaces agree on 4.3.28. `npm run hooks:check`: PASS. `node scripts/doc-currency.mjs`: zero new BLOCK findings (ADR-0051 clean; one pre-existing unrelated BLOCK on ADR-0052, untouched by this change). `node scripts/verify-channels.mjs`: 2 failures, both `HTTP 403` from the GitHub API in this sandboxed network — environmental, unrelated to this candidate.

## Darwin Lineage

Not run — no numeric benchmark axis; a CI-gate structural/coverage fix, not a metric to search.

## Evidence

OBSERVATION (`wireCodexHost()`'s existsSync gate + the virgin `HOME_DIR`'s contents never include `.codex`) → MEASUREMENT (real packed-install repro: `--doctor` says "no host detected", driver still PASSes; broken-Codex fixture still PASSes) → HYPOTHESIS (frozen above) → MEASUREMENT (candidate PASSes healthy, FAILs broken, `test:integration`/`test:unit`/`claims:verify` byte-identical to baseline) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No benchmark/gold data touched (nothing under `evals/`, `data/oracle*`, or the held-out set). No existing test's pass criteria weakened — `seeded-broken`/`strict-ungrounded` are byte-unchanged, verified by direct re-run. No threshold moved. No cost hidden (the new assertions add a few filesystem stats and one already-existing-shape function call, no new network or process spawn). The new `.codex` seed only affects the `healthy` branch, gated by `if (SCENARIO === 'healthy')`, so it cannot be read as loosening either negative-path scenario. Independent critic (fresh-context agent, not this session) reviewed the diff adversarially for exactly these patterns plus call-site correctness of the new `codexStatus()` invocation against the repo's own established convention (every other caller passes both `codexDir` and `configPath` together) — see verdict below.

## Security Review

Out of scope in substance for exploitation surface: the change adds one `fs.mkdirSync` inside a CI-owned, already-virgin, per-run scratch `HOME_DIR` (never a real user's home), one export of a pure path-join function with no I/O of its own, and read-only assertions against `codexStatus()`'s existing return contract. No secrets, tokens, or credentials touched. No new network call. No new shell interpolation (pure JS property/path operations — this candidate does not repeat PR #305's `toJSON(needs)`-in-shell-string class of issue, since no shell command is constructed at all here). No change to permission scope, MCP authority, or agent trust boundaries.

## ADR

`docs/adr/0051-codex-host-wiring.md` — Currency-log row only (required: it governs `bin/install.mjs`). No new ADR: this is a release-gate coverage fix, not a new architectural decision — ADR-051's own §1/§3/§4/§7 already specify exactly the wiring contract this candidate now proves in CI.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation every night since 2026-08-19). Full report committed: `docs/dream-cycle/2026-09-25-cross-host-conformance-report.md`.

## Issue

**NONE** — per the ISSUE DISPOSITION OVERRIDE: this is a new, reproduced, actionable defect that a bounded repair resolved tonight (verified against the real CI-equivalent evaluator, independently critiqued). A verified local fix is a work record, not a GitHub issue. This PR is the work record. (Reconciled against all 5 currently-open dream-cycle issues — #298, #274, #264, #260, #258 — none target this surface; reconciled against open cross-host-conformance PRs #304, #305, #299, #291, #295, #294 and confirmed no overlap.)

## Bonus surface note (coverage-gap-review, DAYINT % 25 == 0)

**CONCURRENT NIGHT.** A separate firing of this same routine (same rotation: SLOT=0, DEEP=cross-host-conformance, same bonus-modulus hit) landed first as PR #324, branch `dream/2026-09-25-coverage-gap-review`: `scripts/onboarding-console.mjs`'s `scopeRow()`/`computeScope()` was alias-blind against `kb/repo-aliases.json` (same conflation class ADR-058/069 already fixed in `store-root.mjs`/`source-coverage.mjs`, never migrated to this sibling). That session explicitly deprioritized the primary DEEP surface, citing three already-open unresolved cross-host-conformance drafts (#291, #304, #305), and worked the bonus surface instead. This session's finding is independent and non-overlapping: a different file, a different host-integration-proof gap, no shared root cause. Both stand as separate, self-contained work records.

## Standing finding this row does not fix — the review backlog

Zero `dream/*` PRs have merged since #178 (2026-08-26) — **30 days** as of tonight. ~30+ open draft dream-cycle PRs span every DEEP surface, most self-certified ACCEPT with clean, real evaluation receipts (confirmed via GitHub MCP tonight: #304, #305, #312, #313, #317, #321, #322, #323 all open/draft; #291, #294, #295, #297, #299 also still open since mid-September). This has been named in PR bodies since 2026-08-26 (first flagged by this exact routine) with no visible change in review throughput. A concrete, non-hypothetical cost was already confirmed by a prior night (PR #304/#305, 2026-09-20): issue #262 was closed `completed` by the owner while its actual code fix (PR #263) sat unreviewed and was lost when its branch was deleted — a verified fix that never shipped because it was never looked at.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
REPORT_HASH    = 98559d69380e5854d6c4b856bbe705a7d8bf9506f9814914a8cb90ba45dfdcb8
WITNESS        = bd4d196c422aa73d64f6cde471bb91eab20597c7ee26a7e2c858d4c848a85984
```

**Verifier procedure (reproducible by anyone):**
1. `git checkout e89ea1ba167d9252ec99910304f534c8da5ca0ab` (or later, on `main`).
2. Apply this PR's diff (or check out its branch).
3. `npm pack --pack-destination /tmp/x && mkdir -p /tmp/x/proj && cd /tmp/x/proj && echo '{}' > package.json && npm install --no-audit --no-fund /tmp/x/ruvnet-brain-*.tgz`
4. `mkdir -p /tmp/x/home-healthy && node scripts/ci/stranger-scenario.mjs --scenario healthy --installed /tmp/x/proj/node_modules/ruvnet-brain --home /tmp/x/home-healthy --plugin-src /tmp/x/proj/node_modules/ruvnet-brain/plugin` — expect the new `OK — Codex host wired ...` line and `PASS`.
5. `sha256sum` this committed report file and `sha256sum` of `(report_sha256 + SESSION_COMMIT)` should reproduce `REPORT_HASH`/`WITNESS` above.
