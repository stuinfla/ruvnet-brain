# RuvNet Brain — Architecture Decision Records

Each ADR records a decision the 3-way red-team forced, so it can't be quietly regressed.

| ADR | Decision | Kills |
|---|---|---|
| [0001](0001-verified-bundle-not-single-file.md) | Ship a verified **zip bundle**, not a single embedded `.rvf` (single-container = deferred spike) | F9 "one magic file" fiction |
| [0002](0002-ground-truth-multivendor-gate.md) | Quality gate of record = **ground-truth-against-source + multi-vendor panel**, not a captured LLM grader | F5/F8 asserted-not-proven |
| [0003](0003-point-deeper-retrieval.md) | **Point deeper**: KB resolves to exact `file:line` + neighbors + whole-doc; agent never chooses to dig | F1 the 15-month skim-and-quit |
| [0004](0004-effectiveness-first.md) | **Effectiveness first**; size is a later pass; f32/multi-vector over SQ8 for v1 | shallow-for-the-sake-of-small |
| [0005](0005-behavioral-grounding-not-lock.md) | **Retrieve-and-inject** grounding (⚠ *reconciled 2026-07-06 — hard-deny/Stop/SLO NOT shipped; see the ADR banner + ADR-0009*) | F4 drift; enforcement theater |
| [0006](0006-segment-per-repo.md) | **Segment-per-repo** + cross-segment normalization, not one merged HNSW | merge-confusion / false "cheap incremental" |
| [0007](0007-tiered-scope.md) | **Tiered scope** (T0–T3) by ingest depth; union selection rule | F7 unbounded-scope death |
| [0008](0008-autonomous-engineering-loop.md) | **Autonomous build loop**: Ruflo *decides* · Claude Code *acts* · brain *grounds*; SPARC + score-to-≥98 + ADR-0005 hooks + one-command install | the "brain alone is the product" / drift-on-action |
| [0009](0009-mirror-discipline-self-audit-and-qa.md) | **Mirror Discipline**: the brain passes its own bar — single version SoT, smoke-gated publish, eval flywheel, ADR-QA/DDD-QA/doc-currency as capabilities, ADR-0005/DDD reconciled to reality | self-drift; the "grounded product that lies about its own version" |
