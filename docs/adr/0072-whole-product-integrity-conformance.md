---
id: ADR-072
title: Whole-product integrity is one executable contract
status: Accepted
date: 2026-08-21
updated: 2026-09-11
version: 1.2.0
reviewed_digest: 2f94ceb4896a
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
  - .github/workflows/protected-release.yml
  - .github/workflows/release-candidate-preflight.yml
---

# ADR-072 — Whole-product integrity is one executable contract

**Status**: Accepted

> **Reviewed 2026-09-04 (authenticated recovery observation).** Public lanes now authenticate their
> read-only GitHub release lookup with the workflow token; immutable byte identity and terminal
> conformance rules are unchanged.

> **Reviewed 2026-09-04 (4.3.9 recovery).** Public host verification now pins Claude's marketplace
> source to the exact candidate checkout, so default-branch advancement cannot substitute a later
> plugin generation. The signed npm, bundle, coverage, and terminal acceptance boundaries remain unchanged.

> **Reviewed 2026-09-04 (4.3.9 candidate).** The candidate strengthens two existing conformance
> edges: publication handoff cannot appear before signed channel convergence, and every public-host
> failure is retained in a digest-bound receipt before the lane exits. It does not complete this
> ADR's remaining source-coverage work, and it does not claim 4.3.9 is public before terminal
> `install-verified` evidence exists.

Accepted by Stuart's 2026-08-21 direction; implementation is in progress. Whole-product conformance
remains unproven. The owner-authorized stabilization milestone below distinguishes an incremental
verified release from that stronger claim. Nothing in this document is a shipped-capability claim.

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

The release rail has two phases without duplicated qualification. On `release/**`,
`release-candidate-preflight.yml` runs CI, integration, UX, and stranger lanes once and emits the
source-bound package plus aggregate as `release-candidate-<exact SHA>`. The published candidate must
equal current `main`: merge required-check-qualified source first, then qualify that exact merge SHA
on `release/**`; alternatively an unchanged prequalified SHA may reach main without rewriting it.
A squash or other source-identity change requires qualification of the resulting SHA.
`protected-release.yml` is the sole publication controller: it selects
the artifact by deterministic name within the authenticated successful producer run, not a
caller-supplied run ID or a global name-only match, revalidates its receipts, payload/source
binding, and digest against current main, then signs/publishes once and owns public three-OS by
three-host-mode verification through terminal `install-verified`.

Refresh success likewise requires an atomic terminal receipt after all nine required phases. The
state sequence is `RUNNING -> SETTLING -> SUCCEEDED|FAILED|ABANDONED`. A dead exact owner is
atomically abandoned; an unknown or remote owner is never guessed dead.

Storage activation uses `CLEANUP_PENDING` for a verified live generation whose redundant rollback
could not yet be deleted. `RECOVERY_REQUIRED` is reserved for identity ambiguity or damaged state.

### 4. SMART acceptance contract

The release objective is specific, measurable, achievable within the existing Node/RVF/AgentDB and
GitHub Actions architecture, relevant to the observed failures, and time-bound to the next public
version. Evidence is due at its actual event boundary on one exact source snapshot: candidate
safety, identity, artifact and staged-runtime requirements precede publication; S-6/S-7 public
download and installation evidence necessarily follows channel publication and precedes
`install-verified` in that same transaction. Staged evidence never substitutes for public evidence.
All twelve rows must be PASS before claiming whole-product conformance. The blanket earlier
requirement for public-download PASS before publication is superseded by this sequencing correction.

