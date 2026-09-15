# Dream Cycle 2026-09-14 — memory-durability (reconciliation, not a new candidate)

## Rotation

```
DATE   = 2026-09-14
DAYINT = 20260914
SLOT   = 4  (20260914 % 5)
DEEP   = memory-durability
SCAN   = managed-boundary, round-trip-proof
BONUS  = none (20260914 % 25 = 14, % 75 = 39 — neither hits)
SESSION_COMMIT = dd435b6bd9132716db23ac4c40d3e04d9f25b95e (origin/main at session start)
```

`OPENROUTER_API_KEY` absent tonight — `LLM_EVAL=blocked`. No stage of tonight's work needed a model
call (a deterministic reconciliation and a merge-conflict rebase).

## STEP 1 — Ledger check / STEP 1.1 — Learning signals

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31 (row for `#215`). This is **not**
nine missed nights — cron fired every night; `git log --all` and `git fetch --prune` confirm 20+
`dream/*` branches exist for 2026-09-01 through 2026-09-13, each with its own draft PR. The ledger row
only lands on `main` when a candidate PR merges, and **zero dream-cycle PRs have merged since #178
(2026-08-26)**. Verified directly via `list_pull_requests`/`pull_request_read`, not assumed:

- 24 pre-2026-09-07 `dream/*` PRs were closed **unmerged** in a single bulk-close window
  (`closed_at` clustered at `2026-09-07T18:48:13`–`18:48:21Z`), coinciding with a `main` history
  squash to a new root commit the same day (per issue #274's prior note).
- 10 `dream/*` PRs remain open and draft as of tonight: #269, #270, #275, #276, #278, #279, #280,
  #281, #282, #287 — the oldest, #269, has sat untouched since 2026-09-08.
- **Zero of the last 14+ candidate PRs merged.** Per STEP 1.1's own learning signal
  ("zero of the last 14 candidate PRs merged → bias to a tiny, one-parameter, easily-reviewable
  candidate"), tonight's action is reconciliation, not a new diff: the review pipeline, not the
  detection pipeline, is this system's actual bottleneck right now. Adding an 11th open draft PR
  would not have served the owner.

## Reconciliation (STEP 1 / ISSUE DISPOSITION OVERRIDE)

Tonight's slot (`SLOT=4`, `memory-durability` / `managed-boundary,round-trip-proof`) is the exact
surface issue **#274** already covers (opened 2026-09-09, same SLOT, `20260909 % 5 == 4`). Reconciled
against current source rather than treated as new:

1. **Reproduced the underlying defect is still live.** `scripts/record-lesson.mjs` on current `main`
   (commit `dd435b6`) still computes `stored = String(back).includes(value)` where `value` is fully
   deterministic from the CLI args (lines 56-94) — the exact aliasing gap #274 describes. Grep-confirmed
   no `nonce`/`probe`/`randomUUID` string anywhere in the file.
2. **Two existing, independent fix PRs already cover it** — both open, both draft, both closing #274:
   - **#275** `fix(record-lesson): a disposable pathway probe proves THIS write, not a stale one` —
     writes a one-shot nonce to a **disposable** key (`${key}-pathway-probe-${pid}-${Date.now()}`),
     never touching the real `lesson-${slug}` key or its content.
   - **#276** `Dream Cycle 2026-09-09: memory-durability — record-lesson nonce fast-follow` — appends a
     per-invocation `nonce` directly onto the **real stored value** (a disclosed, permanent `RUN: <uuid>`
     suffix on every future lesson).
   Both were independently developed the same night (2026-09-09) by different concurrent firings of
   this same routine, both TEETH-tested and green, and both have been rebased through 5-6 `main`
   advances since by prior sessions (visible in each PR's own comment history).
3. **Recommendation: #275 over #276.** #275's own Reward-Hack Check found and fixed a real defect in
   its first draft — an earlier revision that poisoned the *real* key with the nonce before the real
   write, which a process kill mid-write could turn into permanent data loss on a durability fix whose
   entire purpose is preventing data loss. #276 ships the functional equivalent of that same
   real-key-content mutation as its shipped design (a permanent `RUN: <uuid>` tag on real lesson
   content), without the same adversarial pass having been run against it. Given this repo's own
   `extraDisciplines` line — "a guard that cannot fail is not a guard" — the disposable-key design in
   #275 is the safer of the two for a memory-durability fix specifically.
4. **#275 was `dirty` against current `main` tonight** (main has advanced past every prior rebase,
   through the corpus-seed ADR-0086 work). Rebased it: merged `origin/main` (`dd435b6`), resolved the
   sole conflict (`data/convergence-manifest.json`, regenerated via `npm run convergence:write`, never
   hand-edited — `scripts/record-lesson.mjs` itself merged clean, zero conflict markers), pushed as
   `9af1d14f`. Re-verified post-merge:
   - `npx vitest run tests/unit/record-lesson.test.mjs` — 5/5 pass
   - `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` — 10/10 pass (the
     both-hosts TEETH gate named in this repo's own operating notes — never weakened, not touched)
   - `node tests/integration/require-brain-lane.mjs` — 3/3 pass
   - `node scripts/sync-version.mjs --check` — all surfaces agree on `4.3.25`
   - `node scripts/doc-currency.mjs --check --changed HEAD` — 0 blocking findings
   `mergeable_state` is now `blocked` (pending required checks/review on the new head), not `dirty`.
5. **#276 was not rebased tonight** — recommending it be closed as superseded by #275 rather than
   spending an 8th rebase cycle keeping alive a design this review prefers not to ship. That is the
   owner's call, posted as a recommendation on #274, not executed by this session.
6. **No new issue opened.** Per the ISSUE DISPOSITION OVERRIDE: #274 is not new, is already reproduced,
   is already actionable, and — as of tonight's rebase — is no longer blocked by a merge conflict on its
   preferred fix. `Issue = #274 (existing, reconciled, not reopened)`.

## Scan Findings

**managed-boundary**: both #275's and #276's write paths stay inside `ruflo memory store`/`retrieve` —
neither bypasses to raw SQLite. No new finding.

**round-trip-proof**: this IS the surface #274/#275/#276 already cover — no second, independent
round-trip-proof defect found tonight distinct from that one.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate` independently blocked (`no brain at
/root/.cache/ruvnet-brain/kb`, store root never materialized on this container — confirmed via
`brain-score.mjs`/`restore-local-ingests.mjs`/`store-root.mjs`, all `stores 0 dark 0`, the same
condition every night since 2026-08-19). No candidate diff originates from this session — tonight's
only code change is the merge-conflict resolution on #275's existing, already-TEETH-tested diff, so
"evaluated" here means the rebase reproduces the same passing test set #275 already established, not a
fresh hypothesis test.

## Darwin

Not run — no continuous parameter to evolve for a reconciliation night.

## Security Review

No new attack surface introduced tonight: the only change is a merge-conflict resolution
(`data/convergence-manifest.json` regeneration) on an already-reviewed diff. `record-lesson.mjs`
remains human-run-only per `scripts/wired-check.mjs`.

## Reward-Hack Check

N/A — no new candidate logic tonight. #275's own Reward-Hack Check (an independent critic finding and
fixing the real-key-poisoning defect in its first draft) is the basis for tonight's #275-over-#276
recommendation above, cited, not re-litigated.

## Competitors

N/A — no new hypothesis tonight; see #274/#275's own competitor table for this surface.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation every prior
night). This report is the durable record, committed alongside the ledger row.

## Witness

```
SESSION_COMMIT = dd435b6bd9132716db23ac4c40d3e04d9f25b95e
REPORT_HASH    = 9ebb4c52a0bde6c95408c16ed239ae25bbd3788792dfc41c7ab795c3e48ebd8d
WITNESS        = d6a99cb09495b5df08c9b254b763a959bb27f460db13248de35adf8c891aad41
```

Verifier: (1) checkout `dd435b6b`; (2) `sha256sum` this file, compare to REPORT_HASH; (3)
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`, compare to WITNESS; (4) fetch
`dream/2026-09-09-memory-durability` at `9af1d14f`, confirm it merges cleanly onto `dd435b6b`; (5)
re-run the five checks listed in Reconciliation item 4 against that merge.

## Recommendation

`evaluated: not attempted (reconciliation night — existing issue #274, existing PR #275 rebased to
mergeable, no new candidate)`. Human review of #275 requested (currently `blocked` pending checks, not
`dirty`). Separately, and at least as important as tonight's specific finding: **the review backlog is
the system's actual bottleneck.** 10 open draft dream-cycle PRs, some untouched for 6 days, one pair
(#275/#276) duplicate-solving the same bug because neither got reviewed before the next SLOT-4 night
rolled around. Recommend either dedicating review time to the backlog, or pausing new-candidate nights
(reconciliation-only) until it clears — continuing to generate new candidates against an unreviewed
queue compounds the problem this row documents.

**Merge policy**: this session never merges and never self-promotes. Evaluation is not promotion.
