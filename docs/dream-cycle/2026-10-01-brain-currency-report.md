# Corpus Freshness SOTA Report — 2026

**TL;DR**: `kb/forge-ask-all.mjs`'s `corpusAgeFor()` — the function behind the user-facing
"Corpus snapshot ages: newest store Xd old, oldest Yd old" warning — computed every store's age
from `fs.statSync(storePath).mtimeMs` alone. A `git clone` / `npm install` / Docker `COPY` resets
every extracted file's mtime to "now", so the normal end-user install path (ADR-069's own words:
"clone freshness is not artifact freshness") made a corpus built weeks or months ago report as
~0 days old, silently defeating the entire staleness warning this repo built specifically to stop
answering stale "what's the latest version" questions with confidence. Fixed by preferring each
store's recorded `builtUtc` from `kb/RVF-GENERATIONS.json`, falling back to mtime only when a
store has no generation record — same precedence pattern already proven in two siblings
(`corpusSnapshotDate` in the same file's neighbor module, and `resolveBuiltFromSha` in
`scripts/brain-stamp-resolve.mjs`).

## What's new

This is the **third occurrence** of "checkout/install timestamp mistaken for artifact-build
timestamp" in this exact codebase:

1. `scripts/brain-stamp.mjs`'s `builtFromSha` — fixed PR #176 (2026-08-26), preferred
   `RVF-GENERATIONS.json.sourceCommit` over live clone HEAD.
2. `scripts/brain-score.mjs`'s `readPanel()` — fixed via commit `12f8bf1` (issue #258), preferred
   `summary.generatedAt` over `fs.statSync(file).mtime`.
3. `kb/corpus-freshness.mjs`'s `corpusSnapshotDate()` **already carries this exact fix** — it
   prefers `SOURCE.json`'s `builtUtc`, falling back to mtime only as a last resort. But that fix
   was applied only to the snapshot-date *string* used in `freshnessAdvisory()`; its sibling
   `corpusAgeFor()` — which computes the actual per-store age *numbers* shown in the same warning
   sentence (`stalenessNotice()`) — was never updated to match. Two functions in the same feature,
   one fixed, one not; the test suite only covered the fixed one
   (`tests/unit/grounding-freshness.test.mjs:59`, "prefers SOURCE.json builtUtc" — `corpusAgeFor`
   itself had zero direct test coverage before tonight).

## Competitors (external research, grade B — single vendor/blog sources, cross-checked against
this repo's own prior fixes rather than independently reproduced)

| System | Approach to corpus/index freshness | Grade |
|---|---|---|
| General RAG production guidance (2026) | Freshness metadata belongs at the document/record level: "a timestamp capturing when the source data was last verified current, not when it was last ingested" — exactly the builtUtc-vs-mtime distinction this fix makes | B |
| Temporal-RAG research | "Measure the age of an index relative to the corpus it was built from, not the age of either one alone" | B |
| Always-on agent memory survey | Server-side build/write timestamps preferred over local clock reads because "laptop clocks and distributed workers can drift" — same class of problem as a reset filesystem mtime | B |
| Sakana AI Scientist / OpenHands / DSPy-GEPA / SWE-agent / Cursor background agents | No public documentation found describing an analogous build-provenance-vs-checkout-mtime distinction for a retrieval corpus; these systems largely operate over live repos rather than versioned offline snapshot bundles, so the failure mode doesn't directly apply | C (absence, not a disconfirming source) |

## Hypothesis (frozen before implementation)

> Given a store whose `.rvf` file's mtime has been reset by extraction (clone/install/COPY) but
> whose `kb/RVF-GENERATIONS.json` entry records a `builtUtc` weeks in the past, when
> `corpusAgeFor()` is changed to prefer that `builtUtc` over `mtimeMs`, then `oldestDays`/
> `newestDays` should reflect the true build age rather than ~0, subject to: a store with no
> generation record must report byte-identical behavior to before (mtime fallback), and no other
> caller of `corpusAgeFor` is affected.

## Evaluation Receipt