| ID | Specific outcome | Measure and deadline |
|---|---|---|
| S-1 | One complete public corpus | 100% of the live eligible repository rows are `CURRENT`; all eligible gists have complete receipts; the typed public partition is exhaustive with zero extra/private/unclassified stores before candidate sealing. |
| S-2 | Immutable truth remains immutable | Corpus/public ledgers and coverage embedded in archives equal canonical bytes exactly; runtime ledgers are separately derived. Every byte mutation fails before publication. |
| S-3 | Retrieval meets the product promise | Coverage-derived canaries exercise every store added since the failed 62-repository seed plus a deterministic stratified legacy sample. Delta-store citation pass rate is 100%; aggregate Recall@10 is at least 98%; no skipped/unknown result. |
| S-4 | Nightly is deterministic and bounded | Two consecutive runs through the real native scheduler complete the exact nine-phase order. Run two is `noop`, creates zero additional full-corpus copies, and total managed evidence remains within the declared retention budget. Latest verified nightly age must remain <=30 hours. |
| S-5 | Updates preserve one active generation | Concurrent writers serialize; interruption at every rename/receipt boundary recovers; retired public stores disappear; every declared private/local store survives; success leaves one active corpus, zero retained redundant rollback copies, and a valid `storageDelta`. |
| S-6 | Hosts converge from real artifacts | Linux, macOS, and Windows each pass Claude-only, Codex-only, and dual modes through the sealed loader registry: exactly nine green leaves, zero missing/extra/skip/todo leaves. |
| S-7 | Publication cannot overclaim | Channel publication emits only `PUBLISHED, NOT VERIFIED`. The same protected-release run reaches `install-verified` only after downloading actual npm/GitHub bytes and validating the signed nine-leaf aggregate and retrieval canaries. |
| S-8 | Architecture and proof agree | Every Accepted/Implemented ADR and DDD claim governing changed code maps to its implementation owner and executable evidence. Zero unresolved contradictions, dangling supersessions, or unlinked release-critical code at the candidate seal. |
| S-9 | Essential behavior is completely tested | 100% of essential invariants, state transitions, failure boundaries, and public commands in the traceability matrix have at least one positive and one adversarial proof. Security/release/lifecycle state-machine branches are 100% covered. Repository line coverage remains a diagnostic, never a substitute for this requirement. |
| S-10 | Independent review is real when judgment changes | Architecture or retrieval-oracle changes require Fable 5 and GPT-5.6-Sol to independently review the same immutable design/change/rubric. Routine releases consume the accepted change-bound review and mechanical evidence; caller-supplied per-release keys are not an independent trust anchor and cannot authorize publication. |
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
  any change-triggered architecture/oracle review, public 3x3 installs, canaries, and two-run nightly proof. Only the protected
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

### 7. Publication remains fail-closed

The protected workflow must not green an incomplete transaction. Labeled `release-blocker` issues,
missing typed evidence, failed required checks, a missing public 3x3 matrix, or absent terminal
readback stop the run. Unlabeled backlog does not silently acquire release authority.

### 8. Owner-authorized 4.3.10 stabilization milestone

Stuart's 2026-09-05 direction explicitly requires materially improved incremental production
releases while the complete recovery continues. For 4.3.10, use the existing sealed
stabilization-candidate path and its `scoreClaimed: false` receipt, not a new bypass flag,
publisher, unsigned exception, or manufactured ProductIntegrityCase PASS.

This milestone retains required QA, exact source and artifact identity, private-data safety,
authenticated producer provenance, signatures, staged retrieval, and the same protected
public three-OS by three-host-mode matrix, canaries, and terminal readback. Its `install-verified`
receipt certifies that release transaction only. It does not certify all S-1 through S-12,
complete codebase review, universal recall, or fresh end-to-end corpus production.

The stronger `scripts/adr-072-completion.mjs` contract and all twelve obligation owners remain
unchanged. Unproved obligations remain OPEN/UNKNOWN, particularly S-4 producer freshness and complete producer-to-consumer proof; safe interruption recovery and full essential-branch coverage also need
their own complete evidence. Release notes and status must disclose unresolved scope rather than
presenting this stabilization as completed North Star conformance. A known safety failure in the
candidate's release/update path is not exempted by calling the release incremental.

### Installed-update public proof

Before `install-verified`, each public dual-host leaf on Linux, macOS, and Windows must
include two sequential terminal runs triggered by that platform's native scheduler. The
proof consumes the exact public npm package and signed bundle, binds their hashes to the
candidate source, version, and workflow run, and validates the live installed ReleaseCoverage
projection after each run. Run two must be `noop`, with measured storage deltas, no redundant
full-corpus copies, bounded retained evidence, and verified removal of the owned proof job.
Missing raw evidence or failed cleanup blocks acceptance; claimed validation flags do not
replace raw receipt, signature, executable-identity, and projection validation.

This is explicitly `scope: installed-update`. Update, host convergence, and cleanup carry
current-run execution evidence. Corpus phases imported from the signed release remain
`imported-release`, bound to the installed projection and candidate source. Upstream freshness
remains `UNKNOWN`; these consumer runs do not prove a new corpus build or complete S-4.
The strict current-run corpus-production validator remains a separate requirement.

## Consequences

