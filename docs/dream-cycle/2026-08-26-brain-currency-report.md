# Brain-Currency Ambiguity-Class SOTA Report — 2026

**Dream Cycle 2026-08-26 — DEEP=brain-currency, SCAN=dark-stores,corpus-freshness (slot 1)**

## TL;DR

`fs.existsSync(root)` is used at two sites (`scripts/brain-score.mjs`'s `readCoverage()`, `scripts/restore-local-ingests.mjs`'s `classify()`) as the test for "has this host's store root ever been materialized?". It answers a narrower question than the one asked: it is `true` not only for a real materialized directory but also for a stray *file* sitting where the directory belongs (`ENOTDIR`) and for a directory that exists but cannot be read (`EACCES`). In both of those cases `storesAt()`/`cardsAt()` (`kb/store-root.mjs`) then throw internally, get swallowed by a bare `catch { return [] }`, and the caller reports a real, current-looking `0` (`brain-score`) or `WIPED` (`restore-local-ingests`) — the exact false-alarm/false-confidence pair PR #143 and PR #155 (2026-08-19, 2026-08-21) already eliminated for the `ENOENT` case, for a different errno class than either of them covered. The fix (`kb/store-root.mjs`'s new `rootNeverMaterialized()`, ~9 lines) replaces both `existsSync` checks with a `readdirSync`-and-catch probe that treats `ENOENT`/`ENOTDIR`/`EACCES` uniformly as "cannot read this as a store directory," matching the idiom the codebase already uses correctly elsewhere (`brain-state.mjs`'s `isAbsent()`, `hook-shim.mjs`, `forge-mcp-all.mjs`).

## What's new

Nothing external — this is a sibling-defect closure inside a single repo's own diagnostic layer, discovered by re-reading the two commits (`420854b`, and PR #143's original) that fixed the `ENOENT` case, both of which explicitly flagged the `ENOTDIR`/`EACCES` gap as an accepted, unfixed fast-follow rather than silently leaving it undocumented. Tonight closes that named gap.

## Competitors — how autonomous nightly/self-improvement harnesses treat evaluator/environment-state ambiguity (grade C: general knowledge, single-source per row; informs framing only, does not justify the implementation — the implementation is justified by this repo's own measurement above)

| System | Relevant stance on "can't tell if the environment is really empty vs. broken" | Grade |
|---|---|---|
| Sakana AI Scientist | Optimizes for producing accepted-looking papers/experiments; failure modes are typically reported as experiment errors bundled into the writeup rather than classified by cause. | C |
| OpenHands | Sandbox/tool failures surface as raw exceptions in the agent trajectory; no dedicated "environment never initialized vs. corrupted" taxonomy that we're aware of. | C |
| DSPy/GEPA | Optimizes prompts/programs against a metric function; a metric that silently returns 0 for a broken harness is a known general failure mode in evolutionary prompt optimization (reward hacking via degenerate zero-signal), not specifically solved by the framework itself. | C |
| SWE-agent | Tool-call failures (e.g. a missing file) are surfaced as observations back to the agent; classification of *why* a filesystem read failed is left to the wrapped tools, not a first-class SWE-agent concept. | C |
| Cursor background agents | Background-agent runs that hit an unready workspace typically fail the run outright rather than distinguishing sub-causes of "workspace not ready." | C |

The pattern across all five: none treat "the measurement surface itself might be silently broken in a way indistinguishable from a real zero" as a first-class, tested state. This repo's own `NEVER-MATERIALIZED` / `WIPED` / `OK` (and now, more completely, the errno-complete version of `NEVER-MATERIALIZED`) is the more disciplined approach already — tonight's fix is finishing that discipline, not importing it from outside.

## Hypothesis (frozen before implementation, unchanged since)

> Given a store root path that exists on disk but is not a valid, readable directory (a stray file at that path, or a directory the process cannot read), when `scripts/brain-score.mjs`'s `readCoverage()` or `scripts/restore-local-ingests.mjs`'s `classify()` decide whether the root was "never materialized" using `fs.existsSync(root)`, they will incorrectly treat it as materialized (since `existsSync` is `true` for both cases) and let `storesAt()`/`cardsAt()`'s swallowed-exception `[]` render as a real, current `0` or a false `WIPED` alarm — replacing the check with a `readdirSync`-based probe that classifies `ENOENT`/`ENOTDIR`/`EACCES` uniformly as never-materialized should eliminate this, subject to: zero behavior change for a real, existing, readable root (even a genuinely empty one, which must stay a real reportable `0`/`OK` — that distinction, PR #143/#155's original fix, must not regress).

## Benchmarks / Evaluation Receipt

