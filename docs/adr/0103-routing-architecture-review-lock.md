---
id: ADR-103
title: Routing architecture qualification requires a current finite source review
status: Accepted
date: 2026-10-05
updated: 2026-10-08
version: 0.1.23
reviewed_digest: 6868ae881889
impl: built
authors: [Stuart Kerr, Codex]
tags: [routing, governance, review, release, traceability]
relates: [ADR-024, ADR-069, ADR-072, ADR-100, ADR-101]
governs:
  - config/practical-rule-catalog.json
  - plugin/hooks/codex-hooks.json
  - plugin/hooks/hook-contracts.json
  - plugin/scripts/adr-currency-gate.mjs
  - plugin/scripts/advocacy-outcomes.mjs
  - plugin/scripts/agentdb-recall.mjs
  - plugin/scripts/capability-inventory-receipt.mjs
  - plugin/scripts/capability-registry.mjs
  - plugin/scripts/capacity-aware-parallel-work.mjs
  - plugin/scripts/codex-hook-adapter.mjs
  - plugin/scripts/codex-hook-wrapper.mjs
  - plugin/scripts/continuity-brief.mjs
  - plugin/scripts/continuity-events.mjs
  - plugin/scripts/continuity-hook-policy.mjs
  - plugin/scripts/decision-gate.mjs
  - plugin/scripts/decision-outcomes.mjs
  - plugin/scripts/detach.mjs
  - plugin/scripts/doc-currency.mjs
  - plugin/scripts/ground-ruvnet.sh
  - plugin/scripts/grounding-answer.mjs
  - plugin/scripts/grounding-stamp.sh
  - plugin/scripts/grounding-turn-evidence.mjs
  - plugin/scripts/grounding-turn-gate.mjs
  - plugin/scripts/grounding-turn-mark.mjs
  - plugin/scripts/hook-context-budget.mjs
  - plugin/scripts/hook-registry.mjs
  - plugin/scripts/lesson-gate.mjs
  - plugin/scripts/project-capture-queue.mjs
  - plugin/scripts/project-progression-producer.mjs
  - plugin/scripts/project-progression-reader.mjs
  - plugin/scripts/project-progression-session-start.mjs
  - plugin/scripts/project-progression-sources.mjs
  - plugin/scripts/project-progression-store.mjs
  - plugin/scripts/project-store-resolver.mjs
  - plugin/scripts/project-transition-hook.mjs
  - plugin/scripts/native-user-intake.mjs
  - plugin/scripts/session-snapshot-hook.mjs
  - plugin/scripts/session-snapshot-budget.mjs
  - plugin/scripts/session-start-trace.mjs
  - plugin/scripts/turn-outcome-capture.mjs
  - plugin/scripts/unprompted-runtime.mjs
  - plugin/scripts/user-settings.mjs
  - scripts/hook-qualify-core.mjs
  - scripts/practical-rule-selector.mjs
  - scripts/product-integrity-contract.mjs
  - tests/integration/continuity-journal.test.mjs
  - tests/integration/project-progression-session-start.test.mjs
  - tests/integration/unprompted-speech-registry.test.mjs
  - tests/unit/adr-currency-gate-parity.test.mjs
  - tests/unit/adr-currency-gate.test.mjs
  - tests/unit/advocacy-outcomes.test.mjs
  - tests/unit/agentdb-recall.test.mjs
  - tests/unit/capability-inventory-receipt.test.mjs
  - tests/unit/capability-registry.test.mjs
  - tests/unit/codex-claude-hook-parity.test.mjs
  - tests/unit/continuity-brief-host-hint.test.mjs
  - tests/unit/continuity-events.test.mjs
  - tests/unit/continuity-journal-bounds.test.mjs
  - tests/unit/decision-gate.test.mjs
  - tests/unit/decision-outcomes.test.mjs
  - tests/unit/doc-currency.test.mjs
  - tests/unit/entrypoint-symlink.test.mjs
  - tests/unit/grounding-scope.test.mjs
  - tests/unit/grounding-session-isolation.test.mjs
  - tests/unit/grounding-stamp-forgery.test.mjs
  - tests/unit/grounding-stamp-terms.test.mjs
  - tests/unit/grounding-success-shapes.test.mjs
  - tests/unit/grounding-turn-assertion.test.mjs
  - tests/unit/grounding-turn-false-alarm.test.mjs
  - tests/unit/grounding-turn-gate.test.mjs
  - tests/unit/hook-context-budget.test.mjs
  - tests/unit/hook-hardening.test.mjs
  - tests/unit/hook-registry-lint.test.mjs
  - tests/unit/injection-budget.test.mjs
  - tests/unit/lesson-gate.test.mjs
  - tests/unit/practical-rule-selector.test.mjs
  - tests/unit/product-integrity-contract.test.mjs
  - tests/unit/project-progression-producer.test.mjs
  - tests/unit/project-progression-reader.test.mjs
  - tests/unit/project-transition-hook.test.mjs
  - tests/unit/native-user-intake.test.mjs
  - tests/unit/session-snapshot-budget.test.mjs
  - tests/unit/session-start-budget.test.mjs
  - tests/unit/session-start-trace.test.mjs
  - tests/unit/source-scope-receipt.test.mjs
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
  - scripts/managed-frontend-intake.mjs
  - scripts/model-managed-acceptance.mjs
  - scripts/native-workflow-policy.mjs
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
  - tests/unit/managed-frontend-intake.test.mjs
  - tests/unit/managed-frontend-recovery.test.mjs
  - tests/unit/native-workflow-policy.test.mjs
  - tests/unit/native-workflow-schema.test.mjs
  - tests/unit/model-managed-workflow-service.test.mjs
  - tests/unit/model-managed-workflow-service-posix.test.mjs
  - tests/unit/turn-capture-content-privacy-posix.test.mjs
  - tests/unit/learning-worker-supervisor-posix.test.mjs
  - tests/helpers/required-native-tools.mjs
  - console/index.html
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
**Implementation status:** Source-reviewed, awaiting native and release qualification. The
reviewed baseline and finite integration deltas are bound by the independent review
chain. This is not a fresh semantic reread of all 181 governed files. Runtime acceptance
and protected publication remain separate requirements. A stale or unstamped candidate
must fail this guard; this ADR transfers no proof from one SHA to another.

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

