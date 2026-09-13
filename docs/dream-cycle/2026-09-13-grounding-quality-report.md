# Grounding-Quality / Retrieval-Precision SOTA Report — 2026

## TL;DR

Tonight's rotation drew SLOT 3 (`20260913 % 5 == 3`) — `grounding-quality`, scan
`retrieval-precision`, `citation-binding`. Per this repo's ISSUE DISPOSITION OVERRIDE,
reconciliation comes before fresh manufacture. The open surface-defining issue, **#286**
(`retrieval-canary` gate red since 2026-09-10), had 2 of its 3 root causes fixed in the
24h before this run (`aca4303`, `1efcf53`). This session verified that state directly
against current source and git history (not assumed from the issue text), then froze and
tested a falsifiable hypothesis about the one remaining root cause (photonlayer intra-repo
rank crowding) using the real upstream file content. **Hypothesis REJECTED** by direct
measurement — the leading theory in the issue ("likely a cross-encoder length/truncation
artifact") does not hold up against the actual file. No new code candidate was warranted
tonight: the architecturally sound next step (novelty-aware, duplicate-aware reranking,
below) needs its own dedicated investigation, exactly as the issue's own prior review said,
and this container has no live corpus to evaluate a retrieval change against `eval:gate`
regardless. A rejected hypothesis with a clean measurement is a successful night.

## What's new (external research, graded)

- **Set-Encoder** (arXiv 2404.06912, grade A — peer-reviewed-track preprint with public
  method): permutation-invariant inter-passage attention for listwise reranking, explicitly
  trained with a **novelty-aware RankNet loss** and **duplicate-aware InfoNCE loss** so
  that "from a group of relevant but near-duplicate passages, only one should be ranked
  high." This is architecturally the exact shape of #286's remaining defect: photonlayer's
  own `crates/photonlayer-core/README.md` and `ruvector`'s vendored copy of the *same file*
  compete for one rank slot, and this repo's uniform `NAME_BOOST` (+2.0, `kb/forge-ask-all.mjs`)
  cannot distinguish authoritative-repo from vendored-duplicate — it boosts both identically.
  Grade A because the crowding failure mode is described independently of this repo and
  matches byte-for-byte.
- **MICE — Minimal Interaction Cross-Encoders** (arXiv 2602.16299, grade B, single paper,
  plausible but unreplicated here): cheaper cross-encoder interaction patterns that could
  reduce the per-pair cost this repo's own `ADR-0059`/cascade-prefilter machinery already
  works around with a token-budget cascade. Informational, not adopted tonight.
- **VeriCite / CiteEval / "three-rubric" citation evaluation** (ACM SIGIR-AP 2025 /
  futureagi.com summary, grade B): the field is converging on grading citations by three
  independent rubrics — *emitted*, *resolves*, *source actually contains the claim*. This
  repo's `kb/verify-citation.mjs` implements rubric 1 and 2 (a citation must exist and its
  path must resolve to a real on-disk passage) but not rubric 3 (semantic support) — a gap
  this repo's own 2026-08-28 ledger row already named ("a maximally adversarial document
  predicting the exact next expected rank would still be accepted") and is therefore not
  re-filed tonight (dedup).

## Frozen hypothesis (before verification)

