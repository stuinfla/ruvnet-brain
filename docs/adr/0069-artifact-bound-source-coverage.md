---
id: ADR-069
title: Source coverage is artifact-bound, complete, and release-blocking
status: Accepted
date: 2026-08-21
updated: 2026-09-12
version: 1.2.1
reviewed_digest: a33f9708a79d
authors: [Stuart Kerr]
tags: [coverage, corpus, rvf, github, gists, freshness, release]
supersedes: []
relates: [ADR-064, ADR-062, ADR-013]
governs:
  - scripts/brain-stamp.mjs
  - scripts/ingest-new-repos.mjs
  - scripts/ingest-gists.mjs
  - scripts/nightly-wrapper.sh
  - scripts/source-coverage.mjs
  - scripts/release-projection.mjs
  - scripts/build-bundle.mjs
  - scripts/onboarding-console.mjs
  - scripts/console-runtime-identity.mjs
  - console/scope.html
  - console/scope.css
  - console/scope.js
  - data/source-coverage.json
  - docs/RUVNET-COVERAGE.md
  - .github/workflows/ci.yml
  - .github/workflows/gists-nightly.yml
  - .github/workflows/protected-release.yml
  - docs/ddd/0016-source-coverage-context.md
created_at: 2026-08-21T05:32:00-04:00
created_at_source: authored-current
updated_at: 2026-08-21T08:10:43-04:00
updated_at_source: authored-current
---

# ADR-069 — Source coverage is artifact-bound, complete, and release-blocking

**Status**: Proposed

> **Reviewed 2026-09-07 (4.3.10 recovery).** `scripts/release-projection.mjs` now binds the
> assembled runtime ledger to the exact public release ledger and validates coverage before archive
> creation. Public verification requires the exact downloaded artifacts, and native scheduled-update
> proofs retain raw installed coverage after each run. These implemented boundaries still require
> hosted and public execution evidence. They do not establish fresh upstream ingestion; imported
> corpus evidence retains its original provenance and upstream freshness remains UNKNOWN.

> **Reviewed 2026-09-04 (authenticated recovery observation).** Supplying the workflow's read-scoped
> GitHub token changes only release-asset observation reliability. Source enumeration and immutable
> snapshot gaps remain open, so `Proposed` remains accurate.

> **Reviewed 2026-09-04 (4.3.9 recovery).** Pinning the Claude marketplace to the exact candidate
> checkout preserves the already-sealed source identity during public host verification. It does
> not close this ADR's remaining enumeration and source-snapshot gaps; `Proposed` remains accurate.

> **Reviewed 2026-09-04 (4.3.9 candidate).** The protected publication workflow changed only its
> artifact-bound public host-verification transport and failure-receipt retention. It neither adds
> signed source enumeration nor closes the immutable source-snapshot gaps below. `Proposed` remains
> the honest status, and this review is not a source-coverage or publication verdict.

A useful vertical slice is implemented, but the decision's release-proof
contract is not. The generator, JSON/Markdown repository projections, strict candidate-CI call,
bundle projections, installed command, and third Console page exist and have focused tests. Signed
enumeration, a closed immutable candidate snapshot, routing/focused-QA receipts, signed expiring
exemptions, and complete candidate → public artifact → clean install → managed-host generation coherence remain
unproven; implemented transport and validators are not substitutes for completed execution evidence. `Proposed` remains the only honest decision status until those release-blocking
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

## Amendment (2026-09-11) — accepted; the coverage surface is built under the name `scope`; three governed paths never existed

**Status change: Proposed → Accepted (2026-09-11).** The user-facing half of §1 was built and merged today,
tests first (`447bd8a9` RED 13/14 on a stub that read the shipped `status`; `807fbe30`, `d9b631b5`; merged
`1f956632`): `console/scope.html` / `scope.js` / `scope.css` at `/scope`, `GET /api/scope`, and
`gatherScope()` / `computeScope()` in `scripts/onboarding-console.mjs`. It treats the installed
`COVERAGE.json` as canonical exactly as §1 requires, and decides per-row currency by §3 item 1 alone —
`artifact.sourceCommit === upstream.sha` — never by the shipped `status` field, which
`scripts/release-projection.mjs` stamps `CURRENT` on every seeded row regardless of SHA (63 rows measured
`sourceCommit ≠ upstream.sha` under a `CURRENT` label on 2026-09-11). "rUv's last change" is
`upstream.committedAt` for repositories (the default-branch HEAD commit §3 binds to; `pushedAt` and
`updatedAt` were measured to false-flag 2/11 and 11/11 known-current repos) and `updatedAt` for gists;
"the brain read it" is `artifact.ingestedAt ?? RVF-GENERATIONS.stores[x].builtUtc`; the page states
`observedAt` first. Rows the receipts cannot place — 57 repositories with no source commit in either
record — render as a fourth verdict, *in the brain, currency unverified*, never as current.

