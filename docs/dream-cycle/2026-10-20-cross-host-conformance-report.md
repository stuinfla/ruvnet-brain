# Cross-Host-Conformance Reconciliation Report — 2026-10-20

**Dream Cycle 2026-10-20 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0, `20261020 % 5 == 0`). No bonus deep dive (`%25`=20, `%75`=70).**

## Rotation

`SESSION_COMMIT = 37f1f5a2f3e8ad53df27e4d903bd951690c087c8` on `main`. `npm ci` clean (110 packages, 4s, 0 vulnerabilities). `npx -y dream-machine@0.1.1 compile` succeeded in this session (15029-byte `/tmp/tonight.md`) — unlike the concurrent firing below, this session's sandbox classifier did not deny the compiler fetch.

## Concurrent night

A separate firing of this same routine landed first tonight as **PR #475** (`dream/2026-10-20-inconclusive-compile-blocked`), recording that ITS `npx -y dream-machine@0.1.1 compile` was denied by the sandbox classifier (`[Untrusted Code Integration]`) before it could select a slot — a recurrence of #298/#332, not a new issue. That PR's own ledger row already carries fresh global backlog counts (64 open `dream/*` PRs, 5 merged all-time, none since 2026-08-31). This report is this session's independent, non-overlapping work: this session *did* reach STEP 0 successfully and completed a real DEEP=cross-host-conformance cycle. Pushed to a distinctly-named branch (`dream/2026-10-20-cross-host-conformance`) to avoid any collision with #475's branch.

## Ledger check

