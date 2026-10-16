# Dream-Cycle Freshness-Gate SOTA Report — 2026

## TL;DR

`scripts/brain-score.mjs`'s `staleness()` — the ONE gate deciding whether a quality/coverage
reading is "current" enough to back a claim — treated a reading dated *after* `now` (clock skew,
or a corrupt/hand-edited `recorded`/`generatedAt` stamp) as **better than fresh**: negative
`ageDays`, `stale: false`, `why: null`. Reproduced live tonight (`-3d → {stale:false}`). Fixed with
a 4-line guard: a future-dated reading is now `stale: true` with a named reason. Red→green test
added; 25/25 pass in the touched test files; zero other call sites affected (only 3 test files
import this module — it is a diagnostic probe, not a hot production path).

## What's new

Every sibling "checkout-time vs. build-time" defect this codebase has fixed before (brain-stamp's
`builtFromSha` — PR #176; `readPanel()`'s own header, ISSUE #258; `corpusAgeFor()` — open,
unmerged, PR from 2026-10-01) is about a timestamp that is **too old** being mistaken for fresh.
Tonight's finding is the mirror case nobody had checked: a timestamp that is **too new** — which a
budget check (`ageDays > maxAgeDays`) structurally cannot catch, because a negative number is
always less than a positive budget. The guard that exists to say "don't trust a reading nobody can
vouch for" was itself unable to distinguish "vouched for, 2 days old" from "allegedly recorded 3
days from now," and silently chose to trust the impossible one.

## Competitor landscape (grade, per source)

| System | Freshness/staleness handling | Grade |
|---|---|---|
| Sakana AI Scientist | Experiment logs are timestamped at write time by the host process; no published handling of writer/reader clock skew in its public materials. | C (single-source, not independently reproduced here) |
| OpenHands | Session/event timestamps come from the runtime's own clock; cross-host skew is a known general distributed-systems hazard, not something OpenHands documents specially. | C |
| DSPy/GEPA | Optimizer traces carry step indices, not wall-clock freshness gates — a different axis entirely (compile-time quality, not corpus currency). | C |
| SWE-agent | Trajectory logs are append-only and locally timestamped; no public freshness-budget concept comparable to this repo's `maxAgeDays`. | C |
| Cursor background agents | Background-agent run metadata is proprietary; no public documentation of how (or whether) a future-dated artifact timestamp is handled. | C |

No competitor here publishes a reproducible, inspectable freshness-budget mechanism comparable to
this repo's own `staleness()` — this is an internal-tooling finding, not a benchmarked claim
against any of the above, and every row above is graded C (informs, does not alone justify)
because none could be independently verified tonight; they are included because `dream.config.json`
asks every night to consider them, not because this fix is "better than" a competitor's unrelated
system.

## The hypothesis (frozen before the broader evaluation ran)

> Given `scripts/brain-score.mjs`'s `staleness(at, maxAgeDays, now)` gate, when a dimension's
> recorded timestamp (`at`) is dated after `now` — clock skew between writer and reader, or a
> corrupt/hand-edited `recorded`/`generatedAt` field — then the candidate should report that
> reading as `stale: true` with a diagnostic `why`, relative to the baseline which reports
> `stale: false, why: null` for the identical input, subject to: no existing in-budget-fresh case
> flips to stale, and no existing over-budget-stale case changes behavior.

Frozen at the moment the bug was reproduced (`node -e` repro below, baseline behavior captured
before any source edit); the broader evaluator suites (`claims:verify`, `test:unit`,
`test:integration`) ran afterward as regression confirmation, not as part of falsifying the
hypothesis itself.

## Benchmarks / Evaluation

Reproduction (baseline, pre-fix, this exact source tree via `git stash`):

```
$ node -e "...staleness(futureISOString, 14, now)..."
{ stale: false, ageDays: -3, why: null }
```

Evaluator entrypoints (per `dream.config.json`):
- `npm run eval:gate` — **blocked**: `no brain at /root/.cache/ruvnet-brain/kb` (this container
  never materializes a corpus; `stores 0 dark 0` via `kb/store-root.mjs`, same pre-existing
  condition every brain-currency night has recorded since 2026-08-19).
