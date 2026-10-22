# Grounding-Quality Reconciliation SOTA Report — 2026-10-13

**Dream Cycle 2026-10-13 — DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5, `20261013 % 5 == 3`). No bonus deep dive (`%25`=13, `%75`=63).**

## TL;DR

No new candidate opened tonight. The three live grounding-quality fixes this surface has
already found and independently critiqued CLEAR — `#340` (rank-#1 citation forcing), `#297`
(provenance stratum receipt credit), `#372` (fast-lane citation path) — all remain correctly
diagnosed and unintegrated on current `main` (verified by direct source read, not assumed).
Opening a fourth would duplicate already-done work and compound the exact backlog problem this
surface has flagged every active night since 2026-08-26, now acknowledged in writing by the repo
owner (issue `#410`, comment 2026-10-10: "the backlog is real... no blanket owner approval is
being requested"). Tonight's bounded work is reconciliation: re-verify all three against today's
`main` tip, confirm no regression, and report the backlog's current size — which has grown again,
and for the first time **all three** of this surface's own candidates report `mergeable_state`
other than clean (the one that was clean as of 2026-10-08, `#340`, has now also decayed to
`dirty`).

## Read this first — the backlog, freshly counted tonight

- **52 open `dream/*` PRs, 95 opened total, only 5 ever merged, 0 since `#178` (2026-08-26 —
  48 days)** (GitHub MCP `search_pull_requests`, `head:dream`, counted fresh tonight).
- **2 open `dream-cycle`-labeled issues**: `#410` (the backlog itself) and `#298` (an unrelated
  compile-sandbox denial). No grounding-quality-specific open issue exists — this surface's three
  findings have all used `Issue=NONE` per the `extraDisciplines` override, since each was a
  verified, bounded-repaired fix carried as a work record in its own PR, not an unresolved defect.
- **The repo owner has already seen and responded to the backlog** (issue `#410`, comment
  2026-10-10, posted under the owner account, human in tone and content): confirms the backlog is
  real, explicitly declines to grant "blanket owner approval," and directs that "deterministic
  reconciliation of each proposal against current source... belongs to engineering" — i.e. future
  nightly sessions, not a one-time manual sweep. Later nights (`#436` 2026-10-11, `#438` 2026-10-12)
  already restated fresh counts against that directive without attempting the full 52-PR audit
  themselves, consistent with each night scoping reconciliation to its own slot's surface rather
  than a cross-surface sweep that would itself be a large, unreviewed, authority-expanding action.
  Tonight follows that same precedent for `grounding-quality` specifically.
- This is the **ninth** consecutive grounding-quality-surface night (active or reconciliation)
  naming this same, worsening backlog: 2026-08-26, 08-28 ×2, 09-08, 09-18, 09-23, 09-28, 10-01,
  10-03 ×2, 10-08, now 10-13.

## Reconciliation — three existing candidates re-verified against today's `main` (`845d55b`)

| PR | Finding | Opened | `mergeable_state` tonight | Notes |
|---|---|---|---|---|
| `#340` | `kb/forge-ask-all.mjs`'s `sourceBackedCardLane()` forces a synthetic, unverifiable card citation to rank #1 (`candidates.unshift(...)`, lines 2281/2319 on current `main`) ahead of real evidence | 2026-09-28 (15 days) | **dirty** (was `clean` as of 2026-10-08 — this is new decay since the last check) | Confirmed live by direct source read tonight: both `unshift` call sites remain unchanged on `main`. Independently critiqued CLEAR on 09-28. This was the single cheapest, lowest-risk thing in the backlog to merge five days ago; it no longer is. |
| `#297` | `scripts/eval-brain.mjs`'s `provenance` stratum (line 95) reads raw `top?.repo` instead of the already-computed `receipt?.repo`/`routedRepo` — the same bug class `routed` (line 85) was already fixed for | 2026-09-18 (25 days) | **unknown** (GitHub has not recomputed a mergeability verdict recently; prior nights recorded `dirty`) | Confirmed live by direct source read tonight: line 85 (`routed`) already uses `routedRepo = receipt?.repo ?? top?.repo ?? null`; line 95 (`provenance`) still reads `top?.repo !== 'ruv-gists'` directly, unchanged. `#297`'s diagnosis is exactly as accurate as it was on 09-18. |
| `#372` | `kb/card-lane.mjs`'s `renderCardHit()` (line 759) prints a citation header (`path : ${hit.repo}/kb/${hit.path}`) that can never resolve under the real `concepts`-store convention | 2026-10-03 (10 days) | **dirty** | Confirmed live by direct source read tonight: line 759 is unchanged from the broken format `#372` already fixed on its branch. |

All three diagnoses were re-derived from this session's own read of current `main` source
(`scripts/eval-brain.mjs`, `kb/forge-ask-all.mjs`, `kb/card-lane.mjs`), not copied from a prior
night's report or from the PR bodies themselves.

## Testability gate

No new hypothesis was frozen tonight — there is no new candidate to gate. The reconciliation
check above ("are `#340`/`#297`/`#372` still correctly diagnosed, unintegrated, and
undanduplicated against tonight's `main`") is itself the falsifiable claim, answered directly
from source reads and GitHub's own computed PR state.

## Evaluation Receipt

- `npm run eval:gate`: `EVALUATED=blocked` — `eval-brain: no brain at /root/.cache/ruvnet-brain/kb`
  (this container has never materialized a corpus; confirmed independently via
  `node scripts/restore-local-ingests.mjs` — exit 2, 125 ingests correctly reported
  NEVER-MATERIALIZED, not WIPED — and `node -e "...store-root.mjs..."`, both `stores 0 dark 0`).
- `LLM_EVAL=blocked`: `OPENROUTER_API_KEY` absent from this container's environment (checked
  directly). A different, independent blocker from the corpus one above.
- `npm run claims:verify`: `3 PASS / 4 SKIP` — identical composition to every prior documented
  night (`baseline`, `held-out`, `version` PASS; `cost-factor`, `coverage`, `chunk-count`,
  `LEARNING-REPLAY` SKIP, all for the pre-existing "brain not installed in this container" or
  "artifact source not an ancestor of HEAD" reasons).
- `npm ci`: clean, no wasm/NAPI degradation recorded tonight.
- Control-plane probes: `brain-score.mjs` reports all 4 quality dimensions STALE (33.5d old,
  budget 14d) and both coverage dimensions UNMEASURED (store root never materialized) — unchanged
  in kind from every prior night's probe.

## Darwin Lineage

Not run. No candidate diff exists tonight to evolve, and bounded Darwin only runs after a basic
evaluation clears on a real candidate.

## Evidence

- OBSERVATION: `scripts/eval-brain.mjs:85` (`routed`, fixed, uses `receipt?.repo ?? top?.repo`)
  vs `:95` (`provenance`, still raw `top?.repo`) — read directly from current `main` source
  tonight, confirming `#297`'s diagnosis is still accurate and still unresolved.
- OBSERVATION: `kb/forge-ask-all.mjs:2281,2319` still `candidates.unshift(...)` — `#340`'s
  diagnosis still accurate and unresolved.
- OBSERVATION: `kb/card-lane.mjs:759` still prints the old, unresolvable path template —
  `#372`'s diagnosis still accurate and unresolved.
- OBSERVATION: `#340`'s GitHub-reported `mergeable_state` flipped from `clean` (as recorded in
  the 2026-10-08 reconciliation report) to `dirty` tonight — new decay in the five days since,
  from ordinary unrelated `main` churn, not a logical conflict in the fix itself.
- MEASUREMENT: `npm run claims:verify` → 3 PASS/4 SKIP, `npm run eval:gate` → blocked with the
  exact pre-existing message, both reproduced directly tonight.
- OBSERVATION: GitHub MCP `search_pull_requests repo:stuinfla/ruvnet-brain head:dream` →
  `total_count: 95`; `... is:open` → `52`; `... is:merged` → `5` total, all before 2026-08-31.
  `search_issues label:dream-cycle is:open` → `2` (`#410`, `#298`). Counted fresh this session.
- INFERENCE: the backlog is not merely stagnant but actively decaying, and the decay is now
  visible even in the single candidate (`#340`) that was trivially mergeable five days ago — every
  day a correct, already-critiqued fix sits costs strictly more to land than it would have the
  day it was opened.

## Reward-Hack Check

N/A — no candidate code was written or evaluated tonight. Nothing to game.

## Security Review

No new attack surface. Tonight's actions were read-only against source and GitHub (`git fetch`,
`pull_request_read`, `search_pull_requests`, `search_issues`, `issue_read`) plus this report and
ledger addition. No credentials, CI configuration, or permissions touched.

