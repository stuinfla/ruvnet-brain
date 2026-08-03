---
id: ADR-062
title: Remote-durable staged release transaction
status: Accepted
date: 2026-08-02
updated: 2026-08-02
authors: [Stuart Kerr]
tags: [release, evidence, transaction, npm, github, receipts, recovery]
supersedes: []
relates: [ADR-053, ADR-058]
governs:
  - .github/workflows/ci.yml
  - .github/workflows/stranger-matrix.yml
  - .github/workflows/protected-release.yml
  - scripts/release.mjs
  - scripts/release-transaction.mjs
  - scripts/release-transaction-provider.mjs
  - scripts/staged-host-verifier.mjs
  - docs/ddd/0015-release-transaction-context.md
---

# ADR-062 — Remote-durable staged release transaction

**Status**: Accepted

**Date**: 2026-08-02

## Context

Issue #77 proved that a cross-provider release can expose a new GitHub generation while npm and
installed hosts remain on the old generation. The existing protected release rail now binds a
candidate to an exact SHA and stores a local `dist/release-transaction.json`, but the reopening of
#77 identifies four remaining gaps:

1. local transaction state is lost with the runner;
2. GitHub and npm default channels are changed without first staging both providers;
3. interruption at a promotion boundary is not exhaustively recoverable;
4. convergence evidence does not exercise the actual Claude and Codex host interfaces as part of
   the transaction commit.

GitHub drafts are visible only to authorized writers and can carry release assets. npm publication
under an explicit non-default tag makes immutable package bytes installable without changing
`latest`. Provider calls cannot be atomic with each other, so correctness must come from a durable,
idempotent state machine rather than call ordering alone.

## Decision drivers

- No supported client observes B until B has passed candidate and host gates.
- A clean runner can resume B from remote evidence alone.
- Every provider call is preceded by a durable write-ahead intent and followed by observed-state
  reconciliation.
- Replays are idempotent and bind `version + tag + SHA + npm integrity + bundle digest`.
- A pending B blocks B+1.
- Local files and workflow logs are caches/evidence, never release authority.
- Tests use provider fakes; no test may create drafts, tags, packages, or dist-tag changes.

## Evidence DAG implementation (2026-08-02)

Candidate CI now packs the npm tarball exactly once, before release QE, and identifies those bytes
by SHA-256 in the candidate receipt. Release QE and the five stranger-host cells consume that same
uploaded tarball; no host repacks the checkout. The protected publisher downloads the receipt and
sealed bytes, rechecks their SHA/version/digest identity at the Production boundary, and passes the
tarball unchanged into the staged npm/GitHub transaction.

Source tests, unit tests, version/wiring checks, and exact-SHA CI proof are candidate-builder
responsibilities. The publisher does not rerun them, recheck a weaker "latest CI" verdict, or push
main. It performs only the receipt boundary, signed bundle assembly, staged host acceptance,
promotion, one public-channel verification, and final publication receipt. Any source change creates
a new SHA and therefore a new candidate artifact instead of restarting unrelated publisher gates.

## Considered approaches

### 1. GitHub Actions artifact as transaction authority

Advantages: already produced by CI, immutable per upload, straightforward workflow wiring.

Rejected as the sole authority: artifacts expire and are tied to a workflow run. They remain useful
append-only evidence, but expiry or run deletion must not make a pending release unrecoverable.

### 2. Dedicated branch/ref containing transaction records

Advantages: durable Git object history and natural compare-and-swap semantics.

Rejected: it creates a second mutable release control plane, requires commits unrelated to product
source, and complicates branch protection and publisher authority.

### 3. Draft GitHub release plus transaction asset (chosen)

The draft is already the GitHub staging object for the exact tag/SHA. A canonical
sequence-named `release-transaction-<sequence>.json` assets make that object the recovery anchor.
npm stages the immutable version under `candidate-v<version>` (never `latest`). CI artifacts retain append-only copies of
the staged and final receipts for audit.

Receipts are create-only, Ed25519-signed, hash-chained, and carry a monotonic sequence plus fencing
token. The publisher downloads and verifies the just-written asset before crossing the next
boundary. A duplicate sequence or stale fence loses ownership and performs no further mutation.
Recovery accepts only the highest valid chain for the same immutable identity; conflicting identity,
signature, chain, or regressed state fails closed.

## Transaction protocol

### Identity

`transactionId = sha256(version | tag | candidateSha | packageSha512 | bundleSha256)`.

Every state and provider observation repeats those fields. Any mismatch is a collision, not a new
attempt.

### Prepare

1. Verify synchronized manifests, exact candidate SHA CI, sealed npm tarball, signed bundle, and
   candidate receipt.
2. Under one repository-wide publisher lock, discover all draft/published release anchors and npm
   candidate tags. A pending different identity blocks B. Duplicate/orphan drafts for B are adopted
   only when their tag/SHA identity is exact and unambiguous; otherwise the run fails without mutation.