> Given `crates/photonlayer-core/README.md` (photonlayer's #286-designated oracle
> passage, ce=-3.805, retained in-pool but outside the canary's top-10), when the file's
> real upstream content is measured against `kb/forge-rerank.mjs`'s pre-tokenization
> character cap (`ceScore`/`ceScoreBatch`: `passage.slice(0, 3000)`, applied before the
> tokenizer's own 512-token limit ever sees the text), then the passage's *query-relevant*
> content should be found beyond character 3000 — subject to: the fetched content must be
> the exact upstream blob at the oracle's own recorded commit, not a paraphrase.

## Verification

Fetched the real file directly from the upstream commit the coverage ledger records for
this store (`data/source-coverage.json` → `artifact.sourceCommit: fe86c9fad9a1572ce46e337f118656961bdf4ebb`,
`upstream.url: https://github.com/ruvnet/PhotonLayer`):

```
curl https://raw.githubusercontent.com/ruvnet/PhotonLayer/fe86c9fad9a1572ce46e337f118656961bdf4ebb/crates/photonlayer-core/README.md
→ 4077 bytes, 75 lines
```

4077 chars *does* exceed the 3000-char pre-tokenization cap — confirmed the cap can bind
on this exact file. But the file's title, one-line identity claim, and full descriptive
paragraph ("A deterministic optical AI front end...") sit in lines 1–9 (~600 chars), well
inside the retained prefix. The truncated tail (lines ~59–75) is "Honest scope — what not
to claim yet" and the MIT license line — marketing-claims boilerplate, not the passage's
identifying content. **A query asking what PhotonLayer is or does would find its answer
entirely inside the untruncated 3000-char prefix.** Tail truncation cannot explain a
strongly negative cross-encoder score on content the model can fully see.

Separately investigated and also rejected: whether `kb/verify-citation.mjs`'s
`citationResolves()` could fail on a real repo due to a `repo=` case mismatch between the
printed citation and the on-disk `<store>.passages.jsonl` filename (worth checking because
`data/source-coverage.json` records the *display* name as `"PhotonLayer"`, mixed case, next
to the *store* identifier `"photonlayer"`, lowercase). Traced the actual pipeline:
`kb/store-root.mjs`'s `storesAt()` derives repo names directly from on-disk `.rvf`
filenames, `kb/forge-ask-all.mjs`'s `searchOne(name)` threads that exact string through to
the printed `repo=` field, so the citation and the file lookup always agree by
construction. Confirmed empirically across all 229 recorded stores in
`data/source-coverage.json`: zero contain an uppercase character. Not a live bug.

## Hypothesis verdict

**REJECTED.** Root cause 2 in #286 is not explained by cross-encoder tail-truncation
(measured against the real file) or by citation-repo case sensitivity (measured against
the full store population). This narrows tomorrow's search space: the remaining plausible
mechanism is the one Set-Encoder's public research independently names — **near-duplicate,
cross-repo passage crowding**, where `ruvector`'s vendored copy of photonlayer's file and
a different, shorter, more-topical `photonlayer` passage (`docs/README.md`, ce=-0.565)
both out-rank the designated file without any single scoring bug, just an absence of
novelty-awareness in `NAME_BOOST`. That is a reranking-architecture question, not a
one-line fix, and confirming it needs the real candidate corpus this container does not
have (`stores 0 dark 0` — a fresh/ephemeral checkout, not a wipe, per
`restore-local-ingests.mjs`).

## Evaluation Receipt (baseline health, no candidate to compare against)

- `npx vitest run` on the 8 citation/retrieval/grounding-canary unit test files
  (`verify-citation`, `retrieval-canary`, `installed-canary-citation`,
  `grounding-receipt-lanes`, `adr-citation-integrity`, `candidate-retrieval-inputs`,
  `candidate-retrieval-matrix`, `retrieval-result-boundary`): **8 files / 104 tests, all
  passed.**
- `npx vitest run tests/integration`: 9 failed files / 36 passed / 3 skipped (48 files);
  23 failed / 306 passed / 15 skipped / 53 todo (397 tests). Every failure is pre-existing
  and environmental for this container — `node:sqlite`/ruflo-store fixtures
  (`project-progression-*`), `chmod`/EACCES-under-root (`anticipate*`, `health-repair`),
  and a cross-encoder model cache/network-priming failure
  (`reader-deadlock-regression.test.mjs`) — none reference `forge-ask-all.mjs`,
  `forge-rerank.mjs`, or `verify-citation.mjs` (grep-confirmed). No code was changed
  tonight, so this is a baseline read of current `main`, not a regression comparison.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`
  (`stores 0 dark 0`; fresh container, not a credentials block).
- `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY`/model-provider key in this container's env.
- `npm run claims:verify`: 4 PASS / 3 SKIP (brain-not-installed class, same shape as every
  prior night this ledger records).

## Reward-Hack Check

N/A — no candidate; no benchmark, gold data, or threshold touched.

## Security Review

N/A — no code change. The case-sensitivity check above was itself a defensive audit of
`verify-citation.mjs`'s trust boundary (repo name → filesystem path); confirmed the
lookup can only ever narrow (fail closed to `no-store`), never widen, on a case mismatch —
no false-grounding risk exists on that path today.

## Scan Findings — retrieval-precision

Reconciled #286 against current source: root cause 1 (`selectResults()`'s absolute
negative-score prune discarding a named repo's own correct passage) and what the issue
body calls root cause 3 / the `1efcf53` commit calls RC2 (the `implementation`-doc-noun
symbol-routing burial that buried `synaptic-mesh`'s answer at rank 523/3120) are both
fixed and on `main` as of this morning. Estimated aggregate recall per `1efcf53`'s own
commit message: 18/19 (94.7%), still short of the required 98% — `protected-release.yml`
correctly stays blocked. Only photonlayer (root cause 2 / RC1-in-1efcf53's numbering —
the issue and its own fix commits use inconsistent RC numbering, itself worth a follow-up
comment) remains, now with tail-truncation and case-sensitivity explicitly ruled out.

## Scan Findings — citation-binding

`kb/verify-citation.mjs` implements 2 of the 3 rubrics the current external literature
(VeriCite/CiteEval) uses to grade citation systems (emitted, resolves) but not the third
(source semantically supports the claim) — a gap already recorded in this repo's own
2026-08-28 ledger row, not new tonight, not re-filed. All 8 relevant unit test files for
this surface pass cleanly on current `main` (104/104).

## Competitors

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No published cross-repo duplicate-passage crowding mitigation; general-purpose research-loop framing, not retrieval-specific. | C |
| OpenHands | No published retrieval reranking novelty-awareness; issue-driven fixes, not self-auditing. | C |
| DSPy/GEPA | Optimizes prompts/pipelines against a metric; would need this repo's `eval:gate`-style frozen held-out set wired in as the metric to help here, not a substitute for it. | B |
| SWE-agent | Issue-driven; would fix a filed duplicate-crowding bug if scoped, does not self-audit for one. | B |
| Cursor background agents | No published cross-repo duplicate-passage crowding mitigation. | C |
| Set-Encoder (arXiv 2404.06912) | Directly names and solves this exact failure class (novelty/duplicate-aware listwise reranking) — the most relevant external reference found tonight. | A |

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation as
every Dream Cycle night since 2026-08-19; the GitHub MCP server exposes issue/PR/file
tools but no gist-creation tool — confirmed via tool search, not assumed). Full report
committed at `docs/dream-cycle/2026-09-13-grounding-quality-report.md`.

## Witness

(computed and inserted below before publication — see STEP 16)

## Recommendation

1. Root cause 2's real fix direction is now better-scoped by external evidence: a
   novelty/duplicate-aware penalty in `selectResults()`/`NAME_BOOST` (down-weight a
   candidate whose content is a near-duplicate of another, higher-scoring candidate from a
   *different* repo) rather than the uniform +2.0 boost today. This needs the real
   candidate corpus and `eval:gate` to prove it doesn't regress the 18/19 already won —
   exactly the "own careful, Dual-reviewed investigation" #286 already calls for. Not
   attempted tonight.
2. #286's own commit history uses two different, conflicting numbering schemes for the
   same three root causes (the issue body: RC1=selectResults, RC2=photonlayer,
   RC3=synaptic-mesh; commit `1efcf53`'s subject line: "#286 RC2" for the synaptic-mesh
   fix, calling photonlayer "root cause 3" in its body). Left a clarifying comment on #286
   tonight rather than silently living with the ambiguity for whoever picks up root
   cause 2 next.
3. This container still cannot materialize a corpus (`stores 0 dark 0`) or reach a model
   provider (`LLM_EVAL=blocked`) — unchanged since 2026-08-19. Any night targeting
   `retrieval-precision` will keep hitting this ceiling until a persistent corpus cache or
   provider key is wired into the Dream Machine's runner environment; flagging again since
   it directly capped tonight's ceiling from ACCEPT to INCONCLUSIVE.
