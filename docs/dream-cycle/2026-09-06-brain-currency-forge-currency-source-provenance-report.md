# Brain-Currency Source-Provenance SOTA Report — 2026

**Dream Cycle 2026-09-06 — DEEP: brain-currency / SCAN: dark-stores, corpus-freshness (slot 1)**

## TL;DR

`kb/forge-currency.mjs`'s `brainKnownSet(root)` — the function that answers "what has the brain
already indexed," the one thing `discover()` diffs against rUv's live GitHub repo list to report
what is NOT yet indexed — merges name aliases from a `SOURCE.json` file. PR #222 (2026-08-31)
fixed the `.rvf`-filename half of this function to read from the caller's `root` parameter instead
of the script's own checkout directory (`kb/store-root.mjs`'s `storesAt(root)`), but left the
`SOURCE.json` half unfixed: `SOURCE_PATH` was still a module-level constant computed from
`path.dirname(fileURLToPath(import.meta.url))` — this SCRIPT's own directory, i.e. this git
checkout's committed `kb/SOURCE.json` — regardless of what `root` was passed in. A caller passing
any `root` other than this exact checkout (a real host's canonical store root at
`kb/store-root.mjs`'s `storeRoot()`, or a test sandbox) got that root's `.rvf` files correctly, but
its name-alias data silently swapped for whatever this git clone happens to bundle. This is the
same "clone freshness is not artifact freshness" defect class ADR-069 named for
`scripts/brain-stamp.mjs` (Dream Cycle 2026-08-26, issue #175) — now a second, independent instance
in a sibling file, in the exact function PR #222 had already partially repaired five days ago.

## What's new

Nothing external. This is the fast-follow PR #222 itself did not make: its own diff (`cbca83b`)
touched only the `.rvf`-listing branch of `brainKnownSet()`; its own regression test
(`tests/unit/forge-currency-helpers.test.mjs`) proves only that half, never exercising the
`SOURCE.json` branch at all. Confirmed via `git show cbca83b -- kb/forge-currency.mjs`: the
`SOURCE_PATH` constant is untouched by that commit.

## Competitors — how other autonomous nightly/self-improvement harnesses treat "is my knowledge of
the environment sourced from the live target or from a stale local copy?" (grade C: general
knowledge, informs framing only; the implementation is justified by this repo's own measurement)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | Runs experiments against whatever environment/data is locally available at run start; no published distinction between "live target state" and "the harness's own bundled copy" as a first-class concern. | C |
| OpenHands | Sandboxed workspace snapshots are the ground truth for a given run; cross-run provenance drift (a stale bundled manifest vs. the real target) is not a documented first-class check. | C |
| DSPy/GEPA | Optimizes against a fixed dataset/metric; a metric silently computed from a stale cached copy instead of the live target is a known general reproducibility hazard in ML tooling, not something the framework itself detects. | C |
| SWE-agent | Reads repository/environment state live per task; no cross-file "does this reader still consult the checkout instead of the live instance" audit trail that we're aware of. | C |
| Cursor background agents | Proprietary; no published architecture describing provenance-source auditing for background-agent environment reads. | C |

This repo's own `docs/adr/0069-artifact-bound-source-coverage.md` is the more disciplined baseline
already in place — tonight closes a second gap in enforcing it, not importing a practice from
elsewhere.

## The hypothesis (frozen before implementation, unchanged since)

> Given `kb/forge-currency.mjs`'s `brainKnownSet(root)`, when `root` is a store root whose own
> `SOURCE.json` differs from (or is entirely absent relative to) this git checkout's committed
> `kb/SOURCE.json`, the function's name-alias half will read this checkout's own `kb/SOURCE.json`
> regardless of `root` (via the module-level `SOURCE_PATH` constant), so the returned "known" Set
> mixes live `.rvf` filenames from `root` with a foreign or stale set of `sourceRepo`/`kbName`
> aliases — changing the read to `path.join(root, 'SOURCE.json')` should make the returned Set
> reflect only `root`'s own declared state, subject to: zero behavior change for the `.rvf`-derived
> correctness PR #222 already fixed, and the existing graceful skip when no `SOURCE.json` exists at
> the resolved path must be preserved (a brain with no `SOURCE.json` is not an error).

## Evaluation

- **Evaluator:** `npx vitest run tests/unit/forge-currency-helpers.test.mjs` (targeted TEETH proof)
  and the full `npx vitest run tests/unit` / `npx vitest run tests/integration` suites, baseline
  (`git stash` on the two changed files, unmodified `main`@`282c66c0`) vs. candidate.
- **New test TEETH, verified against the real historical defect, not module-absence:** reverting
  only `kb/forge-currency.mjs` (keeping the two new test cases) via
  `git stash push -- kb/forge-currency.mjs` reproduces exactly the predicted failure —
  `known.has('totally-different-repo')` is `false` (root's own `SOURCE.json` is ignored) and
  `known.has('metaharness')` is `true` (this checkout's real `kb/SOURCE.json` leaks in) on BOTH new
  cases. Restoring the fix returns both to green.
- **Full `tests/unit/forge-currency-helpers.test.mjs`:** 5/5 pass post-fix (3 pre-existing + 2 new).
- **`npm run claims:verify`:** 3 PASS / 4 SKIP — unchanged from every recent night's documented
  baseline (this container's canonical store root never materializes; SKIPs are pre-existing
  environmental, not caused by tonight's candidate).
- **`npm run eval:gate`:** not the relevant evaluator (no retrieval/grounding/ranking surface
  touched — this is a corpus-inventory bookkeeping fix). Independently confirmed
  `EVALUATED=blocked` regardless: `eval-brain: no brain at /root/.cache/ruvnet-brain/kb`; `LLM_EVAL`
  also blocked (`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` both absent this session).
- **`npm run qa:pr`:** `version`/`execution-policy`/`substitution`/`catalog`/`contract`/`mesh`/
  `plugin` lanes PASS. `docs` lane's 55 pre-existing doc-currency findings and `wiring` lane's
  pre-existing findings reproduce on unmodified `main` and reference zero files this candidate
  touches (grep-confirmed: `grep -i forge-currency` on both lanes' output returns nothing).
  `convergence` lane required `npm run convergence:write` (mechanical `data/convergence-manifest.json`
  regeneration, committed in this PR, per every recent night's documented precedent).
- **Full `test:unit`, baseline vs. candidate:** baseline (pristine `main`@`282c66c0`, both changed
  files and the new report file removed) — **6 failed files / 6 failed tests / 3755 passed / 28
  skipped / 161 todo (3950 total)**. Candidate — **5 failed files / 5 failed tests / 3758 passed /
  28 skipped / 161 todo (3952 total)**. The 5 candidate failures
  (`advocacy-ignored`, `advocacy-outcomes`, `hook-shim-fallback-once`,
  `release-identity-invariants`, `user-settings`) are a byte-identical subset of the baseline's 6 —
  all pre-existing chmod/EACCES-under-root-user or release-identity environmental artifacts,
  documented unchanged since 2026-08-26/08-28/08-31. The 6th baseline failure,
  `convergence-manifest.test.mjs` ("manifest is stale"), reproduces on PRISTINE, untouched `main` —
  confirmed independently of this candidate's diff by temporarily removing even the new report file
  and rerunning that one test file alone, red on unmodified `main`. It is fixed on the candidate
  side by the mandatory `npm run convergence:write` regeneration this PR commits (required whenever
  tracked files change, per every recent night's precedent) — a side effect of shipping any diff at
  all, not evidence about `brainKnownSet()` itself. The +3 passed (3755→3758) = the 2 new
  `forge-currency` tests + the 1 `convergence-manifest` test the regenerated manifest now passes.
- **Full `test:integration`, candidate:** 5 failed files / 9 failed tests / 290 passed / 12 skipped
  / 53 todo (364 total) — matches the documented baseline signature exactly (byte-identical to the
  2026-09-05 ledger row's own baseline: `sqlite3`/`@xenova/transformers` missing, one pre-existing
  `reader-deadlock-regression` flake), all pre-existing/environmental, none referencing
  `kb/forge-currency.mjs` or its test file.
- **Blast radius:** `grep -rn "brainKnownSet\|SOURCE_PATH" --include=*.mjs` across `scripts/`, `kb/`,
  `plugin/`, `console/`, `tests/` returns exactly one production call site (`discover()`, line 170,
  the pre-existing zero-arg call) and the one test file. `SOURCE_PATH` was a module-local `const`,
  never exported — nothing else could have depended on it.
- **Independent critic (separate subagent, fresh context, not this candidate's author) verdict:
  CLEAR.** Checked reward-hacking, correctness against the one real call site and against how
  `bin/install.mjs` resolves its own `SOURCE.json` (root-relative, consistent with this fix), blast
  radius, regression risk in both directions (false-negative masking vs. false-positive drift),
  test-quality (independently re-ran the TEETH revert-and-restore proof itself), security, and
  scope creep. No blocking issues.

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete path-resolution fix (same precedent as
every other structurally identical fix on this surface: 2026-08-26, 2026-08-28, 2026-08-31).

## Evidence

OBSERVATION (PR #222's own diff, re-read: it fixed the `.rvf`-listing half of `brainKnownSet()` and
left `SOURCE_PATH` as a module-level constant pointing at this checkout's own directory,
unconditionally) → MEASUREMENT (TEETH proof: reverting only the production fix reproduces the exact
predicted leak/omission on both new test cases; full suite baseline-vs-candidate comparison) →
DECISION (ACCEPT, pending human review and pending the independent critic's verdict).

## Reward-Hack Check

No existing test, benchmark, gold-data file, or scoring threshold was touched — `git diff` on all
pre-existing files shows only additive new `it()` blocks in
`tests/unit/forge-currency-helpers.test.mjs`, no modified assertions. The fix makes the "known" Set
strictly more accurate to the actual `root` passed in (removing a false inclusion, not adding a
false exclusion, when `root` has no matching `SOURCE.json`), the opposite of a reward hack. New
tests confirmed non-vacuous (shown red before the fix, above).

## Security Review

No new attack surface: the changed code still performs the same read-only
`fs.existsSync`/`fs.readFileSync` pattern it always did, just at a path derived from `root` instead
of `import.meta.url` — same trust boundary (local filesystem, no network, no credential, no new
dependency). `root` itself is not attacker-influenced in the one real call site (`discover()`'s
zero-arg call resolves it via `storeRoot()`, which only consults `RUVNET_BRAIN_KB`/`KB_DIR`
environment variables already trusted by every other reader in this file family).

## Next steps

1. Human review and merge (or explicit rejection) of the draft PR.
2. If a third sibling reader of `SOURCE.json` (beyond `brainKnownSet()` and
   `scripts/claims-verify.mjs`, fixed 2026-09-01 in PR #227, itself still unmerged) is found on a
   future night, the pattern is now: resolve `SOURCE.json` relative to the caller's actual root
   parameter, never a script's own `import.meta.url` directory.
3. Governance (repeated from every night since 2026-08-26, still true): dream-cycle PRs continue to
   accumulate faster than they are reviewed. See ledger row for tonight's exact open-PR count.

## Witness

```
SESSION_COMMIT = 282c66c0467cf11d1fdd5f9850d61e9b27ce579f
REPORT_HASH    = 53e40c971ec07856908fca0e4cb49743826c5ef3363983c4f3d6d8b699400420
WITNESS        = e8d31850da72c5565990e5681a1fdabd66d952fa0617dd41d5a709b3a2dd7258
```

Note on `REPORT_HASH`: it is the sha256 of this report's content as it stood through the
"Recommendation" section, computed BEFORE this Witness section was rewritten with the stamp values
(the standard chicken-and-egg order this pipeline's STEP 16 specifies). It will therefore NOT match
a fresh `sha256sum` of this file as it now reads, since filling in this section changed the bytes —
expected by construction, not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 282c66c0467cf11d1fdd5f9850d61e9b27ce579f` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. `npx vitest run tests/unit/forge-currency-helpers.test.mjs` — 5/5 pass.
4. Revert only `kb/forge-currency.mjs` (`git stash push -- kb/forge-currency.mjs`), re-run the same
   file — the two new cases must fail with `known.has('totally-different-repo')` false and
   `known.has('metaharness')` true. Restore (`git stash pop`) and confirm green again.
5. `printf '%s%s' 53e40c971ec07856908fca0e4cb49743826c5ef3363983c4f3d6d8b699400420 282c66c0467cf11d1fdd5f9850d61e9b27ce579f | sha256sum` → must equal `WITNESS` above.

## Recommendation

ACCEPT pending human review. Small (one file, ~15 lines of production diff excluding comments; one
test file, two new cases), non-duplicative of open dream-cycle PRs on other surfaces, zero blast
radius beyond the function's own test file and its single call site, closes a fast-follow gap PR
#222 itself left open five days ago on the identical function.
