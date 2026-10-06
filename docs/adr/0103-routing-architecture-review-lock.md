---
id: ADR-103
title: Routing architecture qualification requires a current finite source review
status: Accepted
date: 2026-10-05
updated: 2026-10-05
version: 0.1.4
reviewed_digest: 2312bba4180a
impl: built
authors: [Stuart Kerr, Codex]
tags: [routing, governance, review, release, traceability]
relates: [ADR-024, ADR-069, ADR-072, ADR-100, ADR-101]
governs:
  - scripts/model-managed-prompt.mjs
  - scripts/model-managed-workflow-service.mjs
  - scripts/model-routing-controller.mjs
  - scripts/model-routing-execution-adapters.mjs
  - scripts/claude-controlled-terminal.mjs
  - scripts/codex-managed-terminal.mjs
  - scripts/managed-terminal-input.mjs
  - scripts/model-router-dispatch.mjs
  - scripts/model-routing-defence.mjs
  - config/model-router/policy.default.mjs
  - tests/unit/model-managed-prompt.test.mjs
  - tests/unit/model-managed-workflow-service.test.mjs
  - tests/unit/model-routing-controller.test.mjs
  - tests/unit/model-routing-execution-adapters.test.mjs
  - tests/unit/claude-controlled-terminal.test.mjs
  - tests/unit/codex-managed-terminal.test.mjs
  - tests/unit/managed-terminal-input.test.mjs
  - tests/unit/model-managed-parent-context-posix.test.mjs
  - tests/integration/model-managed-checker-native.test.mjs
  - docs/model-routing-operation.md
  - scripts/model-router-engine.mjs
  - scripts/model-routing-launchers.mjs
  - CONTRIBUTING.md
  - scripts/subscription-hosts.mjs
  - scripts/native-subscription-usage.mjs
  - scripts/model-native-catalog.mjs
  - scripts/model-native-qualification.mjs
  - scripts/model-weekly-cycle.mjs
  - scripts/model-weekly-analyst.mjs
  - scripts/model-weekly-assessment.mjs
  - scripts/model-weekly-qualification.mjs
  - scripts/model-routing-policy-promotion.mjs
  - scripts/model-router-catalog.mjs
  - scripts/model-router-setup.mjs
  - scripts/model-router-outcome.mjs
  - plugin/scripts/routing-outcome-capture.mjs
  - bin/install.mjs
  - plugin/scripts/codex-console-alias.mjs
  - plugin/scripts/session-start-budget.mjs
  - plugin/scripts/session-start-core.mjs
  - tests/unit/model-terminal-launchers.test.mjs
  - tests/unit/npm-tarball-codex.test.mjs
  - tests/qe/release/packed-clean-install.test.mjs
  - tests/unit/session-start-core-parity.test.mjs
  - plugin/scripts/continuity-journal.mjs
  - config/model-router/weekly-analyst-instruction.md
  - tests/unit/subscription-hosts.test.mjs
  - tests/unit/native-subscription-usage.test.mjs
  - tests/unit/model-native-catalog.test.mjs
  - tests/unit/model-native-qualification.test.mjs
  - tests/unit/model-weekly-cycle.test.mjs
  - tests/unit/model-weekly-analyst.test.mjs
  - tests/unit/model-weekly-assessment.test.mjs
  - tests/unit/model-weekly-qualification.test.mjs
  - tests/unit/model-routing-policy-promotion.test.mjs
  - tests/unit/model-router-outcome.test.mjs
  - tests/unit/routing-outcome-capture.test.mjs
  - tests/unit/model-router-update-convergence.test.mjs
  - scripts/model-routing-gateway.mjs
  - tests/unit/model-routing-gateway.test.mjs
  - tests/unit/model-routing-gateway-boundaries.test.mjs
  - scripts/doc-currency.mjs
  - scripts/architecture-review-lock.mjs
  - tests/unit/architecture-review-lock.test.mjs
  - tests/unit/doc-currency-review.test.mjs
  - scripts/release-qualification-contract.mjs
  - scripts/release-qualification.mjs
  - scripts/prepublication-evidence.mjs
  - scripts/candidate-ci-receipt.mjs
  - scripts/qe/agentic-qe-4.3.mjs
  - tests/unit/agentic-qe-early-public.test.mjs
  - tests/unit/release-evidence-dag.test.mjs
  - tests/unit/protected-release-workflow.test.mjs
  - tests/unit/prepublication-evidence.test.mjs
  - scripts/source-scope-receipt.mjs
  - scripts/release-transaction.mjs
  - scripts/release-transaction-provider.mjs
  - .github/workflows/ci.yml
  - .github/workflows/release-candidate-preflight.yml
  - .github/workflows/protected-release.yml
  - .github/workflows/early-public.yml
---

# ADR-103 — Routing architecture review lock

**Decision status:** Accepted: the owner requested an architecture review freeze and a future-change gate.
**Implementation status:** Integrated, awaiting qualification. The adapter and focused refusal fixtures
are wired before expensive release jobs. Final integrated review and runtime evidence remain required. No current review is
stamped here; an unstamped candidate must fail this guard. This ADR does not qualify any historical
candidate or transfer proof from one SHA to another.

## Decision

