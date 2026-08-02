---
name: release-proof
description: Fail-closed exact-artifact release and deployment authority. Use before saying a release is ready, pushing a release commit, publishing npm packages, creating GitHub releases, deploying production, closing release-blocking issues, or claiming all gates are green. Requires clean immutable lineage, zero open issues, exact-SHA GitHub success, nonzero no-skip QE, packed-artifact host tests, installed Brain/RVF proof, independent graders, and post-publication byte verification.
---

# Release Proof

Treat release as a two-seal transaction. Never publish from a source checkout merely because its
tests pass. Never turn `UNKNOWN`, `SKIP`, `todo`, `0 tests`, dirty state, or an agent report into
green.

## Non-bypassable rules

1. Use the exact source SHA and one packed-artifact SHA-256 everywhere.
2. Require zero open GitHub issues for RuvNet Brain. A local fix is not a closed issue.
3. Require every named GitHub workflow to complete successfully on the exact candidate SHA.
4. Reject any test/QE result with zero tests, skips, todos, unknowns, pending jobs, or failures.
5. Require two distinct independent graders scoring at least 95, each bound to the SHA and digest.
6. Install the sealed artifact into virgin Claude Code and Codex homes; test their real entrypoints.
7. Require the source package, Claude manifest, Codex manifest, packed npm version, bundle
   `brainVersion`/`releaseTag`, and both installed host versions to identify one exact generation.
8. Require the active Brain registry to contain the `ruvnet-brain` RVF store and require narrow,
   broad, and concurrent cited searches to complete within 80% of their deadline.
9. Publish only through the protected release workflow. Never run `npm publish` or `gh release
   create` locally.
10. After publication, download npm and GitHub artifacts, compare their bytes with the seal, install
   both hosts again, query the active MCP again, and require `published-surface-probe` green.
11. Close an issue only after posting its acceptance evidence. Never close from source inspection.

## Candidate seal

Generate the receipt from commands in the protected candidate workflow. Do not hand-author it.
Dispatch `.github/workflows/protected-release.yml` only with the full candidate SHA, the exact
current version, and the successful exact-SHA CI run ID whose named `release-qe` job produced
`release-evidence-<sha>`. The workflow derives the artifact digest from those sealed bytes and checks
every binding before creating its handoff and again at the Production boundary. Missing artifacts,
pending/red jobs, malformed inputs, version splits, and byte mismatches stop before the publisher.
Validate it from the repository with:

```bash
node scripts/release-proof.mjs --candidate release-evidence/candidate-receipt.json
```

From an installed Claude plugin, run:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/release-proof/scripts/release-proof.mjs" \
  --candidate release-evidence/candidate-receipt.json
```

Exit 0 is the only candidate seal. Read every failure code; repair the system, regenerate evidence,
and rerun. Do not edit the receipt to remove a failure.

## Publication seal

After the protected publisher completes, validate both receipts:

```bash
node scripts/release-proof.mjs \
  --candidate release-evidence/candidate-receipt.json \
  --publication release-evidence/publication-receipt.json
```

Only exit 0 permits “shipped,” “deployed,” “green,” or “ready.” If publication occurred but this
seal fails, say `PUBLICATION DEGRADED`, preserve the previous known-good release, and repair or
roll back through the release workflow.

`scripts/release.mjs --publish` is intentionally unusable from a local shell or another workflow.
Its invocation guard requires GitHub Actions workflow `protected-release`, the candidate receipt,
and matching SHA/digest/version bindings before any push, tag, release, or npm action. The workflow
then runs `scripts/publication-receipt.mjs` after channel verification. That producer independently
downloads the sealed package from npm and the GitHub Release, requires both copies to match the
candidate bytes and identity, installs the npm copy into virgin Claude and Codex homes, proves the
installed self-RVF/readiness/search deadline, and runs `published-surface-probe` on the candidate
SHA. It refuses to overwrite an existing receipt. The workflow uploads both append-only receipts
only after the two-receipt validator exits 0; missing evidence is red, never inferred.

## Evidence and issue handling

For each issue:

1. Reproduce the original symptom against the old/public artifact.
2. Run its acceptance criteria against the sealed candidate.
3. Disable or mutate the fix; the regression must fail.
4. Post SHA, artifact digest, commands, results, and untested limits to the issue.
5. Close only after the GitHub evidence is visible and exact-SHA required checks are green.

Read [references/receipt-contract.md](references/receipt-contract.md) for receipt fields and failure
semantics. Store the protocol and final release receipt in Ruflo/AgentDB only after the publication
seal passes.

## Status language

- Candidate seal absent or failed: `NOT READY`.
- Candidate sealed, not published: `SEALED, NOT SHIPPED`.
- Published, publication seal pending: `PUBLISHED, NOT VERIFIED`.
- Publication seal failed: `PUBLICATION DEGRADED`.
- Both seals exit 0: `SHIPPED AND VERIFIED`.
