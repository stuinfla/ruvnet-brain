---
id: ADR-070
title: One release generation across corpus, package, hosts, and retained state
status: Accepted
date: 2026-08-21
updated: 2026-09-04
authors: [Stuart Kerr, Codex]
tags: [release, generation, corpus, update, synchronization, retention, proof]
supersedes: []
relates: [ADR-023, ADR-051, ADR-065]
governs:
  - .github/workflows/ci.yml
  - bin/install.mjs
  - kb/forge-update.mjs
  - scripts/brain-stamp.mjs
  - scripts/build-bundle.mjs
  - scripts/release.mjs
  - scripts/release-transaction-provider.mjs
  - scripts/self-update.mjs
  - scripts/published-surface-probe.mjs
---

# ADR-070 — One release generation across corpus, package, hosts, and retained state

**Status**: Accepted

> **Reviewed 2026-09-04 (4.3.9 candidate).** The publisher now validates both handoff paths before
> beginning the remote transaction and materializes the exact identity plus signed channels receipt
> only after convergence validates, using no-overwrite hard links and synchronous-error rollback.
> Pairwise crash atomicity is not claimed. npm, GitHub, hosts, and the canonical site remain
> unproven for 4.3.9 until their live exact-version checks complete.

Fable 5 and GPT-5.6-Sol converged on the corrected design before implementation.

## Context

On 2026-08-21 the public product identified itself as two different generations: GitHub's latest
release was `v4.2.1-dev`, while npm still served `4.0.90-dev`. A new window therefore loaded the npm /
plugin generation and correctly displayed 4.0.90 rather than the newer corpus tag. The nightly then
stamped a local `4.2.2-dev` candidate but failed bundle assembly because many canonical RVF files had
no matching entry in `RVF-GENERATIONS.json`. No public release advanced.

Two open defects expose the architectural seams:

- #152: CI seeds the next knowledge bundle from the latest release bundle. Locally ingested stores
  are invisible to that self-seeding loop, so the shipped corpus cannot grow from the authoritative
  local store root.
- #153: the installer deletes an outgoing Claude plugin-cache version while already-running sessions
  still hold that exact directory as `CLAUDE_PLUGIN_ROOT`. The Stable Spine cannot help because the
  host fails before `hook-shim.mjs` can run.

The same audit measured 29 GB under `~/.cache/ruvnet-brain`, primarily rollback snapshots left from
repeated update attempts. A release system that converges versions but leaks a full corpus snapshot
per attempt is not operationally correct.

ADR-023 is Accepted and implemented: it makes the Stable Spine the hot-update boundary. ADR-051 is
Accepted/Implemented: it requires stable Codex host wiring. This decision extends them; it does not
replace their stable-path contracts.

## Decision under review

### 1. A release is one aggregate, never parallel version strings

Define `ReleaseGeneration` as one immutable aggregate containing:

1. exact source commit or immutable source snapshot;
2. npm plugin/package artifact;
3. signed knowledge bundle;
4. corpus-source receipt (store identities, source commits, RVF digests, visibility fence);
5. release transaction and post-publication receipts.

Every member carries the same normalized version. GitHub `latest`, npm `latest`, the plugin manifests,
the installed Stable Spine, and the installed KB manifest are projections of that aggregate. The
publisher may stage members independently, but it may not mark the release latest or report success
until all projections converge.

### 2. Replace recursive latest-release seeding with an explicit immutable corpus seed

The corpus input is a separately sealed, immutable asset identified by a committed descriptor:

```json
{
  "tag": "corpus-v<generation>",
  "asset": "ruvnet-brain-corpus.zip",
  "sha256": "<digest>",
  "stores": 0,
  "createdFrom": "<source snapshot>"
}
```

CI downloads the exact tag and verifies the committed digest before bundle assembly. It never asks
for "latest" and never uses the candidate bundle as its own source. Advancing the corpus requires a
new immutable seed tag plus a reviewable descriptor change; it never rewrites an already-sealed
release asset. The seed publisher applies the same public/private visibility fence as bundle assembly
and emits a source-linked store inventory.

### 3. The generation ledger is rebuilt from the assets it governs

Before bundle assembly, the candidate process enumerates every canonical `*.big.rvf` in the selected
asset root and writes or validates exactly one `RVF-GENERATIONS.json` entry per store. Entries bind the
actual filename, byte count, SHA-256, embedding metadata, source commit, and build time. Bundle assembly
then fails closed on any missing, extra, aliased, private, or digest-mismatched entry.

The ledger is not inferred from `data/manifest.json`, and a manifest row is not evidence that an RVF
generation record exists. The candidate receipt records both counts and requires equality after the
privacy fence.

