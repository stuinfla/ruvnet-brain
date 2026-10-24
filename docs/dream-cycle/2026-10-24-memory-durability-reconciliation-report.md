# Dream Cycle 2026-10-24 — memory-durability reconciliation

DEEP=`memory-durability`, SCAN=`managed-boundary`,`round-trip-proof` (slot 4, `20261024 % 5 == 4`).
No bonus deep dive (`DAYINT % 25 = 24`, `DAYINT % 75 = 74`).

## Rotation / build

`npx -y dream-machine@0.1.1 compile dream.config.json --out /tmp/tonight.md` succeeded tonight
(15029 bytes) — worth recording because it did **not** on the immediately preceding night (PR #486,
2026-10-23: "6th recurrence of #298", sandbox classifier denied the compile step before slot
selection). No action taken on #298 itself tonight: it is intermittent, not reproducing right now,
and this session's own run is one data point against it recurring, not evidence it's resolved.

`npm ci` clean. Control-plane probes: `brain-score.mjs` — all 4 quality dimensions STALE (44.5d > 14d
budget), both coverage dimensions UNMEASURED (store root never materialized on this container,
`stores 0 dark 0`, unchanged condition since 2026-08-19). `OPENROUTER_API_KEY` present but irrelevant
tonight — no stage in a reconciliation-only night needs a model call.

## Ledger check

`docs/dream-cycle/LEDGER.md` on `main` still ends 2026-08-31 — not missed nights, the known,
repeatedly-documented effect of "a row only lands on `main` when its PR merges, and none have since
`#215`" (tracked by issue #410 since 2026-10-06, restated in this surface's own prior reconciliation
nights #452/2026-10-14 and #474/2026-10-19, and in every other slot's reconciliation PR since).

Fresh counts tonight (GitHub MCP `search_pull_requests`, not assumed):

- `head:dream` all-time: **115** opened.
- `head:dream is:open`: **72**.
- `head:dream is:merged`: **5**, ever — #143, #148, #150, #178, #215. Last merge 2026-08-31 — **54
  days**, unchanged trend.

## Reconciliation of this surface's open items against current `main`@`ea4d778`

Five open `memory-durability` PRs exist for this surface. Checked each fix's target file directly
against tonight's actual source (not assumed from the PR body):

| PR | File | Fix claimed | Still unresolved on `main`? |
|---|---|---|---|
| #379 (2026-10-04) | `plugin/scripts/lesson-promote.mjs` | atomic temp+rename for `CLAUDE.md` promotion | **Yes** — line 230 is still a bare `fs.writeFileSync(file, next)` |
| #422 (2026-10-09) | `plugin/scripts/md-stamp.mjs` | `atomicWriteSync` (temp+fsync+rename+realpath+fchmod) | **Yes** — line 260 is still a bare `fs.writeFileSync(file, stamped)` |
| #453 (2026-10-14) | `plugin/scripts/decision-recall-gate.mjs` | `writeAcksAtomic` | **Yes** — lines 111/117 are still bare `fs.writeFileSync(file, ...)` |
| #473 (2026-10-19) | `scripts/agentdb-fleet-doctor.mjs` | exact-key `memory retrieve` instead of substring `memory search` | **Yes** — lines 87/91 are still the pre-candidate `memory search` + substring-match check |
| #474 (2026-10-19) | `plugin/scripts/continuation-gate.mjs` | route `save()` through the shared `writeAtomic` | **Yes** — line 184 is still a bare `fs.writeFileSync(LEDGER, ...)` |

None superseded, none duplicated by each other (five different files). All five report
`mergeable_state: dirty` as of tonight (conflict-drifted against `main` since opening — consistent
with #452's 2026-10-14 observation that this surface's backlog was already starting to decay, now
confirmed across all five instead of two).

## Research — third sweep, no new candidate

This exact file family (`fs.writeFileSync` into durable cross-session/managed-boundary state without
temp+rename) has now been found and fixed, in five still-unmerged PRs, across: `lesson-promote.mjs`,
`md-stamp.mjs`/`stamp-sweep.mjs`, `decision-recall-gate.mjs`, `agentdb-fleet-doctor.mjs`,
`continuation-gate.mjs`. That is the learning-signal threshold this routine's own STEP 1.1 names
("a finding repeated in ≥3 prior nights") passed for the third time over. Mining this exact vein for a
sixth instance tonight would be marginal at best and ignores the rotation signal; a targeted check
instead:

