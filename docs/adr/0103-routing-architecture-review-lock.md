---
id: ADR-103
title: Routing architecture qualification requires a current finite source review
status: Accepted
date: 2026-10-05
updated: 2026-10-06
version: 0.1.13
reviewed_digest: c30a133bd5aa
impl: built
authors: [Stuart Kerr, Codex]
tags: [routing, governance, review, release, traceability]
relates: [ADR-024, ADR-069, ADR-072, ADR-100, ADR-101]
governs:
  - tests/unit/continuation-commitment-ownership.test.mjs
  - plugin/scripts/continuation-gate.mjs
  - plugin/scripts/completion-claim-evidence.mjs
  - plugin/scripts/continuation-objective.mjs
  - plugin/scripts/hook-shim.mjs
  - tests/unit/continuation-gate-completion-claims.test.mjs
  - tests/unit/continuation-gate-objective-close.test.mjs
  - tests/unit/continuation-objective.test.mjs
  - tests/unit/continuation-gate.test.mjs
  - tests/unit/continuation-gate-capability-truth.test.mjs
  - tests/unit/hook-shim.test.mjs
  - tests/unit/automatic-hook-retirement.test.mjs
  - tests/unit/automatic-hook-retirement-posix.test.mjs
  - docs/adr/0074-ruvnet-capability-claim-integrity.md
  - package-lock.json
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
  - tests/unit/codex-fresh-host-proof.test.mjs
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
  - scripts/model-terminal-launchers.mjs
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
  - tests/unit/release-transaction-provider-buffer.test.mjs
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
| Input and parent context | model-managed-prompt, managed-terminal-input, claude-controlled-terminal, codex-managed-terminal | Corresponding unit files; model-managed-parent-context-posix and model-managed-checker-native integration. Oversized Codex parent context uses a bounded, explicitly incomplete projection of the last native compaction and retained tail, while preserving native session identity, full-source digest and turn count. The existing 16MiB projection limit remains; text never grants host authority. |
| Managed service and AgentDB completion | model-managed-workflow-service, model-routing-controller, continuity-journal, routing-outcome-capture | Managed service/controller and routing-outcome-capture unit files; managed native integration. Verified quality repair may continue the exact freshly approved hard harness/provider/model/effort allocation within existing scoped ownership, deadlines and attempt caps; stronger-route selection remains required otherwise, and independent negative review still blocks completion. |
| Execution, checking and independent review | model-routing-execution-adapters, model-routing-defence, model-routing-gateway, model-routing-launchers | Corresponding unit files and gateway boundary tests; private native-history filesystem assertions run in model-managed-parent-context-posix on Linux/macOS, while shared tests retain the explicit Windows ACL-unavailable refusal. Streamed native observation binds actual session metadata, final model/effort/cwd/sandbox and full turn count without loading oversized rollouts; the native process retains its original full history. Small-rollout behavior, ownership, deadline and output guards remain required. |
| Dispatch and owner policy | model-router-engine, model-router-dispatch, policy.default, model-router-setup, model-router-outcome | Managed service/controller tests; model-router-outcome and model-router-update-convergence tests |
| Native subscription and catalog | subscription-hosts, native-subscription-usage, model-native-catalog, model-native-qualification, model-router-catalog | Corresponding native/catalog tests and installer convergence tests |
| Weekly assessment and promotion | model-weekly-cycle, model-weekly-analyst, model-weekly-assessment, model-weekly-qualification, model-routing-policy-promotion, weekly-analyst-instruction | Corresponding weekly and promotion unit files |
| Installation seam | model-terminal-launchers.mjs returns only already-validated Claude settings source paths for restrictive inherited-plan inspection; it does not evaluate native precedence or grant authority. bin/install.mjs (native administrative hooks probe uses explicit caller/CODEX_BIN or configured realCodex, leaving managed app-server refusal intact), model-routing-operation.md, codex-console-alias and SessionStart core/budget | codex-fresh-host-proof native resolution/override/fallback regression; model-router-update-convergence, session-start-core-parity, model-terminal-launchers and npm-tarball-codex; bounded routing and console-alias installation, not an all-installer review; packed-clean-install and npm-tarball-codex retain sealed archive metadata reads with basename and controlled cwd, rejecting the Windows GNU-tar remote drive-letter seam |
| Qualification and release guard | architecture-review-lock, doc-currency, release-qualification-contract, source-scope-receipt, release-transaction, release-transaction-provider, package-lock.json; candidate/CI/protected workflows | architecture-review-lock refusal fixtures and doc-currency-review; release-evidence-dag, protected-release-workflow and agentic-qe-early-public bind the outer candidate-preflight dependency and same-run receipts; existing release contract chooses execution evidence. release-transaction-provider-buffer executes the actual payload upload path with size-based 30s–600s per-file deadlines while metadata and small sidecars retain 30s; the separate download budget and immutable asset checks remain. The npm audit at the exact-candidate seal rejects high-severity dependency advisories; a compatible transitive development patch still requires source-bound qualification, not reuse of an old candidate's receipt. This does not prove transfer throughput or a hard process-tree retirement bound. |

