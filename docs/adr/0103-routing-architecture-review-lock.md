---
id: ADR-103
title: Routing architecture qualification requires a current finite source review
status: Accepted
date: 2026-10-05
updated: 2026-10-15
version: 0.1.40
reviewed_digest: 3766bcde7ff9
impl: built
authors: [Stuart Kerr, Codex]
tags: [routing, governance, review, release, traceability]
relates: [ADR-024, ADR-069, ADR-072, ADR-100, ADR-101]
governs:
  - .github/workflows/ci.yml
  - .github/workflows/early-public.yml
  - .github/workflows/protected-release.yml
  - .github/workflows/release-candidate-preflight.yml
  - CONTRIBUTING.md
  - bin/install.mjs
  - bin/nightly-refresh.mjs
  - config/model-router/policy.default.mjs
  - config/model-router/weekly-analyst-instruction.md
  - config/practical-rule-catalog.json
  - docs/adr/0074-ruvnet-capability-claim-integrity.md
  - docs/model-routing-operation.md
  - package-lock.json
  - plugin/hooks/codex-hooks.json
  - plugin/hooks/hook-contracts.json
  - plugin/scripts/adr-currency-gate.mjs
  - plugin/scripts/advocacy-outcomes.mjs
  - plugin/scripts/agentdb-recall.mjs
  - plugin/scripts/capability-inventory-receipt.mjs
  - plugin/scripts/capability-registry.mjs
  - plugin/scripts/capacity-aware-parallel-work.mjs
  - plugin/scripts/codex-console-alias.mjs
  - plugin/scripts/codex-hook-adapter.mjs
  - plugin/scripts/codex-hook-wrapper.mjs
  - plugin/scripts/completion-claim-evidence.mjs
  - plugin/scripts/continuation-gate.mjs
  - plugin/scripts/continuation-objective.mjs
  - plugin/scripts/continuity-events.mjs
  - plugin/scripts/continuity-hook-policy.mjs
  - plugin/scripts/decision-gate.mjs
  - plugin/scripts/decision-outcomes.mjs
  - plugin/scripts/decision-recall-gate.mjs
  - plugin/scripts/decision-record.mjs
  - plugin/scripts/deferral-evidence.mjs
  - plugin/scripts/detach.mjs
  - plugin/scripts/developer-update-maintenance.mjs
  - plugin/scripts/developer-update.mjs
  - plugin/scripts/doc-currency.mjs
  - plugin/scripts/ground-ruvnet.sh
  - plugin/scripts/grounding-answer.mjs
  - plugin/scripts/grounding-stamp.sh
  - plugin/scripts/grounding-turn-evidence.mjs
  - plugin/scripts/grounding-turn-gate.mjs
  - plugin/scripts/grounding-turn-mark.mjs
  - plugin/scripts/hook-context-budget.mjs
  - plugin/scripts/hook-failures.mjs
  - plugin/scripts/hook-registry.mjs
  - plugin/scripts/hook-shim.mjs
  - plugin/scripts/lesson-gate.mjs
  - plugin/scripts/nightly-scheduler.mjs
  - plugin/scripts/project-store-resolver.mjs
  - plugin/scripts/routing-outcome-capture.mjs
  - plugin/scripts/ruflo-memory-hooks.mjs
  - plugin/scripts/session-snapshot-hook.mjs
  - plugin/scripts/session-start-budget.mjs
  - plugin/scripts/session-start-core.mjs
  - plugin/scripts/session-start-trace.mjs
  - plugin/scripts/substitution-wall.mjs
  - plugin/scripts/turn-outcome-capture.mjs
  - plugin/scripts/unprompted-runtime.mjs
  - plugin/scripts/user-settings.mjs
  - scripts/architecture-review-lock.mjs
  - scripts/candidate-ci-receipt.mjs
  - scripts/claude-controlled-terminal.mjs
  - scripts/codex-managed-terminal.mjs
  - scripts/deferral-replay.mjs
  - scripts/doc-currency.mjs
  - scripts/hook-qualify-core.mjs
  - scripts/managed-terminal-input.mjs
  - scripts/model-managed-prompt.mjs
  - scripts/model-managed-workflow-service.mjs
  - scripts/model-native-catalog.mjs
  - scripts/model-native-qualification.mjs
  - scripts/model-router-catalog.mjs
  - scripts/model-router-dispatch.mjs
  - scripts/model-router-engine.mjs
  - scripts/model-router-outcome.mjs
  - scripts/model-router-setup.mjs
  - scripts/model-routing-controller.mjs
  - scripts/model-routing-defence.mjs
  - scripts/model-routing-execution-adapters.mjs
  - scripts/model-routing-gateway.mjs
  - scripts/model-routing-launchers.mjs
  - scripts/model-routing-policy-promotion.mjs
  - scripts/model-terminal-launchers.mjs
  - scripts/model-weekly-analyst.mjs
  - scripts/model-weekly-assessment.mjs
  - scripts/model-weekly-cycle.mjs
  - scripts/model-weekly-qualification.mjs
  - scripts/native-subscription-usage.mjs
  - scripts/practical-rule-selector.mjs
  - scripts/prepublication-evidence.mjs
  - scripts/product-integrity-contract.mjs
  - scripts/qe/agentic-qe-4.3.mjs
  - scripts/release-qualification-contract.mjs
  - scripts/release-qualification.mjs
  - scripts/release-transaction-provider.mjs
  - scripts/release-transaction.mjs
  - scripts/source-scope-receipt.mjs
  - scripts/subscription-hosts.mjs
  - tests/integration/model-managed-checker-native.test.mjs
  - tests/integration/unprompted-speech-registry.test.mjs
  - tests/qe/release/packed-clean-install.test.mjs
  - tests/unit/adr-currency-gate-parity.test.mjs
  - tests/unit/adr-currency-gate.test.mjs
  - tests/unit/advocacy-outcomes.test.mjs
  - tests/unit/agentdb-recall.test.mjs
  - tests/unit/agentic-qe-early-public.test.mjs
  - tests/unit/architecture-review-lock.test.mjs
  - tests/unit/automatic-hook-retirement-posix.test.mjs
  - tests/unit/automatic-hook-retirement.test.mjs
  - tests/unit/capability-inventory-receipt.test.mjs
  - tests/unit/capability-registry.test.mjs
  - tests/unit/claude-controlled-terminal.test.mjs
  - tests/unit/codex-claude-hook-parity.test.mjs
  - tests/unit/codex-fresh-host-proof.test.mjs
  - tests/unit/codex-managed-terminal.test.mjs
  - tests/unit/continuation-commitment-ownership.test.mjs
  - tests/unit/continuation-gate-capability-truth.test.mjs
  - tests/unit/continuation-gate-completion-claims.test.mjs
  - tests/unit/continuation-gate-decision-record.test.mjs
  - tests/unit/continuation-gate-objective-close.test.mjs
  - tests/unit/continuation-gate.test.mjs
  - tests/unit/continuation-objective.test.mjs
  - tests/unit/continuity-events.test.mjs
  - tests/unit/decision-gate.test.mjs
  - tests/unit/decision-outcomes.test.mjs
  - tests/unit/decision-record.test.mjs
  - tests/unit/deferral-evidence.test.mjs
  - tests/unit/developer-update-codex-launcher.test.mjs
  - tests/unit/developer-update-scheduled-receipt.test.mjs
  - tests/unit/doc-currency-review.test.mjs
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
  - tests/unit/hook-failures.test.mjs
  - tests/unit/hook-hardening.test.mjs
  - tests/unit/hook-registry-lint.test.mjs
  - tests/unit/hook-shim.test.mjs
  - tests/unit/injection-budget.test.mjs
  - tests/unit/lesson-gate.test.mjs
  - tests/unit/managed-terminal-input.test.mjs
  - tests/unit/model-managed-parent-context-posix.test.mjs
  - tests/unit/model-managed-prompt.test.mjs
  - tests/unit/model-managed-workflow-service.test.mjs
  - tests/unit/model-native-catalog.test.mjs
  - tests/unit/model-native-qualification.test.mjs
  - tests/unit/model-router-outcome.test.mjs
  - tests/unit/model-router-update-convergence.test.mjs
  - tests/unit/model-routing-controller.test.mjs
  - tests/unit/model-routing-execution-adapters.test.mjs
  - tests/unit/model-routing-gateway-boundaries.test.mjs
  - tests/unit/model-routing-gateway.test.mjs
  - tests/unit/model-routing-policy-promotion.test.mjs
  - tests/unit/model-terminal-launchers.test.mjs
  - tests/unit/model-weekly-analyst.test.mjs
  - tests/unit/model-weekly-assessment.test.mjs
  - tests/unit/model-weekly-cycle.test.mjs
  - tests/unit/model-weekly-qualification.test.mjs
  - tests/unit/native-subscription-usage.test.mjs
  - tests/unit/nightly-scheduler.test.mjs
  - tests/unit/npm-tarball-codex.test.mjs
  - tests/unit/practical-rule-selector.test.mjs
  - tests/unit/prepublication-evidence.test.mjs
  - tests/unit/product-integrity-contract.test.mjs
  - tests/unit/protected-release-workflow.test.mjs
  - tests/unit/release-evidence-dag.test.mjs
  - tests/unit/release-transaction-provider-buffer.test.mjs
  - tests/unit/routing-outcome-capture.test.mjs
  - tests/unit/session-start-budget.test.mjs
  - tests/unit/session-start-core-parity.test.mjs
  - tests/unit/session-start-trace.test.mjs
  - tests/unit/source-scope-receipt.test.mjs
  - tests/unit/subscription-hosts.test.mjs