**Guard proven to fail first** (red before fix): isolated the semantic change (kept the function
exported, reverted only the `mtimeMs` preference line) and re-ran the new tests —
`AssertionError: expected +0 to be close to 42` / `expected +0 to be close to 15` on the two
builtUtc-preference cases; the mtime-fallback and null cases still passed, confirming the guard
isolates exactly this defect, not merely the export. Restored the fix: all 4 new tests + all 112
tests in `tests/unit/forge-ask-all.test.mjs` pass (includes the pre-existing `out.corpusAge`
orchestration assertion, unaffected).

**Not a retrieval-quality candidate** — `npm run eval:gate`: `EVALUATED=blocked`, `no brain at
/root/.cache/ruvnet-brain/kb` — this container never materializes a corpus (`stores 0 dark 0`,
confirmed via `kb/store-root.mjs`), same condition as every prior night since 2026-08-19. Not a
credentials block — `OPENROUTER_API_KEY` is present.

**`npm run test:integration`**, baseline vs candidate, both run to completion via `git stash`
isolation: byte-identical, 10 failed files / 25 failed tests / 336 passed / 17 skipped / 45 todo of
423, on both. All pre-existing/environmental (missing global `ruflo`, no network for the
cross-encoder model download under this sandbox).

**`npm run test:unit`** (full suite, 506 files): baseline 16 failed files / 53 failed tests /
6154 passed; candidate (before `convergence:write`) 17 failed / 54 failed — the one extra failure
was `tests/unit/convergence-manifest.test.mjs`, expected mechanically (this diff changes 3 tracked
files' hashes, staling the committed manifest) and fixed by regenerating it
(`npm run convergence:write`, re-verified `{"ok":true}`). All 16 other failures are byte-identical
file names between baseline and candidate — the same pre-existing signature documented in this
ledger since 2026-08-26 (chmod/EACCES-under-root fixtures that don't enforce running as root, plus
corpus-pipeline/advocacy tests needing infra this container doesn't have).

**`npm run qa:pr`**: `version`/`execution-policy`/`architecture`/`wiring`/`substitution`/
`catalog`/`mesh`/`plugin` lanes PASS. `convergence` FAILED on the first run (stale manifest from
this diff's own file changes — the committed detector working correctly), fixed and reverified.
`docs` FAILED — pre-existing backlog, confirmed via `node scripts/doc-currency.mjs --check` on
unmodified `main` (`git stash`-verified): the exact same `1 BLOCK · 11 warn` on ADR-054 and dozens
of other `presumed-stale` ADRs predate this diff by weeks. `coverage` TIMEOUT and (its dependent)
`claims-source` BLOCKED — `scripts/qa-lanes.mjs:28` runs `vitest run tests/unit --coverage`,
which exceeds this container's available time with or without this diff (the uninstrumented full
suite alone takes ~620s here); not reproduced against an isolated baseline timing run tonight due
to the time cost of a second multi-hundred-second run, flagged as an UNVERIFIED (not INFERRED
confident) classification rather than silently assumed pre-existing.

`npm run claims:verify`: 3 PASS / 4 SKIP, identical to the documented baseline pattern.
`node scripts/sync-version.mjs --check`: all surfaces agree on `4.3.40`.

## Darwin Lineage

Not run — no continuous parameter to evolve for a two-branch precedence fix (recorded-value vs.
mtime fallback); skipped rather than run for form's sake, same precedent as PR #143/#178.

## Reward-Hack Check

No benchmark, gold-answer, eval threshold, or test assertion outside the new/touched test file was
touched (confirmed: `evals/`, `tests/unit/grounding-freshness.test.mjs`,
`tests/unit/eval-brain-gate.test.mjs` unmodified). New tests proven non-vacuous (red-then-green,
shown above, with the semantic-only isolation as a second confirmation). Fix only ever makes the
staleness computation *more* accurate in both directions (an artificially-young report is
corrected upward when a build record exists; nothing is corrected downward below the true build
age) — it cannot be a one-directional score inflator. **Independent critic (separate agent, not
this candidate's author) verdict: CLEAR** — checked reward-hacking, cherry-picking, blast radius
(grepped all 3 call sites, all internal to `kb/forge-ask-all.mjs`), correctness (graceful handling
of a missing `RVF-GENERATIONS.json`, case-insensitive lookup matching the established
`resolveBuiltFromSha` convention, `Date.parse`+NaN validation before trusting `builtUtc`),
security, and the ADR currency-log edit's factual accuracy (independently re-grepped the diff for
`brainEnabled`/`sentinel`/`off-state`/`offBehavior`/`disabled` — zero hits, matching the claim).

## Security Review

No new attack surface: `readGenerations()` reads a fixed-path sibling file
(`path.join(dir, 'RVF-GENERATIONS.json')`) already written by this repo's own build tooling
(`kb/forge-build.mjs`) and already read by 6+ other scripts in this codebase. `name` (the per-repo
store name) is only ever used as an object-key/case-insensitive-compare, never interpolated into a
path. No new network call, credential, or write path. Separately unrelated to this candidate: the
GitHub MCP tool `list_pull_requests` returns an unpopulated/always-`false` `merged` boolean field
even when `merged_at` is correctly set — this caused tonight's own backlog-audit subagent to
confidently report "0 of 76 dream/* PRs ever merged" when the true count (independently verified
via `pull_request_read` on individual PRs, and via direct `merged_at`-based computation) is 5.
Recorded here as a process-integrity note, not a code finding in this repo — see Recommendation.

## Regression Analysis

Blast radius: `corpusAgeFor` has exactly 3 call sites (`kb/forge-ask-all.mjs:2398, 3325, 3476`),
all internal to the same file, each on a mutually-exclusive return path (not a loop re-reading the
JSON per request). No other file imports it. `kb/corpus-freshness.mjs` only references the name in
a comment. The fallback path (no generation record) is byte-identical to pre-candidate behavior,
both in code (`??` nullish-coalescing to the old `fs.statSync` expression) and by test.

## Evidence

OBSERVATION: `corpusAgeFor` (`kb/forge-ask-all.mjs:1534` pre-candidate) used only
`fs.statSync(storePath).mtimeMs`. OBSERVATION: `kb/RVF-GENERATIONS.json`'s schema is
`{stores: {<name>: {..., builtUtc}}}`, sitting alongside the `.rvf` files in the same `dir`.
MEASUREMENT: pre-candidate, a store with mtime reset to "now" and a `builtUtc` 42 days in the past
reports `oldestDays: 0`; post-candidate, `oldestDays: 42`. MEASUREMENT: a store with no generation
record is unaffected (mtime-based age unchanged, tested). INFERENCE (not independently re-verified
against a real installed bundle tonight — this container never materializes one): this is live in
every `npx ruvnet-brain` / `npm install` install path, since RVF-GENERATIONS.json's per-store
`builtUtc` entries are already populated in this repo's own committed file (verified:
`stores.agentdb.builtUtc = 2026-07-30T17:24:56.062Z`) and the CLI/MCP server's `stalenessNotice()`
call sites are unconditional.

## Scan Finding 1 — dark-stores

Probed `kb/store-root.mjs`'s `darkStores()` and `storesAt()` on this container: `stores 0 dark 0`
— the store root is never materialized here (consistent with every prior night since 2026-08-19;
this is an environmental condition of the sandbox, not a code defect — `rootNeverMaterialized()`,
PR #178, already classifies it correctly as never-materialized rather than a false `0`/`WIPED`).
No new dark-store defect found; this scan surface was already fixed by PR #178/#213/#215's chain of
alias-aware, errno-aware currency fixes. One unverified runner-up surfaced by tonight's research:
`kb/forge-currency.mjs:166`'s `discover()` compares raw repo names against `brainKnownSet()`
without the `repositoryNames()` alias resolution its three siblings already received — no live
triggering case was found tonight (today's `kb/SOURCE.json` entries happen not to need the alias),
so this is a work record, not a reproduced defect; it's also already the subject of open PR #328
(reviving #260), so it is correctly excluded from tonight's candidacy to avoid duplicating that
PR's territory.

## Scan Finding 2 — corpus-freshness

This IS the primary finding above — `corpusAgeFor()`'s mtime-only computation was the live
corpus-freshness defect. No second, independent corpus-freshness defect was pursued tonight,
consistent with this repo's learning signal to keep tonight's candidate small given the review
backlog (below).

## Process finding: the dream-cycle PR review backlog, corrected numbers

Tonight's own backlog-audit subagent initially reported "0 of 76 dream/* PRs ever merged," which
is **false** — traced to the GitHub MCP `list_pull_requests` tool's `merged` field reading `false`
for every result regardless of actual merge state (only `merged_at` is reliable in list results;
`pull_request_read`'s single-PR `get` call reports `merged` correctly). Independently verified via
direct Python computation over the raw paginated JSON (filtering on `merged_at != null`), and
spot-checked against 3 individual `pull_request_read` calls (#143, #178, #215 — all confirmed
`merged: true`):

| Metric | Corrected value |
|---|---|
| Total `dream/*` PRs ever | 77 |
| Merged (all between 2026-08-19 and 2026-08-31) | 5 |
| Currently open + draft (awaiting human review) | 36 |
| Closed, never merged | 36 |
| Merged in the last 14 days (since 2026-09-17) | **0** |
| Opened in the last 14 days | 24 |
| Oldest open+draft PR | #269, created 2026-09-08 — **22.6 days old** |
| Open issues labeled `dream-cycle` | 5 (#258, #260, #264, #274, #298) |

The underlying trend this corrects *to*, not away from, still holds: the review backlog is real
and growing (24 opened vs. 0 merged in the last 14 days), confirming the ledger's own repeated
flags of this since 2026-08-26. Per STEP 1.1's learning signal ("zero of the last 14 candidate PRs
merged → bias to a tiny, one-parameter, easily-reviewable candidate"), tonight's candidate was kept
deliberately small: 1 production file, ~25 changed lines, 1 test file, 1 ADR currency-log line.

## Witness

```
SESSION_COMMIT = 94bd932f8c6fbd01e66c09191b5cb575d8e8353a
REPORT_HASH    = 2a6eaef65e18a31b891c5d57ec683d448b0749e3c4d61e8eb1d34b2c0e101fba
WITNESS        = c7d5d3b3b78459f98fd51538b55a63c8e68251968caf29f1b1346a08cc229228
```

Verify: (1) `git checkout 94bd932f8c6fbd01e66c09191b5cb575d8e8353a`; (2) obtain this report from
the candidate PR / this file at the commit that added it; (3) `sha256sum` it, confirm
`2a6eaef65e...`; (4) `printf '%s%s' <report-sha256> 94bd932f8c6fbd01e66c09191b5cb575d8e8353a |
sha256sum`, confirm `c7d5d3b3b7...`; (5) `git stash` the candidate diff, confirm the 2
builtUtc-preference tests in `tests/unit/forge-ask-all.test.mjs` fail, `git stash pop`, confirm
they pass.

## Recommendation

1. **Merge this candidate** (small, independently critiqued, guard proven non-vacuous, zero
   regression against baseline on every evaluator that ran to completion tonight).
2. **Human attention on the review backlog itself** is now the single highest-leverage action
   available to this nightly system: 36 open draft PRs, 5 open issues, oldest unreviewed item 22.6
   days old, 0 merges in 14 days against 24 new PRs in the same window. The nightly research loop
   is finding real, verified, independently-critiqued defects — the bottleneck is no longer
   measurement, it is review throughput.
3. **Process note for future nights**: when computing PR/issue fates for the ledger, prefer
   `merged_at != null` over the GitHub MCP `list_pull_requests` tool's `merged` field, or verify
   with `pull_request_read` on individual PRs before asserting a merge count — this cost tonight's
   own research a confidently-wrong headline number that was only caught by independent
   verification before it reached the ledger.
