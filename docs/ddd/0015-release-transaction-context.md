Updated: 2026-08-02 20:59:00 EDT | Version 1.1.0
Created: 2026-08-02 20:10:00 EDT

# DDD-0015 — The Release Transaction bounded context

Governs: ADR-062 · Issue #77 · `scripts/release.mjs`

## Purpose and boundary

The Release Transaction context converts one sealed candidate into one supported product
generation across GitHub, npm, Claude, Codex, Stable Spine, and Console. It owns provider staging,
promotion, compensation, and receipts. It does not build the corpus, choose a version, modify source,
or authorize publication.

## Ubiquitous language

| Term | Exact meaning |
|---|---|
| **Candidate** | Immutable B identity: version, tag, exact source SHA, npm integrity, and bundle digest. |
| **Prior generation** | The observed supported A identity captured before promotion. |
| **Draft anchor** | GitHub draft for B containing signed assets and the remote transaction receipt. |
| **Candidate channel** | npm `candidate-vB`; it resolves B without moving `latest`. |
| **Intent** | Durable receipt written before a provider boundary, naming the exact attempted transition. |
| **Observation** | Provider state read after a call or on recovery; success depends on observation, not exit text. |
| **Prepared** | Draft assets, npm candidate bytes, and all isolated host fixtures agree on B. Defaults remain A. |
| **Promoted** | A provider default has moved to B; this is partial until the final manifest and all surfaces converge. |
| **Compensated** | A default channel was restored to captured A after unsafe promotion order/failure. |
| **Committed** | Signed current-release receipt names B and every live/host check agrees; state is `channels-converged`. |

## Aggregate

`ReleaseTransaction` is the aggregate root. Its identity and signed, hash-chained event sequence are
immutable. Sequence-named GitHub draft assets are authoritative remote state; local JSON is a disposable cache; workflow
artifacts are append-only audit evidence.

### Entity: CandidateIdentity

- `transactionId`
- `version`, `tag`, `candidateSha`
- `packageSha512`, `bundleSha256`
- sealed package/bundle asset names

### Entity: ProviderSnapshot

- prior GitHub latest tag/SHA and npm latest version
- draft id, draft flag, tag target, asset digests
- npm candidate/latest tag targets and registry integrity
- signed current-release manifest identity

### Value object: HostConvergence

- `claude`, `codex`, and `dual` fixture verdicts
- Stable Spine generation
- plugin installed/enabled state
- hook review requirement
- Console state (`ready` or `pending-console-restart`)

## State machine

| State | Meaning | Allowed next states |
|---|---|---|
| `initialized` | Candidate proof valid locally; no remote authority yet. | `remote-prepare-intent` |
| `remote-prepare-intent` | Draft creation identity is fixed. | `remote-prepared` |
| `remote-prepared` | Draft anchor and verified receipt exist. | `asset-upload-intent` |
| `asset-upload-intent` | Create-only staged asset upload is write-ahead recorded. | `host-verification-intent` |
| `host-verification-intent` | Digest-bound local candidate host verification is pending. | `local-hosts-verified` |
| `local-hosts-verified` | Local sealed bytes pass all host fixtures. | `npm-stage-intent` |
| `npm-stage-intent` | Candidate publish is write-ahead recorded. | `npm-candidate-staged` |
| `npm-candidate-staged` | Registry proves B under non-default tag. | `remote-host-verification-intent` |
| `remote-host-verification-intent` | Exact bytes must be re-downloaded from both staged providers. | `prepared` |
| `prepared` | Draft, npm candidate, and host fixtures agree; defaults are A. | `github-promote-intent` |
| `github-promote-intent` | Non-latest GitHub draft publication is write-ahead recorded. | `github-promoted-nonlatest` |
| `github-promoted-nonlatest` | GitHub B is public but not latest; defaults remain A. | `npm-promote-intent` |
| `npm-promote-intent` | npm latest transition A→B is write-ahead recorded. | `defaults-promoted` |
| `npm-promoted` | npm latest observes B; GitHub latest remains A. | `github-latest-intent`, `compensation-intent` |
| `github-latest-intent` | GitHub latest transition A→B is write-ahead recorded. | `defaults-promoted` |
| `defaults-promoted` | Both provider defaults observe B. | `finalize-intent` |
| `finalize-intent` | Signed manifest/surface/host convergence is pending. | `channels-converged` |
| `channels-converged` | Only terminal success. | none |
| `compensation-intent` | Unsafe npm-first partial promotion must return to A. | `compensated`, `manual-intervention-required` |
| `compensated` | Defaults again expose A; B remains resumable. | the interrupted B intent |
| `manual-intervention-required` | Compensation/reconciliation cannot prove a safe supported state. | explicit same-B repair only |
| `aborted` | Human-authorized terminal failure; B is burned and B+1 may start. | none |