3. Create or adopt a GitHub **draft** explicitly targeting the candidate SHA. This does not advance
   `releases/latest`.
4. Upload signed assets and the initial signed remote transaction receipt; download and verify it.
5. Verify Claude-only, Codex-only, and dual-host fixtures from digest-addressed local sealed package
   and bundle files through the supported host interfaces; no public release lookup is used. Record
   that local result separately from remote staging evidence.
6. Write `npm-stage-intent`, then publish the sealed tarball with the non-default
   `candidate-v<version>` tag. Observe registry version, integrity, and candidate tag; record
   `npm-candidate-staged`.
7. Re-download the candidate tarball through npm and all bundle assets through the authenticated
   GitHub draft API, verify their identity digests, then re-run the three fixtures. Record `prepared` only
   when both staged providers reproduce the same host receipt. A fresh Codex fixture may report
   `PENDING_REVIEW` only when the real doctor proves the exact plugin installed and names explicit
   lifecycle-hook trust as its sole nonzero condition; every other nonzero doctor result fails.

If any prepare step fails, GitHub remains a draft and npm `latest` remains A. An npm version is
immutable, so compensation is reconciliation: retain the candidate tag for B and resume or mark the
draft failed; never reuse B for different bytes.

### Promote

1. Record `github-promote-intent`; publish the verified draft with `make_latest=false`.
2. Observe tag-to-SHA, non-latest status, and release assets; record `github-promoted-nonlatest`.
3. Record `npm-promote-intent`; move npm `latest` to the already-observed B bytes.
4. Observe npm `latest`; record `npm-promoted`.
5. Record `github-latest-intent`; make the exact published B release latest, observe it, and record
   `defaults-promoted`.
6. Publish the signed current-release manifest/receipt, run the immediate surface probe, re-run
   actual Claude/Codex doctor interfaces, and record `channels-converged` only after all agree.

If non-latest GitHub promotion succeeds and npm promotion fails, retry B; supported defaults remain
A. If npm promotion succeeds while GitHub remains draft/non-latest, compensate npm `latest` back to
the receipt's captured A only after re-observing that `latest` still equals B. Any third identity is a
race and becomes `manual-intervention-required`, never a blind rollback. A poisoned immutable B may
enter signed, explicitly human-authorized terminal `aborted`; automation cannot abort or reuse B.

### Recovery

- Discover the unique draft/published release whose transaction asset identifies B.
- Reconcile provider observations before trusting the recorded state; an intent may have completed
  even if the process died before its completion receipt.
- Continue the same B only. A different pending identity blocks the run.
- A step is skipped only when provider state proves its exact postcondition.
- `doctor` fails for every state other than `channels-converged` and prints the same-candidate resume
  command plus any required host restart/review action.
- Publisher doctor uses authenticated draft receipts; user doctor trusts only the public signed
  current-release receipt and reports an unpublished transaction as unknown rather than healthy.

## Invariants

1. One canonical publisher owns all release/default-channel mutations.
2. No remote/default mutation occurs before exact-SHA candidate proof.
3. The first remotely durable receipt exists before npm publication or GitHub publication.
4. GitHub draft and npm candidate tag never count as the supported current generation.
5. Receipt state is monotonic; identity is immutable.
6. Every non-idempotent boundary has a write-ahead intent and an observed postcondition.
7. `channels-converged` requires the signed final receipt, live surfaces, and actual managed-host
   interface receipts.
8. A disabled plugin stays disabled; changed hooks remain pending explicit host review; a live
   Console is either restarted onto B or reported `pending-console-restart`.
9. One constant workflow concurrency group plus remote fencing serializes all versions.
10. Ordinary open issues are not release authority; only maintainer-governed release-blocker
    metadata blocks publication.

## Consequences

- Release code gains a small domain state machine and provider adapter boundary.
- The protected workflow must retain both staged and final receipts even on failure.
- A failed release may leave an unpublished GitHub draft and an immutable npm candidate version.
  This is deliberate evidence, not debris to overwrite.
- Cross-provider atomicity remains impossible, but no incomplete B is called current and every
  partial promotion has a deterministic compensation/resume path.
- Exact final-version npm staging can be selected by semver-range consumers even under a non-default
  tag. The supported-client invariant covers bare/`latest` and explicit-version Brain installs; the
  receipt and doctor surface the unavoidable registry visibility rather than claiming isolation.

## Authoritative references

- GitHub Releases and drafts: https://docs.github.com/en/rest/releases/releases
- GitHub release assets: https://docs.github.com/en/rest/releases/assets
- npm candidate tags and immutable package versions: https://docs.npmjs.com/cli/publish/
- npm dist-tags: https://docs.npmjs.com/adding-dist-tags-to-packages/
- Domain model: `docs/ddd/0015-release-transaction-context.md`
