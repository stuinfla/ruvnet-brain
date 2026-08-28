# Citation-Binding Integrity SOTA Report — 2026

## TL;DR

`kb/verify-citation.mjs`'s `parseCitations()` trusted ANY text shaped like the reader's own
citation-block format (`#N  repo=X ...` / `path : ...` / `title: ...`), wherever that text appeared
in the reader's stdout — including inside a retrieved document's own dumped body. Since
`forge-ask-all.mjs` prints each hit's full document text raw and unescaped, a retrieved document
that itself quotes or discusses this exact citation format (this repo's own documentation does, and
so could any ingested transcript, gist, or external corpus content) gets parsed as an EXTRA,
fabricated citation. If that fabricated citation's path happens to resolve — plausible, since
illustrative examples in this repo's own docs cite a real, well-known path — `verifyGrounding()`
reports `grounded: true` off a citation the retriever never actually returned, while the real,
genuinely-cited (and possibly fabricated) path goes unchecked. This directly undermines `eval:gate`,
the repo's own held-out, ground-truth grounding gate. Fixed by (1) bounding each citation's
`path`/`title` extraction to its own span (up to the next real header), so a malformed block can no
longer borrow a neighboring citation's fields, and (2) requiring citation ranks to be strictly
sequential (`#1, #2, …` with no gaps or repeats) — the reader's own invariant, which embedded
look-alike text does not organically continue.

## What's new

- `parseCitations()` in `kb/verify-citation.mjs` now enforces two invariants implicit in
  `forge-ask-all.mjs`'s own output contract but never checked: (a) a citation's `path`/`title` must
  come from its own block, not from a later or earlier one; (b) a rank slot (`#1`, `#2`, …) is only
  ever filled by the first header at that rank whose own block actually resolves a `path` — any
  header at that rank with no path is a look-alike, is skipped, and does **not** consume the slot, so
  a later, genuine header at that same rank can still fill it. (This second point was corrected
  mid-review from an initial, subtly-wrong version — see Correction below.)
- Zero behavior change for any currently-passing fixture or real reader output (`forge-ask-all.mjs`
  always emits ranks `#1..#N` in strict order with `path`/`title` immediately following each header —
  confirmed by reading the printer at `kb/forge-ask-all.mjs:3192-3200`, and by checking every other
  emitter of this format in the repo for compatibility with the invariant).
- Five new failing-then-passing tests added to the existing `tests/unit/verify-citation.test.mjs`
  suite (two from the initial fix, one added and one corrected after independent review, plus an
  end-to-end `verifyGrounding` test demonstrating the exact false-positive this closes).

## Competitors / prior art (grade C — internal code reading, not externally re-verified tonight)

| System | Citation-binding approach | Comparison |
|---|---|---|
| LangChain `RetrievalQA` w/ source docs | Citations carried as structured metadata alongside the LLM answer, not re-parsed from printed text | Avoids this whole bug class by never round-tripping through a printed, delimiter-based protocol — the deeper fix this repo's own reader/verifier boundary should eventually adopt (tracked as an open item below, not done tonight) |
| LlamaIndex response synthesis w/ node citations | Similar — citations are object references, not text parsed back out of a rendered answer | Same observation |
| Sakana AI Scientist (competitor named in `dream.config.json`) | Uses structured JSON tool outputs between pipeline stages, not printf-style human-readable dumps | Same class of structural fix; not adopted here to keep tonight's diff tiny |
| This repo, pre-fix | Round-trips through raw printed text with human-readable delimiters (`#N`, `path :`, `title:`) that a retrieved document's own body can reproduce | The defect this report fixes narrows, not closes, the gap to the structured-output designs above |

C-grade throughout: read from public documentation/memory of these projects' general design, not
independently reproduced tonight (no network research budget spent — LLM_EVAL=blocked, no model
calls, and the finding was internal-code-derived and immediately reproducible without external
sources).

## Hypothesis (frozen before evaluation)

> Given a `forge-ask-all.mjs` citation-block stdout in which a retrieved document's own dumped
> full-text body coincidentally contains a substring shaped like a reader citation block, when
> `verify-citation.mjs`'s `parseCitations()` is applied, then it erroneously parses an EXTRA,
> fabricated citation sourced from within a real citation's document body rather than from the
> reader's own delimiter structure — allowing `verifyGrounding()` to report `grounded: true` on the
> strength of a citation the retriever never returned. Bounding each block's `path`/`title` search
> window to stop at the next `#N repo=` header, and requiring strictly sequential ranks, should
> eliminate this cross-block/embedded-content leakage while producing byte-identical results on all
> currently-passing test fixtures and real reader output.

