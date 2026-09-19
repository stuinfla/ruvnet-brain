---
id: ADR-089
title: Doctor verifies the installed search engine separately from the validator
status: Accepted
date: 2026-09-19
updated: 2026-09-19
version: 1.0.2
governs:
  - scripts/installed-brain-health.mjs
  - bin/install.mjs
  - tests/unit/installed-brain-health.test.mjs
relates: [ADR-058, ADR-086]
---

# Installed search identity health

Status: Accepted; implemented in the candidate, public-install qualification pending.
Date: 2026-09-19. Updated: 2026-09-19.

The live installation had package and validator identity for one release while SOURCE.json and
search-engine files belonged to an older release. RUNTIME-IDENTITY.json intentionally pins the
trusted validator, so its valid hash alone cannot establish which search fixes are active.

Doctor now reads the source runtime identity, validator pin and package independently, reports
their values, and fails on missing identity, a validator/source mismatch, an engine behind the
package, missing search executables or contradictory source version fields. A coherent engine
ahead of the invoking package remains valid; a corpus content address is never ordered as semver.
Observed search-file hashes are compared with the installed archive manifest, detecting changed code even when version labels stay unchanged. Missing, duplicate or invalid file identities fail health. This local-manifest consistency check is not independent release authentication; the signed artifact and public-install gates retain that responsibility.

A resolving citation is also insufficient for the fixed answerable smoke question when the
retriever explicitly reports thin/insufficient evidence or unproven required implementation.
Doctor fails that live result directly even when persisted self-check state cannot be loaded.
Warmup no longer promises an instant first answer.

Tests exercise real disposable source/validator files, changed bytes, missing identities, ahead
versions and corpus tags, plus explicit weak-evidence counterexamples. Installed customer and
public-artifact verification remain release gates; these tests do not prove answer correctness.

## Currency log

| Date | Change | Evidence |
|---|---|---|
| 2026-09-19 | Added installed archive-manifest equality checks for the four search entrypoints. | `scripts/installed-brain-health.mjs`, `tests/unit/installed-brain-health.test.mjs`; unchanged-version code drift must fail. |
| 2026-09-19 | Implemented separate installed identity and smoke-evidence diagnostics; release authentication remains outside this helper. | `scripts/installed-brain-health.mjs`, `bin/install.mjs`, `tests/unit/installed-brain-health.test.mjs`; focused tests passed, public qualification pending. |
