---
id: ADR-072
title: Whole-product integrity is one executable contract
status: Accepted
date: 2026-08-21
updated: 2026-08-22
authors: [Stuart Kerr, Codex]
tags: [architecture, quality, corpus, lifecycle, release, traceability, smart, sparc]
supersedes: []
relates: [ADR-001, ADR-062, ADR-064, ADR-069, ADR-070, ADR-071, ADR-073, ADR-074]
governs:
  - docs/ddd/0018-product-integrity-context.md
  - docs/ddd/0019-project-continuity-context.md
  - docs/ddd/0020-capability-claim-integrity-context.md
  - docs/reviews/adr-072-traceability.md
  - scripts/build-bundle.mjs
  - scripts/corpus-candidate.mjs
  - scripts/release-transaction.mjs
  - scripts/release-transaction-provider.mjs
  - scripts/release.mjs
  - kb/refresh-run.mjs
  - kb/update-storage-transaction.mjs
  - kb/forge-update.mjs
  - kb/brain-profile.mjs
  - bin/install.mjs
  - bin/nightly-refresh.mjs
  - plugin/scripts/nightly-scheduler.mjs
  - plugin/host-adapters/claude.json
  - plugin/host-adapters/codex.json
  - scripts/host-registry.mjs
  - scripts/host-install-matrix.mjs
  - scripts/product-integrity-contract.mjs
  - scripts/adr-072-completion.mjs
  - scripts/retrieval-canary.mjs
  - scripts/source-scope-receipt.mjs
  - scripts/public-verification-aggregate.mjs
  - scripts/public-verification-finalizer.mjs
  - .github/workflows/ci.yml
  - .github/workflows/corpus-seed.yml
  - .github/workflows/release-aggregate.yml
  - .github/workflows/protected-release.yml
---

# ADR-072 — Whole-product integrity is one executable contract

**Status**: Accepted

Accepted by Stuart's 2026-08-21 direction; implementation is in progress and publication remains
locked. Nothing in this document is a shipped-capability claim.

## Reconciliation map

This ADR refines ADR-070 and partially supersedes clauses in earlier Accepted decisions; it does not
supersede those documents wholesale.

| Earlier decision | Clauses superseded by ADR-070/072 | Clauses that remain Accepted |
|---|---|---|
| ADR-001 | The 2026-06-27 illustrative archive filenames as a current schema | One verified self-contained archive; no bare RVF or user-assembled sidecars |
| ADR-062 / DDD-0015 | For schema 3+, `channels-converged` as product-terminal success, healthy doctor state, or substitute for public-byte proof | Build-once payload, durable remote anchor, write-ahead intents, provider observation, compensation, same-B recovery, sole publisher |
| ADR-064 | Per-store activation, mixed-generation live KB, stale generation label, and legacy wrapper as current lifecycle authority | Machinery-QA presence/readability rule, wide-k diagnosis, and preserved failure reason |
| ADR-070 / DDD-0017 | None | Release-convergence domain model; ADR-072 supplies the executable whole-product acceptance boundary |

Where wording conflicts, the narrow supersession above controls. Historical incident narratives,
receipts, and currency logs remain evidence and are not rewritten.

## Context

The 4.2.2 repair accumulated component fixes and locally green tests without one product-level
contract connecting corpus completeness, installed bytes, nightly lifecycle, host wiring, public
publication, retrieval effectiveness, and cleanup. That allowed individually plausible paths to
contradict one another: public and runtime ledgers were written from the same mutated bytes,
`channels-converged` was treated as shipped before post-publication proof, a host-only repair test
claimed a full refresh, and recoverable cleanup could become permanent manual recovery.

More gates are not the remedy. This decision establishes that facts need one producer and
behaviours need tests. It supplies the missing whole-product boundary and makes every
essential behaviour traceable to one owner and one acceptance proof.

## Decision

### 1. One product, seven delivery contexts plus one integrity-policy context, one-way dependencies

The product is these contexts in this order:

1. `SourceCoverage` observes and classifies the complete upstream universe.
2. `CorpusGeneration` creates the privacy-fenced immutable RVF generation.
3. `ReleaseProjection` derives product-bound coverage and runtime projections without changing
   immutable corpus/public truth.