### 4. Retire a host generation to a compatibility shell; never dangle a live path

Claude Code owns the versioned plugin-cache path, while the Brain owns the bytes it installed there.
After the registry advances, the outgoing directory is atomically retired to a tiny compatibility
shell rather than deleted. The shell retains its plugin manifest and the two Stable-Spine entrypoints
(`scripts/hook-shim.mjs` and `scripts/hook-shim-bash.mjs`) needed by frozen hook commands. It removes
skills, commands, hook declarations, and all other discoverable payload so an old generation cannot
be re-registered as a second active plugin.

A failed retirement leaves the original outgoing directory usable. Compatibility shells are not
garbage-collected until a trustworthy host-session lease exists; the current plugin registry alone
does not prove that no running session holds an old `CLAUDE_PLUGIN_ROOT`.

The Brain's own `versions/` remains lease-aware and keeps the active and previous gated generations.
It may collect only unleased generations according to ADR-023.

### 5. Rollback storage is transaction-scoped and self-reclaiming

One update transaction creates at most one KB rollback snapshot. Every terminal outcome classifies it:

- verified success or verified no-op: reclaim immediately;
- damaged/uncertain live KB: retain with a receipt naming the exact reason and recovery command;
- abandoned but provably redundant historical snapshot: reclaim during the next preflight, before a
  new snapshot is created.

Reclamation inventories only governed store artifacts, ignores ordinary tooling symlinks, refuses to
delete a snapshot containing the only copy of a store, and reports bytes freed. Candidate scratch
directories are removed on both success and failure unless explicitly retained as named recovery
evidence.

### 6. Publication is a serialized, guarded, resumable transaction

The publisher starts from the observed prior npm and GitHub latest identities. It stages the exact
package and bundle, verifies their digests and generation identity, then promotes both surfaces with
compare-and-swap guards. A partial promotion is an incomplete transaction to repair, not a release.
Because provider reads and writes are separate, this is not claimed to be atomic compare-and-swap. The next run resumes the same transaction or rolls it forward; it never invents a new version merely
because one surface moved.

### 7. Proof must cross the real user boundary

Release completion requires all of the following against the public bytes:

- exact tag resolves to the release commit;
- npm exact version and `latest` resolve to the same generation;
- GitHub `latest` resolves to the same generation and exposes the signed bundle and receipts;
- a clean temporary install downloads and verifies the public artifacts;
- Claude Code and Codex host probes load the expected generation;
- a fresh process/window prints the same single user-facing version;
- representative `search_ruvnet` queries resolve citations from the installed bundle;
- disk delta and retained-directory inventory remain within the documented budget;
- update rerun is idempotent and does not create another full rollback or candidate copy.

Only after those checks may the nightly failure marker be deleted and issues #152/#153 be closed.

## Rejected alternatives

- **Rewrite the latest release bundle in place.** This invalidates the immutable seal and signature.
- **Keep seeding from GitHub latest.** It preserves the closed loop that caused #152.
- **Delete N-1 plugin cache after install.** A long-running session can still hold N-1; age and ordinal
  are not liveness evidence.
- **Keep every full plugin generation.** Safe but wasteful; the compatibility shell preserves the
  only cold-session entrypoints while removing duplicate payload and rediscovery surfaces.
- **Trust the local version stamp.** A stamp proves neither publication nor installability.
- **Keep every rollback forever.** Safe failure handling still needs bounded, evidence-driven cleanup.

## Consequences

- Corpus promotion becomes an explicit, reviewable input rather than an accidental side effect.
- Publication can resume after partial failure without splitting the public generation.
- Live Claude sessions retain valid hook roots across updates.
- The large corpus is stored once as the active KB plus only a genuinely necessary recovery copy.
- CI needs a corpus-seed descriptor and a seed-publication path; this is deliberate because git does
  not contain the RVF binaries it must ship.

## Acceptance criteria

1. A test breaks if CI downloads an unpinned latest bundle as corpus input.
2. A test breaks if any canonical RVF lacks a byte-bound generation entry.
3. A live-session fixture continues executing UserPromptSubmit and SessionEnd through its retired
   hook root after an update, while stale skills/commands/hooks are absent.
4. A release fixture refuses or repairs GitHub/npm generation divergence.
5. Two consecutive no-op updates produce zero additional full KB backups.
6. A fresh public install and a fresh host window report the same release generation.
7. Coverage documentation is generated from the sealed manifest, source ledger, and gist inventory.

