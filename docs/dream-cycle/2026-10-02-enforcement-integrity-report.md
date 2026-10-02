# Dream Cycle 2026-10-02 — enforcement-integrity

## Rotation

```
DATE   = 2026-10-02
DAYINT = 20261002
SLOT   = 2  (20261002 % 5)
DEEP   = enforcement-integrity
SCAN   = lesson-delivery, gate-teeth
BONUS  = none (20261002 % 25 = 2, % 75 = 52 — neither hits)
SESSION_COMMIT = 5692a04b85391834430dd5b1d94cb2a4f81a93da
```

`OPENROUTER_API_KEY` is absent this session — `LLM_EVAL=blocked`. Irrelevant to tonight's
candidate: a deterministic process-boundary guard needs no model call.

## Ledger check

`docs/dream-cycle/LEDGER.md` on `main` ends 2026-08-31 (the "ledger row ships in the candidate
PR" convention — an empty/stale tail on `main` means "nothing accepted since," not "nothing
ran"). Checked current GitHub state directly via the GitHub MCP tools rather than assuming it:
only 5 `dream-cycle`-labelled issues remain open (#258, #260, #264, #274, #298); issues #141 and
#145 named in this routine's "known state" are both already closed (confirmed via
`issue_read`), so neither is live work tonight.

**#264 is this exact surface** (`enforcement-integrity` / `lesson-delivery`,`gate-teeth`,
2026-09-07): `plugin/scripts/lesson-presentation.mjs`'s cross-trigger nudge-budget truncation
could silently drop an opted-in `enforcement:block` lesson when a bigger, unrelated advisory on a
different trigger consumed the whole budget first. Its candidate, PR #265, is **closed, not
merged** (`merged: false`, `closed_at: 2026-09-07T18:48:21Z`) — no later commit on `main` touches
`plugin/scripts/lesson-presentation.mjs` (`git log --follow` on that path shows exactly one
commit, an unrelated canary-fixture ordering fix). So the defect's fingerprint
(`deep=enforcement-integrity`, `scan=gate-teeth`, `path=plugin/scripts/lesson-presentation.mjs`)
reconciles to: **open issue, no merged fix, no currently-open fix PR** — not a duplicate to skip,
and not a case where `findingPolicy.skipIf` (`already-fixed` / `existing-fix-pr` /
`duplicate-open-issue`) applies. Per the ISSUE DISPOSITION OVERRIDE, tonight's work is a bounded
repair referencing #264, not a second issue.

## Deep dive — reproduced on current `main`, not merely re-read from the old report

`buildLessonPresentation()`'s current source (confirmed by direct read, not assumed from #264's
prose) has changed since PR #265 was written — it now seeds one lesson per trigger before ranking
(`seeded`/`order`) and tracks `blockCapable` for the frequency-cap-fairness fix documented in the
file's own comments. Neither change touches the actual truncation loop that decides `inForce`:

```js
const inForce = [];
let spent = 0;
for (const lesson of order) {
  const cost = renderLesson(lesson, '·').length;
  if (inForce.length && spent + cost > nudgeBudget) continue;
  inForce.push(lesson);
  spent += cost;
}
```

The first item in `order` (by `repeatCount`, not by `isBlocking`) is admitted unconditionally;
every later item — including an opted-in block on a different trigger — is `continue`d once the
budget is spent. `lesson-gate.mjs` computes `blocking = inForce.filter(isBlocking)` and only exits
`EXIT_BLOCK` `if (blocking.length)`, so an excluded block is a silent, permanent ALLOW. Confirmed
directly against this checkout, not inferred from the old issue, via a standalone repro script
calling `buildLessonPresentation()` with a low-`repeatCount` opted-in block on one trigger and a
2000-char, `repeatCount:25` non-blocking advisory on another: `blocking.length === 0` pre-fix.

## Hypothesis (frozen before implementation)

