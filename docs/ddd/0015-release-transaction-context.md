Updated: 2026-09-04 07:33:00 EDT | Version 2.1.1
Created: 2026-08-02 20:10:00 EDT

# DDD-0015 — The Release Transaction bounded context

Status: Accepted; reconciled to the single protected-release controller

Governs: ADR-062 · Issue #77 · `scripts/release.mjs`

## Purpose and boundary

The Release Transaction context converts one sealed candidate into one supported product
generation across GitHub, npm, Claude, Codex, Stable Spine, and Console. It owns provider staging,
promotion, compensation, and receipts. It does not build the corpus, choose a version, modify source,
or authorize publication. `.github/workflows/release-candidate-preflight.yml` qualifies the
candidate once on `release/**` and emits `release-candidate-<exact SHA>`. After that SHA is
fast-forwarded unchanged to main, `.github/workflows/protected-release.yml` is the sole publication
controller: it imports and revalidates those bytes, publishes once, then owns public 3x3 verification
and the terminal receipt.

## Ubiquitous language

| Term | Exact meaning |
|---|---|
| **CandidatePayload** | Build-once persisted bytes: npm tarball, bundle ZIP, signature, digest, and canonical payload manifest. |
| **Payload ID** | SHA-256 of the canonical payload manifest; every retry reuses this byte identity. |
| **EvidenceEnvelope** | Separate signed aggregate binding payload ID, source SHA, required leaves, and verdict. |
| **Candidate** | Immutable B identity: version, tag, exact source SHA, payload ID, and evidence digest. |
| **Prior generation** | A captured once in sequence zero with npm version/integrity and GitHub tag/SHA; immutable on retry. |
| **Draft anchor** | GitHub draft for B containing signed assets and the remote transaction receipt. |
| **Candidate channel** | npm `candidate-vB`; it resolves B without moving `latest`. |
| **Intent** | Durable receipt written before a provider boundary, naming the exact attempted transition. |
| **Observation** | Provider state read after a call or on recovery; success depends on observation, not exit text. |
| **Visibility deadline** | Bounded polling budget; expiry means unresolved, not disproven. |
| **Evidence DAG** | Exact-SHA leaf receipts consumed by one fail-closed aggregate; broad suites run once. |
| **Prepared** | Draft assets and npm candidate bytes agree with the already-proven payload identity. Defaults remain A. |
| **Promoted** | A provider default has moved to B; this is partial until the final manifest and all surfaces converge. |
| **Compensated** | A default channel was restored to captured A after unsafe promotion order/failure. |
| **Channels converged** | npm and GitHub expose B; report `PUBLISHED, NOT VERIFIED`. |
| **Install verified** | Public bytes pass the signed three-OS by three-host-mode aggregate and retrieval checks; the only successful terminal state. |

## Aggregate

`ReleaseTransaction` is the aggregate root. Its identity and signed, hash-chained event sequence are
immutable. Sequence-named GitHub draft assets are authoritative remote state; local JSON is a disposable cache; workflow
artifacts are append-only audit evidence.

### Entity: CandidateIdentity

- `transactionId`
- `version`, `tag`, `candidateSha`
- `payloadId`, `evidenceDigest`, canonical manifest digest
- sealed member names, sizes, and digests

### Entity: CandidatePayload

- canonical manifest; npm tarball; bundle ZIP, signature, and digest
- draft-backed durable locator and retention policy

### Entity: EvidenceEnvelope

- payload ID and exact source SHA
- required exact-SHA leaf receipt names and digests
- fail-closed aggregate verdict, signer identity, and signature

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

### Value object: ObservationPolicy

- max elapsed time/attempts, initial/max delay, multiplier, and jitter source
- injectable clock/sleeper for deterministic visibility and timeout tests
- exact predicate over version, tag, SHA, integrity, and asset digests

## State machine

