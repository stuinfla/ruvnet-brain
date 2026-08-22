---
id: ADR-069
title: Source coverage is artifact-bound, complete, and release-blocking
status: Proposed
date: 2026-08-21
updated: 2026-08-22
authors: [Stuart Kerr]
tags: [coverage, corpus, rvf, github, gists, freshness, release]
supersedes: []
relates: [ADR-064, ADR-062]
governs:
  - scripts/brain-stamp.mjs
  - scripts/ingest-new-repos.mjs
  - scripts/ingest-gists.mjs
  - scripts/nightly-wrapper.sh
  - scripts/source-coverage.mjs
  - scripts/build-bundle.mjs
  - scripts/onboarding-console.mjs
  - scripts/console-runtime-identity.mjs
  - plugin/commands/coverage.md
  - plugin/scripts/coverage.mjs
  - console/coverage.html
  - console/coverage.css
  - console/coverage.js
  - data/source-coverage.json
  - docs/RUVNET-COVERAGE.md
  - .github/workflows/ci.yml
  - .github/workflows/gists-nightly.yml
  - .github/workflows/protected-release.yml
  - docs/ddd/0016-source-coverage-context.md
created_at: 2026-08-21T05:32:00-04:00
created_at_source: authored-current
updated_at: 2026-08-22T12:15:00-04:00
updated_at_source: authored-current
---

# ADR-069 — Source coverage is artifact-bound, complete, and release-blocking

**Status**: Proposed

A useful vertical slice is implemented, but the decision's release-proof
contract is not. The generator, JSON/Markdown repository projections, strict candidate-CI call,
bundle projections, installed command, and third Console page exist and have focused tests. Signed
enumeration, a closed immutable candidate snapshot, routing/focused-QA receipts, signed expiring
exemptions, and candidate → public artifact → clean install → managed-host generation coherence are
still unimplemented. `Proposed` remains the only honest decision status until those release-blocking
acceptance paths pass against the actual artifact.

**Date**: 2026-08-21

## Context

The owner needs one visible answer to two questions: *is every rUv repository and public gist
accounted for?* and *does the installed Brain contain bytes built from the latest upstream version?*

At the start of the 2026-08-21 audit no `COVERAGE.md` existed. A generated repository page and
installed projections now exist; this history remains the reason they cannot be generated from
`data/manifest.json`. `scripts/brain-stamp.mjs` read each local clone's current `HEAD` and wrote it as
`builtFromSha` whenever an RVF file existed. Clone freshness is not artifact freshness. The audit
proved the resulting false-current class:

- `autogenous`: upstream/manifest `9215c747…`; checksum-bound RVF receipt `b5c6e838…`.
- `SynthLang`: upstream/manifest `cf16b421…`; checksum-bound RVF receipt `69599563…`.
- Across 175 public, non-fork, non-empty repositories, only 24 were artifact-proven current; 2 were
  proven stale; 148 were unverified because the RVF receipt lacked a source commit; 1 was missing or
  barren. Unverified is not current.
- The installed cache held 187 canonical RVFs while its installed manifest claimed 62; four installed
  stores failed ledger/byte reconciliation. Its installed gist RVF also lagged the candidate gist
  corpus and disagreed with its ledger hash.

The absence of a Markdown page is therefore a symptom. Generating a page from the existing manifest
would make the false claim easier to read.

## Decision

### 1. One artifact-bound coverage aggregate

`data/source-coverage.json` is the machine-readable repository aggregate.
`docs/RUVNET-COVERAGE.md`, the bundle's `COVERAGE.json`/`COVERAGE.md`, and the installed cache's
`COVERAGE.json`/`COVERAGE.md` are deterministic projections of that same aggregate. They never
maintain independent facts. The build creates both bundle projections; installation extracts those
exact files rather than regenerating one from the other. Runtime readers treat installed
`COVERAGE.json` as canonical.

The generator is `scripts/source-coverage.mjs`:

```bash
node scripts/source-coverage.mjs --owner ruvnet --assets kb --write
node scripts/source-coverage.mjs --owner ruvnet --assets kb --check --strict
```

### 2. Every upstream object appears exactly once

Every public repository appears in the ledger, including forks, archived repositories, and empty
repositories. Ineligible objects receive an explicit evidence-bound disposition; they are not
silently filtered out. Every public gist appears by immutable gist ID and current gist version SHA.

Enumeration produces a signed `EnumerationReceipt` binding owner, request parameters, every page or
cursor response digest, immutable object IDs, duplicate detection, profile repository/gist counts,
terminal no-next-page evidence, observation interval, and read/rate-limit results. Concurrent
upstream churn causes a bounded full retry; exhaustion yields one `UNVERIFIED` generation, never a
partial seal.

