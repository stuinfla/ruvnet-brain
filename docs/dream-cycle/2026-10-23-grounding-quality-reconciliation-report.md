# Dream Cycle 2026-10-23 — grounding-quality (reconciliation, no new candidate)

**Rotation**: slot 3 of 5 (`20261023 % 5 == 3`) → DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding`.
No bonus deep dive tonight (`%25`=23, `%75`=73).
Session commit: `ea4d778f3663308e621f6ba88666ed653ff32e02` on `main`.
Build: `npm ci` clean. `npx -y dream-machine@0.1.1 compile dream.config.json` succeeded (15029 bytes) — contrast
with a separate, concurrent firing tonight (PR #486) whose own compile was denied by the sandbox classifier
(recurrence of #298); this session's compile worked, so this session proceeded past STEP 0.

## Ledger check

`docs/dream-cycle/LEDGER.md` on `main` still ends 2026-08-31 — not because the routine stopped (it has fired
every night since) but because `dream/*` candidate PRs essentially never merge. Fresh counts tonight, via
GitHub MCP, not assumed:

- `head:dream` all-time: **114** opened.
- `head:dream is:open`: **70** (69 at the moment of counting plus tonight's own concurrent #486; was 68 on
  2026-10-22, 66 on 2026-10-21, 60 on 2026-10-17).
- `head:dream is:merged`: **5** total, ever (#143, #148, #150, #178, #215). Last merge **2026-08-31 — 53 days
  ago**, extending the longest zero-merge stretch this ledger has recorded.
- `label:dream-cycle is:open` issues: **2** — #410 (the backlog itself, opened 2026-10-06, 10 prior automated
  reconciliation comments, no recorded human merge/close action since) and #298 (the compile-sandbox-denial
  recurrence, tonight's concurrent PR #486 is its 6th occurrence).

This is the eleventh consecutive night (across multiple surfaces) to re-confirm the same structural fact: the
backlog, not any individual finding, is the dominant thing for the owner to act on.

## This surface's standing findings — re-verified from source tonight, not trusted from history

Three grounding-quality defects have been independently re-diagnosed and re-confirmed live on every
`grounding-quality` rotation since 2026-09-18/2026-09-28/2026-10-03. Re-verified again tonight by direct
source read against current `main`@`ea4d778`, not inferred from the originating PRs' own descriptions:

1. **`scripts/eval-brain.mjs`'s `provenance` stratum (PR #297, 2026-09-18)** — `gradeQuestion()`'s `provenance`
   case still reads the raw top-ranked citation directly:
   ```js
   case 'provenance':
     return { grounded, routed: null, abstained, pass: !!grounded && !abstained && (top?.repo !== 'ruv-gists' || bannerPresent) };
   ```
   while the sibling `routed` computation two lines above already prefers the verified receipt:
   `const routedRepo = receipt?.repo ?? top?.repo ?? null;`. The `provenance` case was never migrated to use
   `routedRepo`, so it can still be fooled by an unverified top-ranked citation the same way `routed` used to
   be before that fix landed. **Still live**, confirmed at `scripts/eval-brain.mjs` lines ~90–99 tonight.

2. **`kb/forge-ask-all.mjs`'s capability-card rank-forcing (PR #340, 2026-10-01)** — two `candidates.unshift({…
   path: \`capability-cards.md#${cardRepo}\` …})` call sites (lines ~2281 and ~2319 tonight, same as every
   prior reconciliation) still force a synthetic capability-card citation to rank #1 regardless of whether it
   is the best-grounded hit for the query. **Still live**, confirmed by direct grep and read tonight.

3. **`kb/card-lane.mjs`'s `renderCardHit()` fast-lane citation (PR #372, 2026-10-03)** — still prints:
   ```js
   `#1  repo=${line(hit.repo)}  evidence=curated-capability-card\n`
   + `path : ${line(hit.repo)}/kb/${line(hit.path)}\n`
   ```
   which `kb/verify-citation.mjs`'s `citationResolves()` can never resolve, because the real on-disk location
   for a capability card is `concepts/<repo>/CARD/<repo>-card` (`scripts/corpus-aggregates.mjs`'s
   `add(repository, 'CARD', …)`), not `<repo>/kb/<path>`. **Still live**, confirmed at lines 750–766 tonight,
   byte-for-byte the same shape PR #372 diagnosed three weeks ago.

All three already have open, independently-critiqued, TEETH-tested, unmerged fix PRs (#297, #340, #372).
Per `dream.config.json`'s `findingPolicy.skipIf: ["existing-fix-pr", "duplicate-open-issue"]` and the repo's
own `extraDisciplines` ISSUE DISPOSITION OVERRIDE, opening a fourth/fifth/sixth PR reimplementing an
already-done fix would add no new evidence — it would only add a 71st unreviewed draft to a queue whose own
single highest-leverage fix, repeated by name in nearly every recent night's recommendation section, is
*fewer* unreviewed drafts, not more.

## No new candidate tonight

Checked one additional `unshift` call site in `kb/forge-ask-all.mjs` (line ~708, the `benchmark` keyword
guard) to rule out a fourth instance of #340's pattern — it is a plain keyword-ranking nudge with no synthetic,
unverifiable citation attached, not a duplicate of #340's shape. No other new retrieval-precision or
citation-binding defect was found in the time budgeted for this reconciliation pass.

## Evaluation receipt

- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (store root never
  materialized on this host, `stores 0 dark 0` per `kb/store-root.mjs`; `restore-local-ingests.mjs` confirms
  125 recorded ingests NEVER-MATERIALIZED, explicitly "NOT evidence of a wipe" on a fresh container).
  `LLM_EVAL=blocked` too — no `OPENROUTER_API_KEY`/model-provider key in this container.
- `npm run claims:verify`: 3 PASS (`baseline`, `held-out`, `version`) / 4 SKIP (brain-not-installed/coverage/
  learning-replay — same standard composition as every prior night).
- `node scripts/doc-currency.mjs --check`: exit 0. Pre-existing repo-wide ADR drift unchanged by this diff
  (this PR touches only `docs/dream-cycle/` files, none of which are ADR-governed paths).
- `node scripts/sync-version.mjs --check`: all surfaces agree on `4.7.17`.
- No production code changed tonight, so `test:integration`/`test:unit` were not re-run in full; the three
  standing findings above were re-verified by direct source read instead (see quoted snippets).

## Baseline

Unmodified `main`@`ea4d778f3663308e621f6ba88666ed653ff32e02` (this session's own start point) — all source
reads above are against this exact commit.

## Darwin lineage

Not run — no code candidate tonight to evolve.

## Evidence

OBSERVATION (three independently-diagnosed grounding-quality defects, each with an existing open fix PR) →
MEASUREMENT (direct source read against tonight's actual `main`, not trusted from the originating PRs'
descriptions — all three reproduce identically) → INFERENCE (a fourth/fifth/sixth PR would duplicate
already-done work and add to, not reduce, the backlog that dominates every recent night's recommendation) →
DECISION (reconciliation work record; no new PR beyond this docs-only report+ledger row; no new issue).

## Reward-hack check

N/A — no candidate code was written or evaluated tonight.

## Security review

No new attack surface. This session only read source files, queried GitHub via the MCP server, and wrote this
report, the ledger row, and one comment on #410.

## Scan findings

- **retrieval-precision**: the capability-card rank-forcing in `kb/forge-ask-all.mjs` (#340) is a retrieval-
  precision defect — it can place a synthetic, non-retrieved citation ahead of the actual best-grounded hit.
  Still live, no change since 2026-10-01.
- **citation-binding**: both the fast-lane path-printing defect (#372) and the `provenance`-stratum
  receipt-binding gap (#297) are citation-binding defects — in each case the printed/graded citation can
  diverge from the citation `verify-citation.mjs` actually resolved. Still live, no change since 2026-09-18 /
  2026-10-03 respectively.

## Competitors

No new SOTA-relevant shift material to tonight's reconciliation pass (Sakana AI Scientist, OpenHands,
DSPy/GEPA, SWE-agent, Cursor background agents — unchanged landscape from prior nights' fuller research
passes; tonight's budget went to source reconciliation instead of fresh external research, consistent with
`findingPolicy.skipIf: duplicate-open-issue` making new research for this surface low marginal value until the
three standing fixes are reviewed).

## ADR

None — reconciliation and a backlog measurement are not architectural decisions; no governed file was
touched.

## Gist

LOCAL — no `gh` CLI auth (`GH_TOKEN` invalid) and no gist-creation MCP tool available this session, consistent
with every prior Dream Cycle night. Full report committed here instead.

## Issue

`NONE` — #410 (backlog) and #298 (compile-sandbox denial) are both already open and already name these
findings; #297/#340/#372 already carry open fix PRs. Per `findingPolicy.skipIf: ["duplicate-open-issue",
"existing-fix-pr"]`, nothing here warrants a new issue.

## Witness

```
SESSION_COMMIT = ea4d778f3663308e621f6ba88666ed653ff32e02
REPORT_HASH    = e8040281b710e8a4cd4d0ab7aa98ece4d337046abec31804243ab2a2a250a2ea
WITNESS        = 408010a82235c93a4a7322180acfd5b5e108ce53d03fc1af8af83a8a77d0b513
```

**5-step verifier procedure** (anyone can reproduce):
1. `git checkout ea4d778f3663308e621f6ba88666ed653ff32e02` (or the commit this PR is based on).
2. `sha256sum docs/dream-cycle/2026-10-23-grounding-quality-reconciliation-report.md` → compare to
   `REPORT_HASH` above (computed before this Witness section's final values were filled in, per this repo's
   standard stamping convention — see e.g. PR #372's report for the identical pattern).
3. `printf '%s%s' "<REPORT_HASH>" "ea4d778f3663308e621f6ba88666ed653ff32e02" | sha256sum` → compare to
   `WITNESS` above.
4. Re-run the three `grep`/`sed` source reads quoted in "This surface's standing findings" above against the
   same commit and confirm they reproduce byte-for-byte.
5. Query GitHub (`search_pull_requests repo:stuinfla/ruvnet-brain head:dream`, `is:open`, `is:merged`) and
   confirm the backlog counts in "Ledger check" above.

## Recommendation (for the repo owner, priority order)

1. **The backlog is still the dominant fact, and it keeps growing**: 70 open drafts, 114 opened all-time, 5
   merged, 0 in 53 days. Issue #410 is now 17 days old with 10 automated reconciliation comments and no
   recorded human merge/close/triage action in that window. The mechanical audit it proposes (check each open
   `dream/*` PR against current `main`, close what already landed via direct commit, merge or reject the
   rest) remains the single highest-leverage action available — and it is explicitly a human decision, not
   one this session can make unilaterally.
2. `#297`, `#340`, `#372` (this surface) are all independently verified CLEAR and still apply cleanly as of
   tonight. Merging even one would be direct, concrete evidence the pipeline can still reach `main`.
3. `#298` (compile-sandbox denial, 6th occurrence tonight as concurrent PR #486) needs a human outside this
   sandbox to vendor `dream-machine` into `devDependencies`, per that issue's own 2026-09-28/2026-10-10
   comments — this session cannot do it from inside the sandbox that is itself denying the action.

## Merge policy

Human review required. `autoMerge: false` per `dream.config.json` (ADR-068) — the decision, not a default.
This session never self-merges and never autonomously promotes candidate state. Docs-only PR, draft by
design.
