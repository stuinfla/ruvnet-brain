# Provenance-Stratum Crediting the Wrong Citation SOTA Report — 2026

**Dream Cycle 2026-09-03 — DEEP=grounding-quality, SCAN=retrieval-precision,citation-binding (slot 3)**

**Concurrent-run note, read this first**: a separate firing of tonight's same scheduled routine
(same SLOT=3, same DEEP=grounding-quality) landed first as issue #236 / draft PR #237
(`dream/2026-09-03-grounding-quality`) — a citation-header rank-hijacking security finding
(`ADR-0076`, Proposed), reaching `INCONCLUSIVE` because the real fix is architectural (touches
`forge-ask-all.mjs`'s output format, used by 3+ other consumers) and not a bounded nightly patch.
That session also performed tonight's ledger reconciliation (confirming PR #186 and issue
#187/PR #188's fixes are already on `main` via commits `a04ffc9`/`0ae0196`/`39349c0`, closing both).
This report does not repeat that reconciliation. This candidate is a **different, disjoint,
non-overlapping finding**: it touches only `scripts/eval-brain.mjs` and
`tests/unit/eval-brain-gate.test.mjs` (PR #237 is docs-only: an ADR, a report, two evidence
scripts, and one `LEDGER.md` line). This branch, `dream/2026-09-03-grounding-quality-provenance-receipt`,
is based on PR #237's tip (`962eb18`) so ledger rows append in order, same protocol as PR #187
(2026-08-28) and PR #215 (2026-08-31).

## TL;DR

`scripts/eval-brain.mjs`'s `gradeQuestion()` grades the `provenance` stratum's rule — "if a gist
chunk wins, it must carry its own status banner; a better hit from the real repo is not a
failure" — by checking `top?.repo` (the raw top-ranked citation) against `'ruv-gists'`. But
`verifyGrounding()` can accept a citation ranked *below* the top one when the top-ranked citation
is unresolved/fabricated (`receipt.repo` names the one that actually resolved, already computed
earlier in the same function as `routedRepo` and already used for the `routed` metric since PR
#187, 2026-08-28). This is the **exact same sibling gap** PR #187 closed for `routed`, never
migrated to the `provenance` branch two lines below it in the same `switch` statement.

## What's new

Nothing external — a sibling-defect closure inside this repo's own evaluation harness, in the same
family as PR #143/#155/#178/#187's "the check used the wrong signal for the state it claims to
detect" pattern, applied here to the one remaining stratum branch in `gradeQuestion()` that PR #187
did not touch.

## Competitors — how other autonomous nightly/self-improvement harnesses treat "which retrieved item gets credited when several are returned" (grade C: general knowledge, single-source per row; informs framing only, does not justify the implementation — the implementation is justified by this repo's own measurement below)

| System | Relevant stance on crediting which retrieved/cited item actually grounded an answer | Grade |
|---|---|---|
| Sakana AI Scientist | Evaluates final paper/experiment outputs against reviewer-style rubrics; no first-class notion of "which citation among several actually backs this claim" distinct from citation presence. | C |
| OpenHands | Tool-use trajectories are scored on task success; when multiple tool/file results are returned, provenance-of-the-winning-result is not a tracked first-class signal. | C |
| DSPy/GEPA | Retrieval-augmented pipelines optimize an end metric; a metric that credits the wrong retrieved passage while getting an unrelated property right is a known general RAG-evaluation failure mode, not specifically solved by the framework. | C |
| SWE-agent | Localization/patch-correctness metrics check the produced diff, not which retrieved context snippet the agent actually used. | C |
| Cursor background agents | Background-agent evaluation is typically end-task-success-based; multi-citation attribution is not a documented first-class concept. | C |

The pattern repeats from the 2026-08-28 report: crediting "what actually grounded this" against the
top-ranked/first result rather than the one actually verified/used is a common, usually-invisible
RAG-evaluation gap. This repo already has the correct primitive (`receipt`, threaded into
`routedRepo`); tonight's fix wires the one remaining consumer of the wrong signal to it.

## Hypothesis (frozen before implementation, unchanged since)

> Given the frozen 120-question held-out gate's `provenance` stratum, when `gradeQuestion()`'s
> banner-requirement check is computed from `routedRepo` (`receipt?.repo ?? top?.repo ?? null`,
> the citation `verify-citation.mjs` actually verified as resolving on disk) instead of the raw
> `top?.repo`, then the banner gate should correctly (a) NOT require a banner when a genuinely
> better, non-gist repo hit is the one that actually grounded the answer even if an unresolved
> gist-named citation ranks above it, and (b) correctly REQUIRE a banner when a `ruv-gists` chunk
> is the one that actually grounded the answer even if an unresolved non-gist-named citation
> happens to rank above it — subject to zero behavior change for the common case where the
> top-ranked citation is also the one that resolved, and zero behavior change for the two other,
> receipt-less callers (`rerank-cap-eval.mjs`, `rerank-cap-warm-ab.mjs`).

## Testability gate → candidate → baseline → evaluation

Testable tonight without any model call or materialized corpus: `gradeQuestion()` is a pure
function over its arguments, exercised directly by unit tests (`tests/unit/eval-brain-gate.test.mjs`).
`npm run eval:gate` (the gate of record) is **not** the applicable evaluator here — the defect is in
the grading function's own logic, not in retrieval quality, and (as every prior night's ledger row
documents) this container has never materialized a corpus (`no brain at
/root/.cache/ruvnet-brain/kb`, reconfirmed tonight via `brain-score.mjs`/`store-root.mjs`,
`stores 0 dark 0`) — a pre-existing, environmental condition, not new tonight and not
credential-related (`OPENROUTER_API_KEY` unset this session; `LLM_EVAL=blocked`, a legitimate
outcome per this routine's own invariants).

**Candidate** (`scripts/eval-brain.mjs`, one line):

```diff
     case 'provenance':
-      return { grounded, routed: null, abstained, pass: !!grounded && (top?.repo !== 'ruv-gists' || bannerPresent) };
+      return { grounded, routed: null, abstained, pass: !!grounded && (routedRepo !== 'ruv-gists' || bannerPresent) };
```

**Baseline**: pre-candidate `gradeQuestion()`, exercised with two constructed adversarial cases
mirroring PR #187's own precedent test shape (see Evaluation Receipt).

## Evaluation receipt

New TEETH test (`tests/unit/eval-brain-gate.test.mjs`, "provenance credits the citation
verify-citation.mjs actually resolved...") constructs both directions:

1. Top-ranked citation names `ruv-gists` but is unresolved (fabricated); the citation that actually
   resolved is a different, real repo (`ruflo`), no banner. **Pre-candidate**: `pass=false`
   (wrongly demands a banner for a citation that never won). **Post-candidate**: `pass=true`.
2. Top-ranked citation names a non-gist repo (`ruflo`) but is unresolved; the citation that
   actually resolved is a `ruv-gists` chunk with no banner. **Pre-candidate**: `pass=true`
   (silently bypasses the one mechanism this stratum exists to test). **Post-candidate**:
   `pass=false`; with a banner present, `pass=true` on both pre- and post-candidate code (sanity
   control, not a differentiator).

Reproduced directly: `npx vitest run tests/unit/eval-brain-gate.test.mjs` — 1 failure
(`expected false to be true`, case 1 above) on pre-candidate code; 17/17 pass post-candidate.

Regression scope, baseline vs. candidate (`git stash`/`pop` on this container):
- `test:unit`: byte-identical failure set both sides — 5 files / 6 tests of 3917 (advocacy-ignored,
  advocacy-outcomes, hook-shim-fallback-once, session-snapshot-health ×2, user-settings), all
  pre-existing chmod/EACCES-under-root container artifacts (this container runs as root, so
  permission-restriction fixtures cannot actually restrict access) — the same class this repo's
  ledger has documented since 2026-08-26. `convergence-manifest.test.mjs` additionally required
  `npm run convergence:write` after touching tracked source (expected, same as PR #215's
  precedent); regenerated and committed alongside this candidate.
- `test:integration`: byte-identical failure set both sides — 9 tests across 6 files
  (`anticipate-dial`, `anticipate`, `console-apply-timings`, `health-repair` ×5,
  `reader-deadlock-regression`), all pre-existing `sqlite3`/`@xenova/transformers`/EACCES-under-root
  infra blockers unrelated to the changed file (confirmed via diff, not grep alone — identical
  before and after). Both-hosts hook conformance gate: green (not in either failure set).
- `qa:pr`: overall `FAIL` on both baseline and candidate, from the `docs` lane (51 pre-existing
  `stamp-lags-doc` violations across ADRs predating tonight, confirmed identical pre/post) and the
  `catalog` lane (model-catalog snapshot >14 days stale, confirmed identical pre/post, needs a live
  network refresh unrelated to grounding). Every other lane (version, convergence, execution-policy,
  wiring, substitution, contract, mesh, plugin) passes on the candidate.
- `claims:verify`: 3 PASS / 4 SKIP, matching every prior night's documented baseline exactly.
- `eval:gate`: not applicable (see Testability gate above) — `EVALUATED=blocked`,
  `no brain at /root/.cache/ruvnet-brain/kb`, the same pre-existing container condition every prior
  grounding-quality night has documented.

## Darwin lineage

Not run — no continuous parameter to evolve for a one-line scoring-attribution fix (same rationale
as PR #187's precedent).

## Evidence

OBSERVATION (`routedRepo` is already computed and already used for `routed`, but the sibling
`provenance` branch two lines below still reads raw `top?.repo`) → MEASUREMENT (TEETH red pre-fix,
green post-fix, reproduced directly; full-suite regression byte-identical baseline vs. candidate) →
DECISION (ACCEPT, pending human review).

## Reward-hack check

Independent adversarial critique (separate agent, not this candidate's author) verdict: **CLEAR**.
Checked: (1) the claimed bug reproduces in both directions against the current, post-candidate code
and the pre-candidate code; (2) the fix is not a one-directional score inflator — when `grounded`
is false, `pass` stays false regardless of which repo signal is used; when `receipt.repo` equals
`citations[0].repo` (the common case), `routedRepo` reduces to exactly `top?.repo`, so behavior is
byte-identical to before for every already-passing/already-failing row that isn't one of the two
constructed mismatch cases; (3) blast radius: `gradeQuestion` has exactly 3 call sites repo-wide;
the two receipt-less callers (`rerank-cap-eval.mjs`, `rerank-cap-warm-ab.mjs`) fall back to
`top?.repo` unchanged, the same fallback precedent PR #187 already established as safe for them;
(4) the `adversarial` stratum's `abstained` check (raw `top.ce`) is not an analogous gap — it
measures whether the retriever surfaced anything relevant at all, a property of the raw top-ranked
hit's cross-encoder score independent of which citation later resolves on disk, so there is no
"receipt" concept it should prefer instead. No benchmark, threshold, or gold answer touched; no
corpus modified; no model call made.

## Security review

Pure comparison/branching logic inside `gradeQuestion` — no I/O, no execution of untrusted input,
no privilege or authority change, no interaction with the citation-parsing security surface PR #237
flagged tonight (`ADR-0076`, a `verify-citation.mjs` parser-level concern, unrelated to this
grading-function fix). Not security-sensitive.

## Scan findings

Both scans (retrieval-precision, citation-binding) are subsumed by tonight's DEEP; no additional,
independent scan findings beyond PR #237's own (which this report does not repeat, per this
routine's own "do not rediscover a failed direction" guidance and to avoid duplicating that
session's already-published findings).

## Witness

```text
SESSION_COMMIT = cbca83bc7a72a8ee4552d50530e391694200b670
REPORT_HASH    = <sha256 of this file as committed, immediately before this section was filled in>
WITNESS        = sha256(REPORT_HASH + SESSION_COMMIT)
```

**Verifier procedure** (5 steps, reproducible by anyone):
1. `git show <this-commit>^:docs/dream-cycle/2026-09-03-grounding-quality-provenance-receipt-report.md` — the version of this file without the Witness section filled in (or diff this commit to isolate the report content used for hashing).
2. `sha256sum` that content → should match `REPORT_HASH` below.
3. Concatenate `REPORT_HASH` with `SESSION_COMMIT` (no separator), `sha256sum` the result.
4. Compare against `WITNESS` below — a match binds this report's content to this exact session commit.
5. Independently re-run `npx vitest run tests/unit/eval-brain-gate.test.mjs` at this commit (17/17
   pass) and against the pre-candidate `scripts/eval-brain.mjs` (`git show
   cbca83b:scripts/eval-brain.mjs`, 1 failure) to reproduce the underlying finding directly, rather
   than trusting this report's own claim.

```text
REPORT_HASH = 5dd4e7999c39ce7bfb62cb49b6dbccee188886bf46df321b4530a5710eed0e53
WITNESS     = 057f7f3cc406555d67ec611ca19675b1a432e48b7611e0cfb7da15d2f28eafb1
```

## Recommendation

`evaluated: yes` / `verdict: ACCEPT`, pending human review (this session never self-merges and
never autonomously promotes candidate state). Separately, restating what PR #237's report already
flagged: the `dream/*` review backlog (17 open/draft PRs as of tonight, zero merged since
2026-08-31) is the single highest-value action available to the owner right now, independent of
anything in this report.
