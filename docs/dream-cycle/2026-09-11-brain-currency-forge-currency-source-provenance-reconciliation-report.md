# Brain-Currency Corpus-Provenance SOTA Report — 2026

**Dream Cycle 2026-09-11 — DEEP: brain-currency / SCAN: dark-stores, corpus-freshness (slot 1)**

## TL;DR

`kb/forge-currency.mjs`'s `brainKnownSet(root)` — the function `discover()` uses to answer "what has
the brain already indexed," diffed against rUv's live GitHub repo list to report what is NOT yet
indexed — still read its name-alias half (`SOURCE.json`) from this script's own checkout directory
(a module-level `SOURCE_PATH` constant built from `import.meta.url`), regardless of the `root`
argument. PR #222 (2026-08-31, `cbca83b`) fixed only the `.rvf`-filename half of the same function
to source from `root`. A prior Dream Cycle night (2026-09-06) found and fixed exactly this gap
(issue #260, PR #261), with a full evidence receipt and a CLEAR independent-critic verdict — but PR
#261 was closed without merging on 2026-09-07, and its branch was later deleted, so the defect is
still live on `main` today. Tonight reconciled the ledger against current source: reproduced the
defect fresh on today's `main`, confirmed issue #260 is still open and accurate, recovered PR #261's
fix from its (still-fetchable) PR head commit, re-validated it end-to-end against today's `main`
(which has moved ~50 commits since, including an unrelated release-recovery event that rewrote
`scripts/claims-verify.mjs` wholesale), and re-opens it as a fresh review PR rather than duplicating
the investigation. Per this repo's updated `dream.config.json` "ISSUE DISPOSITION OVERRIDE" (added
to the config between this session's compile and its execution — read and followed, not reverted):
no new GitHub issue is opened for this already-tracked, already-reproduced defect; issue #260
remains the tracking issue and this PR references it directly.

Separately, tonight also reconciled issue #226 (`scripts/claims-verify.mjs` defaulting `kbDir` to
`<repo>/kb`, 2026-09-01): confirmed via direct grep that the file was rewritten wholesale in
`d315c94` (`fix(release): make public verification install focused`, 2026-09-07, an unrelated
release-recovery commit by the repo owner) and now defaults every brain-census function to
`storeRoot()`. Closed as integrated, per `findingPolicy.closeIntegratedWork`.

## What's new

Nothing new externally. This is a re-validation of PR #261's own investigation (2026-09-06), whose
diff and reasoning remain correct — re-confirmed independently tonight rather than assumed:
`git show cbca83b -- kb/forge-currency.mjs` still shows the `.rvf`-listing half only; `SOURCE_PATH`
was still present and still module-level on today's `main` before this candidate.

## Competitors (grade C — general framing only, not implementation justification)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No published first-class distinction between live target state and the harness's own bundled copy. | C |
| OpenHands | Per-run sandboxed workspace is ground truth; cross-run provenance drift is not a documented first-class check. | C |
| DSPy/GEPA | Optimizes against a fixed dataset/metric; a stale cached copy vs. live target is a known general ML-tooling hazard, not framework-detected. | C |
| SWE-agent | Reads repo/environment state live per task; no published cross-file provenance audit trail. | C |
| Cursor background agents | Proprietary; no published architecture on this specific concern. | C |

This repo's own `docs/adr/0069-artifact-bound-source-coverage.md` remains the more disciplined
baseline already in place — tonight closes a gap in enforcing it that a prior night already found
but that never landed.

## The hypothesis (frozen before implementation)

> Given `kb/forge-currency.mjs`'s `brainKnownSet(root)` on today's `main`, when `root` is a store
> root whose own `SOURCE.json` differs from (or is absent relative to) this git checkout's committed
> `kb/SOURCE.json`, the function's name-alias half will read this checkout's own `kb/SOURCE.json`
> regardless of `root`, so the returned Set mixes live `.rvf` filenames from `root` with a foreign or
> stale set of aliases — reading `path.join(root, 'SOURCE.json')` instead should make the returned
> Set reflect only `root`'s own declared state, with zero behavior change for the `.rvf`-derived
> correctness PR #222 already fixed, and the existing graceful skip when no `SOURCE.json` exists
> must be preserved.

## Testability gate → Candidate

Testable tonight, no model calls required. Candidate: remove the module-level `SOURCE_PATH`
constant; compute `path.join(root, 'SOURCE.json')` inside `brainKnownSet()` itself. One production
file (`kb/forge-currency.mjs`, 12 lines changed including an explanatory comment), one test file
(`tests/unit/forge-currency-helpers.test.mjs`, 2 new cases, 0 modified).

