# Memory-Durability SOTA Report — 2026

## TL;DR

Tonight's slot (`SLOT=4`) is `memory-durability` / scan `managed-boundary,round-trip-proof`. No new,
non-duplicate, actionable defect was found within budget. The surface's two live findings
(`plugin/scripts/lesson-promote.mjs`'s non-atomic global `CLAUDE.md` write, PR #379; and
`plugin/scripts/md-stamp.mjs`'s non-atomic host `.md` write, PR #422) were both re-confirmed
present on current `main` and are not duplicated here. A third candidate investigated tonight
(`scripts/onboarding-console.mjs`'s `saveConfig()`) turned out to be **already fixed** on `main` —
recorded as a negative result so a future night does not re-spend budget on it. Verdict:
**INCONCLUSIVE** (no new candidate to evaluate against a baseline).

The dominant fact about this program remains unchanged and is not re-escalated here: the
dream-cycle PR review lane has not merged a PR since `#215` (2026-08-31) — **44 days**, 53 open
drafts, 96 opened all-time, 5 ever merged. This is already tracked in open issue `#410` (filed
2026-10-06) and was explicitly acknowledged by the repo owner directly on that issue
(2026-10-10: "retained open because the backlog is real... this work belongs to engineering").
Not re-filed, per `findingPolicy.skipIf: ["duplicate-open-issue"]`.

## What's new

- Confirmed via direct source read (not assumed from a prior night's claim) that both open
  memory-durability candidate PRs still describe a real, currently-reproducible defect on
  `main`@`d2982ac`:
  - `plugin/scripts/lesson-promote.mjs:230` — `fs.writeFileSync(file, next)` into the user's
    global `~/.claude/CLAUDE.md`, unchanged since PR #379 opened 2026-10-04.
  - `plugin/scripts/md-stamp.mjs:260` — `fs.writeFileSync(file, stamped)` into any host project's
    `.md` file touched by a `Write`/`Edit`/`MultiEdit` hook, unchanged since PR #422 opened
    2026-10-09.
- Both PRs now report `mergeable_state: dirty` (confirmed via GitHub MCP `pull_request_read`) —
  conflict-drifted against `main` since they opened. Flagged for the owner rather than rebased:
  rewriting another session's open-PR branch history is outside this session's bounded authority
  and risks complicating a human reviewer's eventual diff.
- Investigated a third candidate suggested by `plugin/scripts/user-settings.mjs`'s own header
  comments (lines 424-427), which describe a historical gap: "`/api/save-config` — the only writer
  any user can actually reach — kept using a truncating `writeFileSync` with no lock and no
  validation." Checked `scripts/onboarding-console.mjs`'s current `saveConfig()` (lines 2698-2766):
  it already calls `withLock(CONFIG_PATH, ...)` and `writeAtomic(CONFIG_PATH, ...)`. **Already
  resolved** — not a live defect. Grade A (direct source read of this repo, reproducible by
  anyone).
- Swept `session-start-fsutil.mjs`'s `write()` helper (bare `fs.writeFileSync`, used by
  `session-start-signals.mjs` / `session-start-update-plane.mjs`): every call site targets this
  plugin's own internal state directory (`.last-footprint-sweep.log`, `.seed.log`,
  `.auto-update-pref` inside `brainHome`/`stateDir`), not a file this plugin does not own. A
  truncated stamp file self-corrects on the next run. Judged out of proportion with the
  "managed-boundary" severity class the two open PRs address (a file belonging to the user or a
  host project) — not pursued as tonight's candidate.
- Grepped all 210 `fs.writeFileSync`/`writeFileSync(` call sites across `plugin/`, `scripts/`,
  `kb/`, `bin/`. The untreated remainder are one-shot build/research/CI-output writers (receipts,
  caches, corpora, benchmark artifacts) that this repo's own ADR-063/`offerClaudeMd()` precedent
  has never classified as managed-boundary.

## Competitors (brief, qualitative — no benchmark run tonight)

| Project | Relevant practice |
| --- | --- |
| Sakana AI Scientist | Autonomous research loop; no public documentation of a draft-PR review-backlog safeguard — the exact gap this repo's own `#410` names. |
| OpenHands | Agent opens real PRs against real repos; relies on the host repo's normal review process, same backlog risk this repo is now living with. |
| DSPy / GEPA | Optimizes prompts/programs in-process; no cross-night PR-publication step, so this specific failure mode does not apply. |
| SWE-agent | Single-shot patch generation per issue; no nightly-recurring candidate stream to accumulate a backlog. |
| Cursor background agents | Publishes PRs for human review, same as this harness; no public data on review-lag handling at scale. |

None of the five publicly document the specific failure mode this repo is now the clearest
illustration of: a nightly agentic PR-producer whose *production* rate is sound but whose
*review* rate is zero, so "evidence produced" and "value delivered" diverge monotonically. Grade C
(qualitative, not independently benchmarked tonight) — informs the Recommendation section only.

## Hypothesis

Not frozen — no new candidate was identified to evaluate. Per STEP 5-9's testability gate:
`EVALUATED=no / VERDICT=INCONCLUSIVE / reason=no new, non-duplicate, actionable memory-durability
defect found this slot; the two live candidates already have accurate, unresolved, non-duplicate
PRs open (#379, #422)`.

## Evaluation

N/A — no candidate. `npm run eval:gate`: not invoked (not a retrieval-quality candidate).
`LLM_EVAL`: not invoked (no stage needed a model call tonight).

## Darwin Results

Not run — no candidate to evolve.

## Evidence

- OBSERVATION: `user-settings.mjs`'s own committed comments describe a historical `saveConfig()`
  gap.
- MEASUREMENT: direct read of current `onboarding-console.mjs` shows `withLock`/`writeAtomic`
  already wired into `saveConfig()` — gap closed.
- OBSERVATION: `lesson-promote.mjs:230` and `md-stamp.mjs:260` still show the bare
  `fs.writeFileSync` pattern on `main`@`d2982ac`.
- MEASUREMENT: GitHub MCP `pull_request_read` on #379 and #422 — both `state: open`,
  `draft: true`, `merged: false`, `mergeable_state: dirty`.
- DECISION: INCONCLUSIVE. No new work record beyond this reconciliation; no issue (duplicate of
  #410); no new PR beyond a docs-only reconciliation PR carrying tonight's ledger row.

## Reward-Hack Check

N/A — no candidate, no benchmark or threshold touched.

## Security Review

N/A — no candidate. No new tool authority, credential, or filesystem/network scope was exercised
beyond read-only GitHub MCP queries and local source reads.

## Scan Findings

**managed-boundary** — two live findings, both already tracked by open PRs, both now
`mergeable_state: dirty`:
1. `lesson-promote.mjs:230` (PR #379, opened 2026-10-04)
2. `md-stamp.mjs:260` (PR #422, opened 2026-10-09)

**round-trip-proof** — no new finding. The round-trip-key defect tracked by issue #274
(2026-09-09) was independently confirmed already shipped on `main` via a different mechanism
(commit `88b27b13`, owner, 2026-10-05) during the 2026-10-09 reconciliation (#421); nothing new
to add tonight.

## Gist

**LOCAL** — `gh auth status` fails (`GH_TOKEN` invalid) and no gist-creation MCP tool is available
this session, consistent with every documented Dream Cycle night since 2026-08-19. Full report
committed at `docs/dream-cycle/2026-10-14-memory-durability-reconciliation-report.md`.

## Witness

```
SESSION_COMMIT = d2982ac28ebb72216145e122133403de6102ec03
REPORT_HASH    = a344e2a15a53f6f4a600b8a901459e247b511d0849c230bf7e512e47791bfd4e
WITNESS        = f485c9e9e27b4f2ecae6ab050d9f003a45cc9a566f3455282ca3758f81d06f92
```

Verifier procedure (reproduce independently):
1. `git checkout d2982ac28ebb72216145e122133403de6102ec03`
2. `sha256sum` this exact file content → must equal `REPORT_HASH` above.
3. `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` → must equal `WITNESS` above.
4. Re-read `plugin/scripts/lesson-promote.mjs:230` and `plugin/scripts/md-stamp.mjs:260` on that
   commit and confirm both still show a bare `fs.writeFileSync` call.
5. Re-read `scripts/onboarding-console.mjs`'s `saveConfig()` on that commit and confirm it already
   calls `withLock`/`writeAtomic`.

## Recommendation

1. **Not re-escalating the backlog** — the owner already acknowledged issue #410 directly
   (2026-10-10 comment) and classified the audit as engineering work in progress, not something
   needing another nightly restatement. This report notes it once, for completeness, and moves on.
2. **New, freshness-only observation**: PRs #379 and #422 have both decayed from clean to
   `mergeable_state: dirty` since they opened. If/when the backlog audit reaches them, expect a
   rebase to be needed before merge — flagging now while the conflict is presumably still small.
3. **#379 and #422 remain the right, non-duplicate PRs for this surface.** No new PR opened
   tonight; opening a third candidate on top of an already-saturated surface would not have added
   distinguishable value within this session's budget.
