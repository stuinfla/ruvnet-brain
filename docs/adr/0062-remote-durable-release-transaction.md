---
id: ADR-062
title: Remote-durable staged release transaction
status: Accepted
date: 2026-08-02
updated: 2026-08-30
authors: [Stuart Kerr]
tags: [release, evidence, transaction, npm, github, receipts, recovery]
supersedes: []
relates: [ADR-053, ADR-058]
governs:
  - .github/workflows/ci.yml
  - .github/workflows/stranger-matrix.yml
  - .github/workflows/protected-release.yml
  - .github/workflows/release-aggregate.yml
  - scripts/release.mjs
  - scripts/release-transaction.mjs
  - scripts/release-transaction-provider.mjs
  - scripts/staged-host-verifier.mjs
  - docs/ddd/0015-release-transaction-context.md
---

# ADR-062 — Remote-durable staged release transaction

## Currency log

| 2026-08-30 | Automatic PR execution now has one canonical bounded path; the legacy matrix remains available only by manual dispatch. | `.github/workflows/ci.yml` and `.github/workflows/qe-4-3.yml` remove competing automatic release-quality paths without changing the protected publication transaction. |
| 2026-08-30 | Protected publication now consumes the canonical bounded QA receipt before release dispatch. | `scripts/qa-runner.mjs` binds the candidate SHA and artifact lanes; `docs/QA-RELEASE-PROCESS.md` records recovery and promotion. |

