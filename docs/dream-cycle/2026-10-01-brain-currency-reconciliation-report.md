# Brain-Currency Reconciliation SOTA Report — 2026-10-01

**Dream Cycle 2026-10-01 — DEEP: brain-currency / SCAN: dark-stores, corpus-freshness (slot 1)**

## TL;DR

No new brain-currency defect found tonight after a bounded search. The surface is saturated: the
two open defects from this exact DEEP/SCAN pairing (issues #258, #260) are already correctly
tracked, already have validated fixes, and are blocked on human review/decisions, not on more
research. Tonight re-verified both are still live and current, traced the one corpus-coverage code
path that changed since the last brain-currency night (commit `e76a182`, ADR-0091 D5,
2026-09-28) for the exact alias/case-mismatch bug class that has recurred at least 6 times on this
surface, and found it clean. The highest-value finding tonight is process, not code: this routine's
own output is now actively duplicating and self-correcting because nothing has merged in over five
weeks — concrete, fresh evidence below, not a repeat of a prior night's complaint.

## What's new

Nothing new externally and no new internal defect. This is a reconciliation night, following the
precedent already set by PR #278 (2026-09-10, cross-host-conformance, "no parity gap found") and PR
#321 (2026-09-23, grounding-quality, "no new finding, backlog now 28 days").

## Rotation

`DATE=2026-10-01` · `DAYINT=20261001` · `SLOT = 20261001 % 5 = 1` → natural DEEP=`brain-currency`,
SCAN=`dark-stores`,`corpus-freshness`. No bonus deep dive (`% 25 = 1`, `% 75 = 51`).
`SESSION_COMMIT = 94bd932f8c6fbd01e66c09191b5cb575d8e8353a`.

**Learning-signal override, explained.** `docs/dream-cycle/LEDGER.md` on `main` is stuck at its
2026-08-31 row (9 data rows) and literally shows `brain-currency` 4 of 9 times — the compiled
instructions' own rule ("a finding repeated in ≥3 prior nights → rotate to the next slot's DEEP
surface") would read that as grounds to rotate away. I did not rotate, because that file is stale,
not representative: zero `dream/*` PRs have merged since #178 (2026-08-26), so every night since has
shipped its own ledger row inside its own unmerged draft PR, and `main`'s copy has not moved. Using
real GitHub history instead (`search_pull_requests` for `label:dream-cycle`, 18 results from
2026-09-07 through 2026-09-30): `cross-host-conformance` ran 4 times, `memory-durability` 3,
`grounding-quality` 3, `enforcement-integrity` 3, `coverage-gap-review` 1, and `brain-currency` only
**once** (2026-09-11) plus two reconciliation nights (2026-09-26 ×2). By the real, current history
`brain-currency` is the *least*-mined surface, not an over-mined one — rotating away from it tonight
would have been following a stale signal into exactly the imbalance the rule exists to prevent.
Noted as an override per STEP 3's instruction to explain one.

## Ledger Check

Read `docs/dream-cycle/LEDGER.md` (9 rows, 2026-08-19 through 2026-08-31 — stale, see above).
Cross-checked real state via GitHub MCP (`list_pull_requests`, `search_pull_requests`,
`issue_read`, `pull_request_read`) rather than trusting the file:

- **18 open `dream/*` PRs** from `label:dream-cycle` search, oldest created 2026-09-07 (#265,
  closed-unmerged) / oldest still-open #269 (2026-09-08, 24 days old tonight).
- **Zero dream-cycle PRs merged since #178 (2026-08-26)** — 36 days, unchanged by tonight.
  Ordinary engineering PRs (releases, dependency bumps, the ADR-0091 corpus-isolation fix) continue
  to merge normally into `main` in the same window; the dream-cycle lane specifically is the one not
  moving.
- **Duplicate work, confirmed concretely tonight:** issue #260 (`kb/forge-currency.mjs`'s
  `brainKnownSet()` reading `SOURCE.json` from the checkout instead of `root`) has **two** open
  draft PRs proposing the identical fix — #280 (2026-09-11, refreshed 2026-09-26, `mergeable_state:
  unknown` as of tonight) and #328 (2026-09-26, `mergeable_state: dirty` as of tonight, 5 days
  stale again). A prior reconciliation night already recommended keeping #280 (older, independently
  critiqued twice) and closing #328 as duplicate; neither has happened.
- **Self-correction, confirmed concretely tonight:** issue #258 (`brain-score.mjs` panel-freshness
  write side) was incorrectly closed by PR #328 the same night it was opened (citing a commit,
  `12f8bf1`, that `git show --stat` proves never touched the relevant files), then correctly
  reopened by a *concurrent firing of this same routine*, same night, with a direct `git
  show`/`grep` refutation. The write-side fix remains PR #292, which has a real (non-mechanical)
  merge conflict against `main` — an unrelated Vercel redirect-regex change on its branch tip
  conflicts with a different redirect fix already on `main` — that needs a human to pick the
  correct pattern; two separate dream-cycle nights have already flagged this rather than guessing.

This is not "more research needed." It is two already-solved problems whose solutions are rotting
because nothing reviews them, to the point that the research layer has started producing duplicate
and incorrect bookkeeping about its own prior output.

## Deep Dive (bounded search for a NEW, non-duplicate defect)

1. **Live probes** (`node scripts/brain-score.mjs`, `node scripts/restore-local-ingests.mjs`,
   `kb/store-root.mjs`'s `storesAt`/`darkStores`): this container has no materialized local brain
   (`stores 0 dark 0`); `restore-local-ingests.mjs` correctly reports "never materialized… NOT
   evidence of a wipe" (exit 2) rather than a false wipe alarm — the exact defect class fixed in
   PR #143 (2026-08-19) is still fixed. `brain-score.mjs` correctly refuses to average quality and
   coverage and correctly marks coverage `UNMEASURED` rather than a false `0` — the defect class
   fixed in PR #178/#215 (2026-08-26/31) is still fixed. No regression in either.
2. **What changed on this surface since the last brain-currency night** (2026-09-26,
   `e89ea1b`): exactly one commit touched a file this surface governs —
   `e76a182` (`fix(corpus): isolate a failed store instead of aborting the generation`, ADR-0091
   D5, 2026-09-28, merged directly by repo engineering, not a dream-cycle PR). It adds
   `storeOutcomes` — a map from store name to `{carry|failure|integrity}` — threaded from
   `scripts/corpus-reconcile.mjs`'s `recordStoreOutcomes()` into
   `scripts/source-coverage.mjs`'s `classifyRepository()`. This is exactly the shape of the
   alias/case-mismatch bug class that has recurred at least 6 times on this surface (ADR-058's
   `darkStores()`, `readCoverage()`, `artifactEvidence()`, plus `forge-currency.mjs`'s two
   `SOURCE_PATH` instances and `ingest-repo.mjs`), so it was the natural place to look for a 7th.
   Traced both ends: the write side (`corpus-reconcile.mjs:378-380`,
   `storeOutcomes[store.toLowerCase()] = …`) keys off `item.store`, which is itself derived, at
   plan-construction time (`planReconciliation`, line 220), from `row.artifact.store` —
   `classifyRepository`'s own `storeName(repo.storeName || repo.name)`. The read side
   (`source-coverage.mjs:616`, `storeOutcomes?.[store.toLowerCase()]`) keys off the identical
   `storeName(repo.storeName || repo.name)` call. Both sides resolve through the same single
   lower-casing helper (`storeName()`, `source-coverage.mjs:324`) from the same alias-resolved
   field (`repo.storeName`), so there is no independent map to drift out of sync — unlike every
   prior instance of this bug class, which each involved two *different* resolution paths. **No
   defect found.**
3. No other file this DEEP/SCAN pairing governs changed in this window (confirmed via
   `git log e89ea1b..origin/main -- kb/forge-currency.mjs scripts/brain-score.mjs
   scripts/brain-grade-groundtruth.mjs scripts/restore-local-ingests.mjs kb/store-root.mjs
   scripts/source-coverage.mjs kb/repo-aliases.json`, one hit, covered above).

Within tonight's budget (research capped at roughly half the session, per STEP 0.6), this is where
the search stopped. Not exhaustive — a longer night could look further afield (e.g. the gist
pipeline's request-budget note in ADR-069's 2026-09-13 currency-log row, flagged there as "not yet
addressed" but a cost concern, not a reproducible defect, and not obviously testable without a real
GitHub API budget) — but nothing found tonight clears the bar of "new, reproduced, actionable."

## Hypothesis

Not frozen — no candidate was produced. Per STEP 5-9, this is `EVALUATED=no / VERDICT=INCONCLUSIVE`
territory for "new finding," with the override that this repo's `findingPolicy`/ISSUE DISPOSITION
OVERRIDE governs what happens to the *existing* tracked defects (#258, #260): they stay open,
unmodified, no duplicate issue or PR opened for them.

## Evaluation Receipt

No candidate code to evaluate tonight. Verification performed instead: direct `git show --stat`,
`grep`, and source reads (not inference from PR descriptions) against tonight's real `main` tip for
every claim above, including the `storeOutcomes` trace and the PR #328/#258 correction history.

## Darwin Results

Not run — no candidate to evolve.

## Evidence

OBSERVATION (main's ledger stale 36 days; 18 open dream-cycle PRs; #260 has two duplicate PRs; #258
was wrongly closed and self-corrected the same night) → MEASUREMENT (direct GitHub-state checks via
MCP tools, not assumed; direct source trace of the one new corpus-coverage code path, confirmed
alias-consistent) → DECISION (INCONCLUSIVE for a new finding; no new issue; recommend human triage
of the existing backlog, specifically #280-vs-#328 and PR #292's conflict).

## Reward-Hack Check

Not applicable — no candidate, no test or benchmark touched.

## Security Review

Not applicable — no candidate.

## Scan: dark-stores

No new dark-store defect. `darkStores()`/`rootNeverMaterialized()` remain alias-aware and
never-materialized-aware (fixed prior nights #142/#143, #177/#178); this container's `stores 0
dark 0` is consistent with an ephemeral container that never installs a brain, not a wipe.

## Scan: corpus-freshness

No new corpus-freshness defect. The one new corpus-freshness-adjacent code path since the last
brain-currency night (ADR-0091 D5's `storeOutcomes` threading) was traced end-to-end and found
alias-consistent (see Deep Dive §2). The two already-tracked corpus-freshness defects (#258's
write-side panel timestamp, #260's `SOURCE.json` root-scoping) remain open and correctly described;
this report adds no new claim about either beyond re-verifying they are still live on today's `main`.

## Competitors (grade C — context only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No published first-class distinction between research throughput and review/merge throughput as separate bottlenecks. | C |
| OpenHands | Per-task sandboxed runs; no published handling for an unreviewed-output backlog accumulating across runs. | C |
| DSPy/GEPA | Optimizes within a run against a fixed metric; cross-run backlog management is out of scope. | C |
| SWE-agent | Produces a patch per task; merge decisions are explicitly left to the human loop, same as this repo's policy. | C |
| Cursor background agents | Proprietary; no published architecture for this specific concern. | C |

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session; not fabricated. Full report
committed at `docs/dream-cycle/2026-10-01-brain-currency-reconciliation-report.md`.

## Witness

```
SESSION_COMMIT = 94bd932f8c6fbd01e66c09191b5cb575d8e8353a
REPORT_HASH    = ef8f7706e4df96dc2550431605b710a9f96adc1f7356c49f2fab4a8809198685
WITNESS        = ad6a57ddb8e8d291c8145d75adfda88f5932c50c4cd6f70e5b625f82219481be
```

**Verifier procedure (reproduce independently):**
1. `git show 94bd932f8c6fbd01e66c09191b5cb575d8e8353a:docs/dream-cycle/LEDGER.md` to see `main`'s
   ledger is still 9 rows (stale 2026-08-31), confirming the Rotation section's override claim.
2. `gh pr view 280`, `gh pr view 328` (or the GitHub MCP `pull_request_read` tool) to confirm both
   are open and both propose the same `kb/forge-currency.mjs` diff.
3. `git show --stat e76a182 -- scripts/source-coverage.mjs scripts/corpus-reconcile.mjs` and read
   `storeName()`/`recordStoreOutcomes()`/`classifyRepository()` to confirm both sides of
   `storeOutcomes` key off the identical `storeName(repo.storeName || repo.name)` derivation.
4. `sha256sum docs/dream-cycle/2026-10-01-brain-currency-reconciliation-report.md` → must equal
   `REPORT_HASH`.
5. `printf '%s%s' <REPORT_HASH> 94bd932f8c6fbd01e66c09191b5cb575d8e8353a | sha256sum` → must equal
   `WITNESS`.

## Recommendation

`not attempted: reason=surface saturated — the two tracked brain-currency defects (#258, #260) are
already correctly diagnosed, already have validated fixes, and are blocked on human review/
decisions, not on more research; a bounded search for a new, non-duplicate defect (including
tracing the one new corpus-coverage code path merged since the last brain-currency night) found
nothing actionable.`

**For the repo owner, in priority order:**
1. **Triage #280 vs #328.** Both fix issue #260 identically. Recommend closing #328 as duplicate
   (comment already posted by a prior night explaining why) and merging or requesting changes on
   #280.
2. **Resolve PR #292's Vercel redirect-regex conflict.** This is the one blocker on issue #258 that
   genuinely needs a human judgment call (which redirect pattern is correct in production) —
   dream-cycle nights have correctly declined to guess at it twice now.
3. **Bulk-triage the remaining ~15 open dream-cycle drafts** (oldest 24+ days). Every surface's
   nightly report has flagged this since 2026-08-26 (36 days); tonight adds concrete evidence that
   the cost is no longer just "idle inventory" — it is active duplication (#280/#328) and at least
   one factual error in the system's own bookkeeping (#258's wrongful closure) that a human reviewer
   would have caught immediately by looking at either PR's diff.
