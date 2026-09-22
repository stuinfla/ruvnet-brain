Updated: 2026-09-20 11:10:00 EDT | Version 1.2.1
Created: 2026-09-05 19:00:00 EDT

# QA and release process

The release source and integration producer is [release-qualification.mjs](../scripts/release-qualification.mjs).
Its reviewed requirements and test selection come from
[release-qualification-contract.mjs](../scripts/release-qualification-contract.mjs).
`npm run release:qualify -- --suite source --report <new-path>` runs that source contract;
the integration suite uses the same producer. Do not copy the test inventory into another gate.
The [execution contract](qa-execution-contract.md) explains receipts and acceptance.

The historical suite of approximately 4,332 unit cases was **not individually audited in full**.
It remains developer diagnostics, not mandatory release qualification. The retained release tests
were individually reviewed, including fixtures and assertions. The [proof](reviews/release-test-relevance-proof-20260907.md),
[install/update](reviews/release-test-relevance-install-20260907.md), and
[release QE](reviews/release-test-relevance-qe-20260907.md) reviews record relevant cases,
limitations, and exclusions. A passing historical suite does not establish every test's relevance.

Automatic Brain host hooks and the project command interceptor are retired. Shipped registries
are empty; installation removes exact owned legacy registrations while preserving foreign settings.
MCP, skills, explicit commands, and explicit qualification remain available. `npm run hooks:check`
checks retirement without executing hooks. Tests for dormant handlers use explicit fixtures.

Qualification runs on the actual platform, binds the reviewed contract and source bytes, and rejects
missing cases, failures, skips, TODOs, and source changes. A local dirty-tree result is diagnostic;
promotion requires a clean exact SHA and its matching trusted candidate workflow/artifact evidence.
Qualify the candidate once and consume its evidence; do not rebuild the payload during publication.

Protected publication consumes the exact sealed npm package and signed bundle. Channel convergence
is not completion. All nine public combinations of three operating systems and three host modes
must verify the public candidate. Each dual-host platform leaf must also contain real native
scheduled installed-update evidence: two sequential runs, exact installed coverage, second-run noop,
measured storage, and owned-job cleanup. Imported corpus evidence remains imported; upstream freshness
is UNKNOWN unless a separate producer proves it. Only terminal `install-verified` closes the release.

`qa:pr`, `qa:release`, and the historical test aliases remain explicit diagnostics. Their inventory
is [qa-lanes.mjs](../scripts/qa-lanes.mjs); their PASS cannot replace reviewed qualification,
packaged runtime checks, public verification, or complete North Star conformance.

## Exact-SHA promotion (do not merge the release PR)

Push the candidate commit to `release/<version>` and wait for `release-candidate-preflight` to pass.
Then open a PR from that release branch to `main`; its `canonical-qa` and `integration` consumers
verify the preflight receipt and must pass on the exact candidate SHA. The PR provides review context
and required-check evidence.

From a clean candidate checkout, the first step is reproducible without a version pin:

```bash
CANDIDATE_SHA="$(git rev-parse HEAD)"
VERSION="$(node -p "require('./package.json').version")"
git push origin "$CANDIDATE_SHA:refs/heads/release/$VERSION"
```

After the release preflight is green, open the PR and wait for its checks:

```bash
gh pr create --base main --head "release/$VERSION" --title "Release $VERSION"
gh pr checks --watch
```

Do not click Merge, Squash, or Rebase: each creates a new SHA while the publisher requires the
preflighted SHA unchanged on `main`. After the candidate artifact and required checks pass, promote
with an ordinary non-force fast-forward push. Confirm current `origin/main` is an ancestor first and
verify the remote ref afterward. If the push is rejected, stop and repair branch-policy/check
configuration; never force-push or bypass checks. A changed source SHA must repeat preflight.

`release:proof --status --quick` is only a local/main diagnostic. Because it omits vector evaluation,
it reports `INCOMPLETE` rather than `PASS` when all other observations are clean. It does not
qualify a candidate. Candidate authority comes from the typed preflight receipt and exact-SHA
workflow evidence. After the PR's exact-SHA consumer checks pass and `main` is still an ancestor,
the final source promotion is `git push origin "$CANDIDATE_SHA:refs/heads/main"`; then verify the
remote ref equals `$CANDIDATE_SHA` before dispatching `protected-release.yml` with `mode=code`, that
SHA, and the derived version.

The plugin manifest remains the version source. `npm run version:set -- X.Y.Z` propagates generated
surfaces, and `npm run convergence:write` refreshes source identity. Neither command proves behavior.