- Current patch volume may decrease because contradictory and fact-restating paths are removed.
- Historical receipts and release assets remain immutable; compatibility is explicit by schema.
- A red matrix is actionable because every red result names a domain invariant, not merely a file.
- No one may claim flawless, guaranteed, complete, shipped, or 98% recall until the corresponding
  exact-source receipt exists and the stated untested scope is empty.

## Current implementation status

`Accepted; implementation remains proof-gated.` The executable S-1 through S-12 ownership and
evidence contract lives in `scripts/product-integrity-contract.mjs`. Its source-presence check is
not behavioral completion. This reconciliation defines a
source-bound preflight followed by one protected publication controller, without rerunning the long
lanes. It removes per-release self-supplied reviewer identity and all-open-issue policy from the
architecture. The stabilization release is not complete until preflight produces
`release-candidate-<exact SHA>`, that SHA equals main, and protected release revalidates it before
producing the publication receipt, nine public leaves, and `install-verified` terminal receipt.
Whole-product conformance additionally requires all twelve complete obligation proofs.

## Proposed amendment A — producer, consumer, and composed freshness proof

**Status: Proposed (2026-09-05), pending implementation validation.** This is a decision draft,
not an Accepted supersession, an implemented capability, or verified S-4 evidence. The original
Accepted decision, S-4 row, and historical receipts above remain unchanged. Until this amendment
is explicitly accepted and its implementation/acceptance mapping is validated, the existing
strict whole-product completion gate remains controlling; imported phase evidence must not be relabelled to
obtain a PASS. Drafting authority does not authorize a scheduler, publication, or production run.

### A.1. Problem and proposed boundary

The current consumer `--update` validates a released corpus; it does not execute upstream source
enumeration, ingestion, or public bundle assembly. Importing their coverage statuses cannot prove
that those operations ran in the consumer invocation. Moreover, the original nine-phase order
places private/local-overlay restoration before public ledger/coverage/bundle production. Joining
old producer receipts to a new consumer receipt cannot make that a truthful chronological order.

Propose one centralized immutable public producer, verified local consumers, and a composed
product proof. Preserve all nine obligations, but explicitly replace their single-host execution
assumption with actor-bound execution and dependency order **only after acceptance**:

| Responsibility | Executing owner | Required evidence |
|---|---|---|
| Source enumeration, ingestion/reconciliation, immutable public generation ledger, coverage generation, public bundle assembly | Public producer | Actual phase outcomes, exact source observation and builder identity, invocation/time bounds, immutable output digests |
| Signature/provenance and freshness verification, private/local-overlay restoration, atomic update, host convergence, cleanup | Each consumer | Actual native invocation, exact consumed producer outputs, local runtime projection, preserved private bytes, fenced activation and storage evidence |
| End-to-end S-4 disposition | Read-only proof composition over producer and consumer receipts | Authenticated links, dependency order, both freshness bounds, native two-run/no-op proof, and storage/retention compliance |

Public production precedes consumption; local overlays remain local and are restored into the
consumer candidate before activation. Runtime ledger projection/validation must not rewrite the
immutable public ledger or be represented as public production. A composed proof records each
actor's own run ID and actual timestamps, not one invented execution ID or nine synthetic PASSes.
Reusing a still-fresh authenticated producer receipt in two consumer runs is not two producer runs.

### A.2. Alternatives and reusable owners

1. **Build on every consumer:** permits local production but distributes upstream credentials,
   embedding/build dependencies, resource cost, and reproducibility obligations to every host.
   This is not the smallest repair of the existing immutable distribution design.
2. **Centralized producer plus verified consumers (proposed):** reuse `source-coverage.mjs`,
   `corpus-reconcile.mjs`, `corpus-candidate.mjs`, and `build-bundle.mjs`; keep
   `corpus-seed.yml` a preparation workflow and `protected-release.yml` the sole publisher.
   Consumers retain signature verification, private overlays, and atomic local activation.
3. **A composed producer-consumer run:** appropriate as the end-to-end proof over option 2,
   not a substitute for missing producer execution or a second controller/publisher. Its
   acceptance rules must name the allowed producer reuse and actor/dependency boundaries.

RVF remains the vector/artifact format. Canonical AgentDB remains the structured operational
authority. Signed immutable receipt exports and bounded consumer read models are evidence, not
new competing project-state stores. No additional daemon or independent release publisher is
proposed. The existing protected signing, source binding, private-data fence, retrieval, and
public verification requirements remain mandatory.

### A.3. Authenticated upstream freshness is not download recency

