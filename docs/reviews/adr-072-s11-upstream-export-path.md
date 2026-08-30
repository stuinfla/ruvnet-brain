# ADR-072 S11 upstream export-path evidence

Date: 2026-08-22  
Status: Source-bound fix proven; project acceptance remains blocked on upstream release

## Defect

The Ruflo CLI accepted `memory export --path` and `memory import --path` syntactically through
the command surface, but the MCP handlers discarded that path and opened their default
`.swarm/memory.db`. A source database could therefore contain rows visible to `memory list` while
export reported zero rows and import restored nothing.

## Isolated fix

In the isolated Ruflo PR-3083 clone (`/private/tmp/ruvnet-ruflo-pr3083`), commit
`55fe560355c4b31b4319ee5a5e3a625474c11f2c`:

- adds the explicit database path to export/import tool schemas;
- passes it through initialization, listing, and storing;
- adds the same `--path` option to both CLI subcommands.

The patch is layered on the pagination candidate `a0262e844b9c5ddcc6723e58e19bdaf896731336`.
It was not installed globally and does not modify the primary ruvnet-brain checkout.

## Real round-trip proof

Against two fresh temporary databases, two rows were stored in `continuity`, exported from the
source path, imported into the destination path, and listed from the destination path:

- source rows: 2
- exported entries: 2
- imported rows: 2
- restored keys: `probe/a`, `probe/b`
- build: `pnpm -r build` passed

The strict ADR-073 cross-host contract is preserved. S11 remains release-blocked until this exact
source fix is merged/released by Ruflo and the proof is repeated against the global runtime.