| 2026-08-23 | Failed candidate evidence now preserves suite-level diagnostics and skipped-test identities for remote recovery. | Commit `cc25c24` improves diagnosis only; publication authority and mutation boundaries remain unchanged. |
| 2026-08-23 | Hosted process failures now preserve bounded stdout/stderr tails in candidate receipts. | Commit `1310fb6` improves remote diagnosis only; publication authority and mutation boundaries remain unchanged. |
| 2026-08-23 | The aggregate consumes receipts from the workflow's merged-artifact destination and preserves verbose test diagnostics. | This repairs evidence transport only; the durable transaction remains downstream of exact-SHA PASS receipts and publication authority is unchanged. |
| 2026-08-23 | The Windows candidate adds a direct import probe for the shared installer before artifact qualification. | The exact-SHA failed receipt isolated a platform execution boundary; no release authority, artifact, or publication mutation changed. |
| 2026-08-23 | Candidate lanes stop after the first failed step and preserve the partial receipt for recovery. | This reduces wasted remote work without weakening the downstream exact-SHA evidence requirement or publication fence. |
| 2026-08-23 | Windows installer-import evidence is process-isolated and hosted conformance has a measured 240-second bound. | This changes only test execution boundaries; durable release authority and publication mutation fences remain unchanged. |
| 2026-08-23 | Candidate publication evidence now excludes unavailable live-only checks and uses a platform-neutral Node test entrypoint. | Commit `0e30d68` keeps the transaction downstream of deterministic exact-SHA evidence without laundering live skips into green or relying on `npm.cmd`. |
| 2026-08-23 | Release qualification now waits on every required QE receipt and preserves failed-lane artifacts for diagnosis. | Commit `b570e25` keeps the durable publication transaction downstream of complete exact-SHA quality evidence; no publication mutation was added. |
| 2026-08-23 | The transaction now receives its pre-publication quality evidence from the new exact-SHA QE aggregate, while publication authority and mutation fences remain unchanged. | Commit `b3ddb0d` makes `.github/workflows/qe-4-3.yml` the auto-triggered candidate lane; legacy CI is manual-only, and `scripts/qe/aggregate-4.3.mjs` rejects any missing, skipped, stale, or non-PASS receipt before release work can proceed. |
| 2026-08-23 | Replaced the incomplete Windows shell-string repair after exact-SHA job `97218861232` still split the `--title` argument; the protected mutation fence remains unchanged. | `scripts/windows-command.mjs` now uses the measured `cmd.exe /d /s /c` boundary from `scripts/selfcheck.mjs`, and `tests/unit/corpus-seed-release-authority.test.mjs` asserts the complete argv shape before hosted verification. |
| 2026-08-23 | Re-read the protected corpus-seed publisher after issue #163 exposed Windows shell argument splitting; the staged transaction and mutation fence remain unchanged. | `scripts/release.mjs` quotes complete Windows `gh release create` arguments before the protected mutation, and `tests/unit/corpus-seed-release-authority.test.mjs` proves the exact bundle and receipt payload. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-21 | Re-read the staged transaction after correcting candidate bundle assembly; transaction authority and immutable payload rules are unchanged. | `.github/workflows/ci.yml` repairs stale seed ledger hashes before sealing the candidate, but still produces the npm and bundle artifacts once for the existing protected publisher. No publication mutation or receipt bypass was added. |
| 2026-08-21 | Bound the existing resumable transaction to the immutable corpus seed and generation ledger, and rechecked remote-main immediately before publication. | `scripts/release-transaction.mjs` and `scripts/release.mjs` carry the new payload roles; `.github/workflows/protected-release.yml` fetches `origin/main` and requires an exact clean match directly before `release.mjs --publish`. Provider operations remain serialized and guarded, not falsely described as atomic compare-and-swap. |
| 2026-08-20 | **The digest serialiser disagreed with the one that writes the file, and it corrupted the terminal receipt of EVERY successful release.** | `canonicalJson` KEPT keys whose value was `undefined` (emitting `"error":undefined`, not even valid JSON) while `JSON.stringify` DROPS them on write. The converge observation carries optional fields and on a clean run `verified.error` is undefined, so the digest was computed over a shape that could never be read back. `runReleaseTransaction` appends a receipt, re-reads it and verifies it — so the publish died with `release receipt digest mismatch` AFTER npm and GitHub were both promoted: **4.0.90-dev actually shipped to both channels while the rail reported failure**, the same shape the provider already records for 4.0.24. Measured on v4.0.36 and v4.0.90-dev — both `channels-converged`, both digest=BAD, both missing `hosts.verifier.error`; chain LINKAGE was intact on both, which is what ruled out tampering. Proven by reconstruction: restoring `observation.hosts.verifier.error = undefined` reproduces the stored digest exactly. Fixed by making `canonicalJson` omit undefined exactly as `JSON.stringify` does, for objects AND arrays (`JSON.stringify([undefined])` is `[null]`). Verified no receipt that previously verified changed digest (v4.0.36: 12 ok / 1 bad before and after). Historical bad receipts stay unverifiable — their digests were computed by the broken serialiser — but they are terminal, and terminal receipts are skipped by the pending-transaction scan, so they block nothing. Guard added and proven to fail on the old serialiser. |
| 2026-08-19 | **Release chain unaffected; `release-qe` green through all of it.** | `check`'s nine-day hang now has a NAME: `tests/unit/decision-outcomes.test.mjs`, identified by construction rather than guessed. `--no-file-parallelism` makes completion order equal execution order, and vitest sequences by file size DESCENDING — verified, not assumed: the 129 files that completed are EXACTLY the largest 129 by size, zero mismatches, so the file that started and never finished is the 130th. It converges with the independently-derived regression window (main last green 2026-08-10T11:06, first red 16:23), which contains the two ADR-067 decision-gate commits — and this is a decision-gate test. The file is QUARANTINED via `--exclude`, not fixed: it passes locally in 1.8s WITH coverage, so the cause is ubuntu-specific and unknown. #145 stays open; the exclusion comes out when the mechanism is understood, because a quarantine that quietly becomes permanent is deleted coverage. Recorded here because it did NOT touch the transaction: `release-qe` does not depend on `check` and stayed green across every hung run, so the seal and its four exact-SHA evidence inputs were produced throughout. |
| 2026-08-19 | **The release chain is unaffected by the CI diagnostic — `release-qe` is green three runs running.** | A temporary `--reporter=verbose` diagnostic was added to the `check` job's vitest step (#145). The step hangs DETERMINISTICALLY on ubuntu — two runs 38 minutes apart went silent after the same file, with the same six files before it and the same orphan signature at cleanup — and it survived every one of today's twelve unit-test fixes, so the failing tests were not the cause. The default reporter prints on file COMPLETION only, so a file that starts and never finishes is structurally invisible; verbose prints start events. Diagnostic only, to be removed once the file is named. Worth recording for this ADR specifically: `release-qe` does NOT depend on `check`, so the seal and its four exact-SHA evidence inputs are produced regardless of the hang. The eleven-day publish gap was the org-repo-count dirty-tree defect, now fixed; the hang blocks a green `check`, not the transaction. |
| 2026-08-19 | **The transaction could not begin: the seal refused every candidate for eleven days, because the build dirtied its own tree.** | This ADR's chain is `ci` -> `stranger-matrix` -> `release-aggregate` -> manual `protected-release`, gated on four exact-SHA evidence inputs. Step one never produced them: `stabilization-receipt.mjs` refused with `INVALID_LINEAGE` on every main run since 2026-08-08 (#141 — 46 commits, nothing published). Cause, once the seal was taught to name it: `M data/org-repo-count.json`. `orgRepoCount()` persisted the live reading on EVERY call and both callers (`build-bundle.mjs:421`, `brain-stamp.mjs:76`) are BUILD scripts, so `ci.yml:392` dirtied the tree seconds before `ci.yml:449` demanded it clean. Persistence is now opt-in; the committed record still ships as the offline fallback (`npm run orgcount:refresh` refreshes it deliberately). `ci.yml` additionally gained `timeout-minutes` on all four jobs. The transaction's shape, evidence inputs and authority boundaries are unchanged. |
| 2026-08-08 | **Re-read after PR #124 (private RVF overlay hardening) and the new GitHub health watcher; the release transaction contract is unchanged.** | Governed files moved for two unrelated reasons. PR #124 hardens `kb/forge-update.mjs` and the private overlay updater against symlink attack (direct, ancestor, dangling), validates each generation and sidecar as a contained regular file, and fails closed on corrupt backup inventories — filesystem safety on the UPDATE path, not the publish path. Separately `scripts/github-health-watch.mjs` was added, which REPORTS on release-surface coherence and cannot push, merge, close or publish (asserted by test). Neither changes the staged transaction, its receipt chain, its terminal states, or the sole-publisher rule this ADR decides. |
| 2026-08-07 | **A converged transaction could never be RECOGNISED as converged, so the rail could publish once and then never again.** `scripts/release-transaction-provider.mjs` — the settled check no longer requires `schemaVersion === 1`. | 4.0.24 published successfully to both channels and failed only on its final ledger entry, leaving its latest receipt non-terminal. The provider classifies any non-terminal receipt from another transaction as competing, and its one escape hatch — recognising a transaction whose version and tag are what npm and GitHub currently serve — was gated on `receipt.schemaVersion === 1`. Receipts are written as schemaVersion 2 (`release-transaction.mjs` stateReceipt), so that hatch had silently expired: no current transaction could ever be settled. 4.0.27 was then refused with `pending release 064b6b4e… blocks …`. Same family as `aborted` being unreachable — a recovery path that stopped working when the thing around it moved on. Convergence is a fact about the CHANNELS: published, and this transaction's exact version and tag live on both. The schema clause was never load-bearing for that question, so removing it weakens nothing. |
| 2026-08-07 | **ROOT CAUSE of #77 found and fixed: the release bundle outgrew `spawnSync`'s buffer, so verification could not READ the artifact — and reported that as a digest mismatch.** `scripts/release-transaction-provider.mjs` now streams assets; `scripts/release-transaction.mjs` no longer conflates a read failure with a mismatch. | `assetBytes` buffered each asset via `spawnSync(..., encoding: 'buffer')`. The knowledge bundle is ~529MB, past maxBuffer, so the publisher died with `cannot download transaction asset ruvnet-brain.zip: spawnSync gh ENOBUFS` — surfaced only after the throw site was corrected, because `observeSnapshot`'s catch returns `{readError}`, leaving `github` undefined and making `!observed.github?.assetsExact` throw `staged GitHub payload mismatch` for a failure that was not a mismatch. Measured against the real staged draft, every asset matched the sealed identity byte-for-byte and GitHub's own digest agreed (zip a87c4f51…, sig acffb93c…, sha256 7a5b00ac…, tgz 05244cf7…). This is a SIZE CEILING the corpus crossed, so from that point every release failed regardless of content — which is why hand-publishing became the only way to ship, and hand-publishing is how npm and GitHub came to name different generations. #77 was never version drift. Assets now stream to a temp file and hash in 1MB chunks in both the digest path and `materializeRemoteAssets`, so peak memory is one chunk and no ceiling remains. Commit follows this row. |
| 2026-08-07 | **Two defects that made this ADR's durable transaction unable to complete a single release, both fixed.** `scripts/release-transaction.mjs` (`aborted` reachable), `scripts/release-abort-stale.mjs` (new), `.github/workflows/ci.yml` (deterministic sha256 sidecar). | (1) DEADLOCK: `aborted` was in TERMINAL_STATES but no state listed it as a target, and `manual-intervention-required` has no outgoing transitions and is not terminal — so an interrupted transaction had two destinations and both were permanent non-terminal dead ends. v4.0.7 stopped at `npm-stage-intent`, and `runReleaseTransaction` then refused every later release with `pending release b2ac9b69… blocks …`, with no legal move able to clear it. npm was hand-moved to 4.0.12, which also disqualified the provider's `settled` escape hatch (it needs receipt.version === npmLatest). The rail deadlocked itself, hand-publishing became the only way to ship, and hand-publishing is exactly how npm and GitHub came to name different generations. `aborted` is now reachable from every non-terminal state and a signed abort receipt closed v4.0.7 (receipt 0005); its bundle, signature and digest assets were untouched. (2) NON-DETERMINISTIC SIDECAR: `ci.yml` ran `sha256sum "$RUNNER_TEMP/.../ruvnet-brain.zip"`, and sha256sum records the path it is given, so the sidecar shipped `<digest>  /home/runner/work/_temp/release-evidence/ruvnet-brain.zip`. A user's `shasum -c` then looks for a CI runner path that cannot exist locally, and the sidecar's own digest became environment-dependent — so `assetsExactFor` failed every publish with `staged GitHub payload mismatch`, twice on a fresh draft, which is what ruled out stale residue. Now `cd`-relative, matching `sign-bundle.mjs:59`. Commits `9775450`, `886eeb5`. |
| 2026-08-06 | **The envelope verification this ADR depends on was comparing key ORDER, and refused valid evidence. Now compares the digest explicitly plus the canonical form.** | ADR-062's durable transaction assumes the publisher can verify its own aggregate envelope. It could not. `protected-release.yml:205` used `JSON.stringify(recomputed) !== JSON.stringify(envelope)`, which is key-insertion-order sensitive: the stored envelope carries alphabetically sorted keys, `aggregateEvidence()` returns construction order. Reproduced against the real 4.0.18 artifacts (aggregate run `31112242438`, ci run `31111173442`, both at `ab32c88`) — `evidenceDigest` equal TRUE, `verdict` equal TRUE, canonical form equal TRUE, raw stringify equal FALSE. The release was refused with `aggregate envelope digest or leaves mismatch` when nothing was mismatched. Third independent way this rail was dead on 2026-08-06, after the unbound `EXPECTED_VERSION` and the `-dev`/clean deadlock; all three reported something other than what they measured. The integrity property is unchanged and now checked twice — a substituted value, dropped leaf or added leaf moves both the sha256 and the canonical form, so sorting keys hides nothing. Commit `3c064c6`. |
| 2026-08-03 | `release-aggregate` now runs only for a successful stranger-matrix completion or explicit recovery dispatch. | Post-merge run `30847604771` attempted to download `stranger-evidence-9de40a59…` from a failed run with no artifact; run `30848438803` then proved successful stranger evidence still waits for exact-SHA CI convergence. `.github/workflows/release-aggregate.yml`. |