Require separate consumer-execution age and upstream-observation age, **each <=30 hours** for
the composed healthy verdict. Upstream age is measured from the oldest required observation in
the complete authenticated observation window (or its conservative start), not download time,
consumer `finishedAt`, publication time, source commit age, or a newly copied metadata timestamp.
Absent, incomplete, untrusted, or unverifiable timing/identity evidence yields `UNKNOWN`, never
fresh. Expired evidence is stale; unsupported future timestamps/clock skew cannot yield PASS.

Producer evidence must authenticate the complete observation, trusted producer/build identity,
invocation and time window, phase outcomes, artifact/coverage/ledger digests, expiry, and replay/
rollback controls. Consumer verification must bind that evidence to the exact bytes installed.
A signature without those checks is not freshness proof; a valid consumer update can succeed
while composed product freshness remains `UNKNOWN` or stale.

Keep content identity separate from observation freshness. `sourceObservationDigest()` excludes
`observedAt`, whereas coverage generation includes the timestamp-bearing enumeration receipt.
Therefore blindly refreshing coverage timestamps can churn an otherwise unchanged artifact.
The implementation must support a newly authenticated observation of unchanged source content
without rewriting the immutable installed corpus merely to freshen its label. A phase that
executes reconciliation and proves no change must report that no-op, not claim fresh embedding
or rebuilding of every store. This evidence separation is proposed, not already validated.

### A.4. Acceptance invariants and validation required before adoption

- Two consecutive real native consumer-scheduler invocations must be proven, each bound to valid
  producer evidence and the exact consumed artifact. The second is `noop` and creates zero
  additional full-corpus copies. Subprocess envelopes, fixture receipts, and scheduler
  registration alone do not prove native execution.
- Fenced single-writer activation, crash/rollback recovery, declared private/local overlays,
  exact immutable bytes, and complete public-source coverage remain mandatory. Unknown or
  unlisted private/custom data must never be deleted to satisfy storage acceptance.
- Count preserved installer generations, unresolved prior/stage trees, managed backups, and
  evidence in the relevant storage inventories. Non-cleanup-eligible preserved data remains
  visible. Its presence cannot be hidden behind an evidence-only retention budget or promoted
  into bounded-storage PASS; retention is not authorization to delete it.
- Producer and consumer evidence must reject stale-but-recently-downloaded artifacts, altered
  observation timestamps, wrong signer/builder/source/artifact, partial enumeration, replay,
  future timestamps, out-of-order dependencies, and imported evidence presented as execution.
- Before adoption, map every obligation to producer/consumer validators and positive/adversarial
  tests, reconcile DDD/traceability/completion wording, and collect genuine producer plus native
  consumer proof. Do not weaken the current same-run validator to make an incompatible consumer
  receipt pass. Full-conformance promotion remains blocked until this work is explicitly accepted
  and validated; section 8's stabilization milestone neither accepts this proposal nor proves S-4.