---

# ADR-103 — Routing architecture review lock

**Status**: Accepted

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
| Project memory (AgentDB) integration | agentdb-recall, agentdb-recall-process, agentdb-recall-reader, project-memory-enrollment, project-store-resolver, project-progression-session-start, turn-outcome-capture, continuity-journal, project-progression-store | agentdb-recall, agentdb-recall-native, project-memory-enrollment, project-store-resolver, ruflo-env-scrub and turn-outcome-capture unit files; project-memory-enrollment-native, continuity-journal and project-progression-session-start integration. ADR-105 is the single standard: exact curated records are read natively before ranked search and always leave through a 600-byte block; Ruflo runs from private scratch with an explicit --path and no CLAUDE_FLOW_MEMORY_PATH; writes are native append-only with exact readback and a refusal is never a duplicate; SessionStart never creates a store and enrollment is lazy, consent-gated and replay never re-enrolls. A failed read is reported unavailable or timed out, never as empty history. |
| Hook standard and decision records (ADR-106) | decision-record, decision-recall-gate, hook-failures, deferral-evidence, continuation-gate, hook-shim, session-snapshot-hook, project-transition-hook | decision-record, hook-failures, deferral-evidence, continuation-gate-decision-record, transition-pending-notices unit files; hook-latency-budget and learning-fold integration. Decisions carry what/why/shape/evidence/supersedes and are written through the ADR-105 native door with exact readback; only a ratified record may supersede, and supersession is computed from tombstone rows at recall; a new ADR or ADR status change needs a fresh AgentDB consult (refused once per path per session, retry allowed); continuation-gate asks once for a decision record and once when authorized work is handed back (no-deferral, capped at 3). Prompt and tool boundaries only queue and detach; the shim watchdog stops a body 1.5 s before its registered timeout and records `timed-out-internally`. Limits: the no-deferral false-positive rate is a 15% tuning-set estimate with held-out FP/FN unmeasured; a watchdog kill is read as ALLOW; Codex does not enforce the decision-record or no-deferral checks. |
| Execution, checking and independent review | model-routing-execution-adapters, model-routing-defence, model-routing-gateway, model-routing-launchers | Corresponding unit files and gateway boundary tests; private native-history filesystem assertions run in model-managed-parent-context-posix on Linux/macOS, while shared tests retain the explicit Windows ACL-unavailable refusal. Streamed native observation binds actual session metadata, final model/effort/cwd/sandbox and full turn count without loading oversized rollouts; the native process retains its original full history. Small-rollout behavior, ownership, deadline and output guards remain required. |
| Dispatch and owner policy | model-router-engine, model-router-dispatch, policy.default, model-router-setup, model-router-outcome | Managed service/controller tests; model-router-outcome and model-router-update-convergence tests |
| Native subscription and catalog | subscription-hosts, native-subscription-usage, model-native-catalog, model-native-qualification, model-router-catalog | Corresponding native/catalog tests and installer convergence tests |
| Weekly assessment and promotion | model-weekly-cycle, model-weekly-analyst, model-weekly-assessment, model-weekly-qualification, model-routing-policy-promotion, weekly-analyst-instruction | Corresponding weekly and promotion unit files |
| Installation seam | model-terminal-launchers.mjs returns only already-validated Claude settings source paths for restrictive inherited-plan inspection; it does not evaluate native precedence or grant authority. bin/install.mjs (native administrative hooks probe uses explicit caller/CODEX_BIN or configured realCodex, leaving managed app-server refusal intact), model-routing-operation.md, codex-console-alias and SessionStart core/budget | codex-fresh-host-proof native resolution/override/fallback regression; model-router-update-convergence, session-start-core-parity, model-terminal-launchers and npm-tarball-codex; bounded routing and console-alias installation, not an all-installer review; packed-clean-install and npm-tarball-codex retain sealed archive metadata reads with basename and controlled cwd, rejecting the Windows GNU-tar remote drive-letter seam |
| Decision gate source ceiling | plugin/scripts/decision-gate.mjs removes only 16 blank lines to meet the existing 500-line source gate; source tokens and behavior are unchanged. | Independent blank-line-insensitive diff is empty; the existing lesson-gate checks retain the architecture source-size requirement. Source formatting clearance does not establish runtime or release acceptance. |
| Observed completion and literal fixture annotations | scripts/codex-managed-terminal.mjs derives receipt status from the actual native completion result only after existing model/effort/session/decision/deadline checks. continuation-gate.mjs derives done/state from the existing PASS verdict and matched owned promise claim; no new PASS producer or authority is introduced. | Codex pending/failed-native regression writes no completion receipt/output; continuation FAIL regression leaves the original active commitment and evidence unchanged. agentdb-recall, model-terminal-launchers and model-weekly-analyst add only exact-literal fixture annotations, retaining every assertion. Source-level derived assignments do not prove new native delivery or public qualification. |
| Hook consumer protocol coverage and fixture closure | scripts/hook-qualify-core.mjs derives only named SubagentStop/PostToolUseFailure envelopes from existing captured base events. Claude-derived shapes cite documented fields; Codex/Grok mappings are consumer-only and explicitly set nativeSchemaObserved:false/nativeDeliveryObserved:false. No generic unknown-event fallback is added. | hook-qualify regression fixtures retain strict missing-event refusal; native producer schema and delivery require independent host evidence. project-progression-session-start copies the adapter's required budget helper; model-weekly-qualification copies the actual transitive import closure using the existing installer dependency scanner. Their output/refusal assertions remain unchanged and do not establish real native execution. |
| Coordinated update admission | bin/install.mjs acquires the shared developer-update owner lock before the existing update, propagates its token for owned nested work, restores the previous environment and releases in finally. The coordinator and immutable module closure are governed separately by ADR-104. CONTRIBUTING.md records explicit channel/scope/manager choices, the shipped updater launcher, configured automatic-owner admission and proof boundaries. package-lock.json changes product version and declares the shipped update launcher without changing dependency versions. | developer-update lock inheritance/refusal/release and canonical source tests; architecture-review-lock and doc-currency-review refusal fixtures. Focused checks establish source behavior only; actual scheduled execution, provider currency and public installation need their own exact receipts. |
| Qualification and release guard | architecture-review-lock, doc-currency, release-qualification-contract, source-scope-receipt, release-transaction, release-transaction-provider, package-lock.json; candidate/CI/protected workflows | architecture-review-lock refusal fixtures and doc-currency-review; release-evidence-dag, protected-release-workflow and agentic-qe-early-public bind the outer candidate-preflight dependency and same-run receipts; existing release contract chooses execution evidence. The installed-update requirement adds portable channel/version policy, immutable Claude artifact negatives and complete coordinator-module receipt checks on every platform; original-prefix, existing-owner and shared-lock shell fixtures run on POSIX. The integration contract retains the real authenticated Console endpoint refusal and read-only cases. Local 173-case focused execution and independent baseline-plus-delta review support these selected boundaries; exact-source candidate qualification and actual Windows execution remain required. release-transaction-provider-buffer executes the actual payload upload path with size-based 30s–600s per-file deadlines while metadata and small sidecars retain 30s; the separate download budget and immutable asset checks remain. The npm audit at the exact-candidate seal rejects high-severity dependency advisories; a compatible transitive development patch still requires source-bound qualification, not reuse of an old candidate's receipt. This does not prove transfer throughput or a hard process-tree retirement bound. |

