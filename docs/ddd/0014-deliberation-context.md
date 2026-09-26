Updated: 2026-09-18 19:00:00 EDT | Version 1.1.0
Created: 2026-07-28

# DDD-0014 — Deliberation Context

**Status**: Proposed (2026-07-28)
**Related**: ADR-061, ADR-053, ADR-055

## Purpose

The Deliberation Context turns two authenticated coding-agent subscriptions into one bounded,
auditable design process for hard problems. It owns coordination and convergence. It does not own
model selection, host installation, source retrieval, Agentic-QE execution or project memory.

## Ubiquitous language

| Term | Meaning |
|---|---|
| **Seat** | One verified subscription-backed host login: Claude Code or Codex |
| **Duel** | A run in which both seats complete proposal, critique and verification roles |
| **Degraded review** | A useful one-seat draft that must never be labeled a duel or accepted |
| **Evidence bundle** | The identical, bounded repository context approved for both seats |
| **Scribe** | The seat selected deterministically to reconcile proposals |
| **Verifier** | The other seat, which accepts, requests one revision, or blocks |
| **Synthesis** | The ADR, DDD and outcome-level QE plan produced from both arguments |
| **Adjudicated outcome** | Later evidence that the implemented result met or missed the North Star |

## Aggregate

`DeliberationRun` is the aggregate root.

```text
DeliberationRun
  runId
  taskHash
  evidenceHash
  repositoryHead
  consentMode
  seats: SeatState[]
  proposals: Proposal[]
  critiques: Critique[]
  synthesis: Synthesis?
  verification: Verification?
  status: accepted | unresolved | degraded | failed
```

The aggregate is append-only after completion. A later implementation outcome is a separate event,
not a mutation that rewrites what the models originally decided.

## Invariants

1. `accepted` requires two eligible seats and verifier acceptance.
2. No API-key environment variable may cross the process boundary.
3. Both seats receive the same evidence hash.
4. A source-head or evidence-hash change invalidates convergence.
5. Authentication never implies consent.
6. At most one synthesis revision occurs.
7. Host success is not an adjudicated quality outcome.
8. Raw source, credentials, account identity and full transcripts are not durable learning data.
9. A degraded review always names the missing or capacity-limited seat.
10. Neither Claude nor Codex is permanently the scribe; task hash chooses the role.
11. Native stage output is validated before adapter-owned identities or execution evidence are
    attached. The adapter rejects those fields for an authoring stage and preserves partial-read
    findings without promoting them to completed coverage. Both clients use the same runtime admission contract.
12. Client customizations and external tool integrations are excluded from the review invocation
    as described in ADR-061. Managed administrator policy remains authoritative; the evidence
    captures the supplied task and completion, not a claim to contain every provider instruction.
13. Primary-content identity and full conversation evidence are distinct. The causal trace binds
    corrections, resolutions and ADR/DDD metadata that are outside the primary-content digest.

## Domain events

- `DualHostSuggested`
- `DualHostConsentRecorded`
- `SeatVerified`
- `SeatUnavailable`
- `ProposalCompleted`
- `CritiqueCompleted`
- `SynthesisCreated`
- `RevisionRequested`
- `SynthesisAccepted`
- `DeliberationDegraded`
- `OutcomeAdjudicated`

## Boundaries

- **Host Wiring Context** supplies installed Claude/Codex lifecycle paths.
- **Routing Context** supplies per-user subscription preferences; it does not execute the duel.
- **Retrieval Context** supplies guarded source evidence.
- **Quality Context** executes the Agentic-QE plan and independent experience grading.
- **Learning Context** stores sanitized append-only receipts and verified outcomes in project
  AgentDB.

## Repositories

`DeliberationReceiptRepository` is implemented only through `ruflo memory store` against the
project's `.swarm/memory.db`. Raw debate transcripts may be returned to the caller or saved as an
explicit user artifact, but are not implicit memory records.