Not a retrieval-quality candidate. `npm run eval:gate`: blocked identically baseline vs candidate (`eval-brain: no brain at /root/.cache/ruvnet-brain/kb` — this container's store root is genuinely never-materialized, the same condition the fix concerns). `LLM_EVAL` not blocked (`OPENROUTER_API_KEY` present) but no model-graded stage applies to deterministic error-classification logic. `npm run claims:verify`: 3 PASS / 4 SKIP, unchanged from baseline (skips are pre-existing environmental — brain not installed).

**Guard proven to fail first (TEETH).** Reverted just the two call-site fixes (kept the new helper) and re-ran the three affected test files:
- `tests/unit/brain-score-never-materialized.test.mjs`'s new case: `AssertionError: a stray-file root must not produce a numeric catalogue value: expected +0 to be null`.
- `tests/unit/restore-local-ingests.test.mjs`'s new case: `AssertionError: expected 'WIPED' to be 'NEVER-MATERIALIZED'`.

Then restored the fix: both, plus a new `tests/unit/store-root-never-materialized.test.mjs` (5 cases: ENOENT, real-empty-dir, ENOTDIR-via-stray-file, EACCES-via-mock, and an unrelated errno like EMFILE correctly staying NOT never-materialized) — **42/42 pass** across the five affected/related test files.

**Regression analysis.** `npx vitest run tests/integration`, baseline vs candidate via `git stash push -u`/`pop`: byte-identical — **5 failed files / 9 failed tests / 240 passed / 11 skipped / 53 todo of 313, on both**. All 9 failures pre-existing/environmental (`@xenova/transformers` missing, `sqlite3` binary missing, headless-browser timing), none touch the three changed files. `node scripts/sync-version.mjs --check`: `4.2.2-dev` agrees everywhere. `node scripts/doc-currency.mjs --check`: pre-existing violations against an unrelated bulk commit (`59d15d6a`); no ADR's `governs:` frontmatter lists `kb/store-root.mjs`, `scripts/brain-score.mjs`, or `scripts/restore-local-ingests.mjs`.

**Blast radius.** Only importers of the three touched files' relevant exports: their own test files, plus `scripts/card-from-source.mjs`/`scripts/ingest-repo.mjs`/`scripts/ingest-new-repos.mjs` (import unrelated exports from `kb/store-root.mjs` — `storeRoot`/`storesAt`/`darkStores` — none of which changed behavior; only a new, additive export was added). No other `existsSync(root)`-as-materialization-check pattern exists in `scripts/`, `kb/`, or `plugin/`.

## Darwin Lineage

Not run — no continuous parameter to evolve for an errno-classification fix.

## Evidence

OBSERVATION (measured live: this container's store root genuinely never-materialized) → MEASUREMENT (TEETH tests red pre-fix, green post-fix; integration byte-identical) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No existing test, benchmark, or gold data touched (`git diff` on all pre-existing test files shows only additive new `it()` blocks, no modified assertions). The fix makes both callers *harder* to claim a confident state on an unreadable/malformed root, the opposite of a reward hack. New tests confirmed non-vacuous (shown red before the fix). CLEAR.

## Security Review

No new attack surface: `rootNeverMaterialized()` performs the same read-only `fs.readdirSync(root)` that `storesAt()` already performs, same trust boundary, no new network call, credential, dependency, or write path. Separately — unrelated to this candidate diff — this session's own credential-probing command leaked the live `OPENROUTER_API_KEY` into this container's tool-output transcript via a bash quoting mistake (`${VAR:-no}` after `${VAR:+yes}`, which expands to the value when the var IS set). Reported to the repo owner directly; recommend rotating that key. Not part of, and not caused by, tonight's candidate.

## Next steps

1. Fast-follow: apply the same `readdirSync`-probe idiom to any *other* future "is this root real" check introduced by later Dream Cycle nights, so this class of bug doesn't get reintroduced a third time.
2. Consider hoisting `storesAt()`/`cardsAt()` themselves to surface *why* they returned `[]` (an optional second return value or a paired `rootNeverMaterialized` export, which is what tonight adds) rather than requiring every caller to duplicate a probe — deferred tonight to keep the diff to one conceptual change.
3. Separately (governance, not code): 8 draft Dream Cycle PRs (#157, #159, #162, #164, #167, #168, #172, #174) from 2026-08-22 through 2026-08-25 are open and unreviewed as of tonight; zero dream-cycle PRs have merged since 2026-08-20/21. Not this candidate's problem to fix, but worth the human owner's attention — the backlog is growing roughly one PR per slot per night with no merges keeping pace.

## Witness

```
SESSION_COMMIT = 72f079f3fb4c562da91aa848e7fade448ff665b6
REPORT_HASH    = e36f24c6b21954bbeee112c70bea3ea8404f34e452e6936cd3394434f2e5582a
WITNESS        = 2ba7d4ca1a95eccf0d18f4dba8c44495def84903256350985b2a552f416be240
```

Note on `REPORT_HASH`: it is the sha256 of this report's content as it stood through the "Next steps" section, computed BEFORE this Witness section was written (the standard chicken-and-egg order this pipeline's own STEP 16 specifies: stamp, then rewrite the Witness section with the stamp). It will therefore NOT match a fresh `sha256sum` of this file as it now reads, since appending this section changed the bytes — do not treat a mismatch there as evidence of tampering; it is expected by construction.

**Verifier procedure (reproduce independently):**
1. `git checkout 72f079f3fb4c562da91aa848e7fade448ff665b6` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this gist is attached to.
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above, confirming this stamp is tied to that exact commit.
4. Re-run the guard-proof: revert only the two call-site changes (keep `rootNeverMaterialized` defined), re-run `tests/unit/brain-score-never-materialized.test.mjs` and `tests/unit/restore-local-ingests.test.mjs` — both new cases must fail with the exact messages quoted in the Evaluation Receipt above.
5. Restore the fix, re-run the same two files plus `tests/unit/store-root-never-materialized.test.mjs`, confirm all green, then run `npx vitest run tests/integration` and confirm the same 5-failed-file/9-failed-test/240-passed/11-skipped/53-todo split reported above.