**Not built:** the terminal command this ADR also named. `plugin/commands/coverage.md` and
`plugin/scripts/coverage.mjs` have never existed in this repository's history (ADR-0013's 2026-09-11 row
established this with `git log --all`); `console/coverage.{html,css,js}` likewise never existed. All five
are removed from `governs:` and replaced by the three real `console/scope.*` files, which is why a
`reviewed_digest` is computable for the first time (the previous value, `REVIEW_DIGEST_PENDING`, was a
literal placeholder, not a digest). §3 items 2–6 and every item under *Acceptance* are the generator's,
the mutation suite's and the release gates' obligations, not the page's; nothing about them changed today
and this amendment does not claim them.

**Recorded, not decided here — a semantic shift in the committed aggregate.** §1 gives the generator's
invocation as `--assets kb`, i.e. the release workspace. Commit `1498a8a6` (2026-09-11) changed the
**bare** default target of `scripts/source-coverage.mjs` from `<repo>/kb` to `storeRoot()` (the installed
brain, per `kb/store-root.mjs`, which declares `<repo>/kb` "never a second brain"), added a hard refusal
when that root was never materialized, kept `--assets` behaviour intact, and regenerated the committed
`data/source-coverage.json` + `docs/RUVNET-COVERAGE.md` against the installed brain (227 repos: 104
CURRENT · 21 STALE · 11 MISSING · 57 UNVERIFIED · 34 INELIGIBLE · 0 byte mismatches; 492 gists: 369
FAILED because the installed gist receipt was sealed 2026-08-26 over 479 gists). Three earlier commits the
same day (`7574a325`, `4bda09b3`, `e2b9e4df`) had committed bare-run observations of a dirty workspace
(476 FAILED). The committed aggregate therefore now describes the installed store root, while §1's prose
still calls it "the machine-readable repository aggregate" produced with `--assets kb`. Which of the two
this ADR means is the owner's decision; this review records the divergence and changes neither the prose
of §1 nor the code.

