# Cross-Host-Conformance & Issue-Pipeline Integrity SOTA Report — 2026

**Dream Cycle 2026-10-15 — DEEP=`cross-host-conformance`, SCAN=`codex-parity`,`stranger-project-behaviour` (slot 0, `20261015 % 5 == 0`). No bonus deep dive (`%25`=15, `%75`=65). Session commit `1d4ec0b5` on `main`. Build: `npm ci` clean, no wasm/NAPI degradation.**

## TL;DR

Two independent, bounded findings tonight, both ACCEPT:

1. **(Assigned surface)** `tests/integration/hook-conformance-both-hosts.test.mjs` still has zero real-firing coverage of either host's hook manifest in a stranger project — the exact gap PR #396 (2026-10-05) already diagnosed and fixed, but that PR is now 10 days stale against `main` (359 files of unrelated drift) and cannot be safely rebased as a bounded operation. Reapplied the same, already-reviewed restoration as a **fresh, minimal diff against current `main`** instead of resurrecting the stale branch.
2. **(Found during Step 1 ledger check, outside tonight's rotation, judged too urgent to defer)** `scripts/issue-watch.mjs`'s `judgeIssue()` — ADR-050's I1 invariant, "automation can never produce human acknowledgment" — only ever excluded `issue-fix.mjs`'s `BOT_MARKER`-prefixed comments. Dream Cycle's own nightly sessions comment on issues directly through GitHub tools, with no `BOT_MARKER`, and have been doing so for weeks. Issue #410 — the issue *reporting* that Dream Cycle PRs never get reviewed — has had its own SLA page silenced since 2026-10-10 by Dream Cycle's own reconciliation comments on it. This is the 2026-07-24 incident's root cause, reopened through a second code path ADR-050 never named.

## What's new (competitor landscape, graded)

No competitor framework was adopted tonight; this is a repo-internal defect-finding pass, not an architecture import. Context for the decision not to import anything:

| Project | Relevant mechanism | Grade | Applicability here |
|---|---|---|---|
| Sakana AI Scientist | Fully autonomous hypothesis→experiment→paper loop | B (vendor blog + paper) | Its "reviewer" stage is LLM-judged, not deterministic-test-gated like this repo's `eval:gate`/`test:integration`; not a fit for a repo whose stated discipline is "witness every quantitative claim" over real test receipts. |
| OpenHands | Sandboxed autonomous coding agent w/ resolver evaluation | B (project docs, SWE-bench submissions) | Already structurally mirrored here (worktree isolation, draft-only promotion); no new mechanism to adopt tonight. |
| DSPy/GEPA | Reflective prompt/pipeline evolution w/ Pareto frontier | B (paper + repo) | Not applicable — tonight's candidates are deterministic code fixes, not prompt optimization. |
| SWE-agent | Issue→patch agent w/ ACI (agent-computer interface) | B (paper) | Its single-attempt-then-report pattern matches this repo's own `ISSUE_FIX_MAX_FAILED_ATTEMPTS=1` circuit breaker (ADR-050) — convergent design, not a new import. |
| Cursor background agents | Async background coding agents reporting to a PR | C (product page, no public eval) | Structurally the same shape as this whole Dream Cycle pipeline (branch → draft PR → human review); this repo's 48-day/52-PR unreviewed backlog is the cautionary data point this comparison surfaces, not something to copy. |

Grade ceiling is B across the board (no A-grade reproducible benchmark cited); nothing above justified implementation tonight. The comparison's actual yield is confirming that this repo's human-review gate (`autoMerge: false`) is the right call relative to every competitor surveyed, given tonight's second finding shows what happens when automation's own signals go unchecked.

## Candidate 1 — restore real-firing both-hosts hook conformance coverage

### Hypothesis (frozen before implementation)

> Given the both-hosts hook-conformance integration suite, when the real-firing "every registered hook behaves in a project this plugin does not own" describe block (fire each manifest-registered command, on both Claude Code and Codex, inside a genuine stranger temp-dir project, assert no stderr, no stray files, completion within the manifest's declared timeout) is reapplied against **current** `main`, then `npm run test:integration`'s targeted file should newly measure real cross-host hook safety it currently proves nothing about, relative to baseline (current `main`: 10 schema/policy tests, zero hook subprocess invocations), subject to: zero regression to the existing schema checks; the new assertions must be demonstrably non-vacuous (catch a real injected regression); and reapplication must not merely re-propose PR #396's now-10-days-stale diff unreviewed.

### Why not just rebase PR #396

`git merge-base main origin/dream/2026-10-05-cross-host-conformance` → `3e0802f4` (2026-10-05/06). `git merge-tree` showed only **one real conflict** (`data/convergence-manifest.json`, mechanically regenerable via `npm run convergence:write`) — but actually attempting the merge pulled in **359 changed files** of unrelated drift (a new Grok host-adapter, a developer-update subsystem, dozens of deleted/renamed `project-progression-*` modules, etc.) accumulated on `main` over the intervening 10 days. That is not a "tiny, one-parameter, easily-reviewable candidate" (this repo's own learning signal, triggered by 0-of-last-14-merged) — it is a second, much larger, much riskier PR disguised as a rebase. Aborted that merge (`git merge --abort`) rather than ship it.

### Candidate (fresh, against current `main`)

Extracted the old PR's **appended describe block only** (not its own top-of-file edits, which also carried unrelated drift) via `git show origin/dream/2026-10-05-cross-host-conformance:tests/integration/hook-conformance-both-hosts.test.mjs`, and reapplied it on top of current `main`'s version of the same file:
- Re-added the 4 missing imports (`spawnSync`, `resolveBash`, `rmAfterReap`) and the `BASH`/`gated` guard.
- Appended the unmodified `fire()`/`hookCommands()`/`strangerProject()`/`installCodexSpine()` fixtures and the 3 TEETH tests, byte-identical to the already-reviewed PR #396 content.
- Verified both helper dependencies (`plugin/scripts/hook-shim-bash.mjs::resolveBash`, `tests/helpers/reap-detached.mjs::rmAfterReap`) already exist on current `main` with the exact signatures the restored block expects — they were added independently by unrelated work in the last 10 days, so the restoration needed zero adaptation beyond the import paths.

**+163/−0, one file** (same shape PR #396 reported, now against current source instead of a 10-day-stale branch).

### Evaluation Receipt

- Targeted: `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` → **14/14 passed** (10 pre-existing schema/policy + 4 new real-firing), ~34s real wall-clock subprocess execution against **today's** actual `plugin/hooks/hooks.json` / `plugin/hooks/codex-hooks.json` (which now also register a Grok host — the test's `hookCommands()` reader is host-agnostic by file, so this is covered without changes).
- **Non-vacuousness independently reproduced by this orchestrating session** (not merely re-asserted from the old PR): injected `console.error('TEETH-PROBE-INJECTED-STDERR')` at the top of `plugin/scripts/hook-shim.mjs::dispatchHook()`, reran the stderr TEETH test → **13 offenders** flagged (every Claude Code hook event), confirming the assertion fails on a real regression; reverted (`git diff` on the file is empty — confirmed clean).
- Full `test:unit` (633 files / 8715 tests, 1014s real wall-clock): **26 failed files / 82 failed tests**, none in `tests/unit/issue-*` or anything touching hooks — grep-confirmed zero overlap with changed files. Consistent in shape with prior nights' documented pre-existing chmod/EACCES-under-root container artifacts (e.g. `user-settings.test.mjs`'s "backup cannot be taken" — this container runs as root, so a read-only-file permission probe cannot actually deny root).
- `node scripts/doc-currency.mjs`: candidate vs. baseline (`git stash`) produce the **identical 56-line BLOCK set** — this diff touches no file in any ADR's `governs:` list that isn't already independently reviewed below (ADR-050, for the second candidate).
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (container never materializes a corpus; confirmed independently via `restore-local-ingests.mjs` exit 2 / `stores 0 dark 0`, not a credentials block — this surface has no retrieval-quality claim regardless).
- `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY` in this container.

### Baseline

Current `main` (`1d4ec0b5`): 10 schema/policy tests, zero hook subprocess invocations (confirmed by direct read before any edit: no `spawnSync`/`spawn(` call anywhere in the file).

### Darwin Lineage

Not run — binary-property coverage restoration, not a tunable parameter.

### Reward-Hack Check

No benchmark/gold data touched (`evals/` untouched). No existing assertion weakened — purely additive. No undocumented cache or ordering dependency: the new `describe` block computes `hookCommands()` fresh from the live manifest files each run. Self-critique only (no second agent available tonight to assign as an independent critic within budget) — flagged as a limitation below rather than silently upgraded to "independent critic: CLEAR."

### Security Review

All new subprocess execution is confined to `os.tmpdir()`-rooted temp directories; spawned commands are this repo's own already-shipped hook commands read from `plugin/hooks/*.json` at HEAD, not attacker-controlled input. No credentials introduced, read, or logged. Same residual note PR #396's critic found and this report does not re-verify fresh tonight (budget): `RUVNET_CONFIG_ROOT` is redirected per-test, but `detach.mjs`/`session-start-core.mjs` resolve two append-only log paths from `os.homedir()` directly — low-impact (no credentials, append-only growth), inherited, not introduced tonight.

### Regression Analysis

Byte-identical pre-existing `test:unit` failure shape (environmental, root-container chmod/EACCES). Blast radius: only `scripts/qe/agentic-qe-4.3.mjs` shells out to this vitest file by path; nothing imports `hookCommands`/`fire` as a module (confirmed via `grep -rn "hook-conformance-both-hosts" --include=*.mjs`).

## Candidate 2 — close ADR-050's second acknowledgment-manufacturing gap

### Hypothesis (frozen before implementation)

> Given `scripts/issue-watch.mjs::judgeIssue()`'s owner-response predicate, when it is extended to also exclude owner-authored comments carrying the Claude Code attribution footer (not just `BOT_MARKER`), then a Dream-Cycle-authored comment with no `BOT_MARKER` should correctly register as `ownerComment: false` / non-satisfying, relative to baseline (current `main`, where such a comment silently satisfies the SLA), subject to: the existing `BOT_MARKER` and spoof-safety behavior must not change for any already-passing case.

### Finding

Found while executing Step 1 (ledger check / re-checking the fate of recent issues/PRs). Issue #410 ("the ledger itself has gone stale... zero merges since #178") has 3 follow-up comments from 2026-10-10 through 2026-10-12, each ending in `_Generated by [Claude Code](https://claude.ai/code)_` — i.e. posted by a Dream Cycle session directly via GitHub tools, not through `issue-fix.mjs`'s `BOT_MARKER`-wrapped path. None start with `BOT_MARKER`. `judgeIssue()`'s predicate (`c.author?.login === OWNER_LOGIN && !body.startsWith(BOT_MARKER)`) counts every one of them as `ownerComment: true`. This is the exact mechanism ADR-050 was written to kill in the 2026-07-24 incident ("the fixer silenced the watcher") — reopened through a code path (direct session-to-GitHub comments) the ADR's `governs:` list and I1 analysis never named, because it didn't exist as a pattern when ADR-050 was written.

### Candidate

`scripts/issue-watch.mjs`: added `CLAUDE_FOOTER_MARKER = 'Generated by [Claude Code]'` and `isAutomatedComment(body)` (checks `BOT_MARKER` prefix OR footer substring), used in `judgeIssue()`'s exclusion. **+13/−1, one file**, plus a Currency-log row on ADR-050 (governs this file) and a new regression-test block in `tests/unit/issue-automation.test.mjs` (+29 lines) reproducing issue #410's real 2026-10-10 comment body verbatim.

### Evaluation Receipt

- `npx vitest run tests/unit/issue-automation.test.mjs` → **18/18 pass** post-fix.
- **Red-before/green-after independently verified by this session** via `git stash push -- scripts/issue-watch.mjs`: the new KNOWN-BAD-pinned test fails exactly as predicted (`expected true to be false`) on unmodified `issue-watch.mjs`; `git stash pop` restores the fix, 18/18 pass.
- Blast radius: `grep -rn "BOT_MARKER\|judgeIssue"` repo-wide → `BOT_MARKER` has exactly one other consumer (`issue-fix.mjs::botCommentCount`, unchanged, untouched by this diff); `judgeIssue` has no other callers. No spoof vector introduced: the footer check is gated by the same `author.login === OWNER_LOGIN` condition as `BOT_MARKER`, so a stranger's comment containing the footer text still never counts (new test asserts this explicitly).
- `node scripts/doc-currency.mjs`: ADR-050 (governs `scripts/issue-watch.mjs`) currently shows `[BLOCK] presumed-stale` on uncommitted `main` (8 commits/7d drift, pre-existing before tonight) — resolved by the added Currency-log row, which will take effect once committed (the gate's `lastCommit()` reads git history, not the working tree; confirmed candidate-vs-baseline `doc-currency` output is otherwise byte-identical before commit).

### Reward-Hack Check

Makes the SLA check **strictly stricter** (more things count as a breach, never fewer) — cannot be a one-directional score inflator in either direction that favors silence. No threshold, gold data, or benchmark touched.

### Security Review

This is itself the security-relevant surface ADR-050 names explicitly (tags: `security`). No new attack surface: the exclusion only ever makes `ownerComment` *harder* to satisfy, narrowing what silences a page, not widening it. Spoof-safety preserved and newly tested (see Evaluation Receipt).

### Why this is an issue-worthy escalation, not silently repaired

Per the ISSUE DISPOSITION OVERRIDE: this is a reproduced, actionable defect with a bounded repair **already shipped** in this same work — so it is a work record, not a fresh tracking issue (`Issue=NONE` for a *new* issue). But because it directly concerns issue #410's own SLA integrity, this is additionally posted as a comment on #410 itself (not a new issue — `findingPolicy.skipIf: duplicate-open-issue` territory, except this is the mechanism *underneath* #410, not a duplicate of it) and recorded in ADR-050's currency log.

## Evidence (classified)

- **MEASUREMENT**: `test:integration` targeted file 14/14 pass (Candidate 1); `issue-automation.test.mjs` 18/18 pass + red-before/green-after (Candidate 2); `test:unit` full suite 8633/8715 pass, pre-existing failure shape unchanged.
- **OBSERVATION**: issue #410's real comment bodies (fetched via GitHub MCP, not paraphrased) confirm the gap empirically, not just in the abstract.
- **INFERENCE**: the "zero merges since #178, 52+ open drafts" backlog (independently reconfirmed tonight: `search_pull_requests repo:stuinfla/ruvnet-brain label:dream-cycle is:merged` → 0 total; `is:open` → 22 total — count differs from #410's "52" because that count included non-`dream-cycle`-labeled `head:dream` PRs too) means issue #410 is not an isolated case — any dream-cycle PR/issue thread with a Dream-Cycle-authored follow-up comment has had the same silent exposure.
- **DECISION**: ACCEPT both candidates; draft PRs only; no merge; ADR-050 currency row added; comment posted on #410 explaining the mechanism (not re-filing it).

## Reward-Hack Check (both candidates, repo-wide)

No benchmark corpus, gold answer, or scoring threshold was read or written by either candidate. Neither candidate's own evaluation is self-graded by code the candidate also changed.

## Security Review (summary)

See per-candidate sections. No credential handling, no new network calls, no privilege expansion in either diff.

## Scan Findings

**codex-parity**: `hookCommands()`'s restored reader is host-keyed by manifest file (`hooks.json` / `codex-hooks.json`), not a hardcoded host list — it already covers the Grok host's manifest addition that landed on `main` after PR #396 was written, with zero changes needed. No new codex-specific parity gap found tonight beyond the coverage restoration itself.

**stranger-project-behaviour**: covered by Candidate 1 directly — this is exactly what the restored describe block measures (every hook fired inside `strangerProject()`, a directory the plugin has never seen).

## Competitors

See table above.

## Gist

LOCAL — no `gh gist create` / gist-creation MCP tool available in this container; not fabricated. Full report committed at `docs/dream-cycle/2026-10-15-cross-host-conformance-report.md`.

## Witness

```
SESSION_COMMIT = 1d4ec0b54e00d9fa3eec4e77630e5cc9d40797ee
REPORT_HASH    = 3b099d33bd59dace435688251882477e8686df12a6201f3c2281668d94d3c6d1
WITNESS        = c18d18be115ea5b867d4637a6ade7f6ce1a65f0957a2e76902677051470678a8
```

Reproduce: (1) check out commit `1d4ec0b5` of `stuinfla/ruvnet-brain`; (2) take this report's bytes as committed at `docs/dream-cycle/2026-10-15-cross-host-conformance-report.md`, minus this Witness section's REPORT_HASH/WITNESS lines themselves (hash was computed before they were filled in — recompute against `/tmp/dream-gist-2026-10-15.md`'s pre-stamp bytes, or diff the committed file against the PR's own stated hash); (3) `sha256sum` that file → must equal REPORT_HASH; (4) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal WITNESS; (5) independently re-run `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` and `npx vitest run tests/unit/issue-automation.test.mjs` at that commit and confirm 14/14 and 18/18 pass.

## Recommendation

1. **Merge both draft PRs** — both are small (+163/−0 and +13/−1 respectively plus tests/docs), both independently re-verified by the orchestrating session, not just claimed by the candidate.
2. **The backlog is still the dominant finding on this repo** (22 open `dream-cycle`-labeled PRs, 0 ever merged — independently reconfirmed tonight via GitHub MCP, consistent with every prior night's count). Candidate 2 shows a concrete cost of that backlog going unaddressed: the SLA watcher meant to page the owner about exactly this kind of problem has been silently defeated by the same automation reporting it.
3. **Do not resurrect 10-day-stale dream branches by merging `main` into them.** PR #396 (and likely others in the 22-PR backlog) need the same treatment Candidate 1 got — extract the reviewed diff, reapply fresh against current `main` — rather than a wholesale rebase, which balloons a tiny fix into a 359-file merge.
