# Dream Cycle 2026-10-03 — grounding-quality SOTA / reconciliation report

TL;DR: no new finding. The backlog, not a new defect, is tonight's dominant
signal: **39 open `dream/*` PRs, 5 open `dream-cycle` issues, zero merged
since #214/#215 (2026-08-31) — 33 days and counting, the longest zero-merge
stretch in this ledger's history.** Tonight's grounding-quality slot already
has a clean, open, independently-reproducible candidate sitting in that pile:
PR #340 ("stop forcing an unverifiable citation to rank #1"), opened
2026-09-28. This session re-verified it fresh against tonight's `main`
(`3ddeb1f`) rather than trusting its own 5-day-old claim, found it still
exactly reproduces, and declined to open a duplicate/competing PR — per
`dream.config.json`'s `findingPolicy.skipIf: ["existing-fix-pr", ...]` and
the standing lesson from nights 2026-09-23/2026-09-30 (`#321`, `#358`): the
system is not short on findings for this surface, it is short on review
bandwidth, and manufacturing a second fix for an already-fixed defect would
make that worse, not better.

## Rotation

`DATE=2026-10-03`, `DAYINT=20261003`, `SLOT = DAYINT % 5 = 3` →
`DEEP=grounding-quality`, `SCAN=retrieval-precision,citation-binding`.
`DAYINT % 25 = 3`, `DAYINT % 75 = 53` — no bonus deep dive. `SESSION_COMMIT =
3ddeb1fde8559031853ff21c1ee485ba28178a91`.

## Ledger check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` has not gained a row since 2026-08-31
— not because nights stopped running (36 open `dream-cycle` issues and 39
open `dream/*` PRs since then prove otherwise), but because this repo's own
convention ships the ledger row **inside** the candidate PR, and candidate
PRs have stopped merging. The durable record is live on GitHub, not on
`main`; re-checked via the GitHub MCP tools tonight, not assumed:

- Last merged `dream/*` PR: **#215** (`fix(source-coverage)`, 2026-08-31).
- Open `dream/*` PRs: **39** (oldest: #163's lineage descendants from
  2026-09-08 reconciliation #269 onward; newest: #367, 2026-10-02).
- Open `dream-cycle` issues: **5** (#298, #274, #264, #260, #258).
- Grounding-quality specifically: PR #340 (2026-09-28, open, draft,
  `mergeable_state: clean` against tonight's `main`) is the live outstanding
  work. Earlier grounding-quality nights (#163/2026-08-23, merged into main
  by direct commit per the ledger's 2026-08-26 row's sibling pattern; #297
  recovering #239; #269 finding #161/#163 already integrated) are resolved
  or superseded — reconciled, not reopened, per
  `ISSUE DISPOSITION OVERRIDE`'s "never reopen resolved work solely because
  its historical ledger row names a finding."

## Learning signals (STEP 1.1)

- **Zero of the last several weeks' candidate PRs merged** → bias to a tiny,
  one-parameter, easily-reviewable candidate. Already satisfied: #340 is a
  2-site `unshift`→`push` change, +68/-4 net in its own diff stat, already
  independently critiqued CLEAR by a separate subagent on 2026-09-28. Adding
  a second small candidate would not make review easier; it would add a
  40th PR to the queue.
- **Long `LLM_EVAL=blocked` streak** → confirmed again tonight (see below);
  no model-call candidate was considered.
- No finding has repeated in ≥3 consecutive grounding-quality nights (the
  rotation visits this surface roughly every 5th night; the last three
  grounding-quality nights were 2026-09-08 reconciliation, 2026-09-18
  recovery, 2026-09-28 new-and-small) — no forced slot rotation triggered.

## Accumulated evidence (STEP 2)

Reviewed `docs/dream-cycle/` grounding-quality history end to end: #161/#163
(2026-08-23, ungrounded primers), #185/#186 (2026-08-28, citation-block
spoofing in `parseCitations()`), #187 (2026-08-28 concurrent night, routed-
credit receipt threading), #239/#297 (provenance/receipt recovery), #340
(2026-09-28, rank-#1 unverifiable-citation fix). PR #340's own Security
Review section flags a related, still-open gap tracked separately as
ADR-0087/#236 ("rank-hijack") — out of scope for tonight, not re-litigated.

## Independent re-verification of PR #340 (tonight's actual measurement)

Did not trust the PR's 5-day-old claim; reproduced it fresh in two isolated
git worktrees against tonight's exact `main` tip.

1. **Baseline (main, `3ddeb1f`, unmodified source) + candidate's own new
   test** (`tests/unit/forge-ask-all.test.mjs`, copied in, source
   untouched): **RED**, byte-identical to the PR's original claim —
   `AssertionError: expected 'capability-cards.md#method-engine2' not to
   match /^capability-cards\.md#/` (162 passed / 1 failed / 163 total).
2. **Candidate** (`git fetch origin dream/2026-09-28-grounding-quality`,
   worktree at `407352f`, `npm ci`, same test file): **GREEN** — 163/163
   passed.
3. Confirmed `kb/forge-ask-all.mjs`'s two `capability-cards.md#${cardRepo}`
   `candidates.unshift(...)` call sites (`sourceBackedCardLane()`, the
   `specificationToCompletionMethodQuestion()`/`pythonFreeRustNeuralQuestion()`
   branch and the concept-inventory/`stableCoreSwarmTopology` branch) are
   unchanged on `main` and are exactly the two sites the candidate patches
   — read directly, not inferred from the PR description. The third
   `unshift` in the same function (`packageIdentityCandidate`, line ~2204)
   is a different, resolvable citation path and is correctly untouched by
   the candidate.

`eval:gate`: **blocked** — `eval-brain: no brain at
/root/.cache/ruvnet-brain/kb — run: npx ruvnet-brain`. Not a credentials
block: `OPENROUTER_API_KEY` is present in this container; the store root
itself never materializes here (`node -e ".../store-root.mjs" → stores 0
dark 0`), the same condition every grounding-quality night back to
2026-08-28 has recorded. `claims:verify` and `test:integration` were not
re-run wholesale tonight (no source change to validate beyond the two
isolated worktree runs above) — narrower than a full candidate night,
intentionally, per STEP 0.6's budget discipline for a reconciliation night.

## Hypothesis

Not reframed. PR #340's frozen hypothesis stands unchanged: forcing the
synthetic capability-card candidate to rank #1 via `unshift` makes
`kb/verify-citation.mjs`'s `citationResolves()` permanently unable to verify
the rank-#1 citation, because `capability-cards.md#<repo>` is never written
into any repo's own passages store. Tonight's run is a repeat measurement of
the same hypothesis, not a new one.

## Evidence

OBSERVATION (same unverifiable-path shape, re-read from source tonight) →
MEASUREMENT (RED on tonight's `main` + candidate's test, reproduced
independently of the PR's own claim; GREEN on the candidate branch,
163/163) → INFERENCE (the defect and its fix are both still exactly as
described 5 days ago; nothing in the intervening 5 days of `main` history
touched `kb/forge-ask-all.mjs`'s `sourceBackedCardLane()`) → DECISION (do
not duplicate; strengthen PR #340's evidence trail with tonight's
independent confirmation; spend tonight's slot on naming the backlog
instead).

## Reward-Hack Check

CLEAR — no benchmark, gold answer, or threshold was touched tonight; no
source was modified by this session.

## Security Review (STEP 15)

No new surface. Tonight's only actions were read-only verification
(two throwaway git worktrees, deleted after use) and this report/ledger
addition. No credentials, network calls beyond `git fetch` of the repo's own
branch, or filesystem writes outside `/tmp` worktrees and this repo's
`docs/dream-cycle/` and `docs/dream-cycle/LEDGER.md`.

## Darwin Lineage

Not run — no candidate to evolve tonight.

## Scan findings (retrieval-precision, citation-binding)

No new finding surfaced by a bounded look at `kb/verify-citation.mjs`'s
`citationResolves()`/`parseCitations()` and `kb/forge-ask-all.mjs`'s
remaining `unshift` call sites beyond the two PR #340 already patches. Did
not run a full external SOTA literature pass tonight (STEP 3) — judged a
lower-value use of the budget than independently re-verifying the one real,
already-found, still-unmerged defect on this exact surface, given the
backlog context above. Recorded here as a deliberate, explicit scope
reduction, not a silent skip.

## Recommendation

1. **For the human**: PR #340 is small (+68/-4, 5 files), independently
   re-verified CLEAR twice now (2026-09-28 by a critic subagent, 2026-10-03
   by this session from a cold worktree), and has sat open 5 days. It is a
   low-risk, high-confidence merge candidate. More importantly, the 39-PR /
   33-day backlog itself is now the single largest risk to this ADR-068
   system's own stated purpose — a nightly loop whose output nobody reviews
   is not "shrinking tomorrow's search space," it is growing a pile.
2. **For future nights**: this reconciliation is the fourth of its kind
   (#269, #321, #358, now this one) to name the same backlog without it
   shrinking. A fifth reconciliation night naming the same problem without
   a process change (triage sweep, raising `autoMerge` for a narrowly
   scoped class of trivial/CLEAR fixes, or pausing new-finding nights until
   the queue drains) would itself be worth flagging as the finding.

## Witness

See `docs/dream-cycle/LEDGER.md`'s 2026-10-03 row for the computed witness
stamp (`REPORT_HASH` = sha256 of this file, `WITNESS` =
sha256(`REPORT_HASH` + `SESSION_COMMIT`)).

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same
condition as every prior night since 2026-08-28).

## Issue

`NONE` — per `ISSUE DISPOSITION OVERRIDE`: no new, reproduced, actionable,
unresolved defect was found tonight. The one defect on this surface is
already reproduced, already fixed, and already has an open PR (#340);
opening a second issue or PR for it would be the exact duplicate-work this
override exists to prevent.

## Merge Policy

Human review required. `autoMerge: false` (ADR-068) — unchanged. This
session never self-merges and never autonomously promotes candidate state.