## Currency log
| 2026-09-12 | Currency review at commit d49128d5: decision unchanged and enforced one level deeper. `release-qe` failed on 740752c5 and 7b472440 with "legacy gist aggregate receipt is malformed or has the wrong gist set": the observation moved 479 → 492 gists (13 published 2026-08-27..2026-09-10) while the sealed v4.2.1 seed and `kb/ruv-gists.sources.json` carry 479, and `createReleaseProjection` scoped gists only by `ruv-gists.big.rvf` being present, so 13 unseeded gists were projected CURRENT — a false artifact binding, which is exactly what this ADR forbids. Gist rows are now scoped to the sealed receipt's id set the way repository rows are scoped to present stores; unseeded gists stay UNVERIFIED in CORPUS-COVERAGE.json and never enter the release rows. Receipt not regenerated; validator unchanged. | Reviewed `scripts/release-projection.mjs` (`d49128d5`, the only governed path that moved), `tests/unit/assembled-release-projection.test.mjs` (RED with the production message on the prior code, GREEN now; real observation 492 → 479 projected, directory valid). reviewed_digest e939d38301f3. |
| 2026-09-11 | Currency review at commit 7296c984 — status Proposed → Accepted; the decision is partially built; see the amendment above. `scripts/source-coverage.mjs` `1498a8a6` (bare default → `storeRoot()`, `--assets` intact, refusal on a never-materialized root); `data/source-coverage.json` and `docs/RUVNET-COVERAGE.md` regenerated against the installed brain in the same commit (earlier bare-run commits `7574a325` / `4bda09b3` / `e2b9e4df` had projected a dirty workspace as 476 FAILED); `scripts/onboarding-console.mjs` gained `gatherScope` / `computeScope` and `GET /api/scope` (`807fbe30`) beside the seven card fixes; `console/scope.html` / `.js` / `.css` created (`d9b631b5`; tests first at `447bd8a9`; merged `1f956632`). `governs:` corrected — five never-existing paths removed, the three real `console/scope.*` files added — which is why this is the first computable digest (`REVIEW_DIGEST_PENDING` was a literal). Not built: the terminal command. Recorded, not resolved: the committed aggregate now observes the installed root while §1 still describes `--assets kb`. `scripts/brain-stamp.mjs`, `ingest-new-repos.mjs`, `ingest-gists.mjs`, `nightly-wrapper.sh`, `release-projection.mjs`, `build-bundle.mjs`, `console-runtime-identity.mjs`, the three workflows and DDD-0016 did not move. | Reviewed `scripts/source-coverage.mjs`, `data/source-coverage.json`, `scripts/onboarding-console.mjs`, `console/scope.html`, `console/scope.js`; cross-referenced ADR-0013. reviewed_digest 499a9049e6a1. |
| 2026-09-12 | Currency review at commit 40d8c16b: decision unchanged, and its coverage surface grew as the owner asked — the scope page now offers Newest first / A–Z / Behind first, a search that matches what a repo does (from the installed `capability-cards.md`, the only per-repo description that ships to a customer machine; `data/ruvnet-registry.json` is repo-side and never installs — measured), and states its purpose in one line. The verdict logic (`sourceCommit === upstream.sha`, `committedAt` / `ingestedAt`, never the shipped status word) is byte-for-byte the same. | Reviewed `console/scope.html`, `console/scope.js`, `console/scope.css`, `scripts/onboarding-console.mjs` (`40d8c16b`, diffs read in full); tests `tests/unit/console-scope.test.mjs` (+5) and `tests/unit/console-scope-client.test.mjs` (new). reviewed_digest fcdae3e26891. |
| 2026-09-11 | Currency review at commit 2eef2024: decision unchanged on every resolvable governed path; a computed `reviewed_digest` remains structurally impossible while this ADR stays Proposed. None of `scripts/{brain-stamp,ingest-new-repos,ingest-gists,source-coverage,release-projection,build-bundle,onboarding-console,console-runtime-identity}.mjs` moved in this range. `data/source-coverage.json` and `docs/RUVNET-COVERAGE.md` changed twice (`e7accccd`, `a52a5ddd`) but both are pure generated-data regenerations with zero script-code changes alongside them — the coverage machinery producing its normal output, not a decision change. The three workflow YAMLs gained only lane/scheduling additions. `governs:` still names 5 paths that have never existed in git history (`plugin/commands/coverage.md`, `plugin/scripts/coverage.mjs`, `console/coverage.{html,css,js}` — see ADR-013's 2026-09-11 row, which had wrongly duplicated the first two); `computeDigest()` refuses to hash a manifest with an unresolvable member, so `reviewed_digest` correctly stays `REVIEW_DIGEST_PENDING` rather than a fabricated value, and this document's `presumed-stale` finding will keep BLOCKING until those 5 paths are built or removed from `governs:` — that is this tool's designed fail-closed behavior for a Proposed ADR governing unbuilt artifacts, not an unreviewed document. | Read the combined `git log --stat` for all 11 drift commits against the 15 resolvable governed paths; confirmed zero script-file changes outside the two generated-data files and three CI workflow files. | `scripts/release-projection.mjs`; source review does not claim full upstream freshness or public acceptance. |
| 2026-08-31 | Re-read after the release-control cutover; the nightly wrapper still runs convergence checks, but the watchdog is now report-only and cannot dispatch a publisher or bypass the signed release coordinator. | `scripts/nightly-wrapper.sh`; `scripts/release-convergence-watchdog.mjs`; `.github/workflows/release-cycle.yml`; commit `e2e83c0`. |
| 2026-08-31 | Reconciled the watchdog's Windows command boundary after hosted PR evidence showed shell:false cannot assume an `npx` shim; the unit lane now invokes Vitest through Node while retaining the same full suite. | `.github/workflows/ci.yml`; `scripts/ci/step-watchdog.mjs`; PR #211. |
| 2026-08-31 | Reconciled after the main-branch merge and CI watchdog change; source coverage remains bound to the exact candidate artifact, while hosted long stages now emit bounded receipts. | `scripts/ci/step-watchdog.mjs`; `.github/workflows/ci.yml`; exact-SHA CI run `33358984585`. |

| 2026-08-30 | Re-read after `abc1731` changed oracle source binding for squash-merged candidates; source coverage remains artifact-bound and the fetched source commit must still match its content digest. | `scripts/retrieval-canary.mjs`, `scripts/public-verification-inputs.mjs`, `.github/workflows/ci.yml`. |

| 2026-08-30 | Release projection now retains seed-present excluded repository rows, includes derived stores in the public ledger, and supplies projection receipts before inventory validation. This closes the exact-SHA release-QE mismatch observed in the candidate build. | `scripts/release-projection.mjs`, `scripts/build-bundle.mjs`, `plugin/scripts/coverage-integrity.mjs` |
| 2026-08-30 | Canonical CI now runs on pull requests targeting `main`, so release-QE and the other exact-SHA gates run before merge instead of only after the merge push. | `.github/workflows/ci.yml` |
| 2026-08-30 | Projected seed validation now imports the canonical private-store fence into its temporary validation root; the public seed remains immutable and cannot be mistaken for the policy source. | `scripts/build-bundle.mjs`; `kb/PRIVATE-STORES.json`; exact-SHA release-QE. |
| 2026-08-30 | Release projection now recomputes projected status totals and enumeration counts while preserving the full source-observation digest in `CORPUS-COVERAGE.json`. | `scripts/release-projection.mjs`; `plugin/scripts/coverage-integrity.mjs`; exact-SHA release-QE. |
| 2026-08-30 | The projected gist receipt is staged into the second-stage validation root before inventory validation, so projection and archive partition hashes include the same in-tree evidence. | `scripts/release-projection.mjs`; `scripts/build-bundle.mjs`; exact-SHA release-QE. |
| 2026-08-30 | Replayed the complete projection-to-archive boundary locally; both roots now produce the identical public inventory partition hash. | `scripts/release-projection.mjs`; `scripts/build-bundle.mjs`; local two-stage proof `566fe4f5bb435f11c8a924a8cef9b8c251c508051653121f39e7533536455daf`. |

| 2026-08-30 | Rechecked artifact-bound source coverage after release-QE separated current observation from the immutable seed; projection and bundle assembly now bind the correct evidence plane and source policy registry. | `scripts/release-projection.mjs`; `scripts/build-bundle.mjs`; `data/source-coverage.json`; exact-SHA release-QE. |

| 2026-08-30 | Clarified the two coverage planes: the complete source observation remains immutable evidence, while release `COVERAGE.json` is projected from actual seed RVFs and byte-bound generation records. | Issue #201; `scripts/source-coverage.mjs`; `scripts/release-projection.mjs`; `.github/workflows/ci.yml`. |

| 2026-08-30 | Re-read the governed source-coverage and release-boundary files after the convergence-manifest and public-verification wiring changes. The broader signed coverage projection remains explicitly unbuilt; the manifest records that status instead of implying completion. | `9f3cb36`, `scripts/convergence-manifest.mjs`, `.github/workflows/ci.yml`; no absent coverage command or projection was reintroduced. |

| 2026-08-30 | The CI process now uses a bounded canonical QA runner while preserving source-coverage work as an explicit release/nightly concern. | `.github/workflows/ci.yml`, `scripts/qa-runner.mjs`, and `docs/QA-RELEASE-PROCESS.md` keep coverage evidence tied to the candidate rather than silently treating unrelated PR checks as release proof. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-26 | `scripts/brain-stamp.mjs`'s `builtFromSha` now prefers `kb/RVF-GENERATIONS.json`'s recorded `sourceCommit` over the local clone's live HEAD, via a new pure `scripts/brain-stamp-resolve.mjs` helper; falls back to live HEAD only when no generation record exists. Does not itself satisfy this ADR's still-unbuilt signed enumeration, closed snapshot, or `data/source-coverage.json` generator. | Dream Cycle 2026-08-26 (issue #175) confirmed live the exact "clone freshness is not artifact freshness" gap this ADR's 2026-08-21 audit named against `scripts/brain-stamp.mjs`: the repo's own committed `kb/RVF-GENERATIONS.json` already disagreed with a live-HEAD read for `synthlang` (`sourceCommit` `69599563...`) and `autogenous` (`sourceCommit` `b5c6e838...`), the same two repos this ADR's Context section cites. |
| 2026-08-21 | Re-read the emergency release rail and kept the broader source-coverage system explicitly unbuilt. | `.github/workflows/ci.yml` does not call the absent `scripts/source-coverage.mjs` or claim its absent projections. It uses the committed immutable seed identity plus strict repaired generation receipts to restore service; this ADR's complete coverage generator remains deferred. |
| 2026-08-21 | Corrected the earlier implementation claim: the coverage command and Console projection remain planned, not shipped. | The named `plugin/commands/coverage.md`, `plugin/scripts/coverage.mjs`, and Console coverage files do not exist in this candidate. The emergency release implements corpus-seed and ledger identity only; the broader coverage read model remains Proposed and is explicitly deferred until after service is restored. |
| 2026-08-21 | Re-read the governed release paths after emergency corpus convergence. | `scripts/build-bundle.mjs` now fails closed on seed/ledger byte and metadata disagreement and `.github/workflows/ci.yml` consumes an exact sealed seed. This advances the artifact boundary but does not satisfy this ADR's unbuilt UI, exemptions, or full coverage-report contract. |
| 2026-08-21 | Added signed enumeration, canonical generation input, closed-snapshot, and first-generation exemption contracts; implementation remains pending. | Fable 5 and GPT-5.6-Sol adversarial review found pagination proof, exact digest inputs, exemption lifecycle, and a non-deadlocking bootstrap were not observable in the initial proposal. |
| 2026-08-21 | Initial artifact-bound coverage decision. | The live audit of `scripts/brain-stamp.mjs`, `kb/RVF-GENERATIONS.json`, `scripts/ingest-gists.mjs`, and the installed cache proved false-current repository rows, missing source receipts, a stale installed gist corpus, and no human-readable coverage ledger. |
