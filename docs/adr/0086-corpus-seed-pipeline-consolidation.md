---
id: ADR-086
title: The corpus-seed pipeline consolidation — the written contract for the in-flight twelve-step rewrite
status: Proposed  # 2026-09-13: steps 0–4 merged to main; step 5 committed on a worktree and FAILED Dual review; step 6 in progress uncommitted; 7–11 not started. Per-step table + currency log are the record.
date: 2026-09-13
updated: 2026-09-13
authors: [Stuart Kerr, Claude Fable 5.1]
tags: [corpus, release, consolidation, provenance, gists, assembly, dual-review, living-plan]
supersedes: []
amends: []
relates: [ADR-085, ADR-069, ADR-070, ADR-072, ADR-058, ADR-064]
governs:
  - scripts/corpus-reconcile.mjs
  - scripts/corpus-candidate.mjs
  - scripts/corpus-aggregates.mjs
  - scripts/gist-receipts.mjs
  - scripts/public-inputs.mjs
  - scripts/build-bundle.mjs
  - scripts/release-projection.mjs
  - scripts/wired-check.mjs
  - .github/workflows/corpus-seed.yml
  - .github/workflows/protected-release.yml
  - .github/workflows/ci.yml
  - data/corpus-seed.json
---

# ADR-086 — The corpus-seed pipeline consolidation

**Status**: Proposed — this is a LIVING PLAN, not a completed decision. Steps 0–4 are merged to
`main`; Step 5 is committed on a worktree branch and failed its independent Dual review; Step 6 is
in progress and uncommitted; Steps 7–11 have not started. Nothing in this plan has run end to end.
The per-step table below is the only checkable definition of "production-ready through Step 11".

## Why this ADR exists

An independent Dual review (Claude Fable 5.1 scribe, GPT-6/Codex verifier) of Step 5 on 2026-09-13
returned FAIL and, in its answer to q7, named the missing prerequisite directly:

> "Hard prerequisite: write the 12-step plan down as an ADR so 'production-ready through 11' has a
> checkable definition."

and, in blocker (7) of q6:

> "nothing in docs/adr or PROGRESS.md names the 12-step plan."

The plan had by then been executing for a full session — `git log` shows Steps 0–4 landing on
`main` between 13:36 and 19:15 EDT on 2026-09-13, each followed by at least one fix commit — with
no written contract in the repository. This ADR is that contract. It reproduces the Dual
rearchitect deliberation's decision, invariants, call graph, retained components, all twelve steps,
boundaries and risks **verbatim** (not paraphrased), and adds the one thing Dual could not supply:
each step's status, verified against git rather than recalled.

## Provenance of this contract

| Deliberation | Roles | Verdict | Grounded at | Record |
|---|---|---|---|---|
| Full rearchitect (the plan itself) | scribe: codex · verifier: claude-code | Synthesis; verifier returned **ACCEPT_WITH_CORRECTIONS** (C1–C6, below) | HEAD `a4e35546` | `/tmp/dual-full-rearchitect-out.json` (top-level `artifact` key) |
| Step 5 adversarial review | scribe: claude-code · verifier: codex | **FAIL** — "Do not merge. All four reviews independently reach FAIL" | main `39e4eb32`, worktree `86cbe798` | `/private/tmp/claude-501/-Users-stuartkerr-Code-ruvnet-brain/7bb97bf0-8fc0-415c-999f-2e0290b2350e/scratchpad/dual-step5-review-out.json` |
| Owner acceptance criteria C1–C4 | Dual, launched 2026-09-13 ~21:10 EDT | **PENDING** — output file was 0 bytes at both checks (start of writing and immediately before commit) | — | `/private/tmp/claude-501/-Users-stuartkerr-Code-ruvnet-brain/7bb97bf0-8fc0-415c-999f-2e0290b2350e/scratchpad/dual-acceptance-spec-out.json` |