## Currency log
| 2026-09-04 | Reconciled Windows convergence verification with canonical QA: both lanes now regenerate the convergence manifest after checkout, so a pull request's synthetic merge ref is evaluated as the exact candidate rather than against the branch-tip snapshot. The convergence assertion remains enforced. | `.github/workflows/ci.yml`; `tests/unit/convergence-workflow-parity.test.mjs`; issue #241. |
| 2026-08-31 | Closed the PR merge-ref freshness gap: canonical QA now regenerates the convergence manifest inside the exact checked-out candidate before running the gate, preventing a branch-generated snapshot from becoming stale on GitHub's synthetic merge ref. | `.github/workflows/canonical-qa.yml`; `scripts/convergence-manifest.mjs`; issue #193 release follow-up. |
| 2026-08-31 | Regenerated the convergence manifest after the portable watchdog correction; the manifest now binds the actual PR tip rather than an earlier rebased commit. | `data/convergence-manifest.json`; PR #211. |
| 2026-08-31 | Reconciled the watchdog's Windows command boundary after hosted PR evidence showed shell:false cannot assume an `npx` shim; the unit lane now invokes Vitest through Node while retaining the same exact candidate test surface. | `.github/workflows/ci.yml`; `scripts/ci/step-watchdog.mjs`; PR #211. |
| 2026-08-31 | Reconciled after the 4.3.3 main-branch merge and CI watchdog change; generation identity remains exact-SHA bound and long release stages now fail at named boundaries with receipts. | `scripts/ci/step-watchdog.mjs`; `.github/workflows/ci.yml`; exact-SHA CI run `33358984585`. |

| 2026-08-30 | The two-stage candidate build now validates against the same projection evidence it later packages: seed-compatible gist receipts, class registry, derived receipts, excluded stores, and the projected generation ledger are all present at validation time. | `scripts/release-projection.mjs`, `scripts/build-bundle.mjs`, `plugin/scripts/coverage-integrity.mjs` |
| 2026-08-30 | The projected validation input now receives the canonical private-store fence from the checkout before inventory validation, closing the remaining seed-versus-policy input mismatch. | `scripts/build-bundle.mjs`; `kb/PRIVATE-STORES.json`; exact-SHA release-QE. |
| 2026-08-30 | The release projection now derives its totals and enumeration receipt from the seeded row set and carries the source-observation digest as a separate bound evidence identity. | `scripts/release-projection.mjs`; exact-SHA release-QE. |
| 2026-08-30 | The second-stage builder now stages the projected gist receipt before validation, making the public evidence partition identical before and after archive assembly. | `scripts/build-bundle.mjs`; exact-SHA release-QE. |
| 2026-08-30 | Replayed the complete two-stage release locally and confirmed identical public inventory partition hashes before and after archive assembly. | `scripts/release-projection.mjs`; `scripts/build-bundle.mjs`; local proof `566fe4f5bb435f11c8a924a8cef9b8c251c508051653121f39e7533536455daf`. |
| 2026-08-30 | The repository pre-push gate now verifies the generated convergence manifest, making stale source identity a local push failure instead of a hosted QA failure. | `scripts/git-hooks/pre-push`; `scripts/convergence-manifest.mjs`; exact-SHA CI. |
| 2026-08-30 | The candidate’s full CI contract is now pull-request gated as well as main-push gated, preventing an untested merge from becoming the first place release failures appear. | `.github/workflows/ci.yml` |

| 2026-08-30 | Rechecked generation convergence after the seed lacked the source-controlled public-store class registry; bundle assembly now keeps policy metadata on the source plane and corpus bytes on the seed plane. | `scripts/build-bundle.mjs`; `kb/public-store-classes.json`; exact-SHA release-QE. |

| 2026-08-30 | Rechecked generation convergence after the exact-SHA release-QE failure; the immutable seed's legacy gist evidence is carried explicitly into the projected bundle and is not labeled current-source evidence. | Commit `f526bab`; `scripts/release-projection.mjs`; `scripts/build-bundle.mjs`; `data/corpus-seed.json`. |

| 2026-08-30 | Removed the forbidden live gists observation from the release-QE bundle step and made the coverage projection explicitly derive its public generation set from the sealed seed ledger. | Issue #201; `.github/workflows/ci.yml`; `scripts/release-projection.mjs`. |

| 2026-08-30 | Reconciled the host-only updater after live v4.3.1 had no GitHub assets and the updater stranded the Stable Spine on 4.2.2-dev. | `bin/install.mjs` now keeps executable host synchronization moving when the optional KB refresh is unavailable; the release asset gate remains authoritative. |