| Shared hook intent and ownership | hook-contracts, continuity-hook-policy, hook-registry, shim and native adapters; foreign capture registrations are collision candidates, not current-turn proof | hook-registry-lint, codex-claude-hook-parity, continuity-journal and hook-hardening; native event delivery is separately qualified |
| Native grounding identity and outcome truth | grounding marker/evidence/gate/answer, continuity-events and project-transition-hook share failure/incomplete precedence; Claude prompt_id differs from Codex turn_id | grounding-session-isolation, grounding-success-shapes, grounding-turn-assertion, continuity-events and project-transition-hook; missing IDs remain UNKNOWN |
| Relevant rules and advisory context | practical-rule-catalog/selector, existing managed phase caller, hook-context-budget, owned producers and final Codex merge | practical-rule-selector, model-managed-workflow-service, injection-budget, hook-context-budget and unprompted-speech-registry; selection is advisory, typed quotas exclude critical/unknown/foreign output |
| Canonical recall and recovery | project store resolver, AgentDB recall, continuity journal and progression reader/producer/session-start | agentdb-recall, project-progression-reader/producer, continuity-journal-bounds and session-start-budget; source checks do not imply all-history or all-host recovery |
| Durable intake, acceptance and capture deadlines | native-user-intake binds current owned native USER records; managed-frontend-intake binds the ordinary callback separately; model-managed-acceptance, native-workflow-policy and session-snapshot-budget retain their existing scoped checks | native-user-intake, managed-frontend-intake, native-workflow-policy, native-workflow-schema, managed service and session-snapshot-budget tests. Exact canonical readback is required; a prompt digest alone cannot recover original scope after a frontend crash. Native parent association, actual model execution, universal policy enforcement and all-host recovery remain separately qualified. |

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

## Source-identity reconciliation — 2026-10-08

The governed progression source reader now consumes NUL-delimited exact Git filenames and
unambiguous JSON content-digest/path records. Unavailable or unreadable source cannot mint an
exact identity; the existing bounds and Brain operational-state exclusions remain intact.
`tests/unit/project-progression-producer.test.mjs` maps real Git Unicode/newline byte mutations at
unchanged HEAD, unreadability, newline-record aliasing, and actual producer no-op/canonical
readback. The prior Codex reference-only branch is byte-preserved. This is the finite P013 source
identity boundary, not native/provider, complete recovery, or whole architecture qualification.