**Status**: Accepted

**Date**: 2026-08-02

**Updated**: 2026-08-02 22:20 EDT · **Revision**: 2.0.0

> 4.0.8 correction: the 4.0.7 implementation proved that publisher-side bundle rebuilding makes
> retry identity unstable and receipt-history skipping can report false convergence after
> compensation. Fable 5 and GPT-5.6-Sol adversarially reviewed this revision together with
> DDD-0015; all surviving corrections are incorporated.


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `scripts/release-transaction-provider.mjs` finalize() now MEASURES the host verdict instead of declaring it. It previously accepted the verifier as `_hostVerifier`, ignored it, and set `hosts.verdict` to the literal 'PASS', so every release asserted host convergence with no host verified — while the test fixture called the seam faithfully, certifying wiring production never ran. The verifier is now invoked, its verdict is the release verdict, a missing verifier is itself a FAIL, and it runs before publication and sealing so an unusable artifact stops cheaply. Checked against this decision: this IMPLEMENTS the convergence evidence it already requires; no clause is contradicted or superseded. It does NOT deliver ADR-062 durable transaction, which remains a target.


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved for the 4.0.9 release-integrity work: scripts/host-install-matrix.mjs now holds the ONE host-install harness (modes, env, doctor rule) that scripts/staged-host-verifier.mjs and scripts/publication-receipt.mjs had each been carrying a divergent copy of; release-transaction-provider.finalize() measures the host verdict through the injected verifier instead of declaring a literal PASS; and plugin/scripts/ruflo-bin.mjs applies the Windows extension rule to the preferred path as well as the PATH walk. Checked against this decision: each change IMPLEMENTS evidence this ADR already requires and removes a second representation of a fact it assumes is single. No clause is contradicted or superseded.