4. `RefreshLifecycle` applies one generation under one owner-token transaction and bounded storage.
5. `HostConvergence` installs and exercises the declared real loader paths.
6. `ReleaseTransaction` publishes immutable bytes through resumable provider states.
7. `PublicVerification` downloads public bytes, runs the OS/host/retrieval matrix, and alone may
   declare `install-verified`.
8. `ProductIntegrityCase` validates the complete obligation graph and exact-source evidence without
   becoming a second producer of runtime facts.

Dependencies flow downward only. No host, updater, workflow, test fixture, manifest, or document may
redefine source inventory, release identity, terminal state, or supported-host membership.

### 2. One authority for every fact

| Fact | Sole producer | Consumers may do |
|---|---|---|
| Eligible sources | live `SourceObservation` + policy classifier | project/render/verify the sealed identity |
| Public corpus members | immutable corpus generation ledger | verify exact bytes; never reconstruct it |
| Product public members | `PUBLIC-RVF-GENERATIONS.json` | copy exact bytes; never change kind/version/order |
| Installed members | derived `RVF-GENERATIONS.json` + optional profile/private receipts | validate declared subset/superset rules |
| Supported hosts | sealed host registry generated from adapter descriptors | execute named loaders only |
| Release identity | sealed candidate payload | observe equality; never repack during publication |
| Refresh result | one `RefreshRun` state machine | render the terminal receipt |
| Release result | one signed release transaction chain | report its receipt disposition |
| Product facts in docs/UI | generators/read models over sealed receipts | no hand-maintained counts or versions |

Transaction-scoped candidates, one rollback, retained recovery evidence, and minimal compatibility
shells are not alternate authorities. They are typed, bounded states with receipts and retention.

### 3. One terminal definition

`channels-converged` means npm and GitHub expose the exact candidate. It is nonterminal and must be
rendered `PUBLISHED, NOT VERIFIED`. `install-verified` is the only successful terminal release state
for receipt schema 3+. Historical schema 1/2 `channels-converged` receipts remain readable as
`legacy-closed/unverified`; they are neither rewritten nor silently promoted.

Refresh success likewise requires an atomic terminal receipt after all nine required phases. The
state sequence is `RUNNING -> SETTLING -> SUCCEEDED|FAILED|ABANDONED`. A dead exact owner is
atomically abandoned; an unknown or remote owner is never guessed dead.

Storage activation uses `CLEANUP_PENDING` for a verified live generation whose redundant rollback
could not yet be deleted. `RECOVERY_REQUIRED` is reserved for identity ambiguity or damaged state.

### 4. SMART acceptance contract

The release objective is specific, measurable, achievable within the existing Node/RVF/AgentDB and
GitHub Actions architecture, relevant to the observed failures, and time-bound to the next public
version: no protected publication job may begin until every row below is PASS on one exact source
snapshot, and public success must finish within that same transaction.

| ID | Specific outcome | Measure and deadline |
|---|---|---|
| S-1 | One complete public corpus | 100% of the live eligible repository rows are `CURRENT`; all eligible gists have complete receipts; the typed public partition is exhaustive with zero extra/private/unclassified stores before candidate sealing. |
| S-2 | Immutable truth remains immutable | Corpus/public ledgers and coverage embedded in archives equal canonical bytes exactly; runtime ledgers are separately derived. Every byte mutation fails before publication. |
| S-3 | Retrieval meets the product promise | Coverage-derived canaries exercise every store added since the failed 62-repository seed plus a deterministic stratified legacy sample. Delta-store citation pass rate is 100%; aggregate Recall@10 is at least 98%; no skipped/unknown result. |
| S-4 | Nightly is deterministic and bounded | Two consecutive runs through the real native scheduler complete the exact nine-phase order. Run two is `noop`, creates zero additional full-corpus copies, and total managed evidence remains within the declared retention budget. Latest verified nightly age must remain <=30 hours. |
| S-5 | Updates preserve one active generation | Concurrent writers serialize; interruption at every rename/receipt boundary recovers; retired public stores disappear; every declared private/local store survives; success leaves one active corpus, zero retained redundant rollback copies, and a valid `storageDelta`. |
| S-6 | Hosts converge from real artifacts | Linux, macOS, and Windows each pass Claude-only, Codex-only, and dual modes through the sealed loader registry: exactly nine green leaves, zero missing/extra/skip/todo leaves. |
| S-7 | Publication cannot overclaim | Channel publication emits only `PUBLISHED, NOT VERIFIED`. A later protected finalizer reaches `install-verified` only after downloading actual npm/GitHub bytes and validating the signed nine-leaf aggregate and retrieval canaries. |
| S-8 | Architecture and proof agree | Every Accepted/Implemented ADR and DDD claim governing changed code maps to its implementation owner and executable evidence. Zero unresolved contradictions, dangling supersessions, or unlinked release-critical code at the candidate seal. |
| S-9 | Essential behavior is completely tested | 100% of essential invariants, state transitions, failure boundaries, and public commands in the traceability matrix have at least one positive and one adversarial proof. Security/release/lifecycle state-machine branches are 100% covered. Repository line coverage remains a diagnostic, never a substitute for this requirement. |
| S-10 | Independent review is real | Fable 5 and GPT-5.6-Sol independently review the same immutable source/payload/rubric. Each receipt lists deductions and untested scope and scores >=95; combined mechanical product evidence must score >=98 before publication. |
| S-11 | Project continuity is complete and host-neutral | Every observable project transition is append-only, exact-key verified in the canonical project AgentDB, and automatically restored by every supported coding host. Crash, compaction, semantic-search miss, concurrent writers, and loss of a host-private transcript lose zero resumable project state. |
| S-12 | RuvNet capability claims are evidence-bound | Every final-answer claim about an installed, supported, current, healthy, reachable, present, or absent RuvNet capability carries evidence typed to that claim. Contradictions are corrected before delivery; incomplete evidence yields `UNKNOWN`. Claude Code and Codex pass the same adversarial host matrix, and Grok remains unsupported until a native lifecycle adapter proves the same boundary. |