Design references: [SLSA build provenance](https://slsa.dev/spec/v1.2/build-provenance) separates
builder execution identity, inputs, outputs, and timing; [SLSA consumer verification](https://slsa.dev/spec/v1.2/verifying-artifacts)
requires trust and artifact/expectation checks; [in-toto layouts](https://in-toto.readthedocs.io/en/latest/layout-creation-example.html)
link actor-specific products/materials and distinguish inspections; [TUF](https://theupdateframework.github.io/specification/latest/)
defines expiry and rollback defenses. These are design references, not claims of conformance.

## Currency log
| 2026-09-11 | Currency review at commit 2eef2024: code drifted in `governs:` only (corrected above, not the status) — `.github/workflows/release-aggregate.yml` was deleted on 2026-09-04 (commit `e6774a39`, "ship reconciled candidate") along with `release-cycle.yml` and `product-integrity-review.yml`, consolidated into the already-governed `protected-release.yml` plus the newly-added `release-candidate-preflight.yml` (the 2026-09-04 row below already describes this consolidation, but `governs:` was never updated, which is why this digest had been permanently uncomputable). Decision unchanged on the 25 substantive drift commits found once the digest could be computed: the 12 touching a core file (outside `bin/install.mjs`/`ci.yml`/`hooks.json`, reviewed under ADR-013/034/049/051/056/070) are narrow verification-machinery precision fixes — UTF-8 stream-boundary decoding (`779edc8a`), deterministic cross-release corpus sampling (`779edc8a`), MCP warmup latency isolation (`8770c8e2`, `4117d9f0`), and an ADDITIONAL `acceptancePolicy`/`searchTiming` check appended to `validatePublicVerificationLeaf()` (`c0234b69`) that makes S-7 stricter, not looser. None weaken any S-1..S-12 acceptance row. | Read all 4 previously-unreviewed core-file diffs in full; confirmed `release-aggregate.yml`'s deletion commit and successor files via `git log --diff-filter=D` and `git show --stat`; cross-checked the remaining 13 drift commits against reviews already completed for ADR-013/034/049/051/054/056/062/070. reviewed_digest 2f94ceb4896a. |
| 2026-09-07 | Reviewed the installed-update public proof boundary; producer freshness remains UNKNOWN. | `kb/forge-update.mjs` imports signed corpus evidence; `scripts/public-verification-aggregate.mjs` and `scripts/nightly-two-run-proof.mjs` validate raw native consumer evidence. |
| 2026-09-05 | Corrected the impossible pre-publication public-download deadline and documented the owner's incremental 4.3.10 stabilization milestone without a full-conformance claim. | `scripts/adr-072-completion.mjs` remains unchanged; `scripts/product-integrity-contract.mjs` retains every obligation; `.github/workflows/protected-release.yml` and `scripts/stabilization-receipt.mjs` retain exact candidate, protected publication, and same-transaction public acceptance. `docs/ddd/0018-product-integrity-context.md` distinguishes release disposition from obligation completion. |
| 2026-09-04 | Reconciled the expedited two-phase rail: long qualification runs once in preflight on `release/**`; protected release imports `release-candidate-<exact SHA>` after the unchanged SHA reaches main, revalidates it, publishes once, and completes public install proof. | `.github/workflows/release-candidate-preflight.yml` and `.github/workflows/protected-release.yml` divide qualification from publication without human run IDs or duplicated long lanes. Fable/Sol review remains change-triggered and only `release-blocker` issues stop publication. |
| 2026-08-31 | Reconciled the watchdog's Windows command boundary after hosted PR evidence localized the failure to executable resolution, not the test suite; the product contract is unchanged and the boundary is now portable. | `.github/workflows/ci.yml`; `scripts/ci/step-watchdog.mjs`; PR #211. |
| 2026-08-31 | Reconciled after the 4.3.3 main-branch merge and CI watchdog change; whole-product conformance still requires every exact-SHA lane, and long hosted stages now expose named timeout receipts instead of opaque job progress. | `scripts/ci/step-watchdog.mjs`; `.github/workflows/ci.yml`; exact-SHA CI run `33358984585`. |

| 2026-08-30 | Re-read after `abc1731` repaired the squash-merge provenance boundary; whole-product conformance is unchanged except that release-QE now fetches and validates the pre-candidate oracle source explicitly. | `scripts/retrieval-canary.mjs`, `.github/workflows/ci.yml`; focused suite passed 11/11. |

| 2026-08-30 | Re-read whole-product release conformance after the candidate build found that seed exclusions, derived stores, and projection receipts were not entering one validation boundary, and after confirming PRs did not run `ci.yml`. | `scripts/build-bundle.mjs`, `scripts/release-projection.mjs`, `plugin/scripts/coverage-integrity.mjs`, `.github/workflows/ci.yml`; local canonical QA passed, while hosted exact-SHA publication proof remains the release boundary. |

| 2026-08-30 | Rechecked whole-product integrity after release-QE isolated a missing policy registry in the baseline seed; the final bundle now carries the canonical source-controlled registry explicitly. | `scripts/build-bundle.mjs`; `kb/public-store-classes.json`; exact-SHA release-QE. |
| 2026-08-30 | Rechecked whole-product integrity after the projected validator exposed the same boundary for the private-store fence; policy now enters validation from the canonical checkout while corpus bytes remain seed-bound. | `scripts/build-bundle.mjs`; `kb/PRIVATE-STORES.json`; exact-SHA release-QE. |
| 2026-08-30 | Rechecked whole-product integrity after hosted verification exposed stale projected totals; the release read model now binds its seeded rows, derived counts, enumeration receipt, and source-observation identity together. | `scripts/release-projection.mjs`; exact-SHA release-QE. |
| 2026-08-30 | Rechecked whole-product integrity after partition evidence differed across the two bundle stages; projected receipts now enter the seed validation root before the final public partition is computed. | `scripts/build-bundle.mjs`; exact-SHA release-QE. |
| 2026-08-30 | Rechecked whole-product integrity with an exact local two-stage replay; the public evidence partition remains unchanged through final archive assembly. | `scripts/release-projection.mjs`; `scripts/build-bundle.mjs`; local proof `566fe4f5bb435f11c8a924a8cef9b8c251c508051653121f39e7533536455daf`. |

| 2026-08-30 | Rechecked whole-product integrity after release-QE found the seed/source gist-byte mismatch; the projection now preserves the full observation while validating the actual seeded asset plane with an explicit baseline receipt. | Commit `f526bab`; `scripts/release-projection.mjs`; `plugin/scripts/coverage-integrity.mjs`; Issue #201. |

| 2026-08-30 | Reconciled the whole-product release path after exact-SHA CI exposed the Actions-token gists 403: the publisher now uses the prepared source-bound observation and retains fail-closed seeded-row freshness checks. | Issue #201; `.github/workflows/ci.yml`; `scripts/release-projection.mjs`; `tests/unit/corpus-seed.test.mjs`. |

| 2026-08-30 | Reconciled the host-only updater after live v4.3.1 had no GitHub assets and the updater stranded the Stable Spine on 4.2.2-dev. | `bin/install.mjs` now records the KB plane as degraded while continuing executable host convergence; the missing required release asset remains a publication failure. |

| 2026-08-30 | Whole-product PR evidence now has one bounded canonical entrypoint; the full legacy QE matrix is manual-only and cannot create competing release claims. | `scripts/qa-runner.mjs`, `.github/workflows/ci.yml`, and `.github/workflows/qe-4-3.yml` preserve protected publication checks while simplifying automatic evidence collection. |

| 2026-08-30 | Product integrity now has a bounded exact-SHA canonical gate and a separate release-authority assertion. | `scripts/qa-runner.mjs`, `scripts/release-authority.mjs`, and `docs/QA-RELEASE-PROCESS.md` make the boundary executable and auditable. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-23 | Reconciled the release artifact proof with the private-store integrity boundary. | The bundle builder now copies the source fence into the output and regression coverage asserts it, preventing a candidate that assembles without the policy document required by public-inventory validation. |
| 2026-08-23 | Re-read the CI release path after adding the seed-coverage preflight. | Commit `efcecad` adds a fail-closed coverage assertion before bundle projection; the product-integrity obligations remain unchanged and still require exact green publication evidence. |
| 2026-08-22 | Re-read the S-1 public-partition boundary after the real lifecycle candidate exposed policy-ineligible local stores and unclassified archive sidecars. | Commit `f088e4f` integrates the prerequisite that excludes explicitly ineligible repositories from public generation selection without deleting their local evidence. Commit `5f9a52c` extends the candidate archive check from RVF roots to every recognized sidecar family and rejects case-fold aliases. The combined 63-test focused gate, executable trace, and wiring audit pass; public canaries, dual final-candidate reviews, and the real three-OS host matrix remain absent, so S-1/S-3/S-6/S-10 are not declared complete. |
| 2026-08-22 | Bound both S-10 reviewers to every exact retrieval-oracle row and made the sealed plan mandatory at both review gates. | Commit `63d0e08` requires complete per-row relevance verdicts from Fable 5 and GPT-5.6-Sol and binds them through the signed public aggregate. Commit `f06624a` passes the exact plan into the pre-publish pair verifier; `30826f9` closes the remaining fail-open CLI path by rejecting `verify-pair` without `--retrieval-plan`. Focused source tests pass, but no real final-candidate reviews or public matrix receipts exist, so S-3/S-10 remain unproven in production. |
| 2026-08-22 | Replaced the structurally forgeable S-3 query oracle with a version-two strict-ancestor evidence chain. | Commit `457978b` makes `scripts/retrieval-canary.mjs` bind every canonical query to one exact path and full-passage digest, carry the complete sealed evidence into the plan, and verify both the raw O1 payload and the sealed candidate-tracked bytes. `tests/unit/retrieval-canary.test.mjs` rejects irrelevant-plan rehashing, duplicate queries/passages, missing or wrong expected evidence, stale receipts, and external substitution. Natural-language relevance is not derivable from hashes; S-3 remains release-blocked until the S-10 dual-review receipts attest every exact oracle row. |
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
Implementation note (2026-08-23): ReleaseProjection is wired into the bundle workflow; exact CI remains the production certification boundary.
