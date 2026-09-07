Updated: 2026-09-07 11:07:28 EDT | Version 1.2.0
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

The plugin manifest remains the version source. `npm run version:set -- X.Y.Z` propagates generated
surfaces, and `npm run convergence:write` refreshes source identity. Neither command proves behavior.
