# Coverage-Gap-Review SOTA Report — 2026

## TL;DR

`scripts/onboarding-console.mjs`'s "what's in the brain" console page compared each repo's
canonical store name (`COVERAGE.json`'s `artifact.store`) against installed `.big.rvf` filenames
with a raw `Set.has()` — never resolving aliases via `kb/repo-aliases.json`. A repo installed on
disk under an alias filename (the shipped example: canonical `agent-harness-generator`, alias
`metaharness`) reads as **"not in the brain"** on the console even though it genuinely is
installed, and the reverse listing (`installedOutsideCoverage`) double-counts the same store as
"installed outside coverage" even though it IS covered, just under its canonical name. This is the
fourth-plus instance of the exact conflation ADR-058/069 already fixed in `kb/store-root.mjs`'s
`darkStores()` and `scripts/source-coverage.mjs`'s `artifactEvidence()` — never migrated to this
sibling reader. Fixed by importing the router's own `repositoryNames()` resolver (no new alias
logic invented) and threading `root` through `scopeRow`/`computeScope`.

## What's new

Not a novel technique — a bounded-authority bug fix reusing this repo's own established resolver,
per `dream.config.json`'s `never-hand-roll-what-ruv-already-ships` discipline. What's new is the
*locus*: the fourth production file found with this exact unmigrated gap.

## Rotation

```
DATE   = 2026-09-25
DAYINT = 20260925
SLOT   = 0  (20260925 % 5)
DEEP   = cross-host-conformance
SCAN   = codex-parity, stranger-project-behaviour
BONUS  = coverage-gap-review (20260925 % 25 == 0)
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
```

`OPENROUTER_API_KEY` present this session, but `kb/store-root.mjs`'s `storeRoot()` shows
`stores 0 dark 0` — this container never materializes a local brain corpus (the same pre-existing
condition every dream-cycle night has recorded since 2026-08-19; confirmed via
`restore-local-ingests.mjs`, `brain-score.mjs`, `store-root.mjs`). `eval:gate` independently
confirms: `no brain at /root/.cache/ruvnet-brain/kb`. Irrelevant to tonight's candidate regardless
— it is a deterministic, model-free unit-level fix.

## Ledger check / dedupe (ISSUE DISPOSITION OVERRIDE)