## Scan findings (SCAN=retrieval-precision, citation-binding)

1. **citation-binding**: no new finding; `#297`, `#340`, `#372` already cover every live defect
   this session could identify in `kb/verify-citation.mjs`'s callers, all still present on `main`,
   all already fixed on their respective branches, all now blocked on human review rather than on
   further diagnosis. A fresh read of `kb/verify-citation.mjs` itself (the resolver `#236`/
   ADR-0102 already hardened) found no new gap: `parseCitations()`'s length-bounded body
   consumption, strict rank sequencing, and `samePath()`'s `#`-delimited chunk-suffix match all
   hold as designed.
2. **retrieval-precision**: `kb/self-retrieval-bench.mjs` (ADR-0025 Open Item #3) remains unwired
   into any gate, unchanged from every prior night's note; structurally unactionable from a
   container that has never materialized a corpus.

## Competitors (grade C — general knowledge, not independently re-verified tonight; informs framing only)

| System | Relevant practice | Comparison to tonight's situation |
|---|---|---|
| Sakana AI Scientist | Produces a paper/PR per idea; review loop is a published weak point | Same failure mode this repo is now living: idea generation outpacing review throughput |
| OpenHands | Background-agent PRs queue for human merge; docs recommend capping concurrent open agent PRs | This repo has no such cap — 52 open simultaneously |
| DSPy/GEPA | Optimization loops typically end at a human merge gate, not a continuously-growing shared queue | Not directly comparable; mentioned per `dream.config.json`'s competitor list |
| SWE-agent | Single-PR-at-a-time workflows, by design, to keep review tractable | The opposite of a 52-deep, 95-total backlog |
| Cursor background agents | Documented guidance warns against unreviewed agent-PR accumulation | Direct precedent for tonight's recommendation: review throughput, not generation throughput, is the bottleneck |

## ADR

None. No architectural decision made tonight — reconciliation and a backlog measurement are not
ADR-worthy, and no governed file was touched (docs-only: this report + one ledger row).

## Gist

LOCAL — `gh auth status` reports the token in `GH_TOKEN` as invalid in this container; no
gist-creation MCP tool is available either, consistent with every prior Dream Cycle night's
recorded limitation. This report is the full, committed equivalent.

## Issue

`NONE`. Per the `ISSUE DISPOSITION OVERRIDE`: no new, reproduced, actionable, unresolved defect
was found tonight. `#410` already tracks the structural backlog problem this report reconfirms
and re-measures; filing a second issue for the same condition would be an exact duplicate,
explicitly barred by `dream.config.json`'s `findingPolicy.skipIf: ["duplicate-open-issue", ...]`.

## Witness

```
SESSION_COMMIT = 845d55bdb78b4326033e1b6ed880aec60bbca462
REPORT_HASH    = f0970ebac01589e5435f0a1e3b7c7829d7c76567ec9a50edb6b8b40af94a2929
WITNESS        = a74781079a772c12c4f6dfbe046ba36d4567919df2f3de13c0c90baaf6a59fb6
```

**Verifier procedure:**
1. `git checkout 845d55bdb78b4326033e1b6ed880aec60bbca462` (tonight's base commit on `main`).
2. Take this committed report, keep only its content from the start through the line immediately
   before this "## Witness" heading, `sha256sum` that, and confirm it matches `REPORT_HASH` above.
3. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` and confirm it matches `WITNESS` above.
4. Re-run tonight's checks: `npm run claims:verify` (expect `3 PASS / 4 SKIP`), `npm run eval:gate`
   (expect the `no brain at /root/.cache/ruvnet-brain/kb` block).
5. Re-run the GitHub counts: `search_pull_requests` for `repo:stuinfla/ruvnet-brain head:dream`
   and `head:dream is:open`, and confirm the totals have not *improved* since tonight without a
   corresponding merge having happened.

## Recommendation (for the repo owner, priority order)

1. **The backlog is still the finding, and it is now decaying even where it wasn't before.**
   52 open drafts, 95 opened total, 5 merged ever (none since 2026-08-26). `#340` — the one
   candidate that was still trivially clean against `main` as of five days ago — has now also
   drifted to `dirty`. The mechanical audit `#410` already describes (check each open PR/issue
   against current `main`, close what's already landed, merge or reject the rest) remains the
   single highest-leverage action available, and per the owner's own 2026-10-10 comment it is
   understood as engineering work rather than something needing fresh approval — the gap is
   someone actually running it, not permission to run it.
2. **Merge `#340` before it decays further.** It was zero-conflict five days ago; every day now
   makes the eventual rebase costlier, not cheaper.
3. **Decide on `#297` and `#372`.** Both remain correct and independently critiqued CLEAR; both
   are now stale enough to need a rebase before they can land cleanly.

## Merge Policy

No code to merge — this is a documentation-only reconciliation PR (this report + one ledger row).
**Human review still required** for the PR this report ships in, per `autoMerge: false`
(`dream.config.json`, ADR-0068) — the decision, not a default. This session never self-merges and
never autonomously promotes candidate state.