An exception is not a state transition. On restart, the aggregate observes providers and advances or
compensates according to proven postconditions.

## Commands

- `PrepareRelease(candidateReceipt)`
- `ResumeRelease(transactionId)`
- `StageNpmCandidate(sealedTarball)`
- `VerifyStagedHosts(claude, codex, dual)`
- `PromoteGithubDraft()`
- `PromoteNpmLatest()`
- `CompensateNpmLatest(priorGeneration)`
- `FinalizeRelease(signedManifest)`
- `DiagnoseRelease(transactionId)`

Each command is idempotent for one identity and rejects a competing pending identity.

## Domain events

`ReleaseInitialized` · `RemotePrepareIntended` · `RemoteReceiptVerified` ·
`NpmStageIntended` · `NpmCandidateObserved` · `HostVerificationIntended` ·
`StagedHostsConverged` · `GithubPromotionIntended` · `GithubPromotionObserved` ·
`NpmPromotionIntended` · `NpmPromotionObserved` · `CompensationIntended` ·
`CompensationObserved` · `FinalizationIntended` · `SurfaceProbePassed` ·
`ManagedHostsConverged` · `ChannelsConverged` · `ManualInterventionRequired`.

Every event contains transaction identity, monotonic sequence, prior state, next state, provider
observations, UTC timestamp, fencing token, previous receipt digest, signer identity, and signature.

## Invariants

- RT-1: Candidate identity never changes after `ReleaseInitialized`.
- RT-2: State sequence never decreases or skips a required intent/observation pair.
- RT-3: A remote receipt is verified before GitHub publication or npm package publication.
- RT-4: npm candidate publication uses only the version-specific non-default tag.
- RT-5: GitHub publication operates only on the verified draft anchor targeting the exact SHA.
- RT-6: No B+1 transaction starts while B is nonterminal.
- RT-7: Provider command success is insufficient; exact remote observation is mandatory.
- RT-8: `prepared` requires Claude-only, Codex-only, and dual-host results from staged bytes.
- RT-9: npm-first partial promotion is compensated to captured A before retry.
- RT-10: `channels-converged` requires signed manifest, live surface probe, Stable Spine, Claude,
  Codex, and Console convergence.
- RT-11: Disabled remains disabled; changed hooks require explicit host review.
- RT-12: Receipt conflicts or compensation failure are visible hard failures.
- RT-13: A stale fencing token performs no provider mutation.
- RT-14: Only an explicitly authorized human action may enter `aborted`.

## Policies

### Recovery policy

Load the remote receipt, validate its digest/identity, observe both providers, and derive the next
command. Never infer success from the previous process exit code or a changed tag.

### Compensation policy

GitHub-first partial promotion resumes forward because the public release is immutable evidence and
npm B bytes are already staged. npm-first partial promotion restores npm `latest` to captured A
before continuing. A failed rollback becomes `manual-intervention-required`.

### Doctor policy

Doctor reports healthy only for `channels-converged`. All other states name B, the last proven
state, observed splits, and the exact same-B resume/repair action. `pending-console-restart` and
pending hook review remain non-converged.

## Anti-corruption layers

- **GitHub adapter:** draft/release/tag/asset APIs become typed observations.
- **npm adapter:** registry versions, integrity, candidate tag, and latest tag become typed
  observations.
- **Host adapter:** invokes the supported Claude/Codex install and doctor interfaces; filesystem
  inspection supplements but never replaces those verdicts.
- **Workflow adapter:** supplies authorization and exact-SHA evidence but cannot declare domain
  success.