## Baseline

Today's `main`@`2eef2024cd596e3e6f11523f1b7603306bee5dd9` (this session's start commit — note: this
container's initial local checkout was stale/orphaned relative to `origin/main`, diverged by 83
local-only vs. 50 remote-only commits, almost certainly from the 2026-09-07 release-recovery event;
reconciled by resetting the local `main` ref to `origin/main` before any candidate work began, so
every baseline/candidate number below is measured against the real, current remote tip, not the
stale local snapshot).

## Evaluation Receipt

- **TEETH, verified against the real defect, not module-absence**: wrote the 2 new test cases
  first, ran them against unfixed `main` — both **FAIL** exactly as predicted:
  `known.has('totally-different-repo')` is `false` (root's own `SOURCE.json` ignored) and
  `known.has('metaharness')` is `true` (this checkout's real alias leaks into a foreign root).
  Applied the fix — both **PASS**. `tests/unit/forge-currency-helpers.test.mjs`: 5/5 (3 pre-existing
  + 2 new).
- **`test:unit`, full suite, baseline vs. candidate** (`git stash`/`pop` on the two changed files):
  baseline — 8 failed files / 9 failed tests / 4408 passed / 4613 total. Candidate (before
  `convergence:write`) — 9 failed / 10 failed / 4409 passed / 4615 total; the one delta beyond the
  2 new passing tests is `convergence-manifest.test.mjs` flipping to FAIL, the expected, routine
  consequence of editing tracked files without regenerating the manifest (every prior night's
  documented precedent). Fixed by `npm run convergence:write` (committed in this PR). The other 8
  candidate failures are byte-identical to baseline's 8 (`advocacy-ignored`, `advocacy-outcomes`,
  `doc-currency` [`ADR-0013`], `forge-ask-all` ×2, `hook-shim-fallback-once`, `no-restated-truth`,
  `publication-receipt-wiring`, `user-settings`) — none reference `kb/forge-currency.mjs` or its
  test file.
- **`test:integration`, full suite, baseline vs. candidate**: byte-identical, 7 failed files / 20
  failed tests / 289 passed / 12 skipped / 53 todo on both sides (`anticipate-dial`, `anticipate`,
  `card-lane-hot-path` ×2, `console-apply-timings`, `health-repair` ×8, `reader-deadlock-regression`,
  `unprompted-speech-registry` ×5) — all pre-existing/environmental on this container, none
  referencing the changed files. Notably includes the both-hosts `unprompted-speech-registry` gate;
  it is already red on unmodified `main` tonight (a pre-existing condition worth the owner's
  attention, NOT introduced or weakened by this candidate — confirmed identical on both sides).
- **`npm run claims:verify`**: 4 PASS / 3 SKIP — matches every recent night's documented no-brain-
  installed baseline (`/root/.cache/ruvnet-brain/kb` absent on this container).
- **`npm run eval:gate`**: not the relevant evaluator (no retrieval/grounding surface touched).
  Independently confirmed `EVALUATED=blocked` regardless: `no brain at
  /root/.cache/ruvnet-brain/kb`. `LLM_EVAL` also blocked — no model-provider key this session, a
  legitimate no-model-call night.
- **`npm run qa:pr`**: `version`/`convergence`/`execution-policy`/`architecture`/`wiring`/
  `substitution`/`catalog`/`mesh`/`plugin` lanes PASS. `docs` lane FAILs on the same large
  pre-existing ADR-currency backlog documented in every recent ledger row (confirmed via
  `node scripts/doc-currency.mjs`: no ADR's `governs:` list names `kb/forge-currency.mjs`, so none
  of the blocking findings are this candidate's). `coverage` lane FAILs on the repo's long-standing
  sub-target statement coverage (43.59%, matching `claims:verify`'s own documented "coverage claim
  NOT GRADED" SKIP) — unrelated to a 2-line function fix; adding 2 passing unit tests cannot reduce
  coverage. `claims-source` BLOCKED — same no-installed-brain condition as `claims:verify`'s SKIPs.
- **Blast radius**: `grep -rn "brainKnownSet\|SOURCE_PATH" --include=*.mjs` across `scripts/`,
  `kb/`, `plugin/`, `console/`, `tests/`, `bin/` returns exactly one production call site
  (`discover()`, the pre-existing zero-arg call) and the one test file; `kb/forge-update.mjs`'s own,
  unrelated, same-named `SOURCE_PATH` constant is untouched. `SOURCE_PATH` was never exported.
- **Independent critic (separate subagent, fresh context, not this candidate's author): CLEAR.**
  Checked correctness/edge-cases, reward-hacking, blast radius, regression risk in both directions,
  security, test-quality (independently re-ran the revert-and-restore TEETH proof itself), and scope
  creep. No blocking issues; one non-blocking nitpick (verbose comment), addressed by leaving it —
  the comment documents a real, non-obvious cross-PR history.

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete path-resolution fix (consistent with
every structurally identical fix on this surface to date).

## Evidence

OBSERVATION (issue #260 and PR #261, 2026-09-06: the defect and its fix, both real, both still
unintegrated) → MEASUREMENT (fresh TEETH proof against today's `main`; full-suite baseline-vs-
candidate comparison, byte-identical outside the expected delta) → DECISION (ACCEPT, pending human
review; PR references #260 rather than opening a duplicate issue, per this repo's updated
`findingPolicy`).

## Reward-Hack Check

No existing test, benchmark, gold-data file, or scoring threshold touched. `git diff` on
`tests/unit/forge-currency-helpers.test.mjs` shows only additive new `it()` blocks — the 3
pre-existing cases are byte-identical. The fix makes the known-set strictly more accurate to the
actual `root` passed in (removing a false inclusion when `root` has a different or no `SOURCE.json`
of its own), never adding a false exclusion — the opposite of a reward hack.

## Security Review

No new attack surface: same read-only `fs.existsSync`/`fs.readFileSync` pattern as before, now keyed
off `root` (already caller-supplied and already used one line above for `storesAt(root)`) instead of
`import.meta.url`. `root` is not attacker-influenced at the one real call site.

## Scan: dark-stores

`kb/store-root.mjs`'s `darkStores()` and `rootNeverMaterialized()` are already alias-aware and
never-materialized-aware (fixed prior nights: #142/#143, #177/#178). This container reports
`stores 0 dark 0` tonight, consistent with an ephemeral container that never installs a brain — not
evidence of a wipe. No new dark-store defect found.

## Scan: corpus-freshness

Tonight's candidate IS the corpus-freshness finding: the one function whose entire purpose is
answering "is the brain current with what rUv has shipped" was itself silently stale-scoped.

## Witness

```
SESSION_COMMIT = 2eef2024cd596e3e6f11523f1b7603306bee5dd9
REPORT_HASH    = aa03a7018120871cafbbdb34c237923dd2b9a629d346e6ca791183338329f7ea
WITNESS        = 535c019d0be3b54f91af68fb9d2b6c6c28e9ba25cd5a5865cd0da5181bf170a5
```

**Verifier procedure (reproduce independently):**
1. `git checkout 2eef2024cd596e3e6f11523f1b7603306bee5dd9` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. `npx vitest run tests/unit/forge-currency-helpers.test.mjs` — 5/5 pass.
4. Revert only `kb/forge-currency.mjs` (`git stash push -- kb/forge-currency.mjs`), re-run the same
   file — the two new cases must fail with `known.has('totally-different-repo')` false and
   `known.has('metaharness')` true. Restore (`git stash pop`) and confirm green again.
5. `printf '%s%s' aa03a7018120871cafbbdb34c237923dd2b9a629d346e6ca791183338329f7ea 2eef2024cd596e3e6f11523f1b7603306bee5dd9 | sha256sum` → must equal
   `WITNESS` above.

## Recommendation

ACCEPT pending human review. Small (one production file, ~12 lines excluding comment; one test
file, two new cases), non-duplicative of open dream-cycle PRs on other surfaces, zero blast radius
beyond the function's own test file and its single call site. References existing issue #260 rather
than opening a duplicate — the defect was already tracked and already investigated once; tonight
re-validated and re-submitted it against current `main` per this repo's updated issue-disposition
policy. Also flags, as a work record rather than a new issue (same policy): (1) the
`unprompted-speech-registry` both-hosts gate is red on unmodified `main` tonight, unrelated to this
candidate — worth the owner's attention; (2) issue #226 closed as integrated (fixed by an unrelated
release-recovery commit, `d315c94`); (3) the dream-cycle PR review backlog, flagged in every ledger
row since 2026-08-26, is the likely root cause of tonight's primary finding (a already-validated fix
going stale and needing re-discovery) — merging or explicitly rejecting the ~15 open dream-cycle PRs
would prevent this exact failure mode from recurring.