The exact files are enumerated in frontmatter. This mapping identifies test responsibilities; it
claims neither that every listed test passed on this candidate nor that any reviewer read all files.
The existing bounded execution, persistence and release audits are evidence for their stated scopes,
not a whole-repository or live-provider certification. The final review must identify its source SHA,
actual read coverage, unresolved limitations and architecture/test mapping findings in canonical
project AgentDB. CI cannot verify a local AgentDB decision record merely from a cited key.

The large-history candidate has a read-only capture witness on an authentic oversized source and an
actual normal managed UUID-resume witness on an owned synthetic native-cache fixture. The latter is
synthetic-context acceptance, not proof the live user conversation resumed or the owner activated a
new release. Its native full-history source and projected context have distinct digests and provenance.

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
| 2026-10-06 | Reviewed `f3e9a96b6762`; commitment ownership regression expectations align with the existing truthful Stop audit. | Reviewed `tests/unit/continuation-commitment-ownership.test.mjs`;97 related tests pass, production and native-tested guard bytes are unchanged. |
| 2026-10-06 | Reviewed `5a8b149111c9` for `plugin/scripts/continuation-gate.mjs` and the scoped Stop/ownership/shim changes plus test mapping. | Reviewed `plugin/scripts/continuation-gate.mjs`; independent source receipt recorded;97-path inventory is not a97-file semantic reread. Native candidate proof is separate from installed activation. |
| 2026-10-05 | Initial accepted decision; implementation and final-source review incomplete | scripts/architecture-review-lock.mjs reuses scripts/doc-currency.mjs; tests/unit/architecture-review-lock.test.mjs supplies bounded refusal fixtures. |
| 2026-10-05 | Reviewed final source mapping and bounded deltas; reviewed_digest 6f995f7a7215; source a596375bbf2d7b68054b0f2d8fe36187fb7fa415 | scripts/architecture-review-lock.mjs binds the current 80-file scope. Independent source review receipt rnb-astra-source-review-a596375 records actual read coverage and limits. Isolated native Claude positive business evidence and prior Codex controlled repair evidence remain scoped; public installation, owner activation and default launcher context are not established by this source review. |
| 2026-10-05 | Reviewed Windows sealed-archive metadata setup repair; reviewed_digest 2312bba4180a; source 33b70d222d03f5c2f883a9e8fffdfb2b486b1313 | tests/unit/npm-tarball-codex.test.mjs and packed-clean-install retain the same archive assertions using basename plus controlled cwd. Independent source review confirms 81 resolved paths and bounded local regression/smoke evidence; actual Windows acceptance remains required on the new exact candidate. Prior failed setup receipt remains a failure. |
| 2026-10-05 | Reviewed core repair/upload changes; reviewed_digest c591a7821ef7; source 0727de405570e8e44fbd1ca8ebda28737f535dcf | scripts/model-managed-workflow-service.mjs and scripts/release-transaction-provider.mjs retain original authority, identity and budget gates. Scoped independent review confirms 82 resolved paths and the existing protected-publication selector includes the upload regression. Exact native hard continuation completed with positive independent review; actual new protected upload and release/owner activation remain required. Earlier failures remain failures. |
| 2026-10-05 | Reviewed security lock delta; reviewed_digest a67879ce1eb0; source 896fb7a78d4cf0e8ce10cfece815d04539c325ac | .github/workflows/ci.yml retains the exact-candidate npm audit gate that rejected the vulnerable package; package-lock.json changes only compatible transitive development source-map-js 1.2.1 to patched 1.2.2. Independent scoped review confirms 83 resolved paths, current audit has zero vulnerabilities, and packed core/runtime bytes retain their existing proof. New exact source/integration qualification and protected publication remain required; the old failed audit is not relabeled. |
| 2026-10-05 | Reviewed bounded history integration; reviewed_digest a7175c649296; source fc34e4b2a1b0d313b7559ffe1b1823638249959c | scripts/model-managed-prompt.mjs and scripts/model-routing-execution-adapters.mjs retain native identity, authority and existing size limits while binding streamed full-source provenance and bounded compaction context. Independent combined-source review confirms 83 resolved paths and 112 joint focused tests; authentic read-only capture and normal managed synthetic-cache resume witnesses retain their original distinct runtime identities. No full combined-native or live-user activation claim is made. |
| 2026-10-05 | Reviewed native-home fixture correction; reviewed_digest fb295b1e3e97; source c60637ae825a3a6978b0b33b75988645bce70462 | tests/unit/model-managed-parent-context-posix.test.mjs places Codex fixtures in its native session home and retains missing, ambiguity, symlink, digest and escape refusals. Independent scoped review confirms 83 unique resolved paths and 4 focused tests; production bytes and prior component-proof limits are unchanged. The earlier source qualification remains failed; fresh exact-source qualification is required. |
| 2026-10-05 | Reviewed native administrative doctor and platform fixture correction; reviewed_digest 6e41d9bb1970; source d6e0ddb5a18456a437c4ad497abf205df593a87e | bin/install.mjs reuses existing explicit native binary resolution for hooks/list; tests/unit/codex-fresh-host-proof.test.mjs retains overrides and bounded fallback. Six byte-identical private-history assertions moved into tests/unit/model-managed-parent-context-posix.test.mjs without changing Windows ACL/getuid refusal. Independent review confirms 84 unique paths and 100 focused checks; candidate default metadata probe registers 18 hooks with zero native model turns. The failed Windows qualification remains failed, new exact Windows qualification and installed default doctor verification remain required. |
| 2026-10-07 | Reviewed `c30a133bd5aa` against clean `09a8476516488f88842b041c97cee9765c2d307b`. | Reviewed `scripts/claude-controlled-terminal.mjs`, `scripts/model-managed-prompt.mjs` and the bounded routing/doc delta; 99 paths are a byte inventory, not a full semantic reread. Native acceptance and protected publication require their separate receipts. |


