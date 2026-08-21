Updated: 2026-08-21 08:10:43 EDT | Version 1.2.0
Created: 2026-08-21 05:32:00 EDT

# DDD-0016 — The Source Coverage bounded context

Status: Proposed — projection/read-model slice implemented; release-proof aggregate incomplete

Governs: ADR-069 · `scripts/source-coverage.mjs`

## Purpose and boundary

Source Coverage proves which upstream rUv source versions are represented by which verified Brain
artifact bytes. It owns upstream observation, artifact provenance reconciliation, completeness
classification, and deterministic coverage projections. It does not ingest, embed, publish, or
install; those contexts consume its verdict.

## Current implementation boundary

Implemented now: upstream enumeration, repository/gist reconciliation against available RVF
receipts and byte hashes, explicit status rows, deterministic repository JSON/Markdown projections,
the strict candidate-CI invocation, bundle `COVERAGE.json`/`COVERAGE.md`, the installed terminal
reader, and the Console's third read-only Coverage page.

Still Proposed: cryptographically signed enumeration receipts, closed immutable candidate-snapshot
enforcement, routing and focused-QA result receipts, signed expiring exemptions, and one verified
coverage generation carried unchanged through protected publication, public download, clean install,
managed hosts, and terminal receipts. Existing UI/CLI wiring must not be cited as proof those
stronger aggregate invariants are complete.

## Ubiquitous language

| Term | Exact meaning |
|---|---|
| **Upstream object** | One public GitHub repository or gist observed from the authoritative paginated API. |
| **Upstream identity** | Repository HEAD commit SHA or gist version SHA plus its authoritative update time. |
| **Artifact receipt** | Checksum-bound record naming the source identity used to build one RVF generation. |
| **Coverage row** | Reconciliation of one upstream object, its policy disposition, artifact receipt, bytes, routing, and QA evidence. |
| **Coverage generation** | Immutable identity over the full ordered row set, observation inputs, and artifact digests. |
| **Projection** | Deterministic JSON/Markdown representation of one coverage generation. |
| **Current** | Every required provenance, byte, completeness, routing, and QA predicate agrees. |
| **Unverified** | Required evidence is absent or unreadable; never an alias for current or missing. |
| **Explicit disposition** | Evidence-bound reason a fork, archived, empty, or policy-excluded object is not eligible for ingestion. |
| **Enumeration receipt** | Signed proof of every upstream page/cursor, immutable object IDs, totals, terminal page, and read/rate-limit result. |
| **Coverage exemption** | Signed, object/failure/reason/generation/evidence/expiry-bound temporary release policy. |

## Aggregate: CoverageGeneration

`CoverageGeneration` is the aggregate root. It contains one `CoverageRow` per observed upstream
object, the complete paginated observation receipt, asset-root identity, generator source SHA,
timestamps, and derived totals.

### Repository row

- owner/name, fork/archive/empty flags, default branch
- upstream HEAD SHA, commit time, push time, observation time
- store name, artifact family digests, generation, ingested source SHA/time
- expected/covered/unexpected-missing path counts
- passage/vector counts, capability-card presence, routing probe, focused QA
- status and evidence-bound reason

### Gist row

- gist ID, version SHA, update/observation time
- file inventory, indexed count, explicit exclusions, content digest
- ingested version/time, artifact family digests, generation, QA
- status and evidence-bound reason

## Invariants

- SC-1: Every observed public repository and gist appears exactly once. Policy exclusions remain rows.
- SC-2: Clone state, filenames, mtimes, and existence never establish artifact freshness.
- SC-3: `CURRENT` requires exact upstream/source-receipt equality and verified artifact bytes.
- SC-4: Missing, malformed, ambiguous, truncated, or unreachable evidence is `UNVERIFIED` and fails strict mode.
- SC-5: A built but unroutable store is `DARK`, not current.
- SC-6: Unexpected omitted source paths or gist files fail completeness; truncated gist payloads are
  recovered from `raw_url` or fail.
- SC-7: JSON, repository Markdown, bundle projections, and installed projections share one coverage
  generation and cannot be edited independently.
- SC-8: A candidate snapshot is immutable while coverage is computed; mutable live stores are never
  read directly by the publisher.
- SC-9: Publication requires zero stale, missing, dark, failed, or unverified eligible rows unless an
  explicit signed policy exemption is part of the same generation.
- SC-10: Candidate, public artifact, and managed installed-host coverage receipts must bind the same
  source SHA, payload ID, coverage generation, and artifact digests.
- SC-11: Enumeration binds all request parameters, page/cursor response digests, immutable object
  IDs, duplicate set, profile totals, terminal no-next-page evidence, observation interval, and
  read/rate-limit results. Churn causes bounded retry then whole-generation `UNVERIFIED`.
- SC-12: `coverageGeneration` is the SHA-256 of JCS over schema version, generator source SHA,
  immutable snapshot root, ordered rows, enumeration receipt digest, policy disposition digests,
  and exemption digests. Row evidence uses inventories/counts and receipt/result digests, not bare
  booleans.
- SC-13: The candidate snapshot is a closed contained regular-file set. Missing, unexpected,
  mismatched, or symlinked RVF families, ledgers, cards, projections, or receipts fail; no prior
  manifest/release/cache/mutable/network fallback exists.
- SC-14: Exemptions are authorized-key signed and bind object, failure, reason, generation, evidence,
  and hard expiry. Omission does not renew. B expiry is checked at every release/install gate; A's
  validity remains fixed at its own convergence time.
- SC-15: The first ADR-069 release may use one visible signed, expiring bootstrap exemption
  generation for audited legacy gaps. It cannot silently renew or carry forward.