Both populated deliberations record `verifiedOutcome: false` and `status: unresolved` at the
envelope level: neither executed tests, opened a seed archive, or made network calls. Everything
below is a read-only specification and a read-only review, not runtime proof.

## Decision (verbatim from the rearchitect artifact)

> "Replace the mutable shared-assets pipeline with fresh reconciliation rounds, one producer per
> source fact, one immutable finalized corpus, and one archive assembly. Retain RVF-GENERATIONS.json
> and ARCHIVE-MANIFEST.json; do not add CORPUS-MANIFEST.json."

### Resolved disagreements (the four points the two models argued to a close)

- **Another corpus manifest** — Drop CORPUS-MANIFEST.json. Use an in-memory validated StoreResult
  map during construction, the existing generation ledger for persisted store provenance, and the
  existing archive manifest for complete packaged file identities. Recompute identities from bytes at
  every verification boundary.
- **Invalidating all legacy repository reuse** — Do not require a previously nonexistent recipe hash
  to reuse every legacy store on the first run. Permit an explicit authenticated legacy import with
  exact upstream commit, matching recorded RVF bytes, complete sidecars and structural validation.
  Mark recipe provenance unknown; never label the imported bytes as built by the current recipe.
- **Implementation ordering** — Fix and test detail-fetch transport and dependency prerequisites
  before the full rehearsal. Land independent oracle evidence before the candidate commit that
  consumes it. Update callers, wired-check declarations and tests in the same implementation unit as
  deleted interfaces. Switch production consumers only after a consolidated seed is published and
  verified.
- **Corpus seed versus nightly customer delivery** — "This specification publishes immutable
  bootstrap seeds through manual protected dispatch. Preserve --prerelease --latest=false.
  Scheduling, releases/latest promotion and direct customer delivery are separate integration work
  and are not implied by seed publication."

## Target architecture

### Invariants (verbatim; normative — a step that violates one is not done)

- Observation performs no writes.
- Each round builds into a fresh directory; workers never write shared finalized assets.
- One gist operation acquires source bytes, renders passages and builds the vector family before exposing a bound receipt.
- One public-input operation selects and filters prose before concepts construction.
- One selected StoreResult map controls every corpus store and file copied.
- Generation source identity is authoritative; SOURCE and product manifest fields are derived views.
- Finalized corpus input is immutable. Packaging reads it and writes only a disjoint output directory.
- Coverage is classified once against the build observation. Release projection preserves those facts.
- One ZIP is assembled per candidate.
- Final verification recomputes complete archive identities and cross-file relationships from extracted bytes.
- Only release.mjs performs corpus publication.

### Call graph (verbatim)

```
main -> verifyBootstrap -> importSeedReadOnly
main -> captureBuilderInputs -> materializePublicInputs
observeSourceUniverse -> planRound
planRound -> buildOrReuseRepository[]
planRound -> buildGistAggregate(capture -> render -> vector)
publicInputs -> buildConceptAggregate -> vector
StoreResults -> finalizeCorpus -> measureCoverage
observeSourceUniverse -> compare stable digest -> retry or accept
accepted corpus -> assembleBundle -> extractAndVerify -> createCorpusReceipt
protected corpus import -> authenticate producer -> verifyCorpusReceipt
Production corpus job -> release.mjs --corpus-seed -> downloadPublicBytes -> verifyCorpusReceipt
subsequent code release -> verify committed seed -> assembleBundle once with exact code runtime -> existing qualification and publication
```

### Retained components (verbatim — these are NOT rewritten)

- RVF storage and embedding implementations
- Exact-SHA clone/check-out mechanics
- Generation ledger companion and whole-file byte hashing
- HNSW index audits
- Safe ZIP extraction
- Runtime module-graph discovery
- Public versus installed-profile ledger semantics
- Existing product publication transaction
- The committed source-coverage gist-list 403 fallback

## The twelve steps — the checkable definition of "production-ready through 11"