- `npm run claims:verify` — 3 PASS / 4 SKIP, byte-identical composition to every prior documented
  night; unaffected by this change (it does not touch any claimed number).
- `npm run test:unit` / `npm run test:integration` — see Evidence below for baseline-vs-candidate
  classification.
- `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY` in this container. Legitimate per the compiled
  invariants; candidate was deliberately chosen to be verifiable without a model call.

## Evidence

- **MEASUREMENT** (reproduced, deterministic): baseline `staleness('2026-10-19T00:00:00.000Z', 14, Date.parse('2026-10-16T00:00:00Z'))` → `{stale:false, ageDays:-3, why:null}`. Candidate → `{stale:true, ageDays:-3, why:'-3d — recorded in the future (clock skew or corrupt timestamp)'}`.
- **MEASUREMENT**: `tests/unit/brain-score-producer.test.mjs` 21/21, plus the two sibling brain-score test files, 25/25 total — all pass on candidate; the new TEETH test reproducibly fails on baseline (`git stash`).
- **OBSERVATION** (blast radius): `grep -rl "from.*brain-score\.mjs" --include="*.mjs" .` → exactly 3 files, all test files (`brain-score-producer.test.mjs`, `brain-score-never-materialized.test.mjs`, `brain-grade-groundtruth-timestamp.test.mjs`); zero integration tests, zero production/plugin code imports this module. `scripts/brain-score.mjs` is a manually-invoked diagnostic probe, not a hot path.
- **MEASUREMENT**: `npm run test:integration` run twice on the identical candidate commit: run 1 (under concurrent `test:unit` CPU contention) → 10 failed files/27 failed tests; run 2 (isolated) → 9 failed files/22 failed tests. The failing SET differed between runs of the *same* code — the signature of load-contention flake, not a deterministic regression (a real regression reproduces identically every run). Every failing file in both runs (`anticipate*`, `health-repair`, `managed-cli-server-boundary`, `model-managed-checker-native`, `reader-deadlock-regression`, `unprompted-speech-registry`, etc.) is unrelated to corpus-freshness/staleness and does not import the changed module (confirmed above) — a logical impossibility for this diff to have caused them.
- **MEASUREMENT**: `npm run test:unit` (full, 8766 tests): 24 failed files/63 failed tests/8505 passed. None of the 3 brain-score test files are in the failing set. 4 of the 24 (`advocacy-ignored`, `advocacy-outcomes`, `hook-shim-fallback-once`, `user-settings`) are the exact filenames this repo's own 2026-08-28 ledger row already documented as pre-existing `chmod`/EACCES-under-root fixtures; independently re-ran `advocacy-ignored.test.mjs` + `user-settings.test.mjs` in isolation tonight and confirmed the same failure mode (`expect(r.ok).toBe(false)` fails because chmod-based read-only simulation does not restrict the container's root user) — not candidate-related.
- **INFERENCE**: given (a) zero import path from any integration test or the other 20 unit-test failures to `scripts/brain-score.mjs`, (b) the integration failure set itself was unstable across two runs of identical candidate code, and (c) a sample of the unit failures independently reproduces a previously-documented, unrelated, container-environment limitation — all 24 unit and up to 10 integration failing files are classified **pre-existing/environmental**, not caused by this candidate. A full baseline-vs-candidate rerun of the two largest suites (~16 min + ~5 min again) was judged not to add further decision-relevant evidence over the import-graph proof already in hand, and was not run, consistent with the compiled budget invariant ("a hard ceiling that stops adding work when effort runs long").
- **REJECTION** (ruled out, not pursued): re-proposing the already-known `corpusAgeFor()` checkout-mtime bug (`kb/forge-ask-all.mjs:1546`, still present on `main`) — skipped per `findingPolicy.skipIf: existing-fix-pr` (unmerged PR from 2026-10-01 already covers this exact fingerprint).

## Reward-Hack Check (independent critic pass)