| 2026-08-30 | Automatic PR checks now converge through one bounded canonical runner; the older matrix is manual diagnostic coverage. | `.github/workflows/ci.yml`, `.github/workflows/qe-4-3.yml`, and `scripts/qa-runner.mjs` reduce duplicate observations while leaving protected publication authority unchanged. |
| 2026-08-30 | Query-oracle provenance now preserves strict ancestry by default and explicitly supports fetched, content-bound source commits after squash merges; release-QE opts into that mode and tests it. | `scripts/retrieval-canary.mjs`, `scripts/public-verification-inputs.mjs`, `.github/workflows/ci.yml`, `tests/unit/retrieval-canary.test.mjs` |

| 2026-08-30 | Version propagation is now a single source edit followed by consistency verification, and release QA binds the candidate to one SHA. | `scripts/set-version.mjs`, `scripts/sync-version.mjs`, and `scripts/qa-runner.mjs` remove the emergency publish path that let public and source versions diverge. |

| 2026-08-23 | Candidate receipts now bind not only pass/fail counts but the skipped and failed suite identities used to decide convergence. | Commit `cc25c24` prevents a partial cross-platform observation from masquerading as a converged generation. |
| 2026-08-23 | Windows candidate qualification probes the shared installer import before running its suites. | Hosted exact-SHA evidence isolated the failure to installer-import suites; convergence still requires every assertion and every receipt to PASS. |
| 2026-08-23 | Candidate lane steps fail fast and preserve the exact partial receipt. | A failed step no longer launches later unrelated checks; convergence still requires every required receipt to PASS. |
| 2026-08-23 | Windows installer-import evidence is process-isolated and the hosted conformance bound reflects measured execution. | Convergence still requires every separate receipt to PASS; no assertion is removed or weakened. |
| 2026-08-23 | Candidate generation now uses only deterministic resource evidence; live-only preconditions remain an explicit separate regime, and Windows test invocation is shell-independent. | Commit `0e30d68` preserves one-generation artifact binding while removing two false blockers from the candidate path. |
| 2026-08-23 | The candidate cannot enter artifact qualification unless all required QE lanes have completed, and failed receipts remain available for diagnosis. | Commit `b570e25` strengthens the one-generation release boundary without changing payload identity or publication authority. |
| 2026-08-23 | Candidate convergence now consumes the new six-lane exact-SHA QE aggregate before artifact publication; the one-generation payload and public-channel rules are unchanged. | Commit `b3ddb0d` replaces the auto-triggered legacy matrix with fail-fast preflight, isolated receipts, and a zero-spend local deterministic contract in `.github/workflows/qe-4-3.yml`; no publication mutation was added. |
| 2026-08-23 | Corrected the Windows argv boundary after exact-SHA job `97218861232` split the immutable release title; generation identity and artifact binding remain unchanged. | `scripts/windows-command.mjs` shares the measured cmd invocation contract with the release authority, and the focused authority suite asserts title, notes, bundle, and receipt remain distinct arguments. |
| 2026-08-23 | Re-read the release-generation boundary after issue #163 exposed Windows shell argument splitting; one-generation and immutable-artifact requirements remain unchanged. | `scripts/release.mjs` preserves the exact title, notes, bundle, and receipt arguments on Windows; focused corpus-seed tests prove the release payload. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-23 | QE artifact download now targets the canonical receipt directory, and Vitest retains bounded verbose diagnostics. | This prevents a converged candidate from being rejected because evidence landed one directory away, while preserving exact-SHA convergence rules. |
| 2026-08-23 | Candidate receipts now retain bounded stdout/stderr tails for process-level failures. | Commit `1310fb6` makes convergence failures diagnosable from exact-SHA evidence without changing the one-generation or publication rules. |
| 2026-08-21 | Re-read the shipped-code path after the release-QE failure exposed three index-persistence hash mismatches. | `.github/workflows/ci.yml` now invokes the existing `rvf-index-audit.mjs --repair` restamp before `scripts/build-bundle.mjs` enforces exact ledger closure. A local reproduction on the configured v4.2.1 seed reported `stamped=3`, then assembled 186 audited RVFs with zero index failures; no recursive latest lookup or unbuilt coverage generator is used. |
| 2026-08-21 | Implemented the emergency correctness slice after Fable 5 and GPT-5.6-Sol convergence. | `.github/workflows/ci.yml` pins the immutable corpus seed; `scripts/build-bundle.mjs` validates strict ledger closure; `bin/install.mjs` retains live plugin roots by exact process-incarnation leases; and the protected publisher rechecks `origin/main` immediately before mutation. Focused integrated tests cover these paths. Rollback-storage receipts, fresh interactive-window proof, and generated coverage remain explicit post-restoration work and are not claimed shipped by this row. |
