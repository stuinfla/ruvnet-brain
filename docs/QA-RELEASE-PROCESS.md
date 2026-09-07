Updated: 2026-09-05 19:00:00 EDT | Version 1.1.0
Created: 2026-09-05 19:00:00 EDT

# QA and release process

The [QA execution contract](qa-execution-contract.md) defines producer selection, dependency
handling, source identity, receipt locations, and the distinction between diagnostics and release
qualification. The executable inventory is [qa-lanes.mjs](../scripts/qa-lanes.mjs); this overview
does not maintain a second lane list.

`npm run qa:pr -- --list` prints the default diagnostic inventory.
`npm run qa:release -- --list` includes release diagnostics. Passing either command's diagnostics
alone is not proof of a packaged install, North Star conformance, or a published release.

`npm run convergence:check` validates `data/convergence-manifest.json`, the deterministic identity
boundary for implementation files, version surfaces, ADR inventory, and ownership checks.
Regenerate it with `npm run convergence:write` when its governed inputs change; a stale manifest
fails QA. Regeneration records identity, not behavioral verification.

The plugin manifest (`plugin/.claude-plugin/plugin.json`) is the only hand-edited version field.
Use `npm run version:set -- X.Y.Z` to propagate and immediately verify all package, bundle, README,
and plugin surfaces. Do not use `npm version` or hand-edit a generated surface.

Publication remains a protected-workflow operation. Local checks may prepare and verify bytes, but
they never publish npm packages, move dist-tags, or create GitHub Releases. The protected release
workflow receives the exact candidate SHA and version, downloads the sealed artifact, publishes it,
and runs the post-publication receipt against npm, GitHub, and a clean install.

Corpus rebuilds and nightly learning are separate evidence producers, not actions performed by the
local QA runner. Their release obligations remain defined by the accepted architecture, including
[ADR-072](adr/0072-whole-product-integrity-conformance.md); a diagnostic omission is not an exemption.
A timeout retains an explicit non-passing receipt, never a successful result.