The opaque digest recipe applies to new captures without retroactively changing snapshots. These
changed governed bytes expire the prior review. The existing `reviewed_digest` is historical;
final independent review and the architecture/test mapping must precede a replacement stamp.
Accepted decision and proof-gated implementation status remain unchanged.

## Currency log
| 2026-10-08 | Source-identity implementation/test mapping reconciled: exact NUL filenames and unambiguous digest records, unreadable refusal, preserved bounds/exclusions, and same-HEAD/no-op negative cases. This row does not renew final-source review or any native/whole-architecture claim. | `plugin/scripts/project-progression-sources.mjs`, `plugin/scripts/project-progression-producer.mjs`, `tests/unit/project-progression-producer.test.mjs`; new independent review must precede a new reviewed digest. |


| Date | What | Why |
|---|---|---|
| 2026-10-06 | Reviewed `f3e9a96b6762`; commitment ownership regression expectations align with the existing truthful Stop audit. | Reviewed `tests/unit/continuation-commitment-ownership.test.mjs`;97 related tests pass, production and native-tested guard bytes are unchanged. |
| 2026-10-06 | Reviewed `5a8b149111c9` for `plugin/scripts/continuation-gate.mjs` and the scoped Stop/ownership/shim changes plus test mapping. | Reviewed `plugin/scripts/continuation-gate.mjs`; independent source receipt recorded;97-path inventory is not a97-file semantic reread. Native candidate proof is separate from installed activation. |
| 2026-10-05 | Initial accepted decision; implementation and final-source review incomplete | scripts/architecture-review-lock.mjs reuses scripts/doc-currency.mjs; tests/unit/architecture-review-lock.test.mjs supplies bounded refusal fixtures. |
| 2026-10-05 | Reviewed final source mapping and bounded deltas; reviewed_digest 6f995f7a7215; source a596375bbf2d7b68054b0f2d8fe36187fb7fa415 | scripts/architecture-review-lock.mjs binds the current 80-file scope. Independent source review receipt rnb-astra-source-review-a596375 records actual read coverage and limits. Isolated native Claude positive business evidence and prior Codex controlled repair evidence remain scoped; public installation, owner activation and default launcher context are not established by this source review. |
| 2026-10-08 | Bounded final source review; reviewed_digest ad4e7553d3c6; clean source 40ffd86459526f0e6918af7c3dbcf94f9bcf27a3 | scripts/model-routing-controller.mjs and plugin/scripts/project-store-resolver.mjs anchor the actual baseline-plus-delta review. Receipt bounded-independent-final-source-review SHA256 007294c6476a83c6d814ba8bbcd9302b742a419bd00babbc2646052c542379bd binds 295 file pins and reconciles 50 historical pin occurrences across 16 paths. Full source qualification passed 2233 tests without skips at the stated source. Review scope and native, hosted preflight, publication and installation limits remain explicit; P087 aggregate changes are approved but unshipped. |
| 2026-10-08 | Reviewed portable qualification and restricted UX delta; reviewed_digest c22622f30dd7; source 90881251e9df2b4c5e8143c00add7bdfbbd6cc45 | scripts/model-managed-workflow-service.mjs preserves the native read-only sandbox while using the existing npm invocation adapter. Actual bounded review receipt SHA256 18b5ebf3956b5ac48cffe6fc5503ef02b543cc3115d6d24a048c1e1df7a88f67 binds all 23 frozen delta pins, portable native prerequisites, POSIX physical profile mapping and truthful unavailable-remedy disclosure. Focused local checks passed 338 and 39 cases; real local UX passed six checks in one attempt. Windows, exact-SHA hosted qualification and protected publication remain required; automatic remedy inverse capability and P087 remain unshipped. |
| 2026-10-08 | Reviewed CI prerequisite delta; reviewed_digest 6868ae881889 | .github/workflows/ci.yml loads the official named distro bubblewrap AppArmor profile on Linux while preserving runtime namespace isolation, capability drops and the native read-only sandbox. tests/helpers/required-native-tools.mjs proves a private explicit-path real Ruflo write, exact CLI retrieval and independent SQLite row equality before qualification, with bounded failure evidence. Actual bounded review SHA256 cb55aa6ed87043adb5dbb8e7b241a9303fd3bc5d21866c01bd67f26507f9b1bf binds the two frozen files. Local probe passed; hosted OS qualification remains required. |
| 2026-10-05 | Reviewed Windows sealed-archive metadata setup repair; reviewed_digest 2312bba4180a; source 33b70d222d03f5c2f883a9e8fffdfb2b486b1313 | tests/unit/npm-tarball-codex.test.mjs and packed-clean-install retain the same archive assertions using basename plus controlled cwd. Independent source review confirms 81 resolved paths and bounded local regression/smoke evidence; actual Windows acceptance remains required on the new exact candidate. Prior failed setup receipt remains a failure. |
| 2026-10-05 | Reviewed core repair/upload changes; reviewed_digest c591a7821ef7; source 0727de405570e8e44fbd1ca8ebda28737f535dcf | scripts/model-managed-workflow-service.mjs and scripts/release-transaction-provider.mjs retain original authority, identity and budget gates. Scoped independent review confirms 82 resolved paths and the existing protected-publication selector includes the upload regression. Exact native hard continuation completed with positive independent review; actual new protected upload and release/owner activation remain required. Earlier failures remain failures. |
| 2026-10-05 | Reviewed security lock delta; reviewed_digest a67879ce1eb0; source 896fb7a78d4cf0e8ce10cfece815d04539c325ac | .github/workflows/ci.yml retains the exact-candidate npm audit gate that rejected the vulnerable package; package-lock.json changes only compatible transitive development source-map-js 1.2.1 to patched 1.2.2. Independent scoped review confirms 83 resolved paths, current audit has zero vulnerabilities, and packed core/runtime bytes retain their existing proof. New exact source/integration qualification and protected publication remain required; the old failed audit is not relabeled. |
| 2026-10-05 | Reviewed bounded history integration; reviewed_digest a7175c649296; source fc34e4b2a1b0d313b7559ffe1b1823638249959c | scripts/model-managed-prompt.mjs and scripts/model-routing-execution-adapters.mjs retain native identity, authority and existing size limits while binding streamed full-source provenance and bounded compaction context. Independent combined-source review confirms 83 resolved paths and 112 joint focused tests; authentic read-only capture and normal managed synthetic-cache resume witnesses retain their original distinct runtime identities. No full combined-native or live-user activation claim is made. |
| 2026-10-05 | Reviewed native-home fixture correction; reviewed_digest fb295b1e3e97; source c60637ae825a3a6978b0b33b75988645bce70462 | tests/unit/model-managed-parent-context-posix.test.mjs places Codex fixtures in its native session home and retains missing, ambiguity, symlink, digest and escape refusals. Independent scoped review confirms 83 unique resolved paths and 4 focused tests; production bytes and prior component-proof limits are unchanged. The earlier source qualification remains failed; fresh exact-source qualification is required. |
| 2026-10-05 | Reviewed native administrative doctor and platform fixture correction; reviewed_digest 6e41d9bb1970; source d6e0ddb5a18456a437c4ad497abf205df593a87e | bin/install.mjs reuses existing explicit native binary resolution for hooks/list; tests/unit/codex-fresh-host-proof.test.mjs retains overrides and bounded fallback. Six byte-identical private-history assertions moved into tests/unit/model-managed-parent-context-posix.test.mjs without changing Windows ACL/getuid refusal. Independent review confirms 84 unique paths and 100 focused checks; candidate default metadata probe registers 18 hooks with zero native model turns. The failed Windows qualification remains failed, new exact Windows qualification and installed default doctor verification remain required. |
| 2026-10-07 | Reviewed `c30a133bd5aa` against clean `09a8476516488f88842b041c97cee9765c2d307b`. | Reviewed `scripts/claude-controlled-terminal.mjs`, `scripts/model-managed-prompt.mjs` and the bounded routing/doc delta; 99 paths are a byte inventory, not a full semantic reread. Native acceptance and protected publication require their separate receipts. |


