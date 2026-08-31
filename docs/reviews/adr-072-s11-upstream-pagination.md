# ADR-072 S11 upstream pagination evidence

Date: 2026-08-22
Status: Evidence recorded; project acceptance remains blocked

## Source-bound result

Ruflo commit `a0262e844b9c5ddcc6723e58e19bdaf896731336` (`fix(memory): expose structural list pagination`) was built in an isolated clone at `/private/tmp/ruvnet-ruflo-pr3083`.

- `corepack pnpm -r build`: PASS
- structural pagination suite: 1 file, 7 tests passed
- real CLI traversal with five fresh rows:
  - limit 2, offset 0: total 5, 2 entries, next offset 2
  - limit 2, offset 2: total 5, 2 entries, next offset 4
  - limit 2, offset 4: total 5, 1 entry, terminal page

This proves the upstream pagination commit itself. It is not installed in the global Ruflo `3.38.19` used by this project.

## Remaining blocker

The candidate `memory export`/`memory import` path does not accept or honor `--path`; a fresh-DB round trip reported zero entries while direct `memory list --path` saw all five. Project S11 therefore remains blocked for cross-host continuity until the export backend is source-bound or the acceptance contract explicitly removes that dependency. No global install or primary checkout was changed.
