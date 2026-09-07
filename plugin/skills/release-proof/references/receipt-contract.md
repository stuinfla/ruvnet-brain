# Receipt contract

Updated: 2026-09-07

The authority accepts only typed receipt schemas. The candidate receipts are emitted by
`release-candidate-preflight` and imported by `protected-release`; publication receipts are emitted
inside that protected run. All are append-only evidence artifacts, never editable status documents.

## Candidate receipt

Required bindings:

- `sha`, `tree`, `dirty:false`
- `version`, `tag`, and exact-equal `sourceVersions.package`, `sourceVersions.claudePlugin`, and
  `sourceVersions.codexPlugin`
- `artifact.path`, `artifact.sha256`, `artifact.sourceSha`
- artifact name exactly `release-candidate-<sha>`; selection is by name and exact source SHA, never
  by a caller-supplied workflow run ID
- exact-equal `artifact.version`, `artifact.bundle.brainVersion`, and
  `artifact.bundle.releaseTag`
- exact-SHA release-vector verdict with zero unknown/skipped
- aggregate tests with nonzero total, all passed, zero failed/skipped/todo
- fresh coverage floor and zero critical/high security findings
- zero open GitHub issues labeled `release-blocker`
- required GitHub workflow results on the same SHA
- virgin-home Claude and Codex results on the same artifact digest and exact candidate version
- installed Brain self-RVF plus narrow, broad, and concurrent cited search timings
- nonzero Agentic QE totals with zero failed/skipped
- when architecture or retrieval-oracle surfaces changed, accepted Fable 5 and GPT-5.6-Sol review
  receipts bound to that change; no per-release caller-supplied key can create independent authority

## Publication receipt

Required bindings:

- candidate SHA and artifact digest
- candidate `version` plus exact-equal npm version, GitHub tag, bundle `brainVersion`/`releaseTag`,
  and installed Claude/Codex versions
- npm and GitHub release bytes matching the candidate digest
- clean installed Claude and Codex results from the public package
- installed Brain self-RVF and measured first cited searches within the declared acceptance policy
- `acceptancePolicy: stabilization-public-deadline-v1` requires a fixed 30,000ms deadline and
  finite, nonnegative host and Brain timings at or below it; larger budgets are rejected
- receipts without that policy retain the legacy 80-percent margin; unknown policies fail
- successful exact-SHA `published-surface-probe`

Stuart authorized a materially improved stabilization release on September 7, rather than
requiring every historical performance goal for promotion. The public runtime already enforces
a 30-second deadline. The new policy removes only the additional 24-second promotion margin.
It does not replace first-search timings with warm timings or reduce retrieval, citation,
artifact-integrity, native-update, or host-installation requirements. Fresh signed evidence is
required; prior failed workflows remain failed.

Native update verification uses `bin-links=false` in the isolated home's `.npmrc`, which
persists across scheduled processes. The receipt records this installation configuration.
This disables optional npm command shims; the reader runs through Node directly. The default
npm installation creates a `semver` symlink that 4.3.10's updater rejects. Consequently this
proof covers the explicitly configured installation, not default installations with command
shims. Repairing default-install updater compatibility remains a follow-up; symlink rejection
is not bypassed in the updater or inventory verifier.

Before provider mutation, `protected-release` revalidates the imported candidate receipt, package
payload, source binding, and digest against current `origin/main`. It consumes the long-lane proof;
it does not rerun CI, integration, UX, or stranger qualification.

## Failure semantics

Any missing field, split version identity, malformed digest, mismatched SHA, dirty tree, open labeled release blocker, absent/pending/red
workflow, skipped/todo/zero-test result, missing RVF store, uncited search, deadline-margin breach,
missing required change-triggered design review, or public byte mismatch is `FAIL`. There is no
warning state and no score average. Preflight owns candidate qualification; one `protected-release`
run owns import revalidation, publication, public verification, and the terminal receipt.
