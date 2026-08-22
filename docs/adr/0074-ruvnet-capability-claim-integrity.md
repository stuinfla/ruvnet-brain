---
id: ADR-074
title: RuvNet capability claims require live evidence
status: Accepted
date: 2026-08-22
updated: 2026-08-22
authors: [Stuart Kerr, Codex]
tags: [architecture, truthfulness, capabilities, hosts, evidence, receipts]
supersedes: []
relates: [ADR-020, ADR-055, ADR-067, ADR-072, ADR-073]
governs:
  - docs/ddd/0020-capability-claim-integrity-context.md
  - plugin/scripts/capability-inventory-receipt.mjs
  - plugin/scripts/capability-claim-evidence.mjs
  - plugin/scripts/continuation-gate.mjs
  - plugin/mcp/managed-cli-interface.mjs
  - kb/forge-evidence.mjs
  - plugin/scripts/codex-hook-adapter.mjs
  - plugin/hooks/hooks.json
  - plugin/hooks/codex-hooks.json
  - tests/unit/capability-inventory-receipt.test.mjs
  - tests/unit/capability-claim-evidence.test.mjs
  - tests/unit/continuation-gate-capability-truth.test.mjs
  - tests/unit/managed-cli-interface.test.mjs
  - tests/unit/grounding-receipt-lanes.test.mjs
  - tests/acceptance/adr-074-packed-capability-claims.acceptance.test.mjs
---

# ADR-074 — RuvNet capability claims require live evidence

**Status**: Accepted

Accepted by Stuart's 2026-08-22 mandate. Installation, exact-source behavior, current-installed
version, and health claim enforcement are implemented in the working candidate and exercised
through locally packed Claude/Codex hook wiring. A read-only registry producer now binds
latest-version claims through the same packed Stop paths. The required non-local OS and public-byte
matrix remains open. Nothing in this document is a shipped-capability claim.

## Context

An assistant said Ruflo ADR Verify was not installed after checking one guessed directory. The
active host inventory already listed `ruflo-adr:adr-verify`. The answer converted an incomplete
search into a factual absence claim, exactly the trust failure RuvNet Brain is meant to prevent.

Prompt instructions already required verification. They did not prevent the statement. The system
therefore needs a deterministic final-answer boundary that compares a claim with current host
evidence before the answer can leave the session.

## Decision

### 1. S-12 is a ProductIntegrityCase obligation

ADR-072 gains S-12 without adding a ninth delivery process. `ProductIntegrityCase` owns the final
claim verdict. `HostConvergence` contributes the real installed-host inventory and
`PublicVerification` contributes source/version evidence.

### 2. Claims use evidence typed to the question

One evidence source cannot prove every kind of claim:

| Claim class | Required evidence | Failure meaning |
|---|---|---|
| Installed, registered, or present | Complete `CapabilityInventoryReceipt` over the active host's discoverable RuvNet skill/plugin surfaces | Present bytes contradict absence; complete absence contradicts presence; incomplete enumeration is `UNKNOWN` |
| Behavior, API, support, or limitation | Fresh source-grounding receipt whose exact source path and content identity bind the claim | No binding or design-only evidence is `UNKNOWN`; absence of retrieval never proves absence of capability |
| Current version, latest, healthy, or reachable | Fresh live command/registry/round-trip receipt for the exact installed/public surface | A stale document, version string alone, or adjacent path is `UNKNOWN` |

The current implementation covers the first row, exact-source behavior claims, installed-current
version, managed-CLI health observations, and a dedicated public-registry latest-version probe.
The probe is read-only and emits a content-bound receipt only after an exact successful registry
response; lookup failure or malformed metadata remains `UNKNOWN`.

### 3. CapabilityInventoryReceipt is exhaustive or UNKNOWN

The receipt records host, observed roots, every parsed skill identity, absolute source path, source
digest, enumeration errors, time, and an aggregate digest. Missing optional roots are observed as
absent. An unreadable root, malformed discovered skill, traversal bound, or receipt mutation makes
the inventory incomplete. Incomplete inventory can still prove presence from a found byte; it can
never prove absence.