> **Reviewed 2026-08-05 (4.0.14-dev).** Governed code moved: .github/workflows/integration-linux.yml derives its verdict from vitest JSON rather than grepping a colorized log (the previous regex could never match, failing a run with 234 tests passing), and .github/workflows/stranger-matrix.yml gained one eligibility gate so it stops running after failed or pull_request ci runs where the sealed candidate does not exist. Measured cause: the four required exact-SHA runs passed at 70/45/70/95 percent, so a release attempt succeeded ~1 in 5. Checked against this decision: both IMPLEMENT its exact-SHA evidence requirement. Its durable-transaction target remains a target, not a claim about current code.

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

- No default-channel client observes B until B has passed candidate and host gates.
- A clean runner can resume B from remote evidence alone.
- After deterministic draft-anchor bootstrap, every provider mutation is preceded by a durable
  write-ahead intent and followed by observed-state reconciliation.
- Replays are idempotent and bind `version + tag + SHA + npm integrity + bundle digest`.
- A pending B blocks B+1.
- Local files and workflow logs are caches/evidence, never release authority.
- Tests use provider fakes; no test may create drafts, tags, packages, or dist-tag changes.
- Build, pack, and sign one candidate exactly once; publication and recovery cannot rebuild it.
- Treat registry propagation as bounded observation, not one-shot success/failure.
- Use one exact-SHA evidence DAG and one fail-closed aggregate required status.
- Run broad suites once per SHA; all downstream stages consume receipts and immutable bytes.
- Give every transaction boundary a named log stage and an interruption/recovery test.