Work and Proof columns are quoted verbatim from `ordered_implementation_plan`. The Status column is
what `git log --oneline -40 main`, `git log --oneline --all --grep=step -i`, and `git branch -a
--contains <sha>` actually showed on 2026-09-13; the briefing SHAs that differed are called out.
Timestamps are commit author times (EDT).

| Step | Work | Proof | Status (verified against git, 2026-09-13) |
|---|---|---|---|
| 0 | Create an isolated implementation checkout and capture baseline tests. Add detail-fetch fallback and root/kb dependency setup. Specify disjoint output paths. Preserve the committed list fallback exactly. | Transport fixtures cover integration rejection, ordinary failures, rate limits, cancellation and moved detail. A real local embedding/RVF smoke build proves dependency resolution. | **Merged to main** as `cb988108` (13:36, "step 0 — kb dep install + gist-detail transport hardening"). Worktree original `eae7e142`. |
| 1 | Add shared receipt/identity validation and archive-root semantic verification. Update candidate schema readers/writers together. Add the external seed-tag versus internal product-tag contract. | Reject schema downgrade, arbitrary passage binding, inconsistent commits, unsafe paths and content-addressed baseline tag confusion. | **Merged to main** as `673a26c7` (14:38, "step 1 — schema-2 candidate receipt, archive-root verification, external/internal tag split"); follow-up `35a4c64c` (18:02) wired the RVF HNSW index audit into candidate verification. Worktree original `c78d3413`. The brief cited only `35a4c64c`; the step commit is `673a26c7`. Verifier correction C5 **landed in `673a26c7`**: `git blame` shows `scripts/release.mjs:155-156` now requires `receipt.schemaVersion === 2` plus generator identity, and `tests/unit/corpus-seed-release-authority.test.mjs:178` pins rejection of the schema downgrade. |
| 2 | Implement canonical gist capture/render/vector construction and repoint all gist corpus entrypoints. Delete obsolete binding/materialization functions and their wired-check entries. | Unchanged observation leaves finalized bytes untouched; changed detail takes bounded retry; tampered cache fails; removed gists disappear; failed vector build exposes no finalized receipt. | **Merged to main** as `cbee06fc` (16:16, "step 2 — one canonical gist capture/render/build pipeline"); fix `50553752` (17:55, "reusableCachedGist must check file inventory, not just updatedAt+hashes"). Worktree originals `48a8c37f` / `1496ac7b` — `1496ac7b` exists only on `worktree-agent-a67cb0fb4e392f315`, not on main. The brief cited `50553752` as the step commit; it is the fix. |
| 3 | Consolidate public-input selection and concepts construction; derive class registry. | Private fixtures are excluded, ambiguous ownership fails, deleted seed inputs disappear, and every declared input survives packaging byte-identically. | **Merged to main** as `7598a68e` (17:20, "step 3 — one canonical public-prose selection pipeline"); follow-up `c8464e8b` (17:58, "packaging must never re-derive public inputs"). Worktree originals `52b94c7c` / `06cc9b14` — `06cc9b14` exists only on `worktree-agent-a5367003478840cad`, not on main; the brief cited it as the merged follow-up. |
| 4 | Implement fresh reconciliation rounds and StoreResult integration. Preserve explicitly validated legacy reuse. Pass stabilized coverage into preparation. | No-op stability, source movement, round exhaustion, worker cancellation, removed repositories and legacy provenance limitations are exercised. | **Merged to main** as `72e7718e` (19:15, "step 4 — real prune, no-live-observe candidate prep, worker cancellation, path isolation"). Worktree original `9a608bf3`. |
| 5 | Replace bundle copy/projection paths with one assembly pass and one provenance projection. | Poison checkout receipts/SOURCE/cards and verify that supplied corpus bytes win exclusively. Assert unchanged input hashes, exact selected stores, consistent explicit version and one ZIP invocation. | **Committed on worktree; FAILED Dual review; remediation in progress; NOT merged.** `86cbe798` (20:53) on branch `worktree-agent-a8db1bb2b21ce2564` only — 10 files, +1250/−809 (`scripts/build-bundle.mjs`, `scripts/release-projection.mjs`, `scripts/wired-check.mjs`, `.github/workflows/ci.yml`, 6 test files). Dual verdict FAIL 2026-09-13; blocker order in the currency log. |
| 6 | Reconcile ADR-085's main decision text with its currency corrections. Update wired-check, authority declarations and affected tests in the same changes. Remove the redundant publication wrapper. | No live caller references deleted functions; wired and authority checks pass; ADR does not claim unattended customer delivery or completed runtime proof. | **In progress, uncommitted.** Branch `worktree-agent-step6` at `39e4eb32` (= main; `git log main..HEAD` is empty). `git status --short` shows 7 files: `M .github/workflows/corpus-seed.yml`, `M docs/adr/0085-nightly-corpus-release-channel.md` (+135 lines: "Where this actually stands, 2026-09-13" section), `M scripts/corpus-reconcile.mjs`, `D scripts/corpus-seed-publish.mjs` (−106), `M scripts/wired-check.mjs` (−4, STANDALONE entry removed), `M tests/unit/corpus-release-convergence.test.mjs`, `M tests/unit/corpus-seed.test.mjs` (−52). Verifier correction C4's file:line test-pin inventory is part of this step. |
| 7 | Inventory independent oracle coverage for the actual eligible set and supply missing source-grounded rows before the consuming candidate commit. | Strict-ancestor oracle checks pass. Missing evidence remains a failure; do not generate expected answers from the candidate's own retrieval output. | **Not started.** (ADR-085's F9 names the 12 stores missing oracle rows.) |
| 8 | Run the complete preparation and future product-consumption path in a disposable checkout before any real CI dispatch. | Use real seed import, source acquisition, local embeddings and RVF indexes. Assemble once, remove access to original assets, verify extracted bytes, then import candidate N as seed N+1. Stub publication mutations with a command recorder. | **Not started.** The verifier calls this "a hard gate before any corpus-seed.yml or protected-release.yml dispatch; nothing in this pass reduces its necessity, and C5/C6 add two more contracts it must exercise." |
| 9 | Wire protected corpus import/publication and test both workflow operations. | Wrong workflow/run attempt/repository/SHA/artifact/digest fails before publication. All payloads stay outside tracked paths. Corpus operation cannot invoke npm publication. | **Not started.** |
| 10 | Run exact-source qualification, preparation CI and protected corpus publication. Verify downloaded public bytes. | Retain source, observation, archive, receipt and producer identities. No success claim before public download verification. | **Not started.** |
| 11 | Commit the verified seed pointer and switch ci.yml/public-verification consumers to the consolidated seed path. Run existing full product qualification. | The new content-addressed seed passes baseline verification, product assembly occurs once, installed-profile behavior survives, and existing product release gates remain intact. | **Not started.** |