### 5. SPARC execution and phase exits

- **Specification:** freeze this ADR, DDD-0018, and the traceability matrix. Exit only when every
  requirement has an owner, proof, and failure meaning.
- **Pseudocode:** define total state reducers and crash boundaries before changing providers or
  filesystem state. Exit only when all states and transitions are enumerated.
- **Architecture:** verify ADR/DDD currency and dependency direction. Exit only with zero active
  contradiction in governed surfaces.
- **Refinement:** implement context by context with one writer; after each context, run its focused
  acceptance, mutation, and integration proofs.
- **Completion:** execute full QE, coverage, security, performance/storage, exact-SHA candidate,
  independent graders, public 3x3 installs, canaries, and two-run nightly proof. Only the protected
  finalizer may publish the success receipt.

### 6. Tests are derived from the contract

Tests are classified as `essential`, `supporting`, or `obsolete` in the traceability matrix.

- Essential tests prove a named invariant or transition and fail when that behavior is mutated.
- Supporting tests improve diagnosis but cannot satisfy a release obligation.
- Obsolete tests restate generated facts, assert a superseded state model, duplicate another owner,
  or test an impossible/unsupported path. They are deleted only after the matrix identifies the
  replacement producer or essential proof.

Passing test count, coverage percentage, job conclusion, and a synthetic fixture are never by
themselves proof of the intended user path.

### 7. Publication remains fail-closed during migration

The existing protected workflow must not temporarily green an incomplete architecture. Until the
channel/public-finalizer split, issue lifecycle, 3x3 public matrix, retrieval canaries, storage
evidence, and dual review receipts are wired, publication ends before provider mutation.

## Consequences

- Current patch volume may decrease because contradictory and fact-restating paths are removed.
- Historical receipts and release assets remain immutable; compatibility is explicit by schema.
- A red matrix is actionable because every red result names a domain invariant, not merely a file.
- No one may claim flawless, guaranteed, complete, shipped, or 98% recall until the corresponding
  exact-source receipt exists and the stated untested scope is empty.

## Current implementation status