## Current completion safeguard scope

The 4.5.15 correction uses the existing Stop path and exact hook-ownership checks. Its finite governed scope includes each changed handler, shim, installer boundary, existing regression test and the POSIX-only retirement fixture. Linux/macOS select that fixture explicitly; the shared retirement suite remains available to Windows. Source byte inventory and scoped checker evidence do not imply semantic review of an arbitrary whole task. Expanded contract/admission/service changes remain deferred and are not part of this candidate.


## Current normal terminal routing repair

The normal Codex and Claude terminal paths use the existing managed planner for requests that are
not clearly informational. Whether a task needs execution, registered checks and independent
review is distinct from its model difficulty; medium allocation does not itself permit bypassing
that workflow. Original request, session context and declared ownership remain bound to execution.
Result-frame vocabulary remains answer context; read-only summarization retains the original
request as its routing input rather than promoting allocation from generated review/check text.

Effective authority must come from the native configuration or an existing terminal approval,
with explicit read-only and inherited Claude plan constraints preserved. Approval policy alone
is not a write grant. Claude invocation-scoped PreToolUse admission retains native deny rules
and restricts tools to host-declared ownership; native initialization must actually acknowledge
that hook admission. Only transport-correlated declared-scope denials may be retained as recovered
negative evidence; untracked denials and user/native-policy refusal remain restrictive. Checks
and the fresh independent review must consider those observations. No owner settings, authentication, billing or personal hooks are expanded.

The existing same-session-native-transport and managed-native-workflow requirements select the
changed tests. Source/unit clearance is not native happy-path acceptance: the five-gate contract
requires actual normal entries, model and effort observations, checks, independent review, exact
canonical readback and protected installation proof. An absent optional Codex project layer is
neutral, while a disabled applicable layer refuses authority; native effective sandbox and the
most-specific configured project trust still govern. The final source-bound focused report covers the corrected modules;
those results do not replace native happy-path and protected qualification receipts.
This finite source inventory is not a claim that every governed file was semantically reread.

Claude permission questions use the existing terminal boundary in FIFO order; EOF or cancellation
denies unresolved requests. This serializes human decisions without adding authority, bypassing
native refusal or changing the Codex branch. Old runtime receipts retain their exact source and
host-branch transfer limits; they are not relabeled as the final installed runtime.