### 4. The existing Stop chokepoint owns answer-time enforcement

No second final-answer gate is added. The existing continuation gate receives
`last_assistant_message` from both Claude Code and Codex. Before normal open-work handling it audits
RuvNet installation claims. A contradiction or unprovable absence forces one correction turn under
the existing loop/cooldown protections. The correction names the found capability and source path,
or requires the answer to say `UNKNOWN`.

### 5. Host membership is evidence-bound

Claude Code and Codex are required once packed tests prove their adapters preserve the final answer
and enforcement output. Grok is not a supported lifecycle host until a native adapter exposes an
equivalent final-answer boundary and passes the same mutation cases. Provider routing is not a host
adapter.

## Failure semantics

- Found installed bytes plus an absence claim: `FAIL`, force correction.
- Complete inventory plus an unsupported presence claim: `FAIL`, force correction.
- Incomplete inventory plus a claim that depends on absence: `UNKNOWN`, force re-verification or
  explicitly uncertain language.
- No recognized installation claim: this receipt class has no verdict about the rest of the prose.
- Inventory code failure: Stop remains fail-open operationally, but S-12 remains unproven and the
  product cannot receive an integrity PASS.

## Acceptance

1. Replay the exact false statement against installed `ruflo-adr:adr-verify`; both supported hosts
   must refuse the answer and name the installed source.
2. Mutate the inventory to complete-absent, incomplete, malformed, unreadable, stale, and
   digest-tampered states; every case must produce its typed verdict.
3. Prove behavior/API claims bind to exact source receipts and version/health claims bind to fresh
   live receipts; unsupported confident language must not leave either host.
4. Run the packed Claude/Codex matrix on Linux, macOS, and Windows with zero skip/todo leaves and
   record the signed S-12 aggregate in the product-integrity receipt.
5. Measure Stop latency and false-positive rate. Safety does not authorize a hook that loops,
   mangles quoted user text, or blocks unrelated claims.

## Current implementation status

`Accepted, partially implemented.` `CapabilityInventoryReceipt`, full-SHA `SourceClaimReceipt`,
managed-CLI `LiveSurfaceReceipt`, and their claim audits are wired into the shared Stop body. One
locally packed candidate exercises installation, behavior, current-version, health, and
registry-latest outcomes through both Claude and Codex registrations. The code can sign and verify
an aggregate that derives `PASS | PARTIAL | FAIL` from typed per-lane claim verdicts; only its schema
and cryptography are unit-proven, and no release candidate aggregate has been minted. Linux/Windows
packed leaves, a real candidate/public registry receipt, Grok adapter proof, false-positive
measurement, and the signed public S-12 aggregate remain unproven.

## Currency log

| Date | What changed | Why |
|---|---|---|
| 2026-08-22 | Added the read-only `ruvnet_registry_latest` MCP probe, content-bound registry receipts, exact version comparison, and packed Claude/Codex latest-version cases. | “Latest” is a public-surface claim; installed CLI output cannot prove it. Network failure and malformed registry metadata still emit no receipt, so the answer remains `UNKNOWN` instead of inheriting a cached or adjacent version. |
| 2026-08-22 | Added full-SHA behavior receipts, managed-CLI current-version/health receipts, host-bound Stop auditing, typed signed aggregate logic, and packed Claude/Codex cases; latest remains `UNKNOWN`. | `plugin/scripts/capability-claim-evidence.mjs`, `plugin/mcp/managed-cli-interface.mjs`, and `tests/acceptance/adr-074-packed-capability-claims.acceptance.test.mjs` now distinguish evidence classes instead of treating installation as proof of behavior or currency. |
| 2026-08-22 | Added locally packed Claude/Codex Stop-path acceptance for the installation-claim slice. | Direct shared-body tests did not prove either host registration preserved the final answer and enforcement output. |
| 2026-08-22 | Established S-12 and implemented the first installation-claim receipt/audit slice. | A host asserted that an installed Ruflo ADR skill was absent because it searched one guessed path instead of the active inventory. |