## Candidates considered (5 proposed, 1 selected)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod-value | Reviewability |
|---|---|---|---|---|---|---|---|
| 1 | **[SELECTED]** Bound `parseCitations` block window + enforce sequential rank | 5 | 3 | 5 | 5 | 4 | 5 |
| 2 | Fix `samePath`'s empty-`docPath` chunk-suffix edge (`''` matching any `#`-prefixed path) | 3 | 1 | 4 | 2 | 1 (unreachable — `docPath` is never empty in real output) | 5 |
| 3 | Wire `self-retrieval-bench.mjs` MRR into a nightly gate (ADR-025 Open Item #3) | 4 | 2 | 2 | 2 | 4 | 2 |
| 4 | De-dup citations by `(repo, docPath)` in `verifyGrounding` before resolving | 3 | 2 | 4 | 3 | 2 (doesn't address root cause — a fabricated citation still gets attempted) | 4 |
| 5 | Harden `citationResolves` against store-root `ENOTDIR`/`EACCES` | — | — | — | — | — | already fixed in PR #178 (2026-08-26) — not rediscovering |

Candidate 3 (self-retrieval-bench nightly gate) requires a real, built corpus/store to run
end-to-end; this container has zero materialized stores (`stores 0 dark 0` — confirmed via the
`store-root.mjs` control-plane probe) and no `~/.cache/ruvnet-brain/kb`, so it is untestable tonight
without fabricating a synthetic corpus that wouldn't represent the real benchmark. Candidate 1 is
fully testable via pure unit tests with zero corpus and zero model calls, directly answering
tonight's SCAN=citation-binding surface, and is the only candidate demonstrated as a real,
reproducible defect (not merely theoretical) — selected without needing to override the score order.

## Testability gate

Testable tonight: YES, via `tests/unit/verify-citation.test.mjs` (vitest), with zero corpus and zero
model calls required. `npm run eval:gate` itself is infrastructure-blocked in this container
(`eval-brain: no brain at /root/.cache/ruvnet-brain/kb — run: npx ruvnet-brain` — exact, verified
blocker, matching this container's other control-plane probes showing zero materialized stores), so
the real evaluator used tonight is the deterministic unit-test suite that exercises the exact changed
code path, not a substitute metric.

## Baseline vs candidate

- **Baseline** (`git show 486a144:...` of the two changed files, reproducing pre-candidate `HEAD`
  exactly): `tests/unit/verify-citation.test.mjs` — 16/16 pre-existing tests pass; the 6 new tests
  fail exactly as predicted (missing-path cross-block bleed, embedded look-alike fabricating a
  citation, the resync case, the critic's next-rank-fragment false negative, repeated rank accepted,
  and the end-to-end `verifyGrounding` false-positive).
- **Candidate (final, post-correction)**: all 22/22 tests pass, including the 6 new ones. The
  intermediate (pre-correction) version passed 21/21 — it had not yet been given a test for the
  critic's false-negative — which is exactly why an independent review mattered here: the tests
  written by the same session that wrote the fix did not cover the failure mode a fresh reviewer
  found in under 3 minutes of tracing.
- **Full `test:unit`** (277 files, 3598 tests): 3408 pass, 5 fail this run — but that failing SET is
  not stable across runs (chmod/EACCES-under-root fixtures are order/parallelism-sensitive; a
  targeted re-run of just `advocacy-ignored.test.mjs`, `advocacy-outcomes.test.mjs`,
  `hook-shim-fallback-once.test.mjs`, `user-settings.test.mjs` reproduces 4 of the 5 independently of
  this candidate). The 5th failure in this run's set, `dream-config.test.mjs`, was real and
  self-inflicted — not from the code candidate but from this report's own ledger row: `dream-machine
  ledger verify` rejects any `Evaluated?` value outside the literal enum `yes|no|blocked`, and the
  first-drafted row used `yes (unit, not eval:gate)`. Caught by running the full suite before
  push, corrected to bare `yes` with the nuance kept in the Verdict/Effect prose instead, re-verified
  green. All 5 failures are therefore accounted for and unrelated to `kb/verify-citation.mjs` itself
  — the same `chmod`-under-root class the 2026-08-26 ledger row documented, plus this session's own
  ledger-formatting slip, not a code regression.
- **`test:integration`**: 30/38 files pass; 5 fail, all pre-existing environmental blockers
  (`sqlite3` binary ENOENT, `@xenova/transformers` unresolved — the wasm/NAPI degradation this
  container's `npm ci` already recorded), zero of which reference `verify-citation.mjs` (verified by
  grep). The both-hosts hook-conformance gate itself
  (`hook-conformance-both-hosts.test.mjs`) passes clean, 5/5.
- **`eval:gate`**: attempted, blocked by the exact infra reason above — `EVALUATED=blocked` for this
  specific evaluator; the unit-test evaluator was used instead as the real, deterministic gate for
  this code path.

## Darwin

`npx @metaharness/darwin` is installed and its CLI responds. Not run: this candidate is a discrete
correctness fix (a citation is either correctly bound or it isn't) with no tunable parameter or
fitness landscape for bounded evolutionary search to explore — running Darwin here would be
evolution theater, not a real search. Skipped deliberately rather than run vacuously.

## Evidence

- OBSERVATION: `forge-ask-all.mjs:3192-3200` unconditionally dumps each hit's full document body
  inline, unescaped, after every citation's header/path/title.
- OBSERVATION: `verify-citation.mjs`'s own header comment (lines 16-21, pre-fix) contains literal
  example text in exactly the reader's citation-block shape — a concrete instance of a document that
  could trigger this defect if ever indexed and retrieved.
- MEASUREMENT: reproduced the fabricated-citation defect with a synthetic-but-realistic stdout
  (a real hit whose dumped body embeds that exact example) — pre-fix: 2 citations parsed (1 real, 1
  fabricated, both resolvable, defeating the point). Post-fix: 1 citation parsed.
- MEASUREMENT: reproduced the cross-block field-bleed defect (a citation missing its own path line
  inheriting the NEXT citation's path) — pre-fix: rank-1 citation gets rank-2's path; post-fix:
  rank-1 citation dropped entirely (no invented path).
- MEASUREMENT: end-to-end `verifyGrounding` test — pre-fix: a genuinely-fabricated real citation
  (`meetings/totally/made/up`, does not resolve) is masked by the embedded look-alike resolving
  instead, reporting `grounded: true`; post-fix: correctly reports `grounded: false,
  reason: 'citations-do-not-resolve'`.
- MEASUREMENT (found by independent review, not this session's own testing): the *intermediate*
  fix version — rank check correct, but `expectedRank` advanced before the path check — silently
  dropped a REAL, later citation whenever an earlier hit's body contained a bare, pathless fragment
  at the next rank. Reproduced directly: with that ordering, a real rank-2 citation vanishes
  entirely from `parseCitations`'s output; with the corrected ordering (advance only after a
  resolving path is found), the real rank-2 citation survives.
- INFERENCE: this defect class most plausibly manifests when this repo's own retrieval-format
  documentation (this file, ADR-025, or any future doc explaining the citation format) is itself
  indexed into a self-referential corpus store and later retrieved — not verified end-to-end tonight
  because no corpus is materialized in this container (HYPOTHESIS, not MEASUREMENT).

## Reward-hack / gaming check

The corrected fix (see Correction below) only ever rejects a rank once it is clear no valid header
can still fill it later in the stream — it never rejects a rank a genuine citation goes on to fill,
and it never accepts a citation whose own block lacks a resolving path. No threshold, gold answer, or
held-out question was touched. No new dependency, no cache, no hidden cost. An INDEPENDENT critic
subagent (genuinely separate from the candidate's author, not self-critique) reviewed the *initial*
version of this fix and found a real problem — see Correction below. The corrected version's
self-critique: CLEAR, with one residual risk disclosed below.

## Correction (found by independent review, before this PR left draft)

The first version of this fix advanced `expectedRank` as soon as a header's rank matched, **before**
checking whether that block actually had a `path` line. An independent critic subagent traced every
real emitter of this citation format in the repo and found a concrete false negative: a retrieved
document's body containing an incidental, *partial* look-alike fragment (a bare `#N  repo=X  ce=...`
line with no `path`/`title` following — plausible in any prose that merely mentions the format, not
just a full worked example) would consume the next rank slot and permanently reject the REAL citation
that later filled that same rank — silently turning a genuinely grounded answer into `grounded:
false`. That is a worse failure than the fabrication this guard exists to prevent.

Fixed by moving the `expectedRank` advance to after the `path` check, so only a block that actually
resolves a path fills a rank slot; a pathless match at the current rank is skipped without burning
it, so a later, genuine header at that same rank can still resolve. Verified independently: reverting
just the ordering of that one line reproduces the critic's exact false negative (a real second
citation vanishing); the corrected order fixes it while still passing every test for the original
fabrication defect. One test written before this correction encoded the old, incorrect expectation
(that a pathless citation at rank 1 should let rank 2 through even though rank 1 never resolves) —
corrected to assert the actual, safe invariant instead (no field-bleeding, ever) and a new test added
to demonstrate the resync case explicitly (a pathless match at rank 1, followed by a genuine header at
rank 1, still resolves).

## Security review

This is directly a corpus/citation-poisoning mitigation: untrusted or attacker-influenced retrieved
content (an ingested gist, a meeting transcript, any future external source) could embed
reader-format look-alike text to fabricate a resolvable citation and force a false grounded
verdict. The fix closes the REALISTIC case (out-of-sequence or repeated-rank look-alikes, which is
what this repo's own documentation and any generic illustrative example text would produce). It does
**not** close a maximally adversarial case: content engineered to predict and spoof the *exact next
expected rank* in a specific result position would still be accepted, since sequential-rank checking
alone cannot distinguish that from a real hit. Closing that fully requires a structural fix — the
reader emitting a format that cannot be reproduced by ordinary document content at all (e.g.
JSON-lines with an out-of-band delimiter, or an escaped/non-printable-byte-delimited protocol)
instead of the current human-readable, printf-style text. That is an architectural decision, not a
tonight-sized fix, and is named explicitly as a recommended follow-up rather than silently left
implicit.

## Scan findings (SCAN=retrieval-precision, citation-binding)

1. **citation-binding** (this report's DEEP-adjacent finding, elevated from scan to the night's
   focus once its severity was confirmed): see above.
2. **retrieval-precision**: `kb/self-retrieval-bench.mjs` (ADR-025's own designated flywheel gate) is
   still not wired into any nightly or CI gate three ADR revisions later (ADR-025 Open Item #3,
   dated 2026-07-19) — confirmed still true by inspection tonight (`grep` for its invocation in
   `package.json` and CI workflows found none beyond manual `node kb/self-retrieval-bench.mjs`). Not
   actioned tonight (requires a real corpus this container does not have), but re-flagged since it
   remains open five weeks later.

## Witness

This report was revised once, after independent review found a real bug in the fix's first version
(see Correction above) — the hash below is over the FINAL, corrected content, not the version this
session first drafted.

- Session commit: `486a144dbc9bd5fa3b8b715e0c13935d1add0f1f`
- Report sha256 (of this file's content from the start through the line immediately before this
  "## Witness" heading — i.e. everything above this section, which cannot hash itself):
  `1816529d4eb6e59eedad8c6e53bf15f1a099ffab3532ab7140bfc7edca33bffd`
- Witness stamp (`sha256(REPORT_HASH + SESSION_COMMIT)`):
  `d9a6323e24a8557d55ab98921d447b0c49214decb3f62ace9b8b2d2ee166e7b0`
- Verifier procedure: (1) `git checkout 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f`; (2) apply the
  candidate diff from PR branch `dream/2026-08-28-grounding-quality`; (3) take this committed report,
  keep only its content from the start through the line immediately before this "## Witness" heading
  (i.e. drop this section and "## Recommendation" below it), `sha256sum` that, and confirm it matches
  the Report sha256 above; (4) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` and confirm it
  matches the Witness stamp above; (5) run `npx vitest run tests/unit/verify-citation.test.mjs` and
  confirm 22/22 pass.

## Recommendation

1. Merge the candidate (human review required — this session never self-merges).
2. Treat the "structural, unspoofable reader/verifier wire format" idea named in Security Review as
   a candidate for a future ADR — it is an architectural decision, correctly out of scope tonight.
3. Wire `self-retrieval-bench.mjs` into a real gate (ADR-025 Open Item #3) on a night when a real
   corpus is available in the runner (this container never materializes one).