## Target design and current migration gap

The following is a target for 4.0.8, not a claim about current code. Production 4.0.7 still rebuilds
and signs the ZIP in the publisher, checks only `ci/release-qe` at publication, observes npm once,
uses historical receipt membership to skip recovery work, and has no sole `release-aggregate`
status. Those gaps are the migration work governed by this now-accepted ADR.

Candidate CI now packs the npm tarball exactly once, before release QE, and identifies those bytes
by SHA-256 in the candidate receipt. Release QE and the five stranger-host cells consume that same
uploaded tarball; no host repacks the checkout. The protected publisher downloads the receipt and
sealed bytes, rechecks their SHA/version/digest identity at the Production boundary, and passes the
tarball unchanged into the staged npm/GitHub transaction.

Source tests, unit tests, version/wiring checks, signed bundle assembly, host acceptance, and
exact-SHA proof are candidate-builder responsibilities. They produce one immutable
`CandidatePayload`: npm tarball, knowledge bundle ZIP, signature, digest, and canonical payload
manifest. The manifest binds each member by name, size, digest, source SHA, version, producer run,
and canonical JSON serialization rules. A separate signed `EvidenceEnvelope` binds the payload ID,
candidate SHA, required leaf receipts, and aggregate verdict; separating them avoids a circular hash.
The publisher cannot build, pack, zip, or sign. It only verifies and materializes the persisted
payload and envelope, stages/promotes those bytes, performs one public-channel
verification, and writes the final receipt. Any source change creates a new SHA and payload.

The evidence DAG has content-bound leaves for source quality, release QE, stranger/platform cells,
and Claude-only, Codex-only, and dual-host acceptance. One `release-aggregate` job rejects any
missing, skipped, neutral, degraded, or identity-mismatched leaf. It emits the sole branch-required
release status. Publication and retry consume its signed receipt and never rerun broad suites.

## Considered approaches

### 1. GitHub Actions artifact as transaction authority

Advantages: already produced by CI, immutable per upload, straightforward workflow wiring.

Rejected as the sole authority: artifacts expire and are tied to a workflow run. They remain useful
append-only evidence, but expiry or run deletion must not make a pending release unrecoverable.

