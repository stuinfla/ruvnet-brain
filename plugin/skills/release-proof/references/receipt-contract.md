# Receipt contract

The authority accepts schema version 1 JSON. Receipts are append-only evidence artifacts generated
by protected workflows, never editable status documents.

## Candidate receipt

Required bindings:

- `sha`, `tree`, `dirty:false`
- `version`, `tag`, and exact-equal `sourceVersions.package`, `sourceVersions.claudePlugin`, and
  `sourceVersions.codexPlugin`
- `artifact.path`, `artifact.sha256`, `artifact.sourceSha`
- exact-equal `artifact.version`, `artifact.bundle.brainVersion`, and
  `artifact.bundle.releaseTag`
- exact-SHA release-vector verdict with zero unknown/skipped
- aggregate tests with nonzero total, all passed, zero failed/skipped/todo
- fresh coverage floor and zero critical/high security findings
- zero open GitHub issues
- required GitHub workflow results on the same SHA
- virgin-home Claude and Codex results on the same artifact digest and exact candidate version
- installed Brain self-RVF plus narrow, broad, and concurrent cited search timings
- nonzero Agentic QE totals with zero failed/skipped
- two distinct independent grader receipts at 95 or higher, bound to SHA and digest

## Publication receipt

Required bindings:

- candidate SHA and artifact digest
- candidate `version` plus exact-equal npm version, GitHub tag, bundle `brainVersion`/`releaseTag`,
  and installed Claude/Codex versions
- npm and GitHub release bytes matching the candidate digest
- clean installed Claude and Codex results from the public package
- installed Brain self-RVF and broad search within 80 percent of deadline
- successful exact-SHA `published-surface-probe`

## Failure semantics

Any missing field, split version identity, malformed digest, mismatched SHA, dirty tree, open issue, absent/pending/red
workflow, skipped/todo/zero-test result, missing RVF store, uncited search, deadline-margin breach,
low/missing grader, or public byte mismatch is `FAIL`. There is no warning state and no score
average. The authority never publishes; publication belongs to the protected workflow after the
candidate seal.
