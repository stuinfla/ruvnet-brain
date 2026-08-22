Updated: 2026-08-22 12:00:00 EDT | Version 0.1.0
Created: 2026-08-22 12:00:00 EDT

# DDD-0020 — Capability claim integrity context

Status: Accepted; installation claims are partially implemented and full S-12 proof remains open

Governs: ADR-074 and the claim-evidence boundary used by `HostConvergence`,
`PublicVerification`, and `ProductIntegrityCase`.

## Purpose and boundary

This supporting context prevents an assistant from turning an incomplete check into a confident
fact about a RuvNet tool. It does not decide what tools should do and does not become a second
source corpus. It binds final-answer claims to evidence produced by the owning live surfaces.

It is not a ninth ADR-072 process. `ProductIntegrityCase` owns S-12, `HostConvergence` contributes
installed-host observations, and `PublicVerification` contributes source and live-release proof.

## Aggregate root: CapabilityClaimCase

```text
CapabilityClaimCase
  host
  finalMessageDigest
  claims[]
  inventoryReceipt?
  sourceReceipts[]
  liveReceipts[]
  findings[]
  disposition: PASS | FAIL | UNKNOWN
```

Invariants:

1. Every recognized claim has one typed evidence requirement.
2. Positive presence and negative absence are different propositions and are evaluated separately.
3. A found source byte may prove presence even when enumeration is incomplete.
4. Only a complete inventory may authorize an absence conclusion.
5. Semantic-search miss, guessed directory, cached version string, and prompt instruction are not
   evidence of absence, currency, health, or reachability.
6. Any evidence digest, host identity, source identity, or final-message mismatch invalidates the
   verdict rather than degrading it silently.

## Value objects

| Name | Role |
|---|---|
| `CapabilityClaim` | Exact text, normalized subject, predicate, polarity, and required evidence class. |
| `CapabilityInventoryReceipt` | Content-bound enumeration of installed RuvNet host capabilities with explicit completeness. |
| `SourceClaimReceipt` | Exact repository/path/content identity that supports or contradicts a behavior claim. |
| `LiveSurfaceReceipt` | Command/registry/round-trip observation for version, publication, health, or reachability. |
| `ClaimFinding` | PASS, contradiction, or UNKNOWN with the evidence identity and correction requirement. |

## Commands and events

- `InventoryHostCapabilities(host, roots)` -> `CapabilityInventoryObserved`
- `AuditFinalInstallationClaims(message, inventory)` -> `ClaimPassed | ClaimContradicted | ClaimUnknown`
- `BindSourceClaim(claim, sourceReceipt)` -> `SourceClaimBound`
- `BindLiveClaim(claim, liveReceipt)` -> `LiveClaimBound`
- `RefuseUnprovenFinalAnswer(case)` -> `CorrectionTurnRequired`

All receipts are immutable. Re-running an inventory creates a new identity; it never rewrites the
old observation.

## Policy

The shared Stop body is the sole enforcement adapter. Host wrappers may translate its output shape
but may not weaken the verdict. Ordinary machinery failure remains fail-open so a broken plugin
cannot trap a session; `ProductIntegrityCase` treats that missing proof as release-blocking.

Natural-language recognition must stay narrow and mutation-tested. A detector that cannot
distinguish a quoted user statement, a hypothetical, or an assistant assertion is not authorized to
block that class yet.

## Current status and open proof

The installation-claim slice has a content-bound skill inventory and focused direct-Stop tests,
including quoted-history, inline-code, and hypothetical separation. The following remain open:
packed Claude/Codex execution, broader false-positive measurement, behavior/API source binding,
live version/health binding, signed S-12 public aggregate, and any native Grok lifecycle adapter.
