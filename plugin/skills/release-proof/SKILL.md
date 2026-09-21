---
name: release-proof
description: Fail-closed exact-artifact release and deployment authority. Use before saying a release is ready, pushing a release commit, publishing npm packages, creating GitHub releases, deploying production, closing release-blocking issues, or claiming all gates are green. Requires clean immutable lineage, zero labeled release blockers, exact-SHA GitHub success, nonzero no-skip QE, packed-artifact host tests, installed Brain/RVF proof, and post-publication byte verification.
updated: 2026-09-20
---

# Release Proof

Treat release as a two-seal transaction. Never publish from a source checkout merely because its
tests pass. Never turn `UNKNOWN`, `SKIP`, `todo`, `0 tests`, dirty state, or an agent report into
green.

## Non-bypassable rules

1. Use the exact source SHA and one packed-artifact SHA-256 everywhere.
2. Require zero open GitHub issues labeled `release-blocker`. Unlabeled backlog is not release authority; a local fix does not clear a labeled blocker.
3. Run CI, integration, UX, and stranger qualification once in
   `.github/workflows/release-candidate-preflight.yml` on `release/**`. Require its exact-SHA,
   source-bound package and aggregate before that unchanged SHA reaches `main`.
4. Reject any test/QE result with zero tests, skips, todos, unknowns, pending jobs, or failures.
5. When the candidate changes architecture or the retrieval oracle, require the accepted Fable 5 and GPT-5.6-Sol design-review receipts for that change. Routine releases do not manufacture caller-supplied reviewer keys; bundled public keys are integrity material, not an independent trust anchor.
6. Install the sealed artifact into virgin Claude Code and Codex homes; test their real entrypoints.
7. Require the source package, Claude manifest, Codex manifest, packed npm version, bundle
   `brainVersion`/`releaseTag`, and both installed host versions to identify one exact generation.
8. Require the active Brain registry to contain the `ruvnet-brain` RVF store and require narrow,
   broad, and concurrent cited candidate searches to complete within 80% of their deadline.
   For fresh public stabilization verification, `stabilization-public-deadline-v1` requires the
   first cited search in every host mode and the Brain probe within the enforced 30-second
   deadline. The 24-second headroom target remains a performance follow-up, not promotion authority.
   Receipts without this named policy retain the legacy 80% rule; failed runs are not relabeled.
9. Publish only through the protected release workflow. Never run `npm publish` or `gh release
   create` locally.
10. After publication, download npm and GitHub artifacts, compare their bytes with the seal, install
   both hosts again, query the active MCP again, and require `published-surface-probe` green.
11. Close an issue only after posting its acceptance evidence. Never close from source inspection.

## Candidate seal

Generate the candidate receipt in `.github/workflows/release-candidate-preflight.yml`; do not
hand-author it. Push the exact candidate commit to `release/<version>` to run the long CI,
integration, UX, and stranger lanes once. Require the successful exact-SHA artifact
`release-candidate-<SHA>` before promotion.

Then open a PR from that `release/**` branch to `main`. The release-branch `canonical-qa` and
`integration` consumers verify the producer receipt and report the required checks on the exact
candidate SHA. Wait for both required checks to pass on that SHA. Do **not** use the GitHub PR merge
button: merge, squash, and rebase all create a different commit identity and invalidate the sealed
artifact. Promote only with an ordinary non-force fast-forward push after confirming current `main`
is an ancestor of the candidate:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main "$CANDIDATE_SHA"
git push origin "$CANDIDATE_SHA:refs/heads/main"
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$CANDIDATE_SHA"
```

If the normal push is rejected, stop and repair branch-policy or required-check configuration; never
force-push, use an admin bypass, or substitute a merge-created SHA. Any source change requires a new
candidate preflight and artifact. The PR is review context; its merge button is not the promotion
mechanism.

Dispatch `.github/workflows/protected-release.yml` only after the fast-forward. It is the sole
publication controller: it proves current `origin/main` is the preflight SHA, selects the artifact
by its deterministic name rather than a caller-supplied run ID, revalidates every receipt,
payload/source binding, and digest, then signs and publishes once. The same protected run downloads
the public bytes, executes the three-OS by three-host-mode matrix, and appends `install-verified`.
It does not rerun the long preflight lanes. Conditional architecture/retrieval-oracle reviews are
candidate inputs only when the governed surfaces changed; they do not authorize publication.
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

`npm run release:proof -- --status --quick` is a live local/main diagnostic only. It deliberately
does not evaluate the release vector and therefore reports `INCOMPLETE` when that is its only
missing evidence. It is never a candidate receipt or publication authority. Use the exact candidate
receipt and workflow artifacts for release decisions.

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