| Shared hook intent and ownership | hook-contracts, continuity-hook-policy, hook-registry, shim and native adapters; foreign capture registrations are collision candidates, not current-turn proof | hook-registry-lint, codex-claude-hook-parity, continuity-journal and hook-hardening; native event delivery is separately qualified |
| Native grounding identity and outcome truth | grounding marker/evidence/gate/answer, continuity-events and project-transition-hook share failure/incomplete precedence; Claude prompt_id differs from Codex turn_id | grounding-session-isolation, grounding-success-shapes, grounding-turn-assertion, continuity-events and project-transition-hook; missing IDs remain UNKNOWN |
| Relevant rules and advisory context | practical-rule-catalog/selector, existing managed phase caller, hook-context-budget, owned producers and final Codex merge | practical-rule-selector, model-managed-workflow-service, injection-budget, hook-context-budget and unprompted-speech-registry; selection is advisory, typed quotas exclude critical/unknown/foreign output |
| Canonical recall and recovery | project store resolver, AgentDB recall, continuity journal and progression reader/producer/session-start | agentdb-recall, project-progression-reader/producer, continuity-journal-bounds and session-start-budget; source checks do not imply all-history or all-host recovery |

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

## Native update and nightly identity repair (4.6.2)

The finite scope includes the native maintenance adapter and its trusted-launcher
regressions, plus the immutable nightly runner and scheduler execution tests. Native
Codex maintenance validates the registered user-owned configuration, exact wrapper
bytes, complete runtime digest and standalone native owner before updating. The
existing terminal installer restores the registered wrapper without changing shell
configuration or adopting unknown replacements. Shared Claude configuration remains
preserved. Failed commands or restoration cannot complete the provider; vendor native
files are not rolled back by this adapter.