| 2026-10-07 | Reviewed `ef6b7ed562b6` against source `5f2d3cde64d007c9e92743b3f223e0730e348d6d` and the recorded final working bytes. | Bounded baseline-plus-delta semantic coverage from the 25-artifact review chain and corrected transition addendum; explicit 181-path byte inventory is not 181 fresh file reads. `plugin/scripts/project-transition-hook.mjs`, shared outcome normalization, native identity, typed advisory budgets and practical-rule phase decoration were reviewed with their direct consumers. 335 shared outcome/grounding checks passed. Native event delivery, one Windows case, all-rule hard enforcement and protected publication remain separate or incomplete. |

| 2026-10-07 | Reviewed `09d465c11e67` against source `0e8e1290` and the recorded final working bytes. | Prior bounded baseline-plus-delta review remains scoped. Independent test-correction review confirms `tests/unit/hook-shim.test.mjs` copies the actual hook manifest and `tests/unit/continuation-gate-capability-truth.test.mjs` preserves unknown installation and activation claims; 23 focused checks passed. Native memory capture and protected publication remain incomplete. |

| 2026-10-07 | Reviewed `de355dd5acbb` against source `b92aa838` and the recorded current bytes. | Independent bounded reviews cover the existing native administrative resolver export in `bin/install.mjs`, its discovery and installer fixtures, conservative foreign-owner recall assertions and the actual SessionStart budget-helper import. Root focused checks passed 5 native discovery, 66 ownership/startup and 7 managed-boundary tests with zero skips. Earlier failed integration receipt remains failed; fresh clean qualification, native session evidence and protected publication are required. |