Last row actually committed to `docs/dream-cycle/LEDGER.md` on `main` is still **2026-08-31** (51 days stale), even though the routine has fired, and opened PRs/issues, continuously since (confirmed via GitHub MCP: PRs up to #474 on 2026-10-19, issue #410 open since 2026-10-06 and re-confirmed in 7 prior comments through 2026-10-18, most recently citing 62 open/104 all-time/5 merged). `head:dream is:open` is now **64** (up from 62 two days ago per #410's 2026-10-18 comment), `is:merged` is still **5**, all by 2026-08-31 — **50 days, 0 merges**. Not re-filing or re-stating this in a new issue (#410 already names it in full and is actively tracked); not adding a duplicate comment there either, since PR #475's ledger row already carries tonight's fresh counts to the same effect.

## Learning signals applied

- Zero of the last 14+ candidate PRs merged → bias to a tiny, reconciliation-first candidate (STEP 1.1). Applied: no new code candidate opened tonight (see Finding/Disposition below).
- `cross-host-conformance` has produced a candidate on 6 prior nights (2026-08-20 ×2, 2026-08-30 ×2, 2026-09-10, 2026-09-15, 2026-09-25, 2026-09-30, 2026-10-05) without a forced rotation trigger (no single finding repeated ≥3 times — each night found a different defect) — continuing on this slot's assigned surface rather than improvising a substitute.
- `LLM_EVAL=blocked` streak (unbroken since 2026-08-19, `no brain at /root/.cache/ruvnet-brain/kb`, no `OPENROUTER_API_KEY`/model-provider credential in this container) → candidate selection, if any, restricted to no-model-call surfaces. N/A tonight (no code candidate).

## Finding / Disposition

Re-read this slot's most recent candidate, **PR #396** (2026-10-05, "the both-hosts hook gate stopped firing any hook, on either host, since 2026-09-07"), and independently reconfirmed its diagnosis against tonight's actual `main`, rather than trusting the 15-day-old PR body:

```
$ grep -n "spawnSync\|spawn(" tests/integration/hook-conformance-both-hosts.test.mjs
(no matches)
$ npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs --reporter=verbose
 ✓ ... 10 passed (10)   # all 10 are schema/policy checks; zero hook subprocesses fired
```

**Still true tonight, unchanged, 15 days after PR #396 diagnosed and fixed it with a verified, additive (+163/−0, one file) patch**: the both-hosts hook-conformance integration suite proves nothing about real hook execution in a stranger project on either host — the exact regression class that caused the owner's original 2026-08-13 complaint this file exists to catch. PR #396's `mergeable_state` is `dirty` (conflict-drifted against `main` since it was opened, the same backlog-aging effect #410's thread has flagged for other PRs since 2026-10-12).

Per the `extraDisciplines` ISSUE DISPOSITION OVERRIDE and `findingPolicy.skipIf` (`existing-fix-pr`): a verified, already-fixed, already-open candidate for the exact same defect exists. Opening a second PR that reimplements the identical fix would (a) not add new evidence, and (b) add a 65th unreviewed draft to a queue whose own stated single highest-leverage fix is *fewer* unreviewed drafts, not more. This is therefore recorded as a **work record, not a new issue or PR** — tonight's deliverable is the reconciliation itself (this report + the ledger row), consistent with the docs-only pattern several recent reconciliation nights on other slots have used for the same reason (e.g. #436, #464, #466).

## Scan findings

**codex-parity.** No new divergence found between `plugin/hooks/claude-hooks.json`-equivalent registrations and `plugin/scripts/codex-hook-adapter.mjs`'s classification beyond what PR #396 (zero real-firing coverage) and the already-merged 2026-08-30 `codex-hook-events.mjs` extraction (confirmed present and in use on `main` tonight — `tests/unit/codex-claude-hook-parity.test.mjs` imports `CONTEXT_EVENTS`/`ALL_HOST_EVENTS` from it, not a hand-copied array) already cover. The gap PR #396 would close — real subprocess execution on both hosts inside a stranger project — is the live codex-parity exposure tonight.

**stranger-project-behaviour.** Same root cause as codex-parity tonight: with zero real hook subprocesses fired by the integration gate, a fresh install in someone else's project has no automated proof that either host's hook manifest behaves (no stderr, no stray files, within timeout) outside this repo's own tree. This is exactly the surface PR #396's `strangerProject()` fixture targets and the surface that caused the original 2026-08-13 complaint.

## Competitors (grade C — general knowledge, single-source per row; informs framing only)

| System | Relevant stance on an unmerged, verified fix sitting in a review backlog | Grade |
|---|---|---|
| Sakana AI Scientist | Single-operator research loop; no analogous multi-week human-review backlog concept. | C |
| OpenHands | Runs changes in a sandboxed session per task; no standing nightly-candidate review queue to compare against. | C |
| DSPy/GEPA | Optimizes a program against a metric automatically; no human-approval gate in the loop by design, so this specific failure mode (correct fix, un-reviewed) doesn't arise the same way. | C |
| SWE-agent | Produces patches for human/CI review per-task, not a nightly accumulating stream; backlog dynamics differ. | C |
| Cursor background agents | Each agent's PR is typically reviewed close to creation; no documented pattern of 50+ same-source PRs accumulating unreviewed. | C |

None of the five autonomous-research/coding systems commonly cited as competitors have a documented analogue to "a disciplined nightly loop whose own structural bottleneck is exclusively human review throughput, not agent output quality or correctness" — worth noting as a genuine, if unglamorous, finding about this category of system, not specific to this repo's code.

## Evaluation Receipt

Not a new code candidate — no `npm run eval:gate` (not applicable to this reconciliation; also `EVALUATED=blocked`, `no brain at /root/.cache/ruvnet-brain/kb`, unchanged since 2026-08-19). `npm run claims:verify` not run (no advertised claim touches a docs-only change). `node scripts/doc-currency.mjs --check`: exit 0; pre-existing `stamp-lags-doc`/`presumed-stale` warnings on unrelated ADRs (0078–0099, all traced to the same bulk commit `f856ba88`, 2026-10-13), none naming this report or the ledger file. `node scripts/sync-version.mjs --check`: `4.7.14` agrees everywhere, unchanged.

## Darwin Lineage

Not run — no code candidate tonight, nothing to evolve.

## Evidence

OBSERVATION (PR #396's 15-day-old diagnosis, re-read) → MEASUREMENT (independently re-ran `grep`/`vitest` against tonight's actual `main`@`37f1f5a2`, not taken on trust — defect reproduces identically) → INFERENCE (an existing verified fix for this exact defect is open as PR #396 and conflict-drifting; a duplicate PR would not add evidence) → DECISION (work record, no new issue/PR; ledger row filed).

## Reward-Hack Check

N/A — no benchmark, gold answer, or threshold touched; no code shipped tonight to check.

## Security Review

N/A — no code change. Noting for the record: this report and the ledger row are the only files this PR touches.

## ADR

None. No governed production path changed; `docs/adr/0055-proactivity-that-meshes.md` and the other ADRs touching this surface are unaffected by a docs-only reconciliation.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available in this session, consistent with every documented Dream Cycle night since 2026-08-19. This file carries the full report.

## Issue

NONE — the defect (both-hosts hook gate fires zero real hooks) already has an open, verified, unintegrated fix (PR #396); the backlog meta-finding already has an open, actively-tracked issue (#410) restated fresh tonight by the concurrent PR #475. Filing either as new would be a duplicate per `findingPolicy.skipIf`.

## Next steps

1. Human triage of PR #396 specifically: it is a small (+163/−0), independently-reconfirmed, additive fix for a real production gap, now conflict-drifted after 15 days in the queue. The longer it waits, the more it will cost to land.
2. The structural recommendation is unchanged from every reconciliation night since 2026-10-06 (#410): a mechanical audit of the ~64 open `dream/*` PRs (close what already landed on `main` via direct commit, merge or reject the rest) remains the single highest-leverage action available, and is outside this session's unilateral authority.
3. If `dream-machine@0.1.1`'s sandbox-classifier denial (tonight's concurrent #475, and #298/#332 before it) keeps recurring intermittently, vendoring it into `devDependencies` (per #298's unresolved suggestion) would remove the dependency on a per-run `npx` fetch succeeding at all.

## Witness

```
SESSION_COMMIT = 37f1f5a2f3e8ad53df27e4d903bd951690c087c8
REPORT_HASH    = 27349ad21c0fae03344907976520fcdfb0b54014b9e8dddcfd28a26651a45004
WITNESS        = 86385966382bb50ebc8ea432fecdcbfd0cffc9474bd3a59ebe81db9c58e2ae2a
```

Note on `REPORT_HASH`: it is the sha256 of this report's content through the end of the "Next steps"
section, computed BEFORE this Witness section was written — the standard chicken-and-egg resolution
(stamp, then rewrite the Witness section with the stamp). It will therefore NOT match a fresh
`sha256sum` of this file as it now reads, since appending/editing this section changed the bytes —
expected by construction, not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 37f1f5a2f3e8ad53df27e4d903bd951690c087c8` (this cycle's base commit on `main`).
2. `grep -n "spawnSync\|spawn(" tests/integration/hook-conformance-both-hosts.test.mjs` — must return no matches.
3. `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs --reporter=verbose` — must show exactly 10 passing schema/policy tests, none spawning a hook subprocess.
4. Apply PR #396's diff and re-run the same command — must show 14/14 passing, 4 of them real subprocess-firing tests.
5. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` and confirm it equals `WITNESS` above.