The developer-suite runner forwards the registration, Node path, runner path and runner
SHA-256 it has already verified. Caller-supplied conflicting identity values do not
replace that registration. Native wrapper tests are POSIX qualification; portable
policy and scheduler identity qualification remain selected on Windows.

A separate constant-space scheduled-attempt receipt retains running, failed and completed
scheduled applies independently of the latest currency check or manual operation. The
health reader chooses the newer scheduled attempt from current and retained evidence,
validates registration/source bindings, rejects future or stale proof, and requires the
matching live owner for running state. Before replacing latest evidence with a check or
manual run, the writer reconciles newer scheduled evidence under the existing lock;
failure to preserve it refuses that overwrite. This does not copy an old receipt back
into the latest-operation slot or manufacture a successful scheduled run.

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

| 2026-10-10 | Reviewed `5b6649f102ca` against receipt-repair worker source `8f852170`, integration `56eb2f2d`, and the final 4.6.2 finite mapping. | Root independently reviewed `plugin/scripts/developer-update.mjs`, `plugin/scripts/nightly-scheduler.mjs` and the nine scheduled-receipt regressions; all nine independently executed cases passed. The two-slot constant-space intent preserves newer running/failed scheduled attempts, reconciles evidence before manual/check overwrite, refuses retention failure, and retains source/registration/time/live-owner validation plus legacy compatibility. Integration passed 118 combined focused cases. Earlier native-wrapper and four-field runner review remains scoped to its recorded source. This is not whole-set reread, public installation, actual scheduled customer execution, corpus refresh or SDK hot-reload evidence. The completed `55cf952a` preflight remains bound to its earlier bytes and is not reused. |

| 2026-10-10 | Reviewed `6c905535ed9c` against worker source `4a6e3a71`, integration source `3fc97cc5` and the final finite 4.6.2 mapping. | Root independently reviewed `plugin/scripts/developer-update-maintenance.mjs`, its focused tests, `bin/nightly-refresh.mjs`, `tests/unit/nightly-scheduler.test.mjs`, the POSIX qualification additions and ADR-103/104 normative mapping. Eleven independent wrapper cases passed. Integration reproduced missing scheduled registration identity against the actual content-addressed runner, then passed all 24 scheduler cases and 96 combined focused cases. The controlled existing-runtime launcher restoration matched its 605-file digest, preserved shared config, Claude and shell bytes, and returned native Codex 0.162.1. This bounded review does not assert rereading all 185 governed paths, protected publication, completed customer maintenance, corpus freshness or SDK hot reload. Vendor files are not rolled back on provider failure. |

| 2026-10-10 | Reviewed `fe3bd67a609b` against source `1caa967158560562795e1e6ebae44e2c2cd386f5` and governed paths `package-lock.json` and `scripts/release-qualification-contract.mjs`. | Root independently read `package-lock.json` and `scripts/release-qualification-contract.mjs` in the baseline-plus-delta diff against `db36152f274043d423eb61ef1cf0a85fb9ff49a7`: two root version literals advance 4.6.0 to 4.6.1 without dependency changes; one source requirement adds the two changed admin suites while retaining the prior inventory. Independent candidate execution passed 16 API/DOM fixture cases without skips; root also inspected the local rendered README and admin surface. No hook or routing implementation changed. These scoped checks do not establish full source qualification, remote preflight, production deployment, public installation or upstream corpus freshness; the previous failed preflight remains failed. |

| 2026-10-10 | Reviewed `54844be550d7` against governed source `scripts/release-qualification-contract.mjs` and the final normative mapping. | Independent read-only baseline-plus-delta review of `scripts/release-qualification-contract.mjs` retained all existing requirements and approved the updater qualification additions: portable channel/version policy and immutable artifact negatives, complete coordinator-source receipt controls, POSIX original-prefix/existing-owner/shared-lock fixtures, and the actual authenticated Console endpoint. The integrated 173-case focused report passed without skips. This review does not establish native Windows execution, arbitrary runtime closure, whole-repository plugin equality, or candidate/publication acceptance; those remain separate machine gates. |

| 2026-10-10 | Reviewed `1786179157c9` against governed source `9371e164` and the final status/mapping bytes. | The finite 776e38e4-to-9371e164 delta adds guarded result-derived assignments in `scripts/codex-managed-terminal.mjs` and `plugin/scripts/continuation-gate.mjs`, their pending/FAIL regressions, and comment-only exact-literal annotations in `tests/unit/agentdb-recall.test.mjs`, model-terminal-launchers and model-weekly-analyst. Root independently reviewed both production assignments and the final mapping row: existing native identity/model/effort/deadline and PASS/matched-owned-claim guards remain, with no new producer authority. updater_docs reviewed all seven changed governed paths and retained negative assertions. The parseable Accepted body status repairs document format without granting runtime acceptance. All 537 checks passed across ADR format and the five related fixture suites. The preceding three-file hook/closure review remains scoped; no whole-set reread, native producer/delivery, scheduled-run or protected installation proof is claimed. |