- SC-16: User surfaces read installed `COVERAGE.json`; they never substitute repository projections,
  embedded counts, or remembered answers. Missing or invalid installed proof is unavailable, not an
  empty or successful generation.
- SC-17: Plugin declarations, Console runtime code, and KB coverage data retain their existing
  lifecycles. A new slash-command declaration needs host plugin reload/new-session discovery; the
  loaded reader and Console API resolve the installed ledger per invocation/request. Coverage page
  assets participate in the Console runtime digest, while coverage data remains in the KB.

## Commands

- `ObserveUpstream(owner)`
- `SealEnumerationReceipt(pages, profileCounts)`
- `SnapshotArtifacts(assetRoot)`
- `ReconcileRepository(upstream, receipt, bytes)`
- `ReconcileGist(upstream, receipt, bytes)`
- `ProbeRouting(row)`
- `RunFocusedQa(row)`
- `SealCoverageGeneration(rows)`
- `RenderCoverage(generation)`
- `VerifyCoverage(generation, strict)`
- `ReadInstalledCoverage(kb/COVERAGE.json)`
- `SummarizeInstalledCoverage(filters)`
- `ServeCoveragePage(existingConsoleRuntime)`

## Domain events

`UpstreamObserved` · `ArtifactSnapshotBound` · `RepositoryReconciled` · `GistReconciled` ·
`CoverageGapDetected` · `CoverageGenerationSealed` · `CoverageProjectionWritten` ·
`CoverageStrictGatePassed`.

Every event carries upstream object identity, observation time, artifact/receipt identity, generator
source SHA, previous event digest, and result. A success event is never emitted from a partial API
page or a failed evidence read.

## Policies

### Classification

The classifier evaluates eligibility, receipt presence, source equality, byte integrity,
completeness, routing, and QA in that order. It returns one explicit status and all failing reasons;
it never short-circuits an unknown into current.

### Projection

`data/source-coverage.json` is the canonical repository projection. Markdown is generated and checked
against it. `scripts/build-bundle.mjs` copies and renames both projections into the bundle as
`COVERAGE.json` and `COVERAGE.md`; installation extracts those exact artifact members. It does not
currently regenerate Markdown from JSON. Runtime consumers therefore use installed `COVERAGE.json`
as canonical and treat `COVERAGE.md` as the bundled human-readable projection.

The terminal reader fails if canonical installed JSON is absent or unreadable. The Console reader
prefers `COVERAGE.json` and permits `source-coverage.json` only as a compatibility filename; it
validates schema version, nonempty generation identity, row shape, and total-row coherence before
returning data. Neither reader computes source truth independently.

### User-surface lifecycle

`plugin/commands/coverage.md` is boot-frozen plugin metadata. A host must load the plugin generation
that introduces it before the slash command is discoverable. Its executable,
`plugin/scripts/coverage.mjs`, reads the managed KB each time it runs.

The Coverage web page is the third page on the existing Console, not a second server or copied
ledger. `console/` is already a `CONSOLE_RUNTIME_SURFACE` member, so page bytes are included in the
staged runtime digest and atomic Console activation. `GET /api/coverage` reads the separately managed
installed KB at request time. A Console code update and a KB ledger update can therefore converge
independently without creating duplicate coverage stores.

### Release

Coverage is a candidate input and a post-publication observation. Candidate CI cannot seal with a
strict failure. Protected publication rechecks the immutable snapshot and embeds the coverage
generation in the payload/transaction receipts. Public-artifact and managed-host verification both
recompute and compare it.

## Required acceptance scenarios

1. Clone HEAD advances while RVF bytes remain old: row is stale and ingested SHA remains unchanged.
2. RVF exists without a source receipt: row is unverified.
3. Receipt source matches but bytes do not: row is failed.
4. Store is complete but lacks a routing card/probe: row is dark.
5. Fork, archived, and empty repositories remain visible with explicit dispositions.
6. A gist API file is truncated: raw content is fetched and bound, or the row fails.
7. Pagination or rate-limit failure: the generation is unverified and strict mode fails.
8. Candidate and installed ledgers differ: post-publication verification fails.
9. Every targeted mutation of source identity, byte verification, omission handling, routing, and
   release wiring makes the intended scenario red.
10. Pagination truncation, inventory churn, rate/read failure, forged/replayed/expired exemptions,
    closed-snapshot violations, and forbidden fallback inputs fail closed. These scenarios remain
    unimplemented until their failing-then-passing tests exist.

## Anti-corruption layers

- GitHub repository/gist responses become typed upstream observations; API convenience fields never
  become artifact claims.
- RVF generation ledgers become typed artifact receipts only after checksum verification.
- Ingestion and bundle manifests are consumers/projections; they cannot overwrite provenance.
- Release Transaction receives the sealed coverage generation and verdict, never raw mutable stores.

## Evolution log

| Date | Version | Change | Evidence |
|---|---|---|---|
| 2026-08-21 08:10 EDT | 1.2.0 | Added the implemented terminal/third-page read models, exact installed projection behavior, separate plugin/Console/KB lifecycles, and the explicit remaining Proposed boundary. | `plugin/scripts/coverage.mjs`, `plugin/commands/coverage.md`, `console/coverage.html`, `scripts/onboarding-console.mjs`, `scripts/build-bundle.mjs`, `tests/unit/coverage-command.test.mjs`, `tests/unit/coverage-console.test.mjs`. |
| 2026-08-21 05:49 EDT | 1.1.0 | Added signed enumeration, canonical generation, closed snapshot, and exemption invariants to the Proposed aggregate. | ADR-069 adversarial review and `scripts/source-coverage.mjs`. |