### 3. Freshness follows the bytes

Repository `CURRENT` requires all of:

1. observed upstream HEAD SHA equals the RVF generation receipt's `sourceCommit`;
2. the RVF family bytes match the receipt's SHA-256 values;
3. no unexpected source paths are missing;
4. a capability card exists and a routing probe reaches the store;
5. focused corpus QA passes;
6. the observation and artifact identities are bound to this coverage generation.

Gist `CURRENT` additionally requires the observed gist version SHA and complete file inventory to
equal the ingestion receipt, with every included file content-bound. Truncated GitHub API payloads
must be fetched through their `raw_url`; a failed raw fetch is not an omission exemption.

Any missing evidence is `UNVERIFIED`. Other explicit states are `STALE`, `MISSING`, `DARK`,
`INELIGIBLE`, and `FAILED`. No error path returns `CURRENT`.

`coverageGeneration` is exactly:

```text
sha256(JCS({
  schemaVersion, generatorSourceSha, snapshotRoot, orderedRows,
  enumerationReceiptDigest, policyDispositionDigests, exemptionDigests
}))
```

Rows carry exact path inventories and counts, receipt/byte digests, routing-probe receipt digests,
focused-QA result digests, policy evidence, and reasons; summary booleans are not proof.

The immutable candidate snapshot is a closed set of contained regular files. Every expected RVF
family, ledger, card, projection, and receipt must exist and match its digest; symlinks, unexpected
stores, or missing files fail. Build/publication cannot fall back to a prior manifest/release,
installed cache, mutable store, or network reconstruction.

### 4. Coverage is a release input and post-install receipt

Strict coverage runs after refresh/ingestion, during candidate CI, before protected publication,
against the public downloaded bundle, and after installation into the managed Claude and Codex
hosts. Candidate, published, and installed ledgers must name one generation and identical artifact
digests. A stale, missing, dark, failed, or unverified eligible object blocks publication.

Nightly ingestion may be bounded for cost, but the nightly and release gates may not swallow its
failure or describe an incomplete pass as level with upstream. The release candidate waits until the
backlog is zero or each row has an approved evidence-bound exemption.

Exemptions are signed by keys frozen into the generation and bind object, precise failure, reason,
generation, evidence digest, and hard expiry. Omission never renews one. Expiry is evaluated for B at
every candidate/publication/public-artifact/managed-host/terminal gate, while A's historical
validity remains fixed at A's own convergence time. The first ADR-069 release may use one signed,
expiring bootstrap exemption generation for the audited pre-existing unverified rows; it is visible
per row and cannot be silently carried into the next generation.

### 5. Human-readable columns

The repository table includes upstream SHA/date, ingested SHA/date, artifact digest/generation,
routing/QA status, final state, and reason. The gist table includes gist ID/version/date, file counts
and exclusions, content/artifact digests, ingested version/date, generation, state, and reason.
The document header records observation time, generator source SHA, eligible/current/stale/missing/
dark/unverified totals, and the exact command that verifies it.

### 6. User surfaces and lifecycle

Coverage has two read-only installed projections and no independent database:

- `/ruvnet-brain:coverage` is declared by `plugin/commands/coverage.md` and executes the installed
  `plugin/scripts/coverage.mjs`. The host freezes command declarations with its plugin generation,
  so first discovery of this command follows the normal plugin reload/new-session lifecycle. The
  executable resolves and reads managed `kb/COVERAGE.json` on every invocation, so later knowledge
  bundle coverage changes do not require another command declaration or a remembered checkout.
- The Console's third page (`console/coverage.html`) calls `GET /api/coverage` on the existing local
  Console server. `gatherSourceCoverage()` prefers installed `COVERAGE.json`, accepts the historical
  `source-coverage.json` filename only for compatibility, validates schema/generation/row counts,
  and reports unavailable on failure. It never converts missing proof into zero coverage.

The page participates in the persistent Console runtime transaction because the complete
`console/` directory is part of `CONSOLE_RUNTIME_SURFACE` and its digest. The ledger does not: it
remains in the independently updated installed KB and is read at request time. This preserves one
Console runtime and one coverage aggregate while allowing code and knowledge to update on their own
existing tracks.

These surfaces are implemented. They expose the current ledger honestly; they do not by themselves
prove the still-Proposed signed enumeration and end-to-end release transaction above.

## Rejected alternatives

- **Generate Markdown from `data/manifest.json`:** rejected because clone HEAD can falsely overwrite
  artifact provenance.
- **List only eligible repositories:** rejected because omission is indistinguishable from a missed
  discovery.