| 2026-10-10 | Reviewed `619f5346336e` against final governed source `776e38e4` and this mapping. | Bounded review covers the exact d79602b8-to-776e38e4 deltas in `scripts/hook-qualify-core.mjs`, `tests/integration/project-progression-session-start.test.mjs` and `tests/unit/model-weekly-qualification.test.mjs`. Root independently reviewed the named consumer-only derived envelopes; updater_docs reviewed fixture dependency closure and retained assertions; updater_audit independently approved the final mapping and source scope. Missing future events still refuse, and Codex/Grok native schema/delivery observations remain false. 98 focused checks passed across the three relevant suites. No whole-governed-set reread, native producer/delivery, scheduled-run or protected installation proof is claimed; earlier review and failed receipt limits remain. |


| 2026-10-10 | Reviewed `cf0271a2e0d1` against governed source `dc2301a1` and the final CONTRIBUTING/mapping bytes. | Independent read-only updater_audit review covers the bounded `bin/install.mjs`, `package-lock.json`, `CONTRIBUTING.md` deltas and the 16 blank-line-only removals in `plugin/scripts/decision-gate.mjs`; the blank-line-insensitive source diff is empty. Final bridge documentation was independently checked against canonical-first automatic invocation 05cfa286 and knowledge caller a2351888, including corrupt-legacy negative fixtures. No findings remain in this scope. 115 focused developer-update, lesson-gate, architecture-review-lock and doc-currency-review tests passed; the independent final developer-update run passed 27 cases. Prior governed review scopes remain bounded: no whole-set reread, native scheduled-run, provider freshness or protected public-installation claim is made. |


| 2026-10-10 | Reviewed `034691457343` against source `8237f6d7` and this final mapping. | Independent read-only updater_audit review examined the exact 9cf8fe19-to-8237f6d7 deltas in `CONTRIBUTING.md`, `bin/install.mjs` and `package-lock.json`, the ADR mapping and the canonical coordinator/lock/nightly consumers; no blocking findings. Installer lock/token inheritance and finally-release, metadata-only launcher/version changes and explicit update policy remain scoped. 45 focused developer-update, architecture-review-lock and doc-currency-review checks passed. The other governed bytes retain their prior bounded review chain; no full governed-set reread, native schedule, provider freshness or protected public installation claim is made. |