| State | Meaning | Allowed next states |
|---|---|---|
| `initialized` | Persisted payload and aggregate proof are valid; no remote authority yet. | `remote-prepared` |
| `remote-prepared` | Draft anchor and verified receipt exist. | `asset-upload-intent` |
| `asset-upload-intent` | Create-only staged asset upload is write-ahead recorded. | `npm-stage-intent` |
| `npm-stage-intent` | Candidate publish is write-ahead recorded. | `npm-candidate-staged` |
| `npm-candidate-staged` | Registry proves B under non-default tag. | `remote-materialization-intent` |
| `remote-materialization-intent` | Exact bytes must be re-downloaded from both staged providers. | `prepared` |
| `prepared` | Draft and npm candidate bytes agree with the payload identity; defaults are A. | `github-promote-intent` |
| `github-promote-intent` | Non-latest GitHub draft publication is write-ahead recorded. | `github-promoted-nonlatest` |
| `github-promoted-nonlatest` | GitHub B is public but not latest; defaults remain A. | `npm-promote-intent` |
| `npm-promote-intent` | npm latest transition A→B is write-ahead recorded. | `npm-promoted` |
| `npm-promoted` | npm latest observes B; GitHub latest remains A. | `github-latest-intent`, `compensation-intent` |
| `github-latest-intent` | GitHub latest transition A→B is write-ahead recorded. | `defaults-promoted` |
| `defaults-promoted` | Both provider defaults observe B. | `finalize-intent` |
| `finalize-intent` | Signed manifest/surface/host convergence is pending. | `channels-converged` |
| `channels-converged` | Both channels expose B; public verification still pending. | `public-verification-intent` |
| `public-verification-intent` | The same protected run owns public 3x3 and retrieval verification. | `install-verified`, `manual-intervention-required` |
| `install-verified` | Public artifacts and all nine installed-host leaves are independently reverified. | none |
| `compensation-intent` | Unsafe npm-first partial promotion must return to A. | `compensated`, `manual-intervention-required` |
| `compensated` | Defaults again expose A; B remains resumable. | `github-promote-intent`, `npm-promote-intent` |
| `manual-intervention-required` | Compensation/reconciliation cannot prove a safe supported state. | explicit same-B repair only |
| `aborted` | Human-authorized terminal failure; B is burned and B+1 may start. | none |

An exception is not a state transition. On restart, the aggregate observes providers and advances or
compensates according to proven postconditions.

Draft creation is the sole provider boundary without a remote write-ahead intent because the draft
is the receipt anchor. It is idempotently created/adopted by exact tag and resolved SHA and does not
move a supported default. Any nonterminal state may enter `manual-intervention-required` when a
fresh observation is anomalous but identity-safe.

From `compensated`, the reducer selects `github-promote-intent` when GitHub B is still a draft and
`npm-promote-intent` only when GitHub B is already observed published non-latest.
An npm-B/GitHub-draft anomaly may enter `compensation-intent` from any nonterminal state; this is a
recovery edge selected from fresh provider state, not an ordinary happy-path transition.

## Commands

- `PrepareRelease(candidateReceipt)`
- `ResolveCandidatePayload(payloadId)`
- `ResumeRelease(transactionId)`
- `StageNpmCandidate(sealedTarball)`
- `VerifyStagedPayload(payloadId)`
- `PromoteGithubDraft()`
- `PromoteNpmLatest()`
- `CompensateNpmLatest(priorGeneration)`
- `FinalizeRelease(signedManifest)`
- `DiagnoseRelease(transactionId)`
- `AbortRelease(transactionId, humanAuthorization)`

Each command is idempotent for one identity and rejects a competing pending identity.

Only `reduceReleaseState(lastValidState, freshProviderSnapshot)` selects the next command. The
reducer is total over every state/provider split. No caller may infer a transition from whether a
historical receipt state name exists.

## Domain events

`ReleaseInitialized` · `RemoteReceiptVerified` ·
`NpmStageIntended` · `NpmCandidateObserved` · `PayloadVerificationIntended` ·
`StagedPayloadConverged` · `GithubPromotionIntended` · `GithubPromotionObserved` ·
`NpmPromotionIntended` · `NpmPromotionObserved` · `CompensationIntended` ·
`CompensationObserved` · `FinalizationIntended` · `SurfaceProbePassed` ·
`ManagedHostsConverged` · `ChannelsConverged` · `ManualInterventionRequired`.

Every event contains transaction identity, monotonic sequence, prior state, next state, provider
observations, UTC timestamp, previous receipt digest, signer identity, and signature.

## Invariants

- RT-1: Candidate identity never changes after `ReleaseInitialized`.
- RT-2: State sequence never decreases or skips a required intent/observation pair.
- RT-3: A remote receipt is verified before GitHub publication or npm package publication.
- RT-4: npm candidate publication uses only the version-specific non-default tag.
- RT-5: GitHub publication operates only on the verified draft anchor targeting the exact SHA.
- RT-6: No B+1 transaction starts while B is nonterminal.
- RT-7: Provider command success is insufficient; exact remote observation is mandatory.
- RT-8: `prepared` requires byte-for-byte payload identity from both staged providers.
- RT-9: npm-first partial promotion is compensated to captured A before retry.
- RT-9a: `github-latest-intent` may be recorded only when the same reducer invocation freshly
  observes npm latest B; historical `npm-promoted` membership is insufficient.
- RT-10: `channels-converged` is nonterminal and reports `PUBLISHED, NOT VERIFIED`.
- RT-10a: only the same protected-release run may append `install-verified`, after the signed public
  manifest, live surface probe, and three-OS by three-host-mode matrix are reverified.
- RT-11: Disabled remains disabled; changed hooks require explicit host review.
- RT-12: Receipt conflicts or compensation failure are visible hard failures.
- RT-13: After losing a create-only sequence-receipt CAS, the writer performs no subsequent provider
  mutation; an already-completed idempotent draft bootstrap is the sole exception.
