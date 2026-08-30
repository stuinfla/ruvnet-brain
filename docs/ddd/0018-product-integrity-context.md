Updated: 2026-08-22 16:30:00 EDT | Version 0.3.0
Created: 2026-08-21 13:34:00 EDT

# DDD-0018 — Whole-product integrity context

Status: Accepted; implementation remains proof-gated

Governs: ADR-072 and the conformance boundary across DDD-0003, DDD-0010, DDD-0015,
DDD-0016, and DDD-0017.

## Purpose and boundary

Whole-product integrity does not add a second orchestrator or release service. It is the policy
context that makes the existing contexts agree on identity, ownership, state, and evidence. It owns
the acceptance contract and traceability model. Corpus ingestion owns bytes; refresh owns local
activation; release transaction owns provider mutation; public verification owns the final success
verdict.

## Aggregate root: ProductIntegrityCase

```text
ProductIntegrityCase
  sourceSnapshot
  architectureRevision
  corpusGeneration
  releaseCandidate
  acceptanceObligations[]
  evidenceReceipts[]
  independentReviews[]
  disposition: BLOCKED | CANDIDATE_PROVEN | PUBLISHED_NOT_VERIFIED | INSTALL_VERIFIED
```

Invariants:

1. Every obligation has exactly one owning context, one source identity, and one evidence contract.
2. No evidence can satisfy an obligation bound to a different source, corpus, payload, host
   registry, policy, or transaction identity.
3. Documentation, UI, and tests are projections; none may create product facts.
4. A lower context cannot promote the aggregate. Only `PublicVerificationCompleted` may enter
   `INSTALL_VERIFIED`.
5. `UNKNOWN`, skipped, todo, zero-test, synthetic-only, stale, or contradictory evidence is red.
6. Historical receipt schemas remain readable but never acquire new semantics retroactively.

## Entities and value objects

| Name | Role |
|---|---|
| `AcceptanceObligation` | Stable ID, statement, owner, deadline/event boundary, required evidence, failure semantics. |
| `ArchitectureClaim` | ADR/DDD status and exact governed code/API claim. |
| `ConformanceLink` | Claim -> owner -> code -> tests -> receipt, all bound to source identity. |
| `EssentialBehavior` | User-visible or safety-critical behavior requiring positive and adversarial proof. |
| `GeneratedFact` | Value emitted by one producer and consumed without restatement. |
| `EvidenceReceipt` | Immutable result with command/environment/source/artifact identities and explicit untested scope. |
| `ReviewReceipt` | Independent model identity, rubric digest, deductions, score, and inspected source/payload. |

## Context map

```text
SourceCoverage -> CorpusGeneration -> ReleaseProjection -> RefreshLifecycle
                                                      -> HostConvergence
ReleaseProjection -> ReleaseTransaction -> PublicVerification -> ProductIntegrityCase
```

All arrows are upstream fact/evidence flow. Reverse imports or authority flow are boundary
violations. Workflow YAML is an adapter, not a domain owner.

## Commands

- `InventoryArchitecture(sourceSnapshot)`
- `ClassifyTest(testId, obligationId, class)`
- `RecordConformanceEvidence(obligationId, receipt)`
- `RejectContradiction(architectureClaim, observedCode)`
- `SealCandidateIntegrityCase(sourceSnapshot, evidenceSet)`
- `RecordChannelConvergence(transactionId, receipt)`
- `FinalizePublicVerification(transactionId, publicAggregate)`

## Domain events

`ArchitectureInventoried` · `ContradictionDetected` · `ContradictionResolved` ·
`EssentialBehaviorMapped` · `ObligationProven` · `CandidateIntegritySealed` ·
`ChannelsConverged` · `PublicVerificationFailed` · `InstallVerified`.

Each event carries the exact source snapshot and relevant content digests. Events are append-only.

## Policies

### Architecture currency

Accepted ADRs are enforceable decisions; implementation is measured independently from source and
runtime evidence. Proposed ADRs cannot be cited as shipped behavior.
When code changes an accepted claim, that ADR and its DDD are updated in the same source snapshot.
Conflicting active decisions are resolved by explicit supersession or correction, never by choosing
the convenient document at runtime.

### Essential-test completeness

Coverage is complete only when every essential behavior and every total-state-machine transition has
both success and failure evidence. Line coverage is diagnostic. A test that asserts a generated fact,
superseded state, duplicate implementation, or non-user path cannot close an obligation.

### Evidence strength

Unit < integration < packed artifact < candidate OS/host < actual public-byte proof. Stronger proof
may satisfy a weaker obligation only when identities match. A weaker proof never satisfies a stronger
one.

### Independent review

Fable 5 and GPT-5.6-Sol inspect the same immutable inputs independently. Their scores are advisory
until mechanical evidence passes; neither model can authorize publication or substitute for a real
host, scheduler, registry, filesystem, or retrieval observation.

## Failure semantics

- ADR/code contradiction: `BLOCKED`, with the exact claim and implementation owner named.
- Unmapped release-critical code or test: `BLOCKED` until classified.
- Missing/weak/mismatched evidence: obligation remains open; no score inflation.
- Channel publication without public proof: `PUBLISHED_NOT_VERIFIED`.
- Any public matrix/canary failure: keep the verification issue open and retain the same transaction.
- Storage/ownership ambiguity: no cleanup or takeover; require explicit recovery evidence.

## Acceptance

Acceptance is the S-1 through S-12 contract in ADR-072. The machine-readable traceability projection
must contain every obligation, no duplicate owners, no missing proof links, and no unresolved active
architecture contradiction. Only then may the protected release rail consume it.

`scripts/product-integrity-contract.mjs` is the executable ownership and evidence-contract
projection. A context that contributes evidence is not a second owner: S-1 is owned by
`CorpusGeneration` with `SourceCoverage` contributing the sealed observation, and S-7 is owned by
`PublicVerification` with `ReleaseTransaction` contributing channel state.

S-11 is owned by `ProductIntegrityCase`, with `HostConvergence` contributing real-host wiring and
`RefreshLifecycle` contributing crash/replay evidence. ADR-073 and DDD-0019 define its supporting
project-continuity context without adding a ninth product process.

S-12 is also owned by `ProductIntegrityCase`, with `HostConvergence` contributing the sealed live
host inventory and `PublicVerification` contributing exact source/version evidence. ADR-074 and
DDD-0020 define its supporting capability-claim context without adding a ninth product process.
The completion boundary accepts S-12 only as a valid signed aggregate over all three operating
systems, both supported hosts, and every typed claim class with no `UNKNOWN` or untested scope.