### Sequencing consequence found by the Step 5 review

Step 5 cannot merge on its own: "no single X makes it safe: fixing the seal leaves release-qe red;
re-pinning the seed leaves the seal unproven." Blocker (1) requires publishing a Step-4-produced
seed sealed from the identical coverage observation and re-pinning `data/corpus-seed.json` in the
same change — work the plan had placed in Steps 10–11. Until that seed exists, Step 5's `ci.yml`
rewrite is "structurally red against the seed it pins, by code path, not hypothesis":
`data/corpus-seed.json` pins `v4.2.1-dev` (sourceCommit `63e0b123`, pre-Step-3), whose gist
receipt observation digest cannot equal `data/source-coverage.json`'s, and
`plugin/scripts/coverage-integrity.mjs:253-254` compares them unconditionally, throwing at `:64-65`.

## Verifier corrections carried into this contract (C1–C6)

The rearchitect verifier accepted the synthesis "as the implementation specification with C1–C6
applied." They are binding on the steps they name:

- **C1** — Mis-citation: the "~576x" raw-request budget correction lives in ADR-085's 2026-09-13
  row, not ADR-069; the "V5" label is the synthesis's own, not a repository identifier.
- **C2** — `GIST_OBSERVATION_MOVED` is only raised inside `observe()` (`gist-receipts.mjs:184-187`
  via `corpus-reconcile.mjs:158,176`), outside the try; the catch at `:167-175` is dead code today
  and a mid-run gist move is a hard failure, not a retry. The target design's retry must wrap capture.
