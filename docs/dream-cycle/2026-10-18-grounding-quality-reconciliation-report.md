# Dream Cycle 2026-10-18 — grounding-quality reconciliation

DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5,
`20261018 % 5 == 3`). No bonus deep dive (`% 25` = 18, `% 75` = 68). `GIST: LOCAL`
(no `gh` CLI and no gist-creation MCP tool available this session, consistent with
every documented Dream Cycle night since 2026-08-19).

## TL;DR

Tenth consecutive `grounding-quality` night to find the same three live, unintegrated
defects and no new one. Re-verified all three directly against tonight's `main` tip
(`e323eb1`), by reading the exact lines, not by trusting the originating PRs'
descriptions. All three are still exactly as diagnosed. The backlog that has blocked
every one of them from landing is now **104 `dream/*` PRs opened all-time, 62 open,
5 merged, 0 since `#215` (2026-08-31) — 48 days**. `#410` (filed 2026-10-06) still
open, still the single highest-leverage item, now 12 days old itself.

## Read this first — the backlog, now 48 days

Freshly counted tonight via GitHub MCP (`search_pull_requests`, not assumed from a
prior night's numbers):

- `head:dream` (all-time): **104** (`#466` from last night pushed it to 104; this
  session's own branch below will make it 105).
- `head:dream is:open`: **62**.
- `head:dream is:merged`: **5**, unchanged — `#215`, `#178`, `#150`, `#148`, `#143`.
  Most recent: `#215`, 2026-08-31. **48 days** with zero merges in this review lane.
- `label:dream-cycle is:open`: `#410` only (filed 2026-10-06, 7 comments, still open
  as of tonight).

This is not new — every grounding-quality night since `#297` (2026-09-18) has named
it, and every other surface's recent nights (`#422`, `#453`, `#466`) name it too.
What is new tonight: the count is still climbing (60 → 61 → 62 open across the last
three nights) with zero signs of triage.

## Deep dive — the three known findings, re-verified against current source

Per `dream.config.json`'s `extraDisciplines` ISSUE DISPOSITION OVERRIDE and
`findingPolicy.skipIf: ["duplicate-open-issue", "existing-fix-pr"]`: before any new
candidate, reconcile against open fix PRs. All three below already have an open,
independently-critiqued, CLEAR-verdict draft PR. Opening a fourth candidate on this
surface tonight would duplicate already-done work, so none was attempted; tonight's
budget went to re-verification instead (reading the actual current-`main` bytes, not
trusting the PRs' own descriptions of themselves).

| Finding | PR | Location on `main`@`e323eb1` tonight | Status |
|---|---|---|---|
| `provenance` stratum grades off raw `top?.repo` instead of the already-computed `routedRepo` (`receipt?.repo ?? top?.repo`) | `#297` | `scripts/eval-brain.mjs:95` — confirmed still `top?.repo !== 'ruv-gists'` | **still live** |
| Capability-card synthetic candidates `unshift`'d to rank #1 even though they can never resolve against `verify-citation.mjs` | `#340` | `kb/forge-ask-all.mjs:2281` and `:2319` — confirmed both still `candidates.unshift({...})` | **still live** |
| Fast-lane `renderCardHit()` prints a citation header that can never resolve (`repo=<repo>` / `path: <repo>/kb/<path>` instead of the real `concepts/<repo>/CARD/<repo>-card` convention) | `#372` | `kb/card-lane.mjs:758-759` — confirmed still the unresolvable old template | **still live** |

Checked a fourth candidate `unshift` site while in the file (`forge-ask-all.mjs:2204`,
`packageIdentityCandidate`) to rule out a new instance of the `#340` pattern: not a
duplicate finding — that candidate is a real, independently-resolvable passage (not
a synthetic capability-card stub), so ranking it first is not the defect `#340`
describes. No new site found.

No fourth, disjoint grounding-quality defect was found within tonight's bounded
budget across the files most load-bearing for this surface's two scans
(`kb/verify-citation.mjs`, `kb/forge-ask-all.mjs`, `scripts/eval-brain.mjs`,
`kb/card-lane.mjs`, `kb/grounded-response.mjs`).

## Supplementary observation — the quality composite itself is stale

`node scripts/brain-score.mjs` tonight: `grounded`, `routed`, and `abstained` are all
**38.5 days old**, past this repo's own 14-day freshness budget — `panelStrict` has
no timestamp at all. This is a `brain-currency`-surface condition (measurement
staleness), not a `retrieval-precision`/`citation-binding` defect in the mechanism
itself, so it is recorded here as a cross-surface observation rather than claimed as
tonight's finding — the next `brain-currency` night (slot 1) is the right place to
decide whether it needs its own candidate.

## Hypothesis

Not frozen tonight — no new candidate was proposed. (Per STEP 3.3/4: a hypothesis is
only frozen immediately before implementation; reconciliation nights with no
candidate correctly skip this step, same as `#419`/`#440`/`#466`.)

## Evaluation Receipt

No candidate code tonight, so bench/tests/integration don't apply to a diff. Ran the
real evaluators anyway, against current `main`:

- `npm run eval:gate` → `EVALUATED=blocked`: `eval-brain: no brain at
  /root/.cache/ruvnet-brain/kb` — this container never materializes a corpus
  (unchanged since 2026-08-19; not a credentials block — `node -e
  "import('./kb/store-root.mjs')...` confirms `stores 0 dark 0`).
- `npm run claims:verify` → 3 PASS / 4 SKIP, identical composition to every prior
  documented night (`baseline`, `held-out`, `version` PASS; `cost-factor`,
  `coverage`, `chunk-count`, `LEARNING-REPLAY` SKIP — all for the same documented,
  pre-existing, environment-only reasons).
- `node scripts/restore-local-ingests.mjs` → read-only pass, exit as documented;
  125 ingests correctly reported NEVER-MATERIALIZED (the `#143` fix from night 1
  still holds, 60 nights later).
- `node scripts/brain-score.mjs` → see Supplementary observation above.
- `npx -y dream-machine@0.1.1 compile dream.config.json` → succeeded cleanly
  tonight (15029 bytes, 321 lines); `#298`'s intermittent sandbox denial did not
  reproduce.
- `npm ci` → clean, no wasm/NAPI build failure to record.

## Baseline / Darwin Lineage

N/A — no code diff tonight, no continuous parameter to evolve.

## Evidence

OBSERVATION (three prior grounding-quality candidates remain open and unintegrated)
→ MEASUREMENT (direct read of `main`@`e323eb1`'s exact lines for all three,
tonight, not inferred from the PRs' own text) → MEASUREMENT (fresh GitHub MCP counts:
104 total / 62 open / 5 merged / 48 days) → INFERENCE (no new, disjoint defect
surfaced within this session's bounded research budget) → DECISION (reconciliation
night; no candidate; verdict INCONCLUSIVE — not because evaluation was blocked, but
because no testable hypothesis was formed. A reconciliation with a clean
measurement, per the Global Invariants' own wording for a rejected hypothesis, is a
legitimate night, not a failure to hide).

## Reward-Hack Check

N/A — no candidate code was written or evaluated tonight.

## Security Review

No new attack surface. Read-only against source (five files read, zero written
outside this report/ledger) and GitHub (issue/PR reads only), plus this report, one
ledger row, and one comment on `#410`.

## Regression Analysis

N/A — docs-only diff (this report + the ledger row). No production code changed.

## ADR

None — a backlog measurement and a re-verification of already-diagnosed defects are
not an architectural decision; no governed file was touched.

## Gist

LOCAL — this report, `docs/dream-cycle/2026-10-18-grounding-quality-reconciliation-report.md`.

## Issue

`NONE` — tonight's only finding (the backlog, still escalating; the same three
defects, still live) is already comprehensively tracked by `#410` (open) and by
`#297`/`#340`/`#372` (each open with its own verified fix). Commented on `#410` with
tonight's confirming counts instead of filing a duplicate, per
`findingPolicy.skipIf: ["duplicate-open-issue"]`.

## Witness

```
SESSION_COMMIT = e323eb15965d62adde67649105b59e25980cf182
REPORT_HASH    = 0fb8720356b91931de7ba1ce55cfba7af5f3e829ad8f61d8b3c87062abf8e6d5
WITNESS        = 7e1339ae527a2f1b6d726efb78520b25c852a973e3a328123ba0b36ef4db8695
```

Verifier procedure (reproducible by anyone with repo access):

1. `git checkout e323eb15965d62adde67649105b59e25980cf182`
2. Read `scripts/eval-brain.mjs:95`, `kb/forge-ask-all.mjs:2281,2319`,
   `kb/card-lane.mjs:758-759` — confirm each still matches the "still live" rows
   in the Deep dive table above.
3. `node -e "import('./kb/store-root.mjs').then(m=>console.log(m.storesAt(m.storeRoot()).length, m.darkStores().length))"` → `0 0`.
4. Run `npm run claims:verify` and `npm run eval:gate` → same PASS/SKIP/blocked
   pattern as this report's Evaluation Receipt.
5. `sha256sum docs/dream-cycle/2026-10-18-grounding-quality-reconciliation-report.md`
   → must equal `REPORT_HASH` once stamped; `sha256(REPORT_HASH + SESSION_COMMIT)`
   must equal `WITNESS`.

## Recommendation (for the repo owner, priority order)

1. **The backlog is still the dominant fact, and it is still growing, not
   shrinking**: 62 open drafts, 104 opened all-time, 5 merged, 0 in 48 days. `#410`
   (filed 2026-10-06) is now itself 12 days old with no recorded human triage action
   visible from this repo's own GitHub state. The mechanical audit it proposes
   (check each open PR/issue against current `main`, close what's already landed,
   merge or reject the rest) remains the single highest-leverage action available —
   restated for the sixth time by this surface alone, and by nearly every other
   surface's recent nights too.
2. **`#340`, `#297`, and `#372` are all still independently verified CLEAR and
   mergeable-in-spirit** (each has a passing, independently-critiqued diff).
   Reviewing and merging even one would be direct evidence the pipeline can reach
   `main`, which `#422` was deliberately written small enough to be a candidate for
   and which `#453` restated.
3. Consider whether `grounding-quality`'s own measured numbers being 38.5 days stale
   (see Supplementary observation) belongs on the `brain-currency` surface's list for
   its next rotation (slot 1).

## Merge Policy

**Human review required.** `autoMerge: false` per `dream.config.json` (ADR-068) —
the decision, not a default. This session never self-merges and never autonomously
promotes candidate state. Docs-only PR, draft by design.