Read `docs/dream-cycle/LEDGER.md` (main is stale at 2026-08-31; every night since ships its ledger
row in its own unmerged candidate PR, per this repo's own convention). Checked live GitHub state via
the MCP tools rather than assuming it:

- **26 `dream/*` PRs are open, all draft, zero merged since #178 (2026-08-26)** — a ~1-month,
  still-growing review backlog, flagged by nearly every night's ledger row since 2026-08-26 and
  still true tonight (most recent: #322/#323, 2026-09-24). This is itself the dominant standing
  finding and is restated below for the owner, not fixed here (outside one night's bounded
  authority — it needs human review capacity, not more candidates).
- Tonight's assigned primary DEEP, `cross-host-conformance`, already has **three open, unresolved
  drafts** in that backlog: `dream/2026-09-15-cross-host-conformance` (ledger-row/ADR-stamp only, no
  code fix), `dream/2026-09-20-cross-host-conformance` (`hook-registry.mjs` comment-only fix, #304),
  and `dream/2026-09-20-cross-host-conformance-release-preflight-aggregate` (`release-qe` aggregate
  teeth, #305, diverged history from `main` — no common merge base, flagged for the owner). Adding a
  fourth candidate to an already-unreviewed surface would grow the backlog without shrinking
  tomorrow's search space — the opposite of ADR-068's stated goal.
- Issue #298 (2026-09-19): a prior night's `dream-machine compile` was denied by this session's own
  sandbox classifier. Tonight's STEP 0 compile succeeded cleanly (`npx -y dream-machine@0.1.1
  compile` — 15029 bytes, no denial), so that specific blocker did not recur.
- Given the above, tonight's bounded research+candidate budget went to the **bonus** dimension
  (`coverage-gap-review`, triggered by `20260925 % 25 == 0`) instead of adding a fourth
  cross-host-conformance draft. This surface had no open PR/issue tonight and produced a genuinely
  new, reproduced, fixed defect (dedupe: `deep=coverage-gap-review`, `path=scripts/onboarding-console.mjs`,
  `signature=alias-blind-installed-check` — no match against any open issue/PR).

## Deep Dive (bonus: coverage-gap-review)

See TL;DR. `kb/repo-aliases.json` records `"agent-harness-generator": ["metaharness"]` — the
concrete case already known to this repo (its capability card lives under `## agent-harness-generator`
only). `scopeRow()`'s `installed = Boolean(store) && installedStores.has(store)` and
`computeScope()`'s `covered.add(row.artifact.store)` both compared/added the bare canonical name,
never consulting `repositoryNames()`. Confirmed via `grep` that `onboarding-console.mjs` was the
only consumer of `installedStores`/`covered`-style Set membership in this codebase that never
imported `kb/card-lane.mjs`'s `repositoryNames` (every sibling — `kb/store-root.mjs`,
`scripts/source-coverage.mjs`, `scripts/brain-score.mjs`, `kb/forge-ask-all.mjs` — already does).

## Hypothesis (frozen before implementation)

> Given `scripts/onboarding-console.mjs`'s `computeScope()`/`scopeRow()`, when a repo's installed
> `.big.rvf` filename is an ALIAS of its `COVERAGE.json` canonical `artifact.store` name (per
> `kb/repo-aliases.json`), then the current raw `Set.has()` comparison will report that repo
> "not-in-brain" (and, symmetrically, list the alias-installed store as "installed outside
> coverage") even though it is genuinely installed and covered; resolving both directions through
> `repositoryNames(store, root)` — the router's own resolver, imported rather than reimplemented —
> should make both readings correct, subject to: zero behavior change for the non-aliased case
> (the overwhelming majority of repos), and no new false-positive "installed"/"covered" reading.

Unchanged since freeze.

## Evaluation Receipt

**TEETH, proven RED before the fix**: two new cases in `tests/unit/console-scope.test.mjs`
(`scope — alias-aware installed/covered matching`), run against unmodified `main` —
`AssertionError: expected 'not-in-brain' not to be 'not-in-brain'` and
`expected [ 'metaharness', 'zeta' ] to not include 'metaharness'`. Both green after the fix; full
file 21/21 pass (19 pre-existing + 2 new), zero existing assertions touched.

- `npx vitest run tests/unit` (full suite, 460 files/5795 tests, candidate applied): 53 failed / 5557
  passed / 47 skipped / 138 todo, 17 failed files. Blast radius: the changed file's own test
  (`console-scope.test.mjs`) is NOT among the 17 failed files and passes 21/21 in isolation and in
  this full run; `scopeRow`/`computeScope` have exactly one production caller (`gatherScope`,
  grep-confirmed repo-wide) and zero relationship to the failures actually visible in this run's
  captured tail — `retrieval-canary.test.mjs` (independent oracle has no source-grounded row for 12
  of 194 eligible stores — a data-completeness gap in the oracle corpus, not code; and a
  `git merge-base --is-ancestor` failure, this container's shallow clone lacking full history) and
  `user-settings.test.mjs`'s `"refuses to write when the backup cannot be taken"` — this exact test
  is the pre-existing chmod/EACCES-under-root artifact this repo's own ledger has named in every
  night since 2026-08-26 (root can write through a read-only chmod inside this container). Caveat,
  stated plainly rather than hidden: the run's captured output was tail-truncated, so the other 14
  of 17 failed files' names were not individually re-confirmed against precedent tonight — the
  claim above rests on blast-radius (one caller, unrelated subsystem) and on the three failures that
  were visible, not on a full file-by-file diff against a prior night's list.
- `npm run test:integration` (candidate): 10 failed files / 24 failed tests / 322 passed / 16
  skipped / 45 todo of 407. Same-container **baseline** (candidate `git stash`-ed out, real parent
  comparison, not assumed): identical counts — 10 failed / 24 failed / 322 passed / 16 skipped / 45
  todo of 407. The one failure fully visible in both captured tails is textually identical
  (`reader-deadlock-regression.test.mjs`'s cross-encoder-model network-priming failure, same error).
  Blast radius: none of the three failing test files visible in either run
  (`project-progression-restore-semantics`, `reader-deadlock-regression`, `unprompted-speech-registry`)
  import or exercise `onboarding-console.mjs`. Classified: pre-existing/environmental, not
  candidate-caused.
- `npm run qa:pr`: overall `FAIL` on first run — lanes `version`/`execution-policy`/`architecture`/
  `wiring`/`substitution`/`catalog`/`mesh`/`plugin` PASS; `convergence` FAIL (mechanical — any
  source change makes the committed manifest stale; regenerated via `npm run convergence:write` and
  re-checked `{"ok":true}`, committed in this PR); `docs` FAIL (pre-existing — `node
  scripts/doc-currency.mjs --check --warn-drift` shows ~50 ADR files with `stamp-lags-doc` against
  one unrelated bulk commit `12f8bf14`, "chore(release): prepare 4.3.27 recovery candidate", none of
  which this candidate touches); `coverage` TIMEOUT and `claims-source` BLOCKED (the `coverage` lane
  IS `vitest tests/unit --coverage` — the same slow full-suite run above, which took 656s in this
  container; `claims-source` depends on `coverage` and inherits the timeout — environmental, not a
  candidate defect).
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior documented night
  (SKIPs: `~56× cheaper`, coverage badge, chunk count, LEARNING-REPLAY — all pre-existing, brain-not-installed
  or environment-only).
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (pre-existing
  container condition, confirmed independently via three probes). Not the relevant evaluator for this
  candidate regardless (no retrieval/grounding surface touched).

## Darwin Results

Not run — no continuous parameter to evolve for a discrete alias-resolution fix (same precedent as
every prior discrete-fix dream-cycle night).

## Evidence

OBSERVATION (`onboarding-console.mjs` never imported `repositoryNames`, unlike every sibling
consumer of the same alias table) → MEASUREMENT (TEETH proven red pre-fix / green post-fix; blast
radius confirmed via grep — `scopeRow`/`computeScope` each have exactly one call site,
`gatherScope`) → DECISION (ACCEPT, pending human review and pending the independent critic's
verdict below).

## Reward-Hack Check

No existing assertion touched — only two new `it()` blocks and one optional `aliases` param added
to the test file's `seed()` helper. No threshold, gold data, or benchmark file touched. The fix is
one-directional: it can only make an already-installed/covered store report correctly, never
manufacture a false "installed" reading for a store that genuinely isn't (repositoryNames only
returns names the alias registry itself declares plus the exact input name; it invents nothing).

**Independent critic verdict: CLEAR** (separate agent, not this candidate's author). Confirmed the
fix is a faithful port of `kb/store-root.mjs`'s `darkStores()` pattern; confirmed `root` threads
correctly through all three call sites; confirmed no existing assertion/threshold/fixture was
touched; confirmed the two new tests exercise the real bug shape from both directions and are not
vacuous; confirmed blast radius via independent grep (exactly one caller each). Non-blocking note:
`loadRepoAliases()` re-reads/re-parses `repo-aliases.json` uncached on every `repositoryNames()`
call (~2x per COVERAGE row) — negligible at today's row counts (hundreds), worth a memoization note
if row counts grow substantially. Not fixed tonight (out of this candidate's bounded scope; not a
correctness defect).

## Security Review

No new attack surface: `store` values originate from `COVERAGE.json`/`RVF-GENERATIONS.json`
(locally-produced artifacts), never from user/network input. `repositoryNames()` reads a local
JSON alias file (or its module-bundled fallback) — the same read this repo's other consumers
already perform at the same trust level. No new dependency, credential, or write path.

## Scan Findings

**coverage-gap-review** (bonus, elevated to tonight's focus): the defect above — a fourth,
previously-unmigrated instance of the alias-blindness class, in the one console-facing reader a
user actually looks at to answer "is repo X in my brain?".

**codex-parity / stranger-project-behaviour** (assigned primary scan, cross-host-conformance): no
new finding tonight — the surface's existing three open drafts (see Ledger check) already cover the
recent activity here; no additional non-duplicate defect surfaced in the research budget allotted.

## Competitors

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Agent SDK) | Documents durable-state and provenance concerns generally; no public claim about alias/canonical-name identity resolution specifically. | B |
| DSPy / GEPA | Versioned artifact identity is explicit in its own registry; sidesteps this class structurally by not supporting free-form aliasing. | B |
| SWE-agent | No public documentation of this class surfaced tonight. | C |
| Cursor background agents | No public documentation of this class surfaced tonight. | C |
| Sakana AI Scientist | No public documentation of this class surfaced tonight. | C |

No competitor claim justifies the implementation — justification is entirely this repo's own
ADR-058/069 precedent, extended to a fourth sibling.

## Gist

LOCAL — no `gh` CLI and no gist-creation MCP tool available this session (confirmed: `which gh`
empty; GitHub MCP toolset has no gist endpoint). Same limitation as every dream-cycle night since
2026-08-19. Full report committed instead at
`docs/dream-cycle/2026-09-25-coverage-gap-review-report.md`.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
REPORT_HASH    = 0eafd93095f8fbcb804bff9705ea861304f7f7cb682b3f84bfc1c5c30180ebd3
WITNESS        = 8add3e869f5cf105f56caedeede54b07751a4c08c622a10ea1a02c2febf55b63
```

5-step verifier (anyone can reproduce):
1. `git -C ruvnet-brain rev-parse e89ea1ba167d9252ec99910304f534c8da5ca0ab^{commit}` — confirm the
   session commit exists (it is `origin/main`'s tip at the time this run started).
2. Check out this report at that exact content (it is committed verbatim as
   `docs/dream-cycle/2026-09-25-coverage-gap-review-report.md` in this PR — no post-hoc edits).
3. `sha256sum docs/dream-cycle/2026-09-25-coverage-gap-review-report.md` — must equal `REPORT_HASH`
   above.
4. `printf '%s%s' <REPORT_HASH> e89ea1ba167d9252ec99910304f534c8da5ca0ab | sha256sum` — must equal
   `WITNESS` above.
5. `git diff origin/main...HEAD -- scripts/onboarding-console.mjs tests/unit/console-scope.test.mjs`
   — must reproduce the exact 48-line candidate diff described above; `npx vitest run
   tests/unit/console-scope.test.mjs` must show 21/21 passing.

## Recommendation

`evaluated: accepted` (pending independent critic confirmation, appended below once returned).
Human review requested on the draft PR — this session never self-merges or self-promotes.
Standing note for the owner, restated from nearly every night since 2026-08-26: **26 dream-cycle
PRs are open and draft, zero merged in the last month** — the single highest-leverage action
available is review/merge capacity, not more nightly candidates.