- **Treat timestamps as freshness:** rejected because clock equality does not bind source to bytes.
- **Report drift but keep releases green:** rejected because that recreates the embarrassing state
  this decision exists to prevent.
- **Build directly from a mutable canonical store:** rejected because concurrent refresh can create a
  mixed generation; candidate assets come from one immutable, verified snapshot.

## Acceptance

- Live GitHub repository and gist inventories are captured without truncation and every object is
  represented exactly once.
- Clone HEAD mutation cannot alter an artifact's ingested SHA.
- Missing receipt, digest mismatch, stale SHA, dark store, missing gist file, or probe failure makes
  strict mode nonzero and produces the correct explicit state.
- Markdown and JSON counts, identities, and statuses match exactly.
- Candidate, public bundle, clean install, and managed-host ledgers are byte/generation coherent.
- Mutants that trust clone HEAD, drop unverified rows, skip gist raw-file recovery, ignore digest
  mismatch, or remove the release gate are killed.
- Pagination truncation, concurrent inventory churn, rate/read failure, forged/replayed/expired
  exemptions, symlink/unexpected-store injection, and fallback to prior release/cache/network inputs
  are mutation-tested. These scenarios remain unimplemented until a failing-then-passing test exists.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-22 | Required the protected publisher to validate both independent reviews against the exact coverage-derived retrieval plan before mutation. | Commit `f06624a` passes the sealed `release-evidence/retrieval-canary-plan.json` into the pair verifier and adds an ordering assertion before `release.mjs --publish`. The verifier's S-10 per-row relevance implementation and real source-bound oracle remain absent, so artifact-bound coverage acceptance is still Proposed and release-blocking. |
| 2026-08-22 | Re-read the implemented coverage receipts, corpus-input reconciliation, and protected-release handoff at convergence tip `ddae606`; they strengthen source binding without completing this ADR's missing human projection or live enumeration proof. | `578fbab`, `510e3bf`, `91cfbb9`, `efcaedc`, `41b2c12`, and `17fe54b` add content-bound coverage/retrieval evidence and stable source/gist reconciliation. `4a901d6` carries `COVERAGE.json` and the retrieval-canary plan through the sealed publisher artifact. The named Console/command surfaces and real upstream pagination/public-byte acceptance remain absent, so this ADR stays Proposed and partially unbuilt. |
| 2026-08-22 | Isolated every implemented source-coverage mutation from the primary checkout; broader coverage acceptance remains Proposed. | `ingest-new-repos.mjs --apply` and `self-update.mjs --apply` share `scripts/worktree-integrity.mjs`, which accepts only a clean linked worktree outside the primary. The retired `com.ruvnet.brain-nightly` scheduler and plist are gone; a manual author wrapper additionally verifies that primary HEAD/index/tracked/untracked state is unchanged. This closes the dirty-checkout transport defect, not this ADR's still-unbuilt signed enumeration, exemption, UI, or public-artifact coherence requirements. |
| 2026-08-21 | Re-read the emergency release rail and kept the broader source-coverage system explicitly unbuilt. | `.github/workflows/ci.yml` does not call the absent `scripts/source-coverage.mjs` or claim its absent projections. It uses the committed immutable seed identity plus strict repaired generation receipts to restore service; this ADR's complete coverage generator remains deferred. |
| 2026-08-21 | Corrected the earlier implementation claim: the coverage command and Console projection remain planned, not shipped. | The named `plugin/commands/coverage.md`, `plugin/scripts/coverage.mjs`, and Console coverage files do not exist in this candidate. The emergency release implements corpus-seed and ledger identity only; the broader coverage read model remains Proposed and is explicitly deferred until after service is restored. |
| 2026-08-21 | Re-read the governed release paths after emergency corpus convergence. | `scripts/build-bundle.mjs` now fails closed on seed/ledger byte and metadata disagreement and `.github/workflows/ci.yml` consumes an exact sealed seed. This advances the artifact boundary but does not satisfy this ADR's unbuilt UI, exemptions, or full coverage-report contract. |
| 2026-08-21 | Added signed enumeration, canonical generation input, closed-snapshot, and first-generation exemption contracts; implementation remains pending. | Fable 5 and GPT-5.6-Sol adversarial review found pagination proof, exact digest inputs, exemption lifecycle, and a non-deadlocking bootstrap were not observable in the initial proposal. |
| 2026-08-21 | Initial artifact-bound coverage decision. | The live audit of `scripts/brain-stamp.mjs`, `kb/RVF-GENERATIONS.json`, `scripts/ingest-gists.mjs`, and the installed cache proved false-current repository rows, missing source receipts, a stale installed gist corpus, and no human-readable coverage ledger. |