| 2026-10-07 | Reviewed `e34f347644a6` against source `92147327` and the recorded current bytes. | Independent bounded review covers the PreCompact-only no-op exemption in `plugin/scripts/project-progression-producer.mjs` and actual lifecycle regression through the existing canonical append/readback path. 43 integrated checks passed without skips. The prior native run remains blocked: it delivered PreCompact but intentionally suppressed an unchanged snapshot. Fresh packed native execution and publication are still required; no historical receipt is relabeled. |

| 2026-10-07 | Reviewed `c694f81d5ae3` against source `6808039e` and recorded current bytes. | Bounded independent review and 17 integrated checks cover the three grounding dispatches joining the existing matching-root, undefined-only Claude fallback in `plugin/scripts/hook-shim.mjs`. Explicit Codex and unknown-host safeguards remain. Prior same-source native Claude tool/restore/capture succeeded but grounding was blocked; this new dispatcher requires fresh packed native proof. The reviewed subprocess cases are qualified on macOS/Linux only by the existing platform contract, not asserted on Windows. |

| 2026-10-07 | Reviewed `7ba26e9903fa` against source `439d94d1` and recorded current bytes. | Independent review covers the test-local fixed Node syntax checker in `tests/unit/model-managed-workflow-service.test.mjs`: original hosted source-only refusal was reproduced, all fresh-recall and receipt assertions retained, and the full 27-case integrated file passed. No production runtime code changed. Prior native proof stays bound to its original source and artifact; exact new qualification and hosted gates remain required. Failed preflight 37606672323 remains failed and main was not promoted. |

## Current completion safeguard scope

The three grounding identity dispatches (`grounding-turn-mark`, `grounding-stamp`, `grounding-turn-gate`) share the existing trusted Claude host fallback in `plugin/scripts/hook-shim.mjs`. Inference is allowed only when the host variable is undefined and the native plugin-root realpath matches the executing owned shim. Explicit Codex, invalid or empty host values and missing or mismatched roots remain unchanged. This repairs native Claude identity transport without treating a global stamp as current-turn proof; fresh packed native receipts are required.


Pre-compaction is an explicit canonical checkpoint boundary. `plugin/scripts/project-progression-producer.mjs` must produce a fresh `PreCompact` snapshot even when state and source meaning match the preceding Stop. It uses the existing consent, native session identity, append-only sequence/parent and exact readback path; ordinary unchanged Stop and SessionEnd suppression remains. This is a source contract requiring fresh packed native evidence, not a claim that the current live session has passed.


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


## Hook and practical-rule extension — 2026-10-07

The finite governed set now includes the shared hook contracts, host adapters,
canonical-memory capture and recall, source-grounding identity, typed advisory
budgets and the approved practical-rule catalog/selector. Selection is bounded
advisory delivery; it does not assert that every listed rule is mechanically
enforced. Existing refusal, acceptance and publication gates remain independent.

Component reviews and focused checks cover their recorded source/range scopes.
The dated integrated review identifies the baseline-plus-delta read scope, its
source hashes, resolved findings and remaining limits. Native qualification is
still required before publication. File hashes do not certify semantic reading.