Did it weaken the benchmark? No — `evals/held-out.json`, `evals/baseline.json`, and every grading fixture are untouched; this change is not in the grading path at all, it is the grading-metadata *freshness* gate. Alter gold answers? No. Cherry-pick the test to the one example? No — the guard is `ageDays < 0`, a general predicate, not a literal `-3` check (verified by reading the diff). Exploit the evaluator? N/A — this *is* part of the evaluator-support code, and the fix strictly narrows what it accepts, never widens it. Hide cost? No. Touch a threshold? No — `maxAgeDays` values (14/30/7) are byte-identical to baseline. Rely on an undocumented cache? No. Could the fix be the opposite failure mode — "always stale," which would protect nothing by crying wolf constantly? No — the existing passing case `staleness('2026-08-12T00:00:00Z', 14, now).stale === false` (ageDays=1, in-budget) is untouched and still passes. The fix is one-directional: it can only convert a previously wrong `stale:false` into a correct `stale:true` for `ageDays < 0`; it cannot flip any currently-correct verdict.

## Security Review

No prompt-injection surface, no MCP/tool-authority change, no credential handling, no filesystem or network I/O added (pure function), no agent impersonation, no cross-agent or memory/benchmark poisoning vector, no supply-chain change (no new dependency), no new autonomous mutation capability — `staleness()` is a read-only diagnostic predicate with no side effects before or after this change.

## Darwin

N/A. This is a discrete logic-correctness fix (a missing boundary case in a boolean guard), not a continuous or combinatorial parameter with a fitness landscape to search — there is nothing for bounded Darwin to evolve here. (`npx @metaharness/darwin --version` confirmed available in this container; not invoked, because inapplicable, not because it is absent.)

## Witness

```
SESSION_COMMIT = b44f51ccefe15432d0ba4c5bfffe39aa10bbf6d0
REPORT_HASH    = 3bf80c292773fafe5bf0917a42778e7d05e5837e69307b234dddc41e3a8d35d8
WITNESS        = 4a2c344a3c21557f29d8bda12237b6d6126920c9e96dfa8f6d417fe2906637fc
```

(`REPORT_HASH` is the sha256 of this file's content immediately before this Witness section's numbers were filled in — reproduce by removing this fenced block's two filled values, restoring the placeholder line order, and hashing; or simply treat this stamp as the frozen checkpoint and verify the WITNESS derivation algebraically: `sha256(REPORT_HASH + SESSION_COMMIT) == WITNESS`.)

Verifier procedure (reproducible by anyone):
1. `git fetch origin dream/2026-10-16-brain-currency && git checkout dream/2026-10-16-brain-currency`
2. `git stash` the one-function diff in `scripts/brain-score.mjs`, confirm the new test in
   `tests/unit/brain-score-producer.test.mjs` goes RED (`npx vitest run tests/unit/brain-score-producer.test.mjs -t FUTURE`).
3. `git stash pop`, re-run the same command, confirm GREEN.
4. `sha256sum` this report file, concatenate with `SESSION_COMMIT`, `sha256sum` again — compare to `WITNESS` in the PR body.
5. Re-run `npm run claims:verify` and diff against the PASS/SKIP composition quoted above.

## Next steps (concrete)

1. A human reviewer merges (or rejects) tonight's draft PR — it is the 6th dream-cycle PR with any
   chance of merging since 2026-08-26 (per issue #410's standing backlog count), and the smallest
   (one function, ~6 lines) of the 58 currently open.
2. Separately, and NOT part of tonight's candidate: the unmerged 2026-10-01 `corpusAgeFor()` fix
   (checkout-mtime vs. `RVF-GENERATIONS.json` `builtUtc`) is still a real, live, unduplicated defect
   on `main` — confirmed tonight still present at `kb/forge-ask-all.mjs:1546`. It was not re-proposed
   tonight per the ISSUE DISPOSITION OVERRIDE's `skipIf: existing-fix-pr`, but it has now sat
   unmerged for 15 days.
3. If the backlog (#410, open since 2026-10-06, now its 3rd brain-currency-night mention) is not
   triaged soon, consider whether future brain-currency nights should spend their *research* budget
   confirming the surface is clean (as tonight did, successfully) rather than re-filing the same
   process finding a 4th time.
