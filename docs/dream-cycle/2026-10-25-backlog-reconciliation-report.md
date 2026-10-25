# Dream Cycle Backlog Reconciliation — 2026-10-25

**Not tonight's assigned slot work.** Slot 0 (`cross-host-conformance`) plus both bonus moduli
(`coverage-gap-review`, `self-hosting-review`) were already covered tonight by a concurrent firing
of this same routine — see PR #495 / issue #494 (coverage-gap-review structurally cannot run inside
a Dream Cycle session's GitHub scope; self-hosting-review has no defined check anywhere in the repo).
This report covers a different, second piece of work from the same run: the backlog-reconciliation
audit the owner explicitly asked for.

## Why this, not another candidate PR

Issue #410 (opened 2026-10-06) has been restated every 1-2 nights since with a growing open-PR count
and zero actual triage. The owner's 2026-10-10 comment on #410 said plainly: *"Next work is
deterministic reconciliation of each proposal against current source, recording
integrated/obsolete/current dispositions... This work belongs to engineering; no blanket owner
approval is being requested."* Fifteen days and roughly a dozen reconciliation comments later, no
night had actually performed that audit — each one re-confirmed the count and stopped. Tonight did
the audit instead of restating the count for the 16th time.

## Method

Fanned out 7 parallel sub-agents, each assigned 5 open `dream/*` PRs from the oldest end of the
backlog (35 of ~74 total). For each PR: fetched the exact diff (`git fetch origin
pull/<N>/head`, diffed against `main`), read the PR's own claim, then read the CURRENT `main` source
at the exact file/function the PR touches — never trusted the PR title or body as ground truth.
Classified each into one of four dispositions:

- **INTEGRATED** — the same or an equivalent fix is already on `main` (often via a different,
  unrelated commit that happened to fix the same spot).
- **OBSOLETE** — the file/function no longer exists, or the PR's target (an issue, another PR) is
  already resolved by other means.
- **DUPLICATE** — near-identical content to another PR in the backlog.
- **STILL-LIVE** — the defect reproduces on current `main` exactly as described; the PR's fix is
  still correct and still needed.

## Results: 14 of 35 closed tonight

| PR | Disposition | Evidence |
|---|---|---|
| #280 | INTEGRATED | `kb/forge-currency.mjs:56-59` reads `SOURCE.json` from `root`; commits `eea7f5d1`/`3db0c738`/`94a44d1d` |
| #281 | INTEGRATED | `lesson-presentation.mjs:62-63` already protects blocking lessons from budget truncation; issue #264 closed |
| #282 | OBSOLETE | Deferred to #281 (now integrated); its 6 named issues already closed |
| #287 | OBSOLETE | Target issue #236 already closed via a different PR (#237); ADR recovery never landed |
| #288 | OBSOLETE | #274/#275/#276 already closed 2026-10-09; real fix landed via owner's direct commit `88b27b13` |
| #291 | OBSOLETE | Patches a paragraph in ADR-0084 that no longer exists (doc restructured twice since) |
| #292 | INTEGRATED (different mechanism) | `brain-grade-groundtruth.mjs:90` sets `generatedAt` inline via commit `cea1f713`; this PR's extracted-helper approach never landed |
| #293 | DUPLICATE of #292 | Same hypothesis/file/conclusion, 7 minutes apart |
| #323 | OBSOLETE | Target file `project-progression-reader.mjs` no longer exists (zero grep hits for its exports) |
| #328 | INTEGRATED | Same fix as #280 (`kb/forge-currency.mjs`), same commits |
| #345 | INTEGRATED, then OBSOLETE | Fix landed via `d36bc40a`; whole file then deleted by `4975f73a` (ADR-106 refactor) |
| #348 | INTEGRATED (via later rewrite) | `resolveTurnDb()` now calls `resolveProjectStore()`, which independently closes the same symlink-escape gap |
| #366 | INTEGRATED | `lesson-presentation.mjs:62` fixed via direct commit `c8274876`, 3 days after this PR opened |
| #459 | DUPLICATE of #396 | Byte-identical diff; #396 kept open as the canonical PR (fuller evidence trail), still genuinely unfixed |

## Results: 21 of 35 confirmed STILL-LIVE (left open, no action needed beyond this confirmation)

#270, #289, #294, #295, #297 (partially — the `provenance` line specifically, sibling `routed` metric
already fixed elsewhere), #304, #305, #312, #313, #317, #322, #324, #325, #333, #347, #359, #367,
#396 (the canonical hook-conformance fix — recommend landing this one specifically; small, additive,
independently re-verified clean multiple times), #465, #480, #484.

All 21 were verified by reading the exact current-`main` line the PR claims is still broken — not
inferred from the PR's own age or title.

## Net effect on the backlog

Before tonight: `head:dream is:open` = 74 (all-time 116, merged 5, last merge 2026-08-31 — 55 days).
After tonight's 14 closures: `head:dream is:open` = 60 (see verification below). This is the first
reduction in the open-PR count since tracking began in issue #410 (2026-10-06) — every prior
reconciliation night's count only went up.

**Not claimed:** that the 21 confirmed-live PRs are all worth merging as-is, or that the remaining
~39 untriaged PRs follow the same ~40%-closeable ratio. This was a 35-PR sample (the oldest half of
the backlog), not a full audit. A second pass over the remaining ~39 would likely find a similar mix,
but that's a projection, not a measurement — flagged as the natural next step, not performed tonight
(budget).

## Evaluated / Verdict

`evaluated: not applicable` — this is a process/reconciliation finding, not a code candidate; no
promotion gate applies. **Verdict: ACCEPT** (as a process finding: real, verified, bounded reduction
in the backlog, with full evidence per closed PR, zero speculative closures, zero PRs closed on title
alone).

## Security review

No code changed. All actions were GitHub-visible, reversible (closed PRs can be reopened by the
owner), and each carries a comment citing specific evidence (file:line, commit SHA, or the exact
duplicate PR number) rather than an unexplained bulk closure.

## Merge policy

Human review required for this report/ledger PR, as always. The PR closures themselves are tonight's
substantive work and already took effect directly on GitHub (closing a PR is not a merge and does not
promote any code); this PR exists only to carry the durable record into `docs/dream-cycle/`.