### 2. Dedicated branch/ref containing transaction records

Advantages: durable Git object history and natural compare-and-swap semantics.

Rejected: it creates a second mutable release control plane, requires commits unrelated to product
source, and complicates branch protection and publisher authority.

### 3. Persisted payload plus draft GitHub transaction anchor (chosen)

Before npm mutation, the protected publisher transports the already-built `CandidatePayload` and `EvidenceEnvelope` to the
unique exact-tag/SHA draft, downloads them back, and verifies every digest/signature. The draft is
the durable recovery source after Actions artifacts expire. Creating/adopting that draft is the one
named bootstrap exception to the write-ahead-intent rule because it creates the receipt anchor but
does not change a supported default; every later side effect requires a create-only intent. The
draft is the GitHub staging object for the exact tag/SHA. Canonical sequence-named
`release-transaction-<sequence>.json` assets make that object the recovery anchor.
npm stages the immutable version under `candidate-v<version>` (never `latest`). CI artifacts retain append-only copies of
the staged and final receipts for audit.

Receipts are create-only, Ed25519-signed, hash-chained, and carry a monotonic sequence. The
publisher downloads and verifies the just-written asset before crossing the next boundary. A
duplicate sequence is the compare-and-swap conflict: its writer performs no further mutation.
Recovery accepts only the highest valid chain for the same immutable identity; conflicting identity,
signature, chain, or regressed state fails closed.

## Transaction protocol

### Identity

Canonical JSON is UTF-8 RFC 8785/JCS throughout.

`payloadId = sha256(JCS(payloadManifest))`.

The envelope signature signs `JCS(envelope excluding signature)`.

`evidenceDigest = sha256(JCS(complete signed EvidenceEnvelope))`.

`transactionId = sha256(JCS({schemaVersion, version, tag, candidateSha, payloadId, evidenceDigest}))`.

Every state and provider observation repeats those fields and member digests. Any mismatch is a
collision, not a new attempt. Retry re-materializes and verifies the original payload from the
draft when needed. Missing durable bytes are a hard recovery failure; regenerating, repacking, or
resigning is never a recovery action.

The manifest pins every prior-generation asset digest consumed while assembling the bundle.
Candidate CI creates these bytes once. If the durable payload cannot be resolved, the transaction
becomes `manual-intervention-required`; recovery never attempts to re-derive it.

### Prepare

1. Resolve the persisted payload and evidence envelope; verify every member, synchronized manifests,
   exact candidate SHA, and aggregate receipt. Never build, pack, zip, or sign in the publisher.
2. Under one repository-wide publisher lock, discover all draft/published release anchors and npm
   candidate tags. A pending different identity blocks B. Duplicate/orphan drafts for B are adopted
   only when their tag/SHA identity is exact and unambiguous; otherwise the run fails without mutation.
3. Create or adopt a GitHub **draft** explicitly targeting the candidate SHA. This does not advance
   `releases/latest`.
4. Append, download, and verify sequence-zero `remote-prepared`, capturing immutable A. Then append,
   download, and verify `asset-upload-intent`; only then upload payload/envelope assets and download
   and verify them.
5. Verify the staged provider bytes and metadata against the payload. The evidence envelope already
   contains the one exact-SHA packed/installed Claude-only, Codex-only, and dual-host matrix; do not
   rerun it during staging.
6. Write `npm-stage-intent`, then publish the persisted tarball with the non-default
   `candidate-v<version>` tag. Poll version, integrity, and candidate tag with bounded exponential
   backoff plus jitter until the exact postcondition appears or the deadline expires. Timeout
   preserves the same-byte transaction for resume; it never triggers rebuilding or blind republish.
7. Re-download the candidate tarball through npm and payload assets through the authenticated draft
   API and verify identity digests. Record `prepared` when both staged providers reproduce the same
   payload identity; no broad or host suite reruns here.

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
6. Observe both defaults B; run one public downloaded-artifact install/doctor probe across
   Claude-only, Codex-only, and dual-host modes plus the surface probe; upload create-only signed
   `current-release.json` on release B; download and verify it; freshly reobserve both defaults;
   then append `channels-converged`. Until then user doctor reports pending/unknown.