- RT-14: Only an explicitly authorized human action may enter `aborted`.
- RT-15: Publication cannot build, pack, zip, or sign; it only verifies the persisted payload.
- RT-16: `defaults-promoted` requires one reconciliation step that freshly observes both providers
  within the same reducer invocation and proves both defaults name B.
- RT-17: Visibility polling is bounded and deterministic under an injected clock.
- RT-18: One signed aggregate binds every required evidence leaf to the same SHA/payload ID;
  missing, skipped, or degraded leaves fail closed.
- RT-19: Broad suites execute once per SHA; publication and retry consume receipts only.
- RT-20: Every intent, side effect, observation, and receipt append boundary has interruption and
  clean-runner recovery coverage.
- RT-21: Prior A is captured once in sequence zero with npm integrity and GitHub tag/SHA; retries
  cannot recapture it, and unknown provider reads prohibit mutation.
- RT-22: A terminal receipt is revalidated against both defaults, public receipt, and installed
  surface before returning success.
- RT-23: Host matrices run once as evidence leaves; staging verifies bytes and finalization runs one
  public downloaded-artifact probe.
- RT-24: Draft discovery uses tag plus resolved tag SHA and signed transaction identity;
  published `target_commitish` is not release identity.

## Policies

### Recovery policy

Resolve the original payload and evidence envelope, load the remote receipt, validate identity, observe both
providers, and derive the next command through the reducer. Never infer success from an exit code,
changed tag, or historical receipt membership.

### Compensation policy

GitHub-first partial promotion resumes forward because the public release is immutable evidence and
npm B bytes are already staged. npm-first partial promotion restores npm `latest` to captured A
before continuing. A failed rollback becomes `manual-intervention-required`.

### Doctor policy

Doctor reports healthy only for `install-verified`. All other states name B, the last proven
state, observed splits, and the exact same-B resume/repair action. `pending-console-restart` and
pending hook review remain non-converged.

### Finalization policy

After one reducer invocation freshly observes both provider defaults at B, append
`channels-converged` and report `PUBLISHED, NOT VERIFIED`. Without leaving the protected-release
run, download the public artifacts, run the three-OS by three-host-mode matrix and retrieval probes,
sign the nine-leaf aggregate, and append create-only `install-verified`. Existing user-host restart,
disabled, approval, and Console conditions remain local doctor findings and do not rewrite the
global receipt.

### Review and issue policy

Fable 5 and GPT-5.6-Sol independently review changes to architecture or the sealed retrieval oracle.
Their accepted, change-bound findings inform the candidate, but caller-supplied per-release keys are
not a trust anchor and do not authorize provider mutation. Only open issues carrying the explicit
`release-blocker` label enter prepublication policy; unrelated open issues do not become domain state.

### Candidate-tag and abort policy

The version-specific candidate tag remains as immutable transaction evidence after convergence and
is ignored as pending work once a terminal receipt exists. `AbortRelease` is human-authorized and
may enter `aborted` only after fresh observations prove neither default points to B and both defaults
identify one safe supported generation; otherwise it enters `manual-intervention-required`.

## Anti-corruption layers

- **GitHub adapter:** draft/release/tag/asset APIs become typed observations.
- **npm adapter:** registry versions, integrity, candidate tag, and latest tag become typed
  observations.
- **Host adapter:** invokes the supported Claude/Codex install and doctor interfaces; filesystem
  inspection supplements but never replaces those verdicts.
- **Workflow adapter:** supplies authorization and exact-SHA evidence but cannot declare domain
  success.

## Required acceptance scenarios

- delayed npm visibility succeeds within the bound; timeout resumes later with the same bytes;
- interruption before and after every intent, side effect, observation, and completion append;
- crashes after compensation-before-receipt and after re-entered `npm-promote-intent` cannot converge falsely;
- partial publication, stale tags, wrong immutable bytes, asset mismatch, and competing B/B+1 fail closed;
- packed and installed Claude-only, Codex-only, and dual-host paths run after checkout/build removal;
- mutations deleting an evidence leaf, changing identity, or bypassing the reducer make tests fail.
- ambiguous provider-call success followed by timeout; terminal drift; sequence-zero prior-A
  preservation; full release/asset pagination; fail-closed read errors; expired CI transport with
  draft recovery; concurrent receipt-CAS runners; orphan candidates; missing final public receipt.
- polling removal is mutation-tested; existing correct/wrong npm bytes and missing/wrong candidate
  tags are integrity-first; anomalies record `manual-intervention-required`.

## Currency log

| Date | Change |
|---|---|
| 2026-09-04 | Reconciled the expedited two-phase context with ADR-062: `.github/workflows/release-candidate-preflight.yml` runs long qualification once and names `release-candidate-<exact SHA>`; after an unchanged fast-forward, `.github/workflows/protected-release.yml` revalidates that artifact, publishes once, and owns public proof through `install-verified`. Review is change-triggered and only labeled `release-blocker` issues stop dispatch. |