- **C3** — `corpus-reconcile.mjs:388-389` does `rm -rf` `assets/l2` before `cpSync`; only
  `*-primer.md` and `l2-topics.*.json` are overlaid without removal (`:390-394`).
- **C4** — The test-pin inventory is far larger than "3 existing unit tests": at least
  `tests/unit/protected-release-workflow.test.mjs:39,78,79`, `tests/unit/corpus-reconcile.test.mjs:210-214,229`,
  `tests/unit/corpus-release-convergence.test.mjs:12`, `tests/unit/gist-receipts.test.mjs`,
  `tests/unit/assembled-release-projection.test.mjs`, `tests/unit/corpus-seed.test.mjs:13-14,215,236`,
  `tests/unit/wired-check.test.mjs`, `tests/unit/rebuild-gists-from-receipts.test.mjs`. Each is
  rewritten in the same unit as its call site (Step 6); `protected-release-workflow.test.mjs:39/:78`
  are authority assertions to be updated to the new exact shape, not deleted.
- **C5** — `runProtectedCorpusSeed` (`scripts/release.mjs:133-155`) rejects
  `receipt.schemaVersion !== 1` and requires `generator.corpusCandidateSha256 === sha256(scripts/corpus-candidate.mjs)`
  at the exact target SHA; `tests/unit/corpus-seed-release-authority.test.mjs` pins this. A schema-2
  receipt cannot pass this publisher until the contract is repointed in the same change (Step 1).
- **C6** — The gists 403 exists because Actions' `GITHUB_TOKEN` lacks gist scope. A repository
  secret holding a read-only gist-scoped token, exported as `GH_TOKEN` for the reconcile step only,
  is the primary transport; the anonymous fallback is retained for forks. Provisioning the secret is
  a human action behind the hard fence.

## Scope, boundaries, risk (verbatim from `scope_and_risk`)

- **Rewrite boundary**: "Rewrite orchestration, receipt ownership, public input selection, provenance
  projection, assembly and candidate import/verification. Preserve vector engines, extraction
  mechanics and the existing product transaction."
- **Completion boundary**: "A single verified corpus seed path plus its next-code-release consumption.
  This does not establish an unattended nightly customer-update channel."
- **Estimate**: "Approximately 16–24 implementation/workflow files plus 10–15 test/fixture files;
  roughly 1,500–3,000 production lines added or substantially rewritten, with substantial deletion.
  Planning estimate, not a measured diff or ETA." The verifier's view: file count holds (19–21),
  but "2,000–3,500 is the honest band" for lines; test files at least 11 per C4. "This is a
  multi-day rewrite, not a single pass."
- **Remaining historical gap**: "The complete eleven-correction crosswalk remains unverified. The
  replacement architecture and implementation sequence above are self-contained."
- **Highest risks** (verbatim list):
  - Legacy seed evidence quality
  - Privacy filtering and derivation input closure
  - First product release consuming a content-addressed seed
  - Anonymous detail-fetch quota and resumability
  - Full-corpus disk, memory and build duration
  - Independent oracle coverage
  - SOURCE updater and installed-profile compatibility

## Protected publication contract (Step 9's substance, condensed from `protected_publication`)

- Add an `operation` input (`code` or `corpus`, default `code`) to `protected-release.yml`; keep
  current-main, workflow identity, concurrency and Production controls; corpus routing must never
  enter npm publication.