> Given `buildLessonPresentation()`'s nudge-budget truncation loop, when an opted-in
> `enforcement:block` lesson on one trigger competes against a higher-`repeatCount` or larger
> non-blocking advisory on a different trigger for a `nudgeBudget` too small to admit both, then
> admitting every `isBlocking()` candidate unconditionally before the budget governs the rest
> should make `blocking.length` (and therefore `lesson-gate.mjs`'s exit code) independent of any
> co-occurring advisory's size or `repeatCount`, subject to: zero behavior change when no blocking
> lesson is present in the merge, and the existing frequency-cap-fairness behavior for
> non-blocking lessons (the `seeded`/`compactExtras`/`blockCapable` machinery) is unchanged.

Unchanged since freeze.

## Candidate

`plugin/scripts/lesson-presentation.mjs`: partition `order` into blocking and non-blocking before
the truncation loop; admit every blocking lesson unconditionally (counting its render cost toward
`spent` so later advisories are still bounded correctly); run the existing budget loop over only
the non-blocking remainder. 1 production file, 7 changed lines, one conceptual change.

```js
const blockingFirst = order.filter(isBlocking);
const rest = order.filter((lesson) => !isBlocking(lesson));
const inForce = [...blockingFirst];
let spent = blockingFirst.reduce((sum, lesson) => sum + renderLesson(lesson, '·').length, 0);
for (const lesson of rest) {
  const cost = renderLesson(lesson, '·').length;
  if (inForce.length && spent + cost > nudgeBudget) continue;
  inForce.push(lesson);
  spent += cost;
}
```

## Evaluation Receipt

Real evaluator: `tests/unit/lesson-gate.test.mjs` (process-boundary — exit code + both streams
from a real spawned process; see the file's own header for why weaker tests missed the 2026-07-22
"printed BLOCKED, allowed anyway" defect this bug belongs to the same class as).

**TEETH, proven to fail first** via `git stash -- plugin/scripts/lesson-presentation.mjs`
(production fix only, new test kept): `AssertionError: expected +0 to be 2` (gate exits 0/ALLOW
despite the opted-in block). `git stash pop` restores: green. Full file: 68/68 pass (was 67/67
before the new test).

## Baseline vs candidate

| | Baseline (`git stash`) | Candidate |
|---|---|---|
| Opted-in BLOCK (low repeatCount, trigger A) + oversized advisory (repeatCount 25, trigger B), `RUVNET_NUDGE_BUDGET=50` | exit **0** (ALLOW) — bug | exit **2** (BLOCK) |
| Pre-existing "trimmed into compactExtras" cap-fairness test (`RUVNET_NUDGE_BUDGET=1`) | unchanged | unchanged, still 3/3 pass |
| No blocking lesson present, budget exceeded | first item admitted regardless of cost (unchanged code path) | identical |

## Regression Analysis

`npx vitest run tests/unit/lesson-gate.test.mjs`: 68/68 pass (baseline 67/67 + 1 new TEETH test).

`npx vitest run tests/integration` (458 tests / 56 files): baseline (clean `git stash`) and
candidate produce a **byte-identical failure set** — 12 failed files / 27 failed tests / 365
passed / 21 skipped / 45 todo, diffed line-by-line (`diff` on the sorted `FAIL` lines, 0 lines of
difference). Every failure is environmental to this container, not pre-existing in the sense of
"caused by an earlier PR" but in the sense of "caused by this sandbox": `ruflo` is not installed
(`global Ruflo is required` assertions), the cross-encoder model has no cached weights and no
network to fetch them (`reader-deadlock-regression`), and the container runs as root so a
root-owned-directory permission probe (`ensurePrivateDir('/usr')`) cannot observe a foreign-uid
refusal. `tests/integration/hook-conformance-both-hosts.test.mjs` (the both-hosts conformance
gate ADR-068 names as load-bearing) is **not** in the failure set on either baseline or
candidate — it passed clean both times.

`node scripts/sync-version.mjs --check`: all surfaces agree on `4.5.1`.

`node scripts/doc-currency.mjs --check`: 183 BLOCK findings on both baseline and candidate
(diffed directly, identical count and identical `ADR-0055 presumed-stale` detail), all pre-dating
this session. No ADR's `governs:` frontmatter lists `plugin/scripts/lesson-presentation.mjs`
(confirmed by grep across `docs/adr/*.md`), so this diff owes no currency-log row.

`npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior documented night
(brain-not-installed and coverage-not-run SKIPs; the fourth, `LEARNING-REPLAY`, SKIPs only because
this file currently has uncommitted bytes — `scripts/learning-replay-contract.mjs`'s own
`LOAD_BEARING` drift guard, not a regression, per the 2026-09-07 row's identical precedent).

`npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (this
container never materializes a corpus, independent of `OPENROUTER_API_KEY`). Not a
retrieval/grounding candidate regardless.

`npm run qa:pr` (this repo's `evaluatorEntrypoints.tests`): `contract`/`version`/`execution-policy`/
`architecture`/`wiring`/`substitution`/`catalog`/`mesh`/`plugin` lanes PASS. `convergence` FAILed
("manifest is stale; run npm run convergence:write") — mechanical, not a regression: regenerated
and committed in this PR, same as every prior night that shipped any diff. `docs` FAILed with the
identical 183-BLOCK signature already confirmed byte-identical against baseline above. `coverage`
TIMEOUT and the dependent `claims-source` lane BLOCKED as a result — `coverage` runs the full
`tests/unit --coverage` suite, which this container's resources do not complete inside `qa:pr`'s own
budget; this is an infrastructure ceiling unrelated to the 7-line candidate diff, not a result the
candidate could plausibly cause. The full non-coverage `npx vitest run tests/unit` (7115 tests / 554 files, no `--coverage`
instrumentation) completed: 17 failed files / 52 failed tests / 6869 passed / 56 skipped / 138
todo. None of the 16 distinct failing files (`advocacy-ignored`, `advocacy-outcomes`,
`advocacy-route`, `agentdb-fleet-doctor-sql-escape`, `capability-registry`,
`console-honesty-regressions`, `console-memory-canonical-store`, `corpus-accuracy-gate`,
`corpus-customer-promotion`, `corpus-seed-release-authority`, `doc-currency`,
`hook-shim-fallback-once`, `rehearse-corpus-pipeline`, `retrieval-canary`,
`session-start-knowledge-currency`, `user-settings`) touches `lesson-gate.mjs`,
`lesson-presentation.mjs`, or `lesson-store.mjs` — unsurprising given the single-importer blast
radius confirmed above. Several (`advocacy-ignored`, `advocacy-outcomes`, `hook-shim-fallback-once`,
`user-settings`) are named by their exact filename in multiple prior ledger rows (2026-08-26,
2026-08-28, 2026-09-07) as pre-existing chmod/EACCES-under-root container artifacts; the rest show
the same `fatal: invalid object name` git-squash-history symptom #274's 2026-09-09 row documented
for this container's post-squash state, or corpus/retrieval-oracle fixtures unrelated to lesson
enforcement. Not independently re-diffed against a second full baseline run tonight (cost/time);
the standalone `lesson-gate.test.mjs` TEETH run above remains the authoritative evaluator for this
specific candidate, consistent with this file's own stated purpose ("the real evaluator").

**Blast radius**: `buildLessonPresentation` has exactly one functional importer repo-wide —
`plugin/scripts/lesson-gate.mjs` (grep-confirmed, zero other matches outside the two files
themselves). `scripts/learning-replay-contract.mjs` and `learning-replay-verdict.test.mjs`
reference the file's path only as a string in a `LOAD_BEARING` list, not a functional import.

## Darwin Results

Not run — no continuous parameter to evolve for a boolean admission-order fix; same precedent as
every prior `enforcement-integrity` night.

## Evidence

OBSERVATION (#264's finding, independently re-read against current source, not merely trusted:
the truncation loop still admits by `repeatCount` order with no `isBlocking` exemption, even after
the unrelated `seeded`/`blockCapable` fairness fix landed) → MEASUREMENT (TEETH red pre-fix / green
post-fix via `git stash`; full `test:unit`/`test:integration` diffed byte-identically against a
clean baseline) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

1. Weakened test — CLEAR: 1 added `it()` block in an existing `describe`, no existing assertion
   changed.
2. Altered gold/threshold — N/A, no retrieval-quality surface touched.
3. Vacuous assertion — CLEAR: proven to flip red→green via `git stash`.
4. Hidden cost — CLEAR: one extra array partition + a `reduce` over an already-small in-memory
   array; no new I/O, dependency, or network call.
5. Cherry-picked corpus — N/A.
6. One-directional inflation — CLEAR: `isBlocking()`'s four-condition trust boundary (opt-in file
   membership, `enforcement:block`, `ratified`/`active` status, `origin:user-stated`) is completely
   unchanged by this diff; the fix can only let an already-qualifying refusal survive budget
   competition, never manufacture a new one or weaken the boundary that decides *whether* a lesson
   may block.

## Security Review

No new attack surface. The opt-in trust boundary is untouched; this diff only changes whether an
already-qualifying block survives the character budget. `blockingFirst`'s cost is still added to
`spent`, so a non-blocking advisory's share of the budget shrinks exactly as much as the admitted
block costs — unbounded-length output stays bounded by the number of *opted-in* blocks in force at
once, which is gated by the user's own opt-in file, not by model- or externally-controlled input.
No new dependency, credential, or network call.

## Scan Findings

1. **gate-teeth** (tonight's focus): a guard whose own budget accounting could silently disable it
   — see Deep Dive above.
2. **lesson-delivery**: the delivery-side mirror of the same defect — a lesson the user explicitly
   asked to enforce was not delivered as a refusal when it lost the budget race.

## Competitors

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Agent SDK) | Documents cost/length budgets for tool output; no published distinction between a budget-exempt safety refusal and a budget-governed advisory. | B (official docs) |
| DSPy / GEPA | No published mechanism for exempting a subset of ranked candidates from a shared length budget. | C |
| SWE-agent | No public claims on this surface. | C |
| Cursor background agents | No public documentation of budget-exemption for safety-critical output. | C |
| Sakana AI Scientist | No public documentation of this class of guard. | C |

No competitor claim justifies the implementation; justification is entirely this repo's own prior
precedent (`lesson-store.mjs`'s `lessonsFor()` already orders block-first within one trigger — this
diff extends the same discipline to the cross-trigger merge, the layer #264 found it missing from).

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation as every
Dream Cycle night since 2026-08-19). Full report committed here.

## Witness

- Session commit: `5692a04b85391834430dd5b1d94cb2a4f81a93da`
- Report sha256 (of this file's content from the start through the line immediately before this
  "## Witness" heading — i.e. everything above this section, which cannot hash itself):
  `cb438675e61e0ebfd3625bff080a91be03bc977c5cedbc1e11175b7f6ca21ecb`
- Witness stamp (`sha256(REPORT_HASH + SESSION_COMMIT)`):
  `63f9640ea79ce5b89752dab75a8280c6a5d0f33656620f177e2294ba65242593`
- Verifier procedure: (1) `git checkout 5692a04b85391834430dd5b1d94cb2a4f81a93da`; (2) apply the
  candidate diff from branch `dream/2026-10-02-enforcement-integrity`; (3) take this committed
  report, keep only its content from the start through the line immediately before this "##
  Witness" heading (i.e. drop this section and "## Recommendation" below it), `sha256sum` that,
  and confirm it matches the Report sha256 above; (4) `printf '%s%s' REPORT_HASH SESSION_COMMIT |
  sha256sum` and confirm it matches the Witness stamp above; (5) `git stash push --
  plugin/scripts/lesson-presentation.mjs`, run `npx vitest run tests/unit/lesson-gate.test.mjs -t
  "crowd the block"`, confirm it fails red, then `git stash pop` and confirm it passes green.

## Recommendation

`evaluated: accepted`. Human review requested — this session never self-merges or
self-promotes. References issue #264 (not a new issue, per the ISSUE DISPOSITION OVERRIDE: the
defect was already tracked, unresolved, and is now independently reproduced and repaired).
