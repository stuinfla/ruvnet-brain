---
id: ADR-088
status: Accepted
date: 2026-09-19
updated: 2026-09-19
version: 1.1.0
authors: [Stuart Kerr, Codex]
tags: [evaluation, benchmark, grounding, operations, abstention]
supersedes: []
amends: [ADR-0002, ADR-0011]
relates: [ADR-0074, ADR-0086]
governs:
  - scripts/eval-brain.mjs
  - scripts/brain-novice-50.mjs
  - evals/operational-benchmark.v1.mjs
  - evals/operational-benchmark.v2.mjs
  - evals/operational-benchmark.v3.mjs
  - evals/oracles/operational-source-oracles.v3.json
  - scripts/run-operational-benchmark.mjs
  - scripts/run-operational-benchmark.v3.mjs
  - tests/unit/eval-brain-gate.test.mjs
  - tests/unit/brain-novice-50.test.mjs
  - tests/unit/operational-benchmark.test.mjs
  - tests/unit/operational-benchmark-v3.test.mjs
---
# ADR-0088: Operational evaluation requires source support and honest abstention

**Status**: Accepted (2026-09-19)
**Date**: 2026-09-19
**Related**: ADR-0002 (source-grounded quality gate), ADR-0011 (frozen held-out quality program), ADR-0074 (capability claim integrity), ADR-0086 (corpus retrieval accuracy)

## Context

The answerable grading path in `scripts/eval-brain.mjs` treated a resolving citation and expected repository as a pass even when the top cross-encoder score was negative and the grade itself reported `abstained: true`. The reproducible counterexample was a described Ruvector question with `grounded: true`, citation `{repo: "ruvector", ce: -2.66}`, and `receipt.repo: "ruvector"`; the grader returned `pass: true`.

The novice-50 evaluator also exposed `expectedRepoCited` but did not require it for its `effective` result. Its keyword regex could label usefulness while a wrong-owner citation still qualified. Repository existence and lexical overlap establish neither that the expected source answered nor that the answer is supported by that source.

## Decision

1. Negative cross-encoder evidence cannot pass an answerable named, described, scenario, or provenance case. Only the adversarial stratum may pass by abstaining. An honest refusal stays correct on a negative control and does not convert an answerable miss into a pass.
2. Novice-50 `effective` requires an expected-owner citation in addition to transport, citation presence, the existing keyword signal, honesty, and its latency bound. The keyword match remains a heuristic indicator; it is not represented as semantic accuracy.
3. Operational quality claims use a separately frozen, independently authored query set with broad, named, negative, and ambiguity classes. Answerable fixtures carry exact expected source spans authored before replay. A pass requires a resolved citation from an allowed owner and the expected span inside that cited result. Negative and ambiguous cases have no source-fact oracle and pass only with explicit evidence-qualified abstention.
4. The fixture suite distinguishes same-project next-session continuity from cross-project transfer. It includes a source-backed CogruOS named query. A named capability without a source oracle is reported as unavailable and excluded from measured denominators; it also blocks the overall qualification verdict. Version 1 retained an unavailable IPFS case. Before candidate replay, version 2 binds that case to the public Ruflo plugin declaration at commit `e332689b8c04fc63989d82124298e6cf3d71ee76` (`evals/oracles/ruflo-ipfs-provenance.json`), which proves a documentation claim only. The original version 1 fixture remains unchanged.
5. Each operational run writes raw query output, verification receipts, oracle decisions, latency observations, and per-class p50/p95/p99. It does not overwrite `evals/baseline.json`, the historical novice report, or the frozen held-out fixture hashes.
6. Source-span checks provide auditable evidence support for the specific asserted fact; they do not claim complete semantic coverage. Reports must keep routing, citation existence, exact source support, refusal behavior, and latency as distinct measures.
7. Version 3 keeps the 19 v2 query strings unchanged and adds the frozen exact doctor query plus an independently authored cross-project discovery query. Its separate catalog binds each fixture to zero or more required claim slots; slots are AND, and reviewed source alternatives inside a slot are OR. Each alternative pins an exact repository/path, the SHA-256 of the stored passage text, and every required verbatim span. Before invoking retrieval, the runner verifies catalog structure, the mounted `ARCHIVE-MANIFEST.json` and `SOURCE.json` hashes, and every alternative against actual passage bytes. A source hash or span mismatch is `INVALID_ORACLE`; a pinned source absent from the mounted corpus is `CORPUS_GAP`; a valid oracle whose retrieval/process/citation does not satisfy all slots is `RETRIEVAL_MISS`; successful cases are `PASS`. Proof labels alone cannot satisfy an oracle. CE-null citations qualify only with the `reviewed-source-catalog` proof method and an independently preflighted exact source match.
8. The v3 catalog has 21 fixed cases. A fixture marked unavailable remains in `total`, is reported as `CORPUS_GAP`, and forces `qualificationPass: false`; it is excluded only from the clearly named measurable count and latency distribution. The baseline's cross-project automatic-learning guarantee is intentionally unavailable because the pinned archive contains no independently verified end-to-end proof of automatic transfer. Manual IPFS transfer evidence does not establish that broader runtime behavior. No candidate search result can add, change, or repair an oracle.