- Corpus imports require preparation run ID, run attempt, artifact ID, builder SHA, archive digest
  and receipt digest; authenticate GitHub-owned workflow identity/path, successful run, exact source
  repository/SHA and artifact ownership — "Artifact names or self-reported receipt fields are
  insufficient."
- Download and safely extract into `RUNNER_TEMP`, never the tracked checkout; verify layout and both
  digests; perform full archive-root candidate verification; pass the exact verified payload into
  the Production job and verify it again there; invoke `release.mjs --corpus-seed` with absolute
  paths and exact target SHA; download the public archive and receipt and rerun verification.
- Publisher: move full candidate verification into `runProtectedCorpusSeed`; make it and its caller
  asynchronous; delete `corpus-seed-publish.mjs` after repointing tests/callers; keep
  prerelease/non-latest and immutable no-overwrite semantics; if a tag exists, verify its public
  bytes or report an explicit conflict — never overwrite; report corpus-published-verified
  separately from product install-verified.
- Preparation: install both root and `kb` lockfile graphs; preserve `GH_TOKEN` propagation and the
  corrected list fallback; put all generated coverage, receipts, logs and artifacts outside the
  checkout; assert tracked source paths unchanged after preparation and before publication.

## What this ADR does NOT claim

Per PRINCIPLES P6 ("Derive; never assert") and P7 ("Built is not shipped; shipped is not wired"):

- No step is production-proven. Steps 0–4 are merged and unit-tested; none has run against real
  data end to end. Step 8's disposable-checkout dry run is the hard gate before any real dispatch.
- Nothing here establishes unattended nightly customer delivery. That remains ADR-085's open
  decision, and the plan's own completion boundary excludes it.
- Nothing here establishes per-repo retrieval accuracy. The plan has no per-repo ≥95% gate (Step 7
  supplies oracle rows; it does not grade them per repository). See the amended-scope section.
- The two Dual records are read-only reviews (`tests_executed: false`, `seed_archive_opened: false`).
  "Measured N under conditions D" statements in this ADR come from git and from reading source, not
  from running the pipeline.

## Amended scope — owner acceptance criteria (C1–C4)

**PENDING — Dual acceptance deliberation launched 2026-09-13 ~21:10 EDT; incorporate on landing.**
The output file (`dual-acceptance-spec-out.json`, path in the provenance table) was 0 bytes at the
start of writing and again immediately before this ADR was committed. The next editor must load it
(top-level `verification` and `artifact` keys, same envelope as the two records above) and record,
per criterion, Dual's YES / PARTIAL / NO verdict and any additional steps (12+) it specifies, then
add a currency-log row.

The owner's four criteria, as put to Dual:

| # | Criterion | Known gap against the twelve-step plan (before Dual's answer) |
|---|---|---|
| C1 | Collects ALL rUv repos and gists | Plan enumerates live org + gists each round (Steps 2, 4); completeness is measured (`measureCoverage`, `assertAllEligibleCurrent`) but "all" is defined by the eligibility policy, not asserted. |
| C2 | Stores them correctly (RVF / HNSW / provenance) | Retained components cover RVF, HNSW audits, generation ledger; Steps 1, 4, 5 own provenance. |
| C3 | Verifies ≥95% retrieval accuracy PER REPO | **No per-repo gate exists in Steps 0–11.** Step 7 inventories oracle rows; nothing grades retrieval per repository against a 95% threshold. ADR-058 ("The 95 contract") is the relevant standing contract. |
| C4 | Automatically updates itself (unattended nightly corpus → customers) | **Explicitly excluded** by the completion boundary and by the fourth resolved disagreement. Lives in ADR-085, whose own S1/S2 blockers (prerelease invisibility; `schedule:` cannot pass `validateProtectedPublishEnvironment`) are unfixed. |

## Relationship to other ADRs

- **ADR-085** (nightly corpus release channel, Proposed) — this ADR is the implementation contract
  for the corpus-seed side ADR-085 depends on. Step 6 reconciles ADR-085's decision text with its
  own currency corrections (in progress). The "seed bootstrap only, not nightly customer delivery"
  boundary is shared and must stay in both documents.
