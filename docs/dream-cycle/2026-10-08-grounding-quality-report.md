# Grounding-Quality Reconciliation SOTA Report — 2026-10-08

**Dream Cycle 2026-10-08 — DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5, `20261008 % 5 == 3`). No bonus deep dive (`%25`=8, `%75`=58).**

## TL;DR

No new candidate opened tonight. Every readily-reachable grounding-quality defect this
session could identify already has an existing, independently-critiqued-CLEAR, open fix PR
sitting unreviewed: `#340` (rank-#1 citation forcing, clean), `#297` (provenance stratum
receipt credit, now conflicted), `#372` (fast-lane citation path, now conflicted). Opening a
fourth would duplicate work already done and add to the exact backlog this surface has
flagged every night since 2026-08-26. Tonight's bounded work is reconciliation: re-verify
those three against today's `main` tip, confirm no regression, and report the backlog's
current, freshly-measured size — which has grown, not shrunk, and crossed from "unreviewed"
into "rotting" (two of the three candidates now have real merge conflicts from age alone).

## Read this first — the backlog, freshly counted tonight

- **48 open `dream/*` PRs, 89 opened total, 0 merged — ever** (GitHub MCP `search_pull_requests`,
  `head:dream`, counted fresh tonight, not reused from a prior night's number).
- **3 open `dream-cycle`-labeled issues**, including **`#410`** (filed 2026-10-06, title: "the
  ledger itself has gone stale — 5+ weeks, 60+ unreviewed draft PRs, zero merges since #178").
  `#410` itself has exactly one comment, an automated acknowledgment bot reply
  (`🤖 Automated acknowledgment — received and opened...`) posted under the owner's account at
  the moment the issue was filed (2026-10-06T09:39Z) — no human engagement since, 2 days later.
- The PR that was supposed to catch up `docs/dream-cycle/LEDGER.md` on `main` — **`#411`**
  (2026-10-06, "ledger reconciliation, close 3 already-fixed issues, file #410") — is *itself*
  still open and unmerged. This local checkout's `LEDGER.md` on `main` therefore still ends at
  `2026-08-31`, even though real work (including three issue closures and `#410`'s filing) has
  continued past it. Tonight's row is appended on top of that same stale base, same as every
  other open dream-cycle PR branch currently does — fixing that structurally is outside one
  night's bounded authority (see `#410`'s own "Suggested next step," which names this as a human
  triage task, not an automated one).
- This is the **sixth** consecutive grounding-quality night naming this same, worsening backlog
  (2026-08-26, 08-28 ×2, 09-18, 09-23, 09-28, 10-01, 10-03 ×2, now 10-08) with zero process change
  in between.

## Reconciliation — three existing candidates re-verified against today's `main` (`9cf8fe1`)

| PR | Finding | Opened | `mergeable_state` tonight | Notes |
|---|---|---|---|---|
| `#340` | `forge-ask-all.mjs` forces a synthetic, unverifiable card citation to rank #1 ahead of real evidence | 2026-09-28 (10 days) | **clean** | Base SHA in the PR's own metadata (`9cf8fe1...`) is *exactly* tonight's `main` tip — zero drift. Independently critiqued CLEAR on 09-28, re-verified clean by this surface's own 10-03 reconciliation night too. Still the single best, lowest-risk thing in this backlog to merge. |
| `#297` | `eval-brain.mjs`'s `provenance` stratum reads raw `citations[0].repo` instead of the already-computed `receipt.repo`, the same class of bug `routed` was fixed for (`#187`/`#188`, merged into `routed` on `main` already — confirmed: `scripts/eval-brain.mjs:85` already reads `receipt?.repo ?? top?.repo`) | 2026-09-18 (20 days) | **dirty** | Recovers an even older closed PR (`#239`, 2026-09-03, lost in a 2026-09-07 bulk-close). Independently critiqued CLEAR on 09-18. 20 days of unrelated `main` churn (16 point releases, 4.5.2→4.5.17) have produced a real conflict — not attempted to resolve tonight: a 20-day-stale 3-way merge across a shallow clone is exactly the kind of risky, history-rewriting operation this session should not improvise mid-cycle, and it is someone else's job to decide whether `#297` still reflects what they want merged first. |
| `#372` | `kb/card-lane.mjs`'s fast-lane citation path (`renderCardHit()`) prints a citation header that can never resolve under the real `concepts`-store convention | 2026-10-03 (5 days) | **dirty** | `git diff --stat origin/main origin/dream/2026-10-03-grounding-quality` shows 468 files touched purely from `main` drift (5 days, several point releases) — same reasoning as `#297`: not safe to improvise a rebase of someone else's unmerged candidate across that much unrelated churn inside one bounded night. |

Confirmed by direct source read, not assumed: `scripts/eval-brain.mjs`'s `routed` computation
(line 85) already uses `receipt?.repo ?? top?.repo ?? null` on current `main` — the `#187`/`#188`
fix is integrated. The sibling `provenance` case (line 95) still reads `top?.repo` directly —
`#297`'s finding is still live and unresolved on `main`, exactly as it was on 09-18.

`kb/self-retrieval-bench.mjs` (ADR-0025 Open Item #3): still not wired into any nightly/CI gate
(confirmed again tonight — `grep` for its invocation in `package.json`/`.github/workflows/*.yml`
found none beyond the manual CLI). Unactionable from this container regardless: `stores 0 dark 0`,
no corpus ever materialized here. Re-flagged, not re-litigated.

## Testability gate

No new hypothesis was frozen tonight — there is no new candidate to gate. The reconciliation
work above (checking `mergeable_state`, diffing branches, re-reading `scripts/eval-brain.mjs`
against each PR's described fix) is itself the night's falsifiable check: "are `#340`/`#297`/`#372`
still valid, unduplicated, and (for `#340`) still trivially mergeable" — answered directly from
GitHub's own computed state and source reads, not inferred.

## Evaluation Receipt

- `npm run eval:gate`: `EVALUATED=blocked` — `eval-brain: no brain at /root/.cache/ruvnet-brain/kb`
  (this container has never materialized a corpus; confirmed independently via
  `node scripts/restore-local-ingests.mjs` and `node -e "...store-root.mjs..."`, both `stores 0
  dark 0`). Not a credentials block — but there is no credential either tonight:
  `OPENROUTER_API_KEY` is **absent** from this container's environment (checked directly), so
  `LLM_EVAL=blocked` too, for an independent reason. Both blockers pre-exist this session.
- `npm run claims:verify`: `3 PASS / 4 SKIP` — identical composition to every prior documented
  night (`baseline`, `held-out`, `version` PASS; `cost-factor`, `coverage`, `chunk-count`,
  `LEARNING-REPLAY` SKIP, all for the same pre-existing "brain not installed in this container"
  reason).
- `npm ci`: clean, no wasm/NAPI degradation recorded tonight.
- Control-plane probes: `brain-score.mjs` reports all 4 quality dimensions STALE (28.5d old,
  budget 14d) and both coverage dimensions UNMEASURED (store root never materialized) —
  unchanged in kind from every prior night's probe; `restore-local-ingests.mjs` lists only
  previously-recorded ingests, read-only, no wipe signal.

## Darwin Lineage

Not run. No candidate diff exists tonight to evolve, and bounded Darwin only runs after a basic
evaluation clears on a real candidate.

## Evidence

- OBSERVATION: `#340`'s PR metadata reports `mergeable_state: clean` with a base SHA identical to
  tonight's `main` tip — independently reproduced by this session's own `git merge-base
  origin/main origin/dream/2026-09-28-grounding-quality`, which returns exactly `9cf8fe19a5...`
  (tonight's `main` HEAD).
- OBSERVATION: `#297` and `#372` both report `mergeable_state: dirty`; `git diff --stat` against
  tonight's `main` shows large, drift-driven file counts (468 files for `#372`) consistent with
  having sat 5–20 days across repeated point releases, not a logical conflict in the fix itself.
- OBSERVATION: `scripts/eval-brain.mjs:85` (`routed`, fixed) vs `:95` (`provenance`, still
  `top?.repo`) — read directly from current `main` source, confirming `#297`'s diagnosis is still
  accurate and still unresolved.
- MEASUREMENT: `npm run claims:verify` → 3 PASS/4 SKIP, `npm run eval:gate` → blocked with the
  exact pre-existing message, both reproduced directly tonight, not inferred from a log.
- OBSERVATION: GitHub MCP `search_pull_requests repo:stuinfla/ruvnet-brain head:dream` →
  `total_count: 89`; `... head:dream is:open` → `total_count: 48`; a prior `is:merged
  label:dream-cycle` search → `total_count: 0`. Counted fresh this session, not carried over from
  `#410`'s 2-day-old numbers (which were already smaller: 60–62 open at the time).
- INFERENCE: the backlog is not merely stagnant but actively decaying — the longer a correct,
  already-critiqued fix sits, the more likely ordinary unrelated `main` churn turns it into a
  conflict that then requires strictly more human (or careful automated) effort to land than it
  would have taken on the night it was written.

## Reward-Hack Check

N/A — no candidate code was written or evaluated tonight. Nothing to game.

## Security Review

No new attack surface. Tonight's actions were read-only against source and GitHub (`git fetch`,
`git merge-base`, `git diff --stat`, `pull_request_read`, `search_pull_requests`, `search_issues`,
`issue_read`) plus this report and ledger addition. No credentials, CI configuration, or
permissions touched.

## Scan findings (SCAN=retrieval-precision, citation-binding)

1. **citation-binding**: no new finding; `#297` and `#372` already cover the two live defects this
   session could identify, both still present on `main`, both already fixed on their respective
   branches, both now blocked on human review rather than on further diagnosis.
2. **retrieval-precision**: `kb/self-retrieval-bench.mjs` (ADR-0025 Open Item #3) remains unwired
   into any gate, unchanged from every prior night's note; structurally unactionable from a
   container that has never materialized a corpus.

## Competitors (grade C — general knowledge, not independently re-verified tonight; informs framing only)

| System | Relevant practice | Comparison to tonight's situation |
|---|---|---|
| Sakana AI Scientist | Produces a paper/PR per idea; review loop is the published system's own weak point in public write-ups | Same failure mode this repo is now living: idea generation outpacing review throughput |
| OpenHands | Background-agent PRs queue for human merge; project docs recommend capping concurrent open agent PRs | This repo has no such cap — 48 open simultaneously |
| DSPy/GEPA | Optimization loops are typically run against a local metric with a human merge gate at the end, not continuously against a shared PR queue | Not directly comparable; mentioned per `dream.config.json`'s competitor list |
| SWE-agent | Single-PR-at-a-time workflows per task, by design, to keep review tractable | The opposite of a 48-deep, 89-total backlog |
| Cursor background agents | Documented guidance explicitly warns against unreviewed agent-PR accumulation | Direct precedent for tonight's recommendation: review throughput, not generation throughput, is the bottleneck |

## ADR

None. No architectural decision made tonight — reconciliation and a backlog measurement are not
ADR-worthy.

## Gist

LOCAL — no `gh` CLI (`GH_TOKEN`/`GITHUB_TOKEN` both report "invalid" to `gh auth status`) and no
gist-creation MCP tool available in this session, consistent with every prior Dream Cycle night's
recorded limitation. This report is the full, committed equivalent.

## Issue

`NONE`. Per the `ISSUE DISPOSITION OVERRIDE`: no new, reproduced, actionable, unresolved defect
was found tonight. `#410` already tracks the structural backlog problem this report reconfirms
and re-measures; filing a second issue for the same condition would be an exact duplicate,
explicitly barred by `dream.config.json`'s `findingPolicy.skipIf: ["duplicate-open-issue", ...]`.

## Witness

```
SESSION_COMMIT = 9cf8fe19a57671eb430ce7341b7b8bf123ccce75
REPORT_HASH    = ba50d44ccaed817c5e4cd9815c218c64865e985450ea80e1af98d25e19a851c9
WITNESS        = 116d4c1076d60868b111377b571976d1adc7e057e80c0ac8944e5d1ac6cbc612
```

**Verifier procedure:**
1. `git checkout 9cf8fe19a57671eb430ce7341b7b8bf123ccce75` (tonight's base commit on `main`).
2. Take this committed report, keep only its content from the start through the line immediately
   before this "## Witness" heading, `sha256sum` that, and confirm it matches `REPORT_HASH` above.
3. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` and confirm it matches `WITNESS` above.
4. Re-run tonight's checks: `npm run claims:verify` (expect `3 PASS / 4 SKIP`), `npm run eval:gate`
   (expect the `no brain at /root/.cache/ruvnet-brain/kb` block), and `git merge-base origin/main
   origin/dream/2026-09-28-grounding-quality` (expect it to equal `SESSION_COMMIT` above, proving
   `#340` was still trivially current as of tonight).
5. Re-run the GitHub counts: `search_pull_requests` for `repo:stuinfla/ruvnet-brain head:dream`
   and `head:dream is:open`, and confirm the totals have not *improved* since tonight without a
   corresponding merge having happened.

## Recommendation (for the repo owner, priority order)

1. **The backlog is the finding.** 48 open drafts, 89 opened total, 0 merged, ever. Issue `#410`
   named this 2 days ago and got only an automated bot acknowledgment — no triage has started yet.
   The suggested mechanical audit in `#410` (check each open PR/issue against current `main`,
   close what's already landed, merge or reject the rest) is still the single highest-leverage
   action available, and it is explicitly a human (or a differently-scoped session) task, not
   something a nightly 26-step research cycle should attempt unilaterally.
2. **Merge `#340` first.** It is clean against `main` right now, zero conflict, independently
   critiqued CLEAR twice (09-28 and again via 10-03's reconciliation). It is the cheapest possible
   proof that this pipeline's output can reach `main` at all.
3. **Decide on `#297` and `#372` before they decay further.** Both are correct, both are now
   conflicted from age alone, and every day of delay makes the eventual rebase more expensive, not
   less — exactly the dynamic this report's Evidence section measured directly.
4. **Also merge or close `#411`** (the 2026-10-06 ledger catch-up PR) so `docs/dream-cycle/LEDGER.md`
   on `main` stops understating how much has actually happened.

## Merge Policy

No code to merge — this is a documentation-only reconciliation PR (this report + one ledger row).
**Human review still required** for the PR this report ships in, per `autoMerge: false`
(`dream.config.json`, ADR-0068) — the decision, not a default. This session never self-merges and
never autonomously promotes candidate state.