## Consequences

- Negative-score citations to existing paths fail answerable grading instead of earning a false pass.
- Existing historical baselines remain byte-for-byte historical and are not silently rebased to the corrected rubric.
- The operational benchmark is an additional qualification surface. Its small sample and exact-span oracle do not justify universal semantic-accuracy claims; broader independent review remains necessary for such claims.
- The v3 runner measures source-supported retrieval utility only. It does not claim generated-answer usefulness, prove that code executes, or turn the explicit cross-project corpus gap into a negative answer.
- Raw receipts are the evidence artifact. A summary score without its per-query receipt is not a benchmark result.

## Principles served and traded

- **P1 and P6 — verify through the user's path; derive rather than assert.** The runner invokes the bounded customer retrieval path and binds receipts to the runtime, verifier, fixture, and source-oracle hashes. Missing oracle spans fail preflight.
- **P9 — silence is valid.** Unsupported and underspecified queries have separate expected-refusal classes. A relevant, positive citation blocks refusal credit.
- **Tradeoff — P3, nudge rather than force.** This work changes evaluation outputs and promotion evidence; it does not change user-facing retrieval policy or add a blocking runtime gate.

## Verification contract

- The reported counterexample must fail, while a negative control with explicit uncertainty and no relevant positive citation passes.
- A path-only citation, wrong-owner source, or relevant phrase outside the cited result must fail an answerable operational fixture.
- Fixture text, expected repositories, and exact source facts are frozen by a test-pinned SHA-256. Intentional fixture changes require a new benchmark version and documented independent oracle review; never modify historical fixture hashes to make a result pass.
- V3 preflight must happen before query execution; malformed catalogs, absent source, failed retrieval, and successful retrieval remain separate statuses. A qualification result requires every one of the 21 fixtures to be available and passing.
- Any unavailable fixture is listed in its own report field and is absent from the class's measured `n` and latency distribution; it is not a pass.
- Run `npx vitest run tests/unit/eval-brain-gate.test.mjs tests/unit/brain-novice-50.test.mjs tests/unit/operational-benchmark.test.mjs tests/unit/operational-benchmark-v3.test.mjs --maxWorkers=1` and report the result. The v3 real-corpus run uses `RUVNET_BRAIN_KB=<pinned-kb> node scripts/run-operational-benchmark.v3.mjs`; retain the generated raw receipt and report actual latency distributions and every unavailable fixture.

## Implementation state

Accepted decision; v1/v2 history remains preserved and v3 implementation is tracked by the governing code and tests above. The pinned 4.3.26 archive preflight currently validates 20 cases and records one explicit cross-project `CORPUS_GAP`; no full retrieval replay is claimed by this ADR update.

## Currency log

| Date | Change | Evidence |
|---|---|---|
| 2026-09-19 | Added v2 with a pinned public IPFS oracle before candidate replay; unavailable cases now block overall qualification. Preserved v1. | `evals/oracles/ruflo-ipfs-provenance.json`, `evals/operational-benchmark.v2.mjs`, `scripts/run-operational-benchmark.mjs`; no universal quality score claimed. |
| 2026-09-19 | Added v3's archive-bound source catalog and preflight-before-search runner. It requires every claim slot, verifies exact actual passage hashes/spans, separates invalid oracle/corpus gap/retrieval miss/pass, preserves all 21 cases, and keeps the one automatic cross-project case unavailable. The exact archive preflight is 20 available source oracles plus 1 explicit gap; no heavy baseline/candidate replay was run here. | `evals/oracles/operational-source-oracles.v3.json` (catalog SHA-256 `8426dfb0fe3cbe9f98a882dc9a08039fb80987394eb7e1e75064084a53724c67`); `evals/operational-benchmark.v3.mjs`; `scripts/run-operational-benchmark.v3.mjs`; `tests/unit/operational-benchmark-v3.test.mjs`; `/tmp/brain-retrieval-20260919-ut54XL/archive-kb`. |