| 2026-10-11 | Reviewed `20266b697155` against governed source `55ebe8dc` (base `e0737470`, release 4.6.3) and this final mapping. | Independent read-only Opus 5.5 reviews of the AgentDB integration delta: first pass at `36fe043f` returned REVISE with four blocking findings (SessionStart store creation without consent, an 1800-byte curated block on a 600-byte path, curated records discarded when ranked search was empty, torn enrollment files wedging enrollment); second pass over `36fe043f..32ebd019` confirmed three resolved and found one partial plus one non-blocking item; final pass over `32ebd019..55ebe8dc` (`plugin/scripts/project-memory-enrollment.mjs`, `plugin/scripts/agentdb-recall.mjs`) returned APPROVE with two non-blocking notes. Focused unit/integration files re-run by the author after the fixes passed: agentdb-recall, agentdb-recall-native, project-memory-enrollment (unit and native), project-store-resolver, ruflo-env-scrub, turn-outcome-capture, project-progression-session-start (one npm-12 pack test fails on the clean base too), automatic-progression-continuation, project-progression-restore-semantics. Real Ruflo 3.56.3 end-to-end through the registered Claude and Codex hook commands (Stop capture, native enrollment, fresh-process prompt recall, single store) passed at machine load about 14 and timed out under load of 24 or more. The Astra (`gpt-6-astra`) review was NOT obtained: the managed dispatcher refused launch (native subscription allowance host exited before proof). No whole-governed-set reread, native scheduled-run, provider-freshness or protected public-installation claim is made. |
| 2026-10-11 | Reviewed `abe7f78abbf5` against governed source `e82a83a0` (base `e26e15cf`, release 4.6.4) and this final mapping. | Independent read-only Fable reviews of the hooks slice (author: Opus 5.5): `f65280ce` REVISE (supersession computed only over retrieved rows, unvalidated `--supersedes`, a vacuous test); `581b3818` REVISE (a detected record could write a tombstone); `e00b6d9d` APPROVE with three text-only conditions (`plugin/scripts/continuation-gate.mjs`, `plugin/scripts/hook-shim.mjs`, `plugin/scripts/project-transition-hook.mjs`, `plugin/scripts/decision-record.mjs`); `b6bf04a0` CONFIRMED as text-only with 16 of 16 Codex trust identities unchanged; after CI preflight failed one Windows acceptance test (EBUSY on cleanup, a recovery worker holding the project directory), `e82a83a0` (`plugin/scripts/learn-capture.mjs`: recovery spawns only when learning bytes are queued) APPROVED. Known LOW: retained acknowledged originals still match the queue name, so such a project keeps spawning a worker at each boundary. Governed bytes that changed after the main review: version fields in `package-lock.json` for 4.6.4, and the reviewed `learn-capture.mjs` gate. Not covered: no native `claude -p` or `codex exec` session ran the hooks (this machine's wrapper refuses `-p` with `--plugin-dir`); no ADR-075 dual-seat review with a second vendor (both seats are Anthropic models); the full unit suite on the branch carries 16 failures that are not from this change (npm 12 `pack --json` shape, rehearse-corpus, forge-refresh, reader-deadlock). File hashes do not certify semantic reading. |



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


| 2026-10-07 | Reviewed `ef6b7ed562b6` against source `5f2d3cde64d007c9e92743b3f223e0730e348d6d` and the recorded final working bytes. | Bounded baseline-plus-delta semantic coverage from the 25-artifact review chain and corrected transition addendum; explicit 181-path byte inventory is not 181 fresh file reads. `plugin/scripts/project-transition-hook.mjs`, shared outcome normalization, native identity, typed advisory budgets and practical-rule phase decoration were reviewed with their direct consumers. 335 shared outcome/grounding checks passed. Native event delivery, one Windows case, all-rule hard enforcement and protected publication remain separate or incomplete. Source as of commit 845d55bd (4.6.4); the modules named in this row were removed on 2026-10-12 (see the section below). |

| 2026-10-07 | Reviewed `09d465c11e67` against source `0e8e1290` and the recorded final working bytes. | Prior bounded baseline-plus-delta review remains scoped. Independent test-correction review confirms `tests/unit/hook-shim.test.mjs` copies the actual hook manifest and `tests/unit/continuation-gate-capability-truth.test.mjs` preserves unknown installation and activation claims; 23 focused checks passed. Native memory capture and protected publication remain incomplete. |

| 2026-10-07 | Reviewed `de355dd5acbb` against source `b92aa838` and the recorded current bytes. | Independent bounded reviews cover the existing native administrative resolver export in `bin/install.mjs`, its discovery and installer fixtures, conservative foreign-owner recall assertions and the actual SessionStart budget-helper import. Root focused checks passed 5 native discovery, 66 ownership/startup and 7 managed-boundary tests with zero skips. Earlier failed integration receipt remains failed; fresh clean qualification, native session evidence and protected publication are required. |

| 2026-10-07 | Reviewed `e34f347644a6` against source `92147327` and the recorded current bytes. | Independent bounded review covers the PreCompact-only no-op exemption in `plugin/scripts/project-progression-producer.mjs` and actual lifecycle regression through the existing canonical append/readback path. 43 integrated checks passed without skips. The prior native run remains blocked: it delivered PreCompact but intentionally suppressed an unchanged snapshot. Fresh packed native execution and publication are still required; no historical receipt is relabeled. Source as of commit 845d55bd (4.6.4); the modules named in this row were removed on 2026-10-12 (see the section below). |

| 2026-10-07 | Reviewed `c694f81d5ae3` against source `6808039e` and recorded current bytes. | Bounded independent review and 17 integrated checks cover the three grounding dispatches joining the existing matching-root, undefined-only Claude fallback in `plugin/scripts/hook-shim.mjs`. Explicit Codex and unknown-host safeguards remain. Prior same-source native Claude tool/restore/capture succeeded but grounding was blocked; this new dispatcher requires fresh packed native proof. The reviewed subprocess cases are qualified on macOS/Linux only by the existing platform contract, not asserted on Windows. |

| 2026-10-07 | Reviewed `7ba26e9903fa` against source `439d94d1` and recorded current bytes. | Independent review covers the test-local fixed Node syntax checker in `tests/unit/model-managed-workflow-service.test.mjs`: original hosted source-only refusal was reproduced, all fresh-recall and receipt assertions retained, and the full 27-case integrated file passed. No production runtime code changed. Prior native proof stays bound to its original source and artifact; exact new qualification and hosted gates remain required. Failed preflight 37606672323 remains failed and main was not promoted. |
| 2026-10-12 | Reviewed `a1808e649ce1` against source `8ac35320` and the recorded final working bytes. | Three fresh-context single-seat Anthropic reviews (claude-opus-5-5; the OpenAI/Codex seat was unavailable because the managed codex wrapper refused `exec`, so this is DEGRADED under ADR-0075 section 5 and is not a dual-seat review) covered the persistence removal against shipped commit `845d55bd`: `plugin/scripts/ruflo-memory-hooks.mjs`, `plugin/scripts/turn-outcome-capture.mjs`, `plugin/scripts/learn-capture.mjs`, `plugin/scripts/session-snapshot-hook.mjs`, `plugin/scripts/agentdb-recall.mjs` and `plugin/scripts/substitution-wall.mjs`. Each returned ACCEPT-WITH-CONDITIONS with no blocker; conditions 1-7, then 1-5, then 1-2 were fixed with tests (2,079 tests passed on the committed tree). The two third-round fixes (linear Add-File judging and CRLF-tolerant hunk matching, in `plugin/scripts/substitution-wall.mjs`) were not independently re-reviewed. Not verified: Windows, a live Codex session, concurrency under load, and the installed plugin against a live-size store. This is a finite source inventory, not a claim that every governed file was semantically reread. |
| 2026-10-12 | Reviewed `3f8e7f179c75` against source `061a70c1` and the recorded final working bytes. | Mechanical follow-up to the review row above, found by the hosted preflight on the first push of 4.7.0: `scripts/release-qualification-contract.mjs` still named three deleted tests (`tests/unit/learn-flush-partial-failure.test.mjs`, `tests/unit/health-repair-flush-learning.test.mjs`, `tests/integration/learning-console-scope.test.mjs`), so release-acceptance failed on all three platforms with ENOENT. The entries were removed and the retired learning-recovery entry now says so; no behaviour changed. This edit was not independently re-reviewed; the platform-wide qualification command passed locally (2,079 of 2,079) after it. |
| 2026-10-13 | Reviewed `68f3db5eace3` against source `1c5950f8` and the recorded final working bytes. | Mechanical follow-up found by hosted run 38267827528: release qualification refuses todo and skipped cases, and the integration suite carried nine `it.todo` entries in `tests/unit/agentdb-recall.test.mjs` (the register of recall capabilities lost vs 4.6.4). The nine were deleted from that governed test file with no assertion changed; all thirteen lost capabilities are now a named list in the ADR-106 4.7.0 amendment, and the persistence-removal section here points to it. The ungated `tests/unit/learn-capture-*.test.mjs` POSIX shell stub became a Node stub with an npm `ruflo.cmd` layout on Windows; no production code changed. DEGRADED under ADR-0075 section 5: author edit only, not independently re-reviewed, single seat. Verified locally on macOS only; hosted Linux and Windows results were not available when this row was written. |
| 2026-10-13 | Reviewed `09a1b97166d8` against source `2c48bb27` (release/4.7.1 integration of fix/4.7.1-a, -c, -d, -e on 4.7.0 `bd70b05f`) and the recorded final working bytes. | Governed changes: `plugin/scripts/continuation-gate.mjs` now returns before gating when `plugin/scripts/automated-run.mjs` finds an SDK entrypoint or a `codex exec` ancestor (the owner's own gate `owner-review-gate.mjs` was read, not edited); `plugin/scripts/agentdb-recall.mjs` and `plugin/scripts/ruflo-memory-hooks.mjs` select the newest `project-state-current-<epoch-ms>` by its key and run every ruflo call from a private scratch directory with daemon autostart off (measured median 1,729 ms to 1,067 ms for one list); `bin/install.mjs` accepts a Codex hook bridge byte-identical to a wrapper a retained Brain generation shipped, fixing the 4.6.4 to 4.7.0 refusal `hook-wrapper-ownership-conflict` measured on the owner's machine. Non-governed additions: the Grok host adapter and manifest, the weekly-cycle version-pin fix and the advice-only prompt text. The integrating session read every governed diff in full; 141 of 141 focused tests passed on the merged tree and `single-source:check`, `wired:check`, `hooks:check` and `substitution:check` pass. DEGRADED under ADR-0075 section 5: author-side review by the integrating session only, no independent seat, no OpenAI seat. Real-machine upgrade proof, hosted Linux and Windows results and a fresh Grok session are not yet available and are stated as UNVERIFIED in the release notes. |
| 2026-10-13 | Reviewed `6b96467e7126` against source `8723fc1f` and the recorded final working bytes. | Mechanical follow-up found by hosted preflight run 38467250540 on `ee723e28`: Linux integration failed 3 cases because the new fallback in `scripts/model-routing-execution-adapters.mjs` returned `~/.local/bin/codex` without checking it exists (it now returns the standard path only if present, else a PATH match, else throws ENOENT as 4.7.0 did); Windows source failed because two POSIX-only cases skipped and the gate allows none (the weekly-cycle stub case and the symlink cases moved to files listed only for linux and macos in `scripts/release-qualification-contract.mjs`; the other-uid case now runs everywhere). No gate was loosened. Reproduced locally before pushing: full macOS source qualification 2,093 of 2,093 with 0 skipped, a zero skip-capable scan of the 106 Windows source files, the Linux no-codex condition, and the three stranger scenarios from the packed tarball. DEGRADED under ADR-0075 section 5: author edit only, single seat, not independently re-reviewed. Hosted early-public, macos-candidate-search and Windows results are not yet available. |
| 2026-10-13 | Reviewed `073780ab6199` against source `d45c3ede` (fix on top of 4.7.1 `fbe233ba`) and the recorded final working bytes. | Found by the post-install proof of 4.7.1: a real `grok -p` turn still returned the continuation gate's UNVERIFIED correction because the exemption read by `plugin/scripts/continuation-gate.mjs` (`plugin/scripts/automated-run.mjs`) covered only Claude `sdk-*` and `codex exec`. Measured with a temporary user-level probe hook under `grok -p` (removed afterwards): the hook's parent process is `grok -p ...` and its environment carries `GROK_HOOK_EVENT` and `GROK_SESSION_ID`. The exemption now also applies when Grok set that environment (or the Grok adapter marked the host) and an ancestor is a headless `grok` (`-p`, `--single`, `--prompt-file`, `--prompt-json`, `agent`); interactive `grok` stays gated. No other governed behaviour changed. Tests: a real-process `grok -p` / interactive `grok` case and the ancestor-table cases, order-independent (unique session id per case), verified to fail with the exemption removed. DEGRADED under ADR-0075 section 5: author edit only, single seat, not independently re-reviewed. Hosted results and a live `grok -p` after install are not yet available. |
| 2026-10-14 | Reviewed `b86f4fce23a7` against source `05f7af95` (fix on top of 4.7.2 `d2982ac2`) and the recorded final working bytes. | 4.7.3 changes no routing behavior. The one governed byte that moved is `package-lock.json`: its two version fields went 4.7.2 to 4.7.3 through `npm run version:set`; a JSON comparison of `origin/main` against this branch shows the file identical apart from those two fields, and no other governed file changed (`plugin/scripts/continuation-gate.mjs` and the rest of the governed set are byte-identical to 4.7.2). The code change is `scripts/model-currency-evidence.mjs`, which is not governed: one incomplete third-party coding-agent row (Meta Muse Wonder Full (max), `mean.costUsd` null) made the weekly refresh throw for all 39 rows. An incomplete row from a harness other than Codex/OpenAI or Claude Code/Anthropic is now skipped and listed in `coverage.skippedIncomplete`; routable rows still throw. DEGRADED: a single-session review by the integrating agent, not an independent review. |
| 2026-10-14 | Reviewed `743d1ca45768` against source `c0ac45dc` (fix on top of 4.7.3 `5e6a28c0`) and the recorded final working bytes. | Found by running the weekly job on 4.7.3: with the metadata stage fixed, the semantic stage failed with "Private native hook metadata transport failed" because launchd gives the job `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, on which `codex` does not exist (it is `~/.local/bin/codex`), and `scripts/model-analyst-sandbox.mjs` spawns bare `codex`. Measured: the trust step fails under that PATH and returns `trusted:true, inferenceStarted:false` with `~/.local/bin` added. `scripts/goldie-weekly.sh` now prepends `$HOME/.local/bin:$HOME/.npm-global/bin`. Governed bytes that moved: `scripts/release-qualification-contract.mjs` gained one test file in the existing weekly group's linux and macos platform lists (the new test needs `/bin/bash`), and `package-lock.json` changed only its two version fields. No routing rule, policy or selection logic changed. DEGRADED: a single-session review by the integrating agent, not an independent review. |
| 2026-10-14 | Reviewed `76e2a4e8f66b` against source `de60ac6c` (fix on top of 4.7.4 `4dc7a034`) and the recorded final working bytes. | 4.7.5 changes no routing behavior. Two governed bytes moved. `package-lock.json`: its two version fields went 4.7.4 to 4.7.5 (2 lines, from `npm run version:set`). `scripts/release-qualification-contract.mjs`: one new inventory entry, `ruflo-runs-under-a-node-that-loads-its-binding`, listing `tests/unit/ruflo-native-node.test.mjs` under linux and macos (9 lines added, nothing removed or reordered). Found by diagnosing 67 `turn-capture` hook failures: hooks inherited a PATH whose first node (v26) could not load ruflo's node-24 better-sqlite3, so `ruflo memory store` was refused. The fix is in the non-governed `plugin/scripts/ruflo-bin.mjs`: `rufloInvocation` now runs ruflo under the first node that loads its own binding and changes nothing when the PATH node already does. |
| 2026-10-14 | Reviewed `934ff5ef048c` against source `cf6d1439` (fix on top of 4.7.5 `9a4c4003`) and the recorded final working bytes. | 4.7.6 changes no routing behavior. Three governed bytes moved. `package-lock.json`: its two version fields went 4.7.5 to 4.7.6 (from `npm run version:set`). `scripts/release-qualification-contract.mjs`: the `reason` text of the existing entry `ruflo-runs-under-a-node-that-loads-its-binding` now names every direct ruflo launch (1 line changed, no file added or removed). `plugin/scripts/ruflo-memory-hooks.mjs`: `rufloMemory` and `storeExact` now build their command with `rufloInvocationOrPlain` before `execFile`/`run` (3 call expressions; arguments, cwd, env, timeout, maxBuffer and result handling are unchanged). Found by running the installed 4.7.5 SessionEnd hook under a PATH with node 26 first: the checkpoint store exited 1 because these launches bypassed the 4.7.5 node selection. With the three launch sites routed (`ruflo-memory-hooks.mjs` twice, `agentdb-recall-reader.mjs` once) the same hook wrote its `project-state-auto` row and logged no failure; 3 of 4 new tests go red on the 4.7.5 call sites. |
| 2026-10-15 | Reviewed `ea863c8b1d0c` against source `33e69694` (fix on top of 4.7.6 `1d4ec0b5`) and the recorded final working bytes. | 4.7.7 changes no routing behavior. Three governed bytes moved. `package-lock.json`: its two version fields went 4.7.6 to 4.7.7 (from `npm run version:set`). `plugin/scripts/continuation-gate.mjs`: an assistant promise that can never close (its completion verdict cannot be PASS) was forced at every Stop; it is now forced at most three times, counted beside the ledger, then retained as deferred and never marked completed, and the gate is quiet by default (only an explicit objective or a contradicted capability claim speaks) unless `RUVNET_STOP_NUDGES=full`. `plugin/scripts/grounding-turn-gate.mjs`: exits silently unless `RUVNET_STOP_NUDGES=full`. No model route, spend, authority or allocation changed. |
| 2026-10-15 | Reviewed `f480102b6005` against source `75dd2308` (fix on top of 4.7.7 `ba0f9ec3`) and the recorded final working bytes. | 4.7.8 changes no routing behavior. Four governed bytes moved. `package-lock.json`: its two version fields went 4.7.7 to 4.7.8 (from `npm run version:set`). `plugin/scripts/hook-shim.mjs`: three advisory-only hook ids exit silently unless `RUVNET_STOP_NUDGES=full`. `plugin/scripts/agentdb-recall.mjs`: a timed-out or unavailable recall prints nothing by default. `plugin/scripts/decision-gate.mjs`: its budget-exhausted and policy-skipped stderr lines print only on a refusal or under `full`; the outcome ledger is unchanged. No model route, spend, authority or allocation changed. |
| 2026-10-15 | Reviewed `3766bcde7ff9` against source `f30756df` (fix on top of 4.7.8 `9074cea2`) and the recorded final working bytes. | 4.7.9 changes no routing behavior. Two governed bytes moved. `package-lock.json`: its two version fields went 4.7.8 to 4.7.9 (from `npm run version:set`). `plugin/scripts/continuation-gate.mjs`: the observed-work advisory line is printed only under `RUVNET_STOP_NUDGES=full`. The ungoverned `plugin/scripts/developer-update-lock.mjs` now reclaims a developer-update lock whose owner has been dead for 10+ minutes. No model route, spend, authority or allocation changed. |

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

## Persistence removal — 2026-10-12

The owner ruled that the plugin only CALLS rUv's memory tools and never rebuilds his storage. The
progression store/outbox/producer/reader/sources/hook/session-start/checkpoint, the capture queue, the
transition hook, the continuity journal and brief, the learning queue/flush/worker and the turn transport
journal were deleted, together with the tests that exercised only them. The governed set above no longer
names them; `ruflo-memory-hooks.mjs` (checkpoint and restore through `ruflo memory`) and
`substitution-wall.mjs` (the write-time refusal of a rebuilt transport) now join it. Capabilities that
were reduced rather than moved are recorded as a named register in the ADR-106 4.7.0 amendment (they were
todos in `tests/unit/agentdb-recall*.test.mjs`; the gated ones were removed because qualification refuses todo cases). This
section is a change record, not a review: the source-bound review of the final governed bytes below is the
only statement that they were examined, and it states its own limits.