`Accepted, partially implemented.` The executable S-1 through S-12 ownership and evidence contract
now lives in `scripts/product-integrity-contract.mjs`; individual obligations remain proof-gated.
The baseline measured 2026-08-21 is MetaHarness 75/100, task coverage
65, and publish readiness 0.7. Security audit was clean, but S-1 through S-10 are not yet jointly
proven. S-11 is not yet implemented or proven. S-12 installation, full-SHA behavior,
installed-current-version, and health enforcement now run through locally packed Claude/Codex
paths; latest-version is locally receipt-bound, the non-local OS/public matrix is absent, and no signed
candidate aggregate exists. `scripts/adr-072-completion.mjs` rejects an unsigned, partial, stale, or
non-3x2 capability aggregate. ADR-070 and DDD-0017 provide the release-convergence model. The partial-supersession map above
is now the documentation authority; implementation must still change before the code may claim
conformance.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-22 | Wired the terminal S-6/S-7 workflow after the channel-converged boundary and carried every signed public-verification input through the protected handoff. | `89b2f2b` creates independently signed specialist receipts; `3489b6e` requires them before publication and executes three OS by three host-mode lanes, the signed nine-leaf aggregate, and immutable install finalization; `4a901d6` carries `COVERAGE.json` and `retrieval-canary-plan.json`; `ddae606` removes the obsolete in-publisher finalization expectation. Exact-tip focused gates and the executable trace pass, but real specialist reviews and public installed bytes remain absent, so S-7/S-10 acceptance is not declared complete. |
| 2026-08-22 | Re-read the whole-product contract after adding the single-owner refresh receipt and sharing the canonical transaction serializer. | Commit `a1a3057` adds `kb/refresh-run.mjs` with fenced ownership, PID-reuse rejection, ordered required phases, append-only receipts, and terminal settlement; `tests/unit/refresh-run.test.mjs` passes all eight focused cases. Commit `4f59bc6` removes the duplicate serializer from `scripts/release-transaction.mjs` without changing its state machine. These are bounded S-4/S-7 primitives only: the public matrix, clean corpus reconciler, and signed final aggregate remain unproven, so this ADR remains partially implemented. |
| 2026-08-22 | Added a read-only public-registry receipt producer for S-12 latest-version claims. | The prior local packed proof correctly left “latest” `UNKNOWN`; `ruvnet_registry_latest` now mints exact response-bound evidence, while network/malformed responses remain non-authoritative and no candidate/public PASS is claimed. |
| 2026-08-22 | Bound S-12 into the executable trace and completion boundary with typed source/live receipts and a signed aggregate. | `scripts/product-integrity-contract.mjs` now names every S-12 producer/test/receipt, while `scripts/adr-072-completion.mjs` cryptographically rejects incomplete OS/host or claim-class evidence. `plugin/scripts/capability-claim-evidence.mjs` leaves latest-version `UNKNOWN`; no candidate/public PASS is claimed. |
| 2026-08-22 | Added S-12 and ADR-074/DDD-0020 for evidence-bound RuvNet capability claims. | A host declared `ruflo-adr:adr-verify` absent even though its live skill inventory contained it; prompt-level verify-first guidance did not prevent the false final answer. |
| 2026-08-22 | Added S-11 and ADR-073/DDD-0019 for complete perennial project continuity. | The active eight-process repair existed in a Codex-private transcript but was absent from the exact project checkpoint stream restored by Claude Code. AgentDB storage worked; continuous capture and host-neutral restore did not. |
| 2026-08-22 | Added the executable S-1 through S-10 obligation registry and resolved combined owners into one owner plus explicit contributors. | DDD-0018 requires one owner per obligation; the prose traceability table previously assigned two owners to S-1 and S-7. |
| 2026-08-22 | Added the coverage-derived retrieval canary plan and receipt reducer. | S-3 now has an executable owner for complete delta selection, deterministic legacy sampling, exact repo/path Recall@10, and fail-closed evidence derivation; public-host execution remains open. |
| 2026-08-22 | Added the no-guess scope contract to the Brain playbook and a complete repository/governed-file scope receipt. | Whole-codebase claims now require a content-bound inventory and full governed-file reads; snippets, searches, tests, and agent reports cannot be promoted into review-complete evidence. |
| 2026-08-22 | Added the signed PublicVerification nine-leaf aggregate. | S-6/S-7 now have one cryptographic validator for exact lane membership, identity equality, public bytes, installed loaders, complete coverage, and derived Recall@10; workflow leaves and finalization remain open. |
| 2026-08-22 | Added the schema-3 public finalizer and immutable aggregate materialization. | Only a valid signed aggregate may append `install-verified`; channel drift, legacy state, evidence conflict, and failed readback remain red. Workflow wiring remains open. |
| 2026-08-21 | Added the explicit partial-supersession map for ADR-001, ADR-062/DDD-0015, and ADR-064. | Earlier decisions retain valid archive, provider-transaction, and machinery-QA intent, but their obsolete archive-member, release-terminal, and mixed-generation clauses contradicted ADR-070/072. Narrow reconciliation removes ambiguity without deleting history. |