- Re-ran #452's (2026-10-14) broad sweep spot-check rather than its full 210-site grep (disproportionate
  for a reconciliation night): `onboarding-console.mjs`'s `saveConfig()` remains fixed (`withLock` +
  `writeAtomic`, unchanged from 10 days ago). `session-start-fsutil.mjs`'s `write()` helper remains
  self-correcting internal-stamp-only, still out of this severity class.
- No new file under `plugin/scripts/`/`scripts/` introducing a fresh managed-boundary write surface
  was found in this container's shallow history (`git log` depth 50 does not reach 2026-10-14, so this
  is a source-level check tonight, not a historical diff).

Per STEP 5-9's testability gate: `EVALUATED=no / VERDICT=INCONCLUSIVE / reason=no new, non-duplicate,
actionable memory-durability defect found this slot; the known family is already fully covered by five
unmerged PRs, and re-mining it further is the exact pattern STEP 1.1 says to rotate away from`.

## Evidence

OBSERVATION (five independent fixes for the same write-safety shape exist, unmerged, across five files)
→ MEASUREMENT (direct source read of all five target files against tonight's `main`@`ea4d778` — all
five still carry the pre-fix code at the exact lines the PRs name) → MEASUREMENT (GitHub MCP confirms
all five PRs open/draft/dirty) → OBSERVATION (spot-check of #452's broader sweep: no new instance) →
DECISION (INCONCLUSIVE; docs-only reconciliation, no new PR beyond this one).

## Reward-Hack Check / Security Review / Regression Analysis / Darwin / ADR

N/A — no candidate. Docs-only change (this report + one ledger row). No production code touched. No
benchmark, threshold, or gold-answer file touched. `node scripts/sync-version.mjs --check`: clean.

## Gist

**LOCAL** — no `gh` CLI gist auth and no gist-creation MCP tool available this session, consistent with
every documented night since 2026-08-19.

## Issue

**NONE** — the backlog this report reconciles against is already tracked by open issue #410 (filed
2026-10-06), explicitly acknowledged by the repo owner directly on that issue (2026-10-10: "retained
open because the backlog is real... this work belongs to engineering; no blanket owner approval is
being requested"), and restated nightly since by essentially every slot. Not re-filed, per
`findingPolicy.skipIf: ["duplicate-open-issue"]`.

## Witness

```
SESSION_COMMIT = ea4d778f3663308e621f6ba88666ed653ff32e02
REPORT_HASH    = 1b9a061888fcc98fbd842fb439d934c26158d5d8835b61b86dc131082637741d
WITNESS        = db79e8536177f9246056d64e81380481f3bc175574319571a53f2413d1778ed0
```

REPORT_HASH is the sha256 of this report as it stood immediately before this Witness section was
stamped with its own hash. WITNESS = sha256(REPORT_HASH || SESSION_COMMIT). Verifier: (1) check out
`SESSION_COMMIT`; (2) `sha256sum` this file with the Witness section's values blanked back to the
placeholder above and confirm `REPORT_HASH`; (3) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`
and confirm `WITNESS`. No candidate diff tonight, so no TEETH red→green reproduction step applies.

## Recommendation

1. Not re-escalating the backlog itself on this issue tonight beyond the fresh count above — it is
   18 days past the owner's own 2026-10-10 acknowledgment, restated every single night since by nearly
   every slot (10+ comments on #410 alone), and the owner has explicitly declined to request autonomous
   triage. Repeating the same ask nightly without new information is the thing worth NOT doing.
2. New, concrete fact for whenever the owner does reach this surface: all five open memory-durability
   PRs (#379, #422, #453, #473, #474) are independently verified still-correct and still-unresolved on
   current `main`, and all five are now `mergeable_state: dirty`. A single reviewer pass across just
   these five, in isolation from the other ~67 open dream-cycle PRs, is a bounded, low-risk way to make
   the first dent since 2026-08-31 if that is ever prioritized.
3. No sixth atomic-write PR opened tonight — the family is exhausted for this surface at its current
   coverage; a genuinely new memory-durability finding on a future night should look outside this exact
   shape.

## Merge Policy

**Human review required.** This session never self-merges and never autonomously promotes candidate
state. Draft, by design.
