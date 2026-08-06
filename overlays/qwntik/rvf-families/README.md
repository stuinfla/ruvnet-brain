# QWNTIK private RVF family overlay

This directory version-controls the private Testimate, MakerKit, and SayThanks RVF cluster without
placing private stores in the public RuvNet Brain bundle.

`registry.json` binds family membership, aliases, RVF bytes and hashes, source provenance, and the
six family/routing manifests. `registry.mjs check` is read-only. `registry.mjs apply` first verifies
every RVF byte/hash, creates a rollback copy, merges only the named private entries into the live
registries, and reads the result back.

Private `SOURCE.json` entries carry `updateManaged: false`. They remain visible as provenance while
`forge-update.mjs` excludes them from public release replacement.

```sh
node overlays/qwntik/rvf-families/registry.mjs check \
  --kb-dir /opt/quantic-impact/clients/daxiom/ruvnet-brain/kb \
  --manifests-dir /opt/quantic-impact/clients/daxiom/ruvnet-brain/manifests

node overlays/qwntik/rvf-families/registry.mjs apply \
  --kb-dir /opt/quantic-impact/clients/daxiom/ruvnet-brain/kb \
  --manifests-dir /opt/quantic-impact/clients/daxiom/ruvnet-brain/manifests
```