If non-latest GitHub promotion succeeds and npm promotion fails, retry B; supported defaults remain
A. If npm promotion succeeds while GitHub B remains an unpublished draft (non-latest publication
never observed), compensate npm `latest` back to sequence-zero A only after re-observing that
`latest` still equals B. npm latest = B with GitHub published non-latest is the normal state
preceding `github-latest-intent` and resumes forward. Prior A includes npm
version/integrity and GitHub tag/SHA, is immutable, and is never recaptured on retry. Any third identity is a
race and becomes `manual-intervention-required`, never a blind rollback. A poisoned immutable B may
enter signed, explicitly human-authorized terminal `aborted`; automation cannot abort or reuse B.

### Recovery

- Discover the unique draft/published release whose transaction asset identifies B.
- Resolve and verify the original payload and evidence envelope before any mutation.
- Feed the last valid state and fresh observations of both providers through one total transition
  reducer. Receipt history is evidence, never permission to skip a postcondition. An intent may have completed
  even if the process died before its completion receipt.
- Continue the same B only. A different pending identity blocks the run.
- A step is skipped only when fresh provider state proves its exact postcondition.
- `defaults-promoted` requires one reducer invocation that freshly observes npm latest and GitHub
  latest both name B;
  compensation and re-promotion never advance from historical receipt names alone.
- Capture prior A exactly once in sequence zero, including npm version/integrity and GitHub tag/SHA.
  A retry never recaptures or replaces it. Unknown/failed provider reads prohibit mutation.
- A prior `channels-converged` receipt is not an early return: replay re-observes the public receipt,
  npm, GitHub, and host surface; drift is non-success.
- Discovery paginates all releases/assets and candidate tags. Create-only sequence receipts are the
  compare-and-swap authority; there is no decorative fencing token.
- Published-release discovery resolves the tag SHA and verifies signed transaction identity;
  `target_commitish` is not trusted after publication.
- Any identity-safe anomaly may enter `manual-intervention-required`. An explicitly authorized
  `AbortRelease` burns B against its discovered anchor so it cannot block every future release.
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
7. `channels-converged` requires the signed final receipt, live surfaces, and isolated
   installed-artifact host-interface receipts with accurate restart/review metadata.
8. Existing user-host restart, disabled state, hook approval, and Console state are doctor-reported
   local postconditions, not global publication blockers.
9. One constant workflow concurrency group plus create-only receipt CAS serializes all versions.
10. Ordinary open issues are not release authority; only maintainer-governed release-blocker
    metadata blocks publication.
11. The publisher has no code path that creates candidate bytes.
12. One payload ID and evidence digest bind every CI, npm, GitHub, transaction, and installed-host receipt.
13. Propagation timeout is resumable uncertainty, never proof of provider failure.
14. GitHub logs separate intent, provider call, observation, and receipt stages and name the
    transaction/payload IDs, attempt, deadline, and observation without secrets.
15. Delayed visibility, interruption at every boundary, partial publication, byte mismatch,
    competing releases, compensation, and re-promotion are mandatory executable recovery tests.

## Consequences

- Release code gains a small domain state machine and provider adapter boundary.
- The protected workflow must retain both staged and final receipts even on failure.
- A failed release may leave an unpublished GitHub draft and an immutable npm candidate version.
  This is deliberate evidence, not debris to overwrite.
- Cross-provider atomicity remains impossible, but no incomplete B is called current and every
  partial promotion has a deterministic compensation/resume path.
- Exact-version and semver consumers may observe staged B; they are outside the supported default
  channel until commit. The receipt and doctor surface that unavoidable registry visibility.
- Retry may re-download/re-materialize and reverify the same persisted bytes or repeat an idempotent
  provider mutation. It may not regenerate/repack/resign or repeat broad suites.
- The version-specific candidate tag remains as transaction evidence after convergence; terminal
  tags are ignored as pending work. `aborted` requires fresh proof that neither default points to B
  and both defaults identify a safe supported generation, otherwise state remains
  `manual-intervention-required`.
- The per-generation workflow version lock remains explicit and must match source.

## Authoritative references

- GitHub Releases and drafts: https://docs.github.com/en/rest/releases/releases
- GitHub release assets: https://docs.github.com/en/rest/releases/assets
- npm candidate tags and immutable package versions: https://docs.npmjs.com/cli/publish/
- npm dist-tags: https://docs.npmjs.com/adding-dist-tags-to-packages/
- Domain model: `docs/ddd/0015-release-transaction-context.md`
