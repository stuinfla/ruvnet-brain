---
id: ADR-088
status: Accepted
date: 2026-09-19
updated: 2026-09-19
authors: [Stuart Kerr, Codex]
tags: [evaluation, benchmark, grounding, operations, abstention]
supersedes: []
amends: [ADR-0002, ADR-0011]
relates: [ADR-0074, ADR-0086]
governs:
  - scripts/eval-brain.mjs
  - scripts/brain-novice-50.mjs
  - evals/operational-benchmark.v1.mjs
  - scripts/run-operational-benchmark.mjs
  - tests/unit/eval-brain-gate.test.mjs
  - tests/unit/brain-novice-50.test.mjs
  - tests/unit/operational-benchmark.test.mjs
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
4. The fixture suite distinguishes same-project next-session continuity from cross-project transfer. It includes a source-backed CogruOS named query. A requested named capability without a source oracle (Ruflo/IPFS pattern sharing in this checkout) is reported as unavailable and excluded from measured denominators; the runner must not invent an expected fact or count the case as success.
5. Each operational run writes raw query output, verification receipts, oracle decisions, latency observations, and per-class p50/p95/p99. It does not overwrite `evals/baseline.json`, the historical novice report, or the frozen held-out fixture hashes.
5. Source-span checks provide auditable evidence support for the specific asserted fact; they do not claim complete semantic coverage. Reports must keep routing, citation existence, exact source support, refusal behavior, and latency as distinct measures.

## Consequences

- Negative-score citations to existing paths fail answerable grading instead of earning a false pass.
- Existing historical baselines remain byte-for-byte historical and are not silently rebased to the corrected rubric.
- The operational benchmark is an additional qualification surface. Its small sample and exact-span oracle do not justify universal semantic-accuracy claims; broader independent review remains necessary for such claims.
- Raw receipts are the evidence artifact. A summary score without its per-query receipt is not a benchmark result.

## Principles served and traded

- **P1 and P6 — verify through the user's path; derive rather than assert.** The runner invokes the bounded customer retrieval path and binds receipts to the runtime, verifier, fixture, and source-oracle hashes. Missing oracle spans fail preflight.
- **P9 — silence is valid.** Unsupported and underspecified queries have separate expected-refusal classes. A relevant, positive citation blocks refusal credit.
- **Tradeoff — P3, nudge rather than force.** This work changes evaluation outputs and promotion evidence; it does not change user-facing retrieval policy or add a blocking runtime gate.

## Verification contract

- The reported counterexample must fail, while a negative control with explicit uncertainty and no relevant positive citation passes.
- A path-only citation, wrong-owner source, or relevant phrase outside the cited result must fail an answerable operational fixture.
- Fixture text, expected repositories, and exact source facts are frozen by a test-pinned SHA-256. Intentional fixture changes require a new benchmark version and documented independent oracle review; never modify historical fixture hashes to make a result pass.
- Any unavailable fixture is listed in its own report field and is absent from the class's measured `n` and latency distribution; it is not a pass.
- Run `npx vitest run tests/unit/eval-brain-gate.test.mjs tests/unit/brain-novice-50.test.mjs tests/unit/operational-benchmark.test.mjs --maxWorkers=1` and report the result. A real corpus qualification runs with `node scripts/run-operational-benchmark.mjs`; retain the generated raw receipt and report actual latency distributions.

## Implementation state

Accepted decision; implementation and qualification are tracked by the governing code and test files above. Acceptance of this ADR does not claim that a live corpus benchmark has passed.