- **ADR-069, ADR-070, ADR-072** (Accepted) — record the seeded-scoping design (projection-time
  gist-row scoping to the seed receipt) that Step 5 retires. Step 5 review blocker (7) asked for
  either amendments to those three or this consolidation ADR; this ADR satisfies the "or". Each of
  the three still needs a currency-log row pointing here when Step 11 actually switches consumers.
  `amends:` is deliberately empty until then — nothing has been switched yet.
- **ADR-058** (The 95 contract) — the standing per-dimension observable/mutant contract that owner
  criterion C3 would attach to; the plan does not yet reference it.
- **ADR-064** (corpus-QA proves machinery, not ranking; amended by ADR-085) — the "cannot dispatch
  a publisher" rule ADR-085 loosens for corpus content only; this plan preserves manual protected
  dispatch and does not loosen it further.

## Currency log
| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-13 | **Step 5 (`86cbe798`, branch `worktree-agent-a8db1bb2b21ce2564`) FAILED independent Dual review; status set to "Committed on worktree; FAILED Dual review; remediation in progress; NOT merged."** Core defect, agreed by all four reviews: the sealed-input boundary is `if (fs.existsSync(sealedSelectionFile))` at `scripts/build-bundle.mjs:369` — "a file-existence toggle, not a verified seal. No kind/schemaVersion check, no receiptSha256 recompute, no included-name membership check, no content binding. `{}` takes the trusted branch." The else-branch (`materializePublicInputs`) fires for any corpus directory lacking the receipt, including the immutable seed; `SELECTION_FILE` is never copied into `out`, so no archive this code produces carries one and the CI seed path re-derives prose from the checkout every run. Coverage is read unconditionally from `runtimeRoot/data/source-coverage.json` (`:417-421`) with no association to the supplied corpus; `--coverage`/`--projection` are accepted and silently ignored. **Two customer-facing regressions**: (a) `scripts/build-bundle.mjs:454-455` — `try { updaterConfig = JSON.parse(corpus/SOURCE.json) } catch {}` "turns a previously REQUIRED file into silent null canonical URLs, i.e. self-update unconfigured for every installer"; (b) `:440-445` — `try { classes = JSON.parse(public-store-classes.json) } catch {}` "silently reclassifies concepts as kind 'repository' (SOURCE.json row, manifest row, gradeFor, mcp entry)". Also: partial `seedIdentity` silently downgrades to a non-release build instead of rejecting (`:617-619`); `release-projection.mjs:93` reserializes coverage with `JSON.stringify` (P3, latent). Tests: every assembly fixture writes `receiptSha256: 'unused-in-fixture'` (`tests/unit/assemble-bundle.test.mjs:113`), so passing REQUIRES the seal to be unvalidated; none removes the receipt, supplies `source-coverage.json`, or supplies `seedIdentity`. **Remediation order (q6, verbatim)**: (1) publish a Step-4-produced seed sealed from the identical coverage observation and re-pin `data/corpus-seed.json` in the same change; (2) propagate SELECTION_FILE into the archive; validate on read (kind, schemaVersion, recomputed receiptSha256, included names ⊆ on-disk, extra managed files rejected) and extend the receipt to bind included file bytes, since today it hashes names only; (3) run materializePublicInputs ONLY under an explicit standalone condition (corpus === runtime/kb), never against an external directory, never destructively against tracked source without opt-in; (4) make corpus SOURCE.json and public-store-classes.json fail-loud again; reject partial seedIdentity; reject non-canonical --coverage / any --projection; (5) do not commit the three deletions or kb/PUBLIC-INPUT-SELECTION.json; gitignore the latter; (6) tests: missing receipt → rejection for external corpus / success for kb, tampered receipt, full-seed assembly through bindAssembledReleaseProjection, coverage drift rejection, candidate-archive → re-assembly round-trip preserving the receipt; (7) update ADRs 0069/0070/0072/0058, which record the retired seeded-scoping design as Accepted, or add the consolidation ADR. Verifier corrections to the synthesis: `plugin/scripts/coverage-integrity.mjs:56-57` returns `validateLegacyGistAggregateReceipt` for schema 2 BEFORE the observation comparison, so the claimed unconditional rejection is false for schema-2 receipts; the checkout receipt has 492 gist IDs (not 491), digest `de8f5a4f…` vs coverage `94051916…`; the 17–32-hour estimate is an assumption, not a verified feasibility result. This ADR's author spot-checked the five `build-bundle.mjs` citations against `git show 86cbe798:scripts/build-bundle.mjs` — `:369`, `:417-421`, `:440-445`, `:454-455`, `:617-619` all match. | Step 5 Dual review record `dual-step5-review-out.json` (`verification.answers` q1–q7; `artifact.text` fenced JSON `consensus.agreed_by_all_four`, `disagreements_resolved`, `answers` q6); `scripts/build-bundle.mjs` and `scripts/release-projection.mjs` as committed in `86cbe798`; `plugin/scripts/coverage-integrity.mjs`; `data/corpus-seed.json`; `tests/unit/assemble-bundle.test.mjs`; ADR-069, ADR-070, ADR-072, ADR-058. |
| 2026-09-13 | **Initial: written as the contract for the in-flight consolidation, at Dual's explicit demand.** Decision, invariants, call graph, retained components, all 12 steps, rewrite/completion boundaries, highest risks, and verifier corrections C1–C6 reproduced verbatim from the rearchitect record. Per-step status verified against `git log`/`git branch --contains` rather than the briefing: Step 1's step commit is `673a26c7` (brief cited only follow-up `35a4c64c`); Step 2's step commit is `cbee06fc` (brief cited fix `50553752`; `1496ac7b` is that fix's worktree-only original); Step 3's merged follow-up is `c8464e8b` (brief cited `06cc9b14`, which is worktree-only); Step 4 `72e7718e` and Step 5 `86cbe798` match. Step 6 worktree (`worktree-agent-step6`) confirmed at `39e4eb32` with 0 commits ahead and 7 uncommitted files. Verifier correction C5 confirmed landed in `673a26c7` via `git blame` on `scripts/release.mjs:155-156` (schema-2 receipt required) and `tests/unit/corpus-seed-release-authority.test.mjs:178` (downgrade rejected). `node scripts/doc-currency.mjs --check` on this document: 2 pre-commit warnings only (`no-git-history`, `stamp-unverifiable-dirty`); the 10 `presumed-stale` BLOCKs the gate reports are on ADR-054/056/058/060/062/069/070/072/084/085 and are identical on the primary `main` checkout — pre-existing, not caused here. `tests/unit/doc-currency.test.mjs`, `doc-currency-review.test.mjs`, `adr-currency-gate-parity.test.mjs`: 75/75 passed. All 12 `governs:` paths confirmed present on main; all 6 `relates:` ADRs confirmed present and on-topic. `docs/adr/README.md`'s index stops at 0010 (last updated 2026-07-27) and lists none of 0011–0085, so no 0086 row was added — an out-of-sequence single row would misrepresent the index as current. Owner acceptance-criteria deliberation output was empty at both checks; section left as a marked placeholder. | Rearchitect record `dual-full-rearchitect-out.json` (`artifact.decision`, `.target_architecture`, `.ordered_implementation_plan`, `.scope_and_risk`, `.protected_publication`; `verification.text` corrections C1–C6); `git log --oneline -40 main` at `39e4eb32`; commits `cb988108`, `673a26c7`, `35a4c64c`, `cbee06fc`, `50553752`, `7598a68e`, `c8464e8b`, `72e7718e`, `86cbe798`; `git -C .claude/worktrees/agent-step6 status --short`; ADR-085 (shape reference); `docs/PRINCIPLES.md` P6/P7. |
