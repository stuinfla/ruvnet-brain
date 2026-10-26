# Dream Cycle 2026-10-03 — grounding-quality

DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5,
`20261003 % 5 == 3`). No bonus deep dive tonight (`% 25` = 3, `% 75` = 53, both non-zero).

## Concurrent night

A separate firing of tonight's same scheduled routine landed first, on `dream/2026-10-03-grounding-quality-reconciliation`
(branch `60dcf8c`, PR **#371**, "grounding-quality reconciliation — no new finding, backlog now 33
days"). That session re-verified `#340` is still clean against tonight's `main` tip and deliberately
did not duplicate it. This session's branch (`dream/2026-10-03-grounding-quality`, no name collision)
carries a disjoint finding — `kb/card-lane.mjs`'s fast-lane citation path, which #371's session did
not touch — found independently before either session was aware of the other.

## Read this first — the backlog

As of tonight, via GitHub MCP (not assumed): **39 open `dream/*` PRs**, 100% draft, oldest from
2026-08-20 (46 days). Zero merged since `#214`/`#215` (2026-08-31) — **33 days with zero merges**.
36 open `dream-cycle` issues. This surface alone has had five nights now since 2026-08-26
(2026-09-08 reconciliation, 2026-09-13 ADR recovery, 2026-09-18 fix PR #297, 2026-09-23
reconciliation, 2026-09-28 fix PR #340, plus tonight's concurrent #371) and every one flagged the
same growing backlog. Re-verified tonight that neither #297 nor #340 has landed: `scripts/eval-brain.mjs:95`
still reads `top?.repo` instead of `routedRepo`, and `kb/forge-ask-all.mjs:2281`/`2319` still
`unshift` instead of `push` — both defects are still live on current `main` (`3ddeb1f`), and #371
independently confirmed #340 the same way tonight. This is not tonight's candidate's problem to
fix, but it is the single highest-value thing for the human owner to look at.

## Rotation / Ledger Check

`main`'s `docs/dream-cycle/LEDGER.md` is stuck at 2026-08-31 (9 rows) because every candidate PR
since has stayed open/draft — the ledger rows exist, just not on `main` yet (each draft PR carries
its own row). Read real state via GitHub MCP instead of trusting the stale file: confirmed `gh` CLI
auth is broken (`GH_TOKEN` invalid) but the GitHub MCP connector works fine (`get_me` succeeds) —
issue/PR writes are available tonight; FALLBACK=false for those. Gist writes are separately blocked
by this container's network proxy (`403: Gist writes are not permitted through this proxy`), same
as every prior night — GIST=LOCAL.

## Hypothesis

A fresh scan (independent `Explore` subagent, then re-verified directly against source) found a
defect distinct from #236/#297/#340:

> Given a query the FAST LANE (`kb/card-lane.mjs`'s `answerFromCards()`/`renderCardHit()`) answers
> confidently — the first-responder path tried on EVERY query before the heavy cross-repo search,
> and the sole responder once it hits (no fallback candidate exists) — when `renderCardHit()`
> prints its citation as `repo=<subject-repo>` / `path: <subject-repo>/kb/capability-cards.md#<subject-repo>`,
> then `kb/verify-citation.mjs`'s `citationResolves()` can NEVER resolve it, because capability
> cards are actually built into the derived `concepts` store under `<repo>/CARD/<repo>-card`
> (`scripts/corpus-aggregates.mjs`'s `add(repository, 'CARD', ...)`) — the same convention the HEAVY
> path already prints correctly for this exact kind of hit (`kb/verify-citation.mjs`'s own header
> comment and `tests/unit/verify-citation.test.mjs`). Fixing the two printed header lines to match
> that already-established convention should make `verifyGrounding()` report `grounded: true` for a
> fast-lane answer, subject to: zero behavior change to `hit.repo`/`hit.path` themselves (a separate
> caller, the ADR-055 receipt in `forge-mcp-all.mjs`, still needs the subject repo) and zero change
> to any benchmark, threshold, or gold answer.

Frozen before writing the diff (diagnosis-only subagent ran first; the fix was written only after
independently re-confirming the on-disk convention from source and tests).

## Candidate

`kb/card-lane.mjs`: `renderCardHit()`'s two printed header lines, `repo=${hit.repo}` →
`repo=concepts`, `path : ${hit.repo}/kb/${hit.path}` → `path : concepts/${hit.repo}/CARD/${hit.repo}-card`.
`tests/unit/card-lane.test.mjs`: fixed one stale assertion that encoded the old, unresolvable path
string (`toContain('capability-cards.md')` → `toContain('concepts/ruflo/CARD/ruflo-card')`), and
added one new end-to-end TEETH test that builds a real temp `concepts.passages.jsonl` fixture and
asserts `verifyGrounding(renderCardHit(hit), kbDir)` returns `grounded: true`. `tests/unit/brain-off.test.mjs`:
one producer⇄consumer source-string pin (line 283) updated to the new literal — see Adversarial
Critique. 3 files, +44/-5.

## Evaluation Receipt

- **TEETH, independently reproduced via `git stash`**: reverting only `kb/card-lane.mjs` turns both
  the fixed assertion and the new test red — `expected … to contain 'concepts/ruflo/CARD/ruflo-card'`
  (got the old `ruflo/kb/capability-cards.md#ruflo` text) and
  `expected { grounded: false, reason: 'citations-do-not-resolve' } to match { grounded: true, reason: 'ok' }`.
  Restoring the fix: `tests/unit/card-lane.test.mjs` 58/58 pass.
- Directly related suites, unmodified by this diff, all pass: `grounding-success-shapes.test.mjs`,
  `grounding-stamp-forgery.test.mjs`, `top100-semantic-assertions.test.mjs`, `verify-citation.test.mjs`
  — 98/98 combined.
- `npm run claims:verify`: 3 PASS / 4 SKIP (standard composition, brain-dependent claims skip loudly).
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (container
  never materializes a corpus, confirmed via `restore-local-ingests.mjs`/`store-root.mjs`, both
  `stores 0 dark 0`; not a credentials block). `LLM_EVAL=blocked` too — no model-provider key in
  this container.

## Baseline

Unmodified `origin/main` at `3ddeb1fde8559031853ff21c1ee485ba28178a91`, compared via `git stash`
(not a separate worktree — this branch has no other uncommitted files to contaminate the diff).

## Darwin Lineage

Not run — no continuous parameter to evolve for a two-line citation-format fix.

## Evidence

OBSERVATION (`renderCardHit()`'s printed citation can never match the real on-disk `concepts`-store
convention) → MEASUREMENT (TEETH red→green, reproduced via `git stash`; related-suite 98/98 green;
`test:integration` byte-identical 27-file failure set baseline vs candidate once a documented,
reproduced load-flake is excluded — see Regression Analysis) → INFERENCE (sole production call site
is `forge-mcp-all.mjs:383`; `hit.repo`/`hit.path` themselves are untouched, so the separate ADR-055
receipt path is unaffected) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

CLEAR. No benchmark, threshold, or gold-answer file touched. The fix is strictly corrective in one
direction: it can only turn a previously-always-`grounded:false` fast-lane answer into
`grounded:true` when the citation is now one `citationResolves()` can actually verify against a
real on-disk passage — it cannot make an ungrounded answer pass, because `verifyGrounding()` still
requires a literal match against `concepts.passages.jsonl`'s real stored paths.

## Adversarial Critique

Independent `general-purpose` subagent, no access to this session's reasoning, tasked to find
reasons to reject. **Initial verdict: BLOCKING, one real finding** — independently re-derived the
`<repo>/CARD/<repo>-card`-under-`concepts` convention from source (not trusting the claim), traced
`parseCitations`/`samePath`/`citationResolves` by hand against the new output, ran 6 related test
files (164 tests, all passing), confirmed the blast radius (`forge-mcp-all.mjs:383` is the sole
production call site; `hit.repo`/`hit.path` reads elsewhere are untouched), and confirmed
reward-hack and security CLEAR — but caught a producer⇄consumer source-string pin this session
missed: `tests/unit/brain-off.test.mjs:283` asserted `kb/card-lane.mjs`'s live source literally
contains the OLD template `` `#1  repo=${hit.repo}  evidence=curated-capability-card\n` ``, which
the diff's edit removes. Independently reproduced red on the candidate / green on baseline via
`git stash`. **Fixed** by updating the pin to the new literal (`repo=concepts`); the test's actual
invariant — that `plugin/scripts/grounding-answer.mjs`'s consumer-side regex
(`#1  repo=\S+  evidence=curated-capability-card\n`) still matches what the producer emits — holds
unchanged, since `\S+` matches `concepts` exactly as well as any other repo name. Re-ran: 1/1 pass
(previously 58 skipped alongside it in the same `describe.skipIf` block, unaffected). The critic
found no other stale-format assertion anywhere in the repo (grepped `tests/`, `kb/`, `scripts/`,
`docs/` for `FAST LANE`, `curated-capability-card`, and the old template shape).

## Security Review

Pure, offline string-template change inside a citation renderer that consumes only this repo's own
already-computed `hit.repo`/`hit.text` (no user/network input touches the two changed lines). No
new attack surface, no new write path, no credential or network code touched.

## Regression Analysis

`test:integration` (57 files/459 tests): candidate 12 failed files/27 failed tests; baseline (`git
stash`) 12 failed files/27 failed tests — identical set, except one extra candidate-run failure,
`unprompted-speech-registry.test.mjs`'s advocacy/DismissalLedger TEETH test (unrelated subsystem,
no connection to citations/grounding). Re-ran that file in isolation on both baseline and
candidate: 29/29 pass both sides — a concurrent-run load flake, same documented pattern as this
ledger's 2026-08-31 and 2026-09-28 rows, not a regression. All other 27 failing files are
pre-existing container artifacts (sqlite3/native-module/EACCES-under-root/CE-model-cache fixtures),
none referencing `card-lane.mjs`, `verify-citation.mjs`, or `forge-mcp-all.mjs` (grep-confirmed).

## ADR

None — a two-line citation-format bug fix mirroring an already-established, already-tested
convention, not an architectural decision.

## Gist

LOCAL — gist writes blocked by this container's network proxy (`403`), same limitation every prior
Dream Cycle night has recorded. Full report committed here.

## Issue

`NONE` — per this repo's ISSUE DISPOSITION OVERRIDE: a new, reproduced, actionable defect was found
and resolved within bounded authority tonight. The verified fix is a work record carried by this PR.

## Witness

```
SESSION_COMMIT = 3ddeb1fde8559031853ff21c1ee485ba28178a91
REPORT_HASH    = 623addddfc7a1586275a0e67f6296c1b14a58059d17d89e33223832e73196cc5
WITNESS        = 9b039b790c5d4fd65deef7d3540078b9d89691b9b635b4835ff7a36765587b2b
```
`REPORT_HASH` is `sha256sum` of this report's pre-stamp snapshot (the committed file's bytes differ
after this section was filled in, per this pipeline's own STEP 16 ordering — same precedent as
every prior night's report). Verifier: (1) `git show <branch>:docs/dream-cycle/2026-10-03-grounding-quality-report.md`
with this section blanked back out should reproduce `REPORT_HASH`; (2) `SESSION_COMMIT` is the
`main` tip this candidate branched from; (3) `sha256(REPORT_HASH + SESSION_COMMIT)` reproduces
`WITNESS`; (4) the TEETH test in `tests/unit/card-lane.test.mjs` fails on `SESSION_COMMIT` with
`kb/card-lane.mjs` reverted and passes with it restored (both independently reproduced above);
(5) `node scripts/doc-currency.mjs --report --json` on this branch shows ADR-0090's `review.current: true`.

## Recommendation (for the repo owner, priority order)

1. **The backlog is now 33+ days / 39 open drafts, zero merged since 08-31.** This is the dominant
   finding across the last five grounding-quality nights and several other surfaces' nights too —
   worth owner attention ahead of any single candidate, this one included.
2. Merge or close `#297` and `#340` — both still apply cleanly, both independently critiqued CLEAR
   on prior nights, both still fix live defects.
3. Resolve `PR #287`'s merge conflict (ADR-0087 recovery for issue #236) so a reviewer can read the
   citation-rank-hijack decision document it's blocked on.
4. Review tonight's candidate (this PR) — small, isolated, TEETH-tested.

## Merge Policy

**Human review required.** `autoMerge: false` per `dream.config.json` (ADR-068) — the decision, not
a default. This session never self-merges and never autonomously promotes candidate state. Draft,
by design.