Before candidate preflight starts expensive qualification jobs, run
`node scripts/architecture-review-lock.mjs`. The command reuses
`scripts/doc-currency.mjs`'s exported `evaluateDoc` and `blockingFindings`.
It requires this Accepted ADR, a nonempty explicit finite set of tracked governed files, no normal
strict document blockers, and `review.current === true`. Failure exits nonzero before the matrix.
It neither changes routing execution nor creates another review engine, controller or network caller.

A change to a governed file or this document's normative mapping expires the review. Update the
architecture and test mapping, inspect the final governed source and tests, resolve findings, then
record a dated Currency log review row naming the recomputed `reviewed_digest` and a governed source
path. Final-source independent review must precede that stamp. A matching source digest does not
substitute for release qualification, exact-candidate receipts or published verification.

## Architecture and test mapping

| Boundary | Actual source responsibility | Executable mapping |
|---|---|---|
| Input and parent context | model-managed-prompt, managed-terminal-input, claude-controlled-terminal, codex-managed-terminal | Corresponding unit files; model-managed-parent-context-posix and model-managed-checker-native integration |
| Managed service and AgentDB completion | model-managed-workflow-service, model-routing-controller, continuity-journal, routing-outcome-capture | Managed service/controller and routing-outcome-capture unit files; managed native integration |
| Execution, checking and independent review | model-routing-execution-adapters, model-routing-defence, model-routing-gateway, model-routing-launchers | Corresponding unit files and gateway boundary tests |
| Dispatch and owner policy | model-router-engine, model-router-dispatch, policy.default, model-router-setup, model-router-outcome | Managed service/controller tests; model-router-outcome and model-router-update-convergence tests |
| Native subscription and catalog | subscription-hosts, native-subscription-usage, model-native-catalog, model-native-qualification, model-router-catalog | Corresponding native/catalog tests and installer convergence tests |
| Weekly assessment and promotion | model-weekly-cycle, model-weekly-analyst, model-weekly-assessment, model-weekly-qualification, model-routing-policy-promotion, weekly-analyst-instruction | Corresponding weekly and promotion unit files |
| Installation seam | bin/install.mjs, model-routing-operation.md, codex-console-alias and SessionStart core/budget | model-router-update-convergence, session-start-core-parity, model-terminal-launchers and npm-tarball-codex; bounded routing and console-alias installation, not an all-installer review; packed-clean-install and npm-tarball-codex retain sealed archive metadata reads with basename and controlled cwd, rejecting the Windows GNU-tar remote drive-letter seam |
| Qualification and release guard | architecture-review-lock, doc-currency, release-qualification-contract, source-scope-receipt, release-transaction, release-transaction-provider; candidate/CI/protected workflows | architecture-review-lock refusal fixtures and doc-currency-review; release-evidence-dag, protected-release-workflow and agentic-qe-early-public bind the outer candidate-preflight dependency and same-run receipts; existing release contract chooses execution evidence |

The exact files are enumerated in frontmatter. This mapping identifies test responsibilities; it
claims neither that every listed test passed on this candidate nor that any reviewer read all files.
The existing bounded execution, persistence and release audits are evidence for their stated scopes,
not a whole-repository or live-provider certification. The final review must identify its source SHA,
actual read coverage, unresolved limitations and architecture/test mapping findings in canonical
project AgentDB. CI cannot verify a local AgentDB decision record merely from a cited key.

## Assurance limits and consequences

The machine guard enforces byte-bound review currency and evidence structure. It cannot establish
semantic correctness, review sincerity, independent reviewer identity or completeness. Frontmatter
and the Currency log are excluded from the existing digest recipe. An author able to edit both the
ADR and its review metadata can forge a structurally current review; this adapter is not a signed
approval boundary. Scope changes therefore require an explicit independent review of the mapping,
not merely regenerating a digest. Existing protected-release machine gates remain authoritative for
publication and cannot be satisfied by relabeling the previous candidate's proof.

This is the smallest immediate lock over existing semantics. It serves P1/P2 by distinguishing fixture
proof from workflow enforcement, P6 by deriving current review from bytes, P7 by stating partial wiring,
and P10 by reusing doc-currency. It trades P3's usual nudge for the owner's explicit opt-in to this
finite release refusal. No paid provider call, model generation or system configuration is added.

## Currency log

| Date | What | Why |
|---|---|---|
| 2026-10-05 | Initial accepted decision; implementation and final-source review incomplete | scripts/architecture-review-lock.mjs reuses scripts/doc-currency.mjs; tests/unit/architecture-review-lock.test.mjs supplies bounded refusal fixtures. |
| 2026-10-05 | Reviewed final source mapping and bounded deltas; reviewed_digest 6f995f7a7215; source a596375bbf2d7b68054b0f2d8fe36187fb7fa415 | scripts/architecture-review-lock.mjs binds the current 80-file scope. Independent source review receipt rnb-astra-source-review-a596375 records actual read coverage and limits. Isolated native Claude positive business evidence and prior Codex controlled repair evidence remain scoped; public installation, owner activation and default launcher context are not established by this source review. |
| 2026-10-05 | Reviewed Windows sealed-archive metadata setup repair; reviewed_digest 2312bba4180a; source 33b70d222d03f5c2f883a9e8fffdfb2b486b1313 | tests/unit/npm-tarball-codex.test.mjs and packed-clean-install retain the same archive assertions using basename plus controlled cwd. Independent source review confirms 81 resolved paths and bounded local regression/smoke evidence; actual Windows acceptance remains required on the new exact candidate. Prior failed setup receipt remains a failure. |
