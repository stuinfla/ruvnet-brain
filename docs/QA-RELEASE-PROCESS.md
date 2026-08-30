# QA and release process

The repository has two intentionally small gates:

* `npm run qa:pr` is the required pull-request gate. It runs version, substitution, catalog, unit,
  mesh, regression, plugin, and integration lanes in a fixed order. Each lane has a timeout and
  writes `.qa/<lane>.json`; `.qa/aggregate.json` is the only verdict consumed by CI.
* `npm run qa:release` adds mutation and claims checks. It is the release-candidate gate and must
  run against one clean commit. The receipt records the exact SHA, version, lane status, and timing.

The plugin manifest (`plugin/.claude-plugin/plugin.json`) is the only hand-edited version field.
Use `npm run version:set -- X.Y.Z` to propagate and immediately verify all package, bundle, README,
and plugin surfaces. Do not use `npm version` or hand-edit a generated surface.

Publication remains a protected-workflow operation. Local checks may prepare and verify bytes, but
they never publish npm packages, move dist-tags, or create GitHub Releases. The protected release
workflow receives the exact candidate SHA and version, downloads the sealed artifact, publishes it,
and runs the post-publication receipt against npm, GitHub, and a clean install.

Corpus rebuilds and nightly learning are separate evidence producers. They are not prerequisites for
the fast PR gate unless the changed paths alter the corpus or release bundle. A timeout is a failed
lane with a receipt, never a pending or successful result.
