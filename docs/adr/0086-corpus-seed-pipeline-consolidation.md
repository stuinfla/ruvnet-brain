---
id: ADR-086
title: The corpus-seed pipeline consolidation — the written contract for the in-flight rewrite (twelve steps, amended to nineteen)
status: Proposed  # 2026-09-14 evening: 19 of 20 steps merged. main now also carries the seed bootstrap-deadlock and descriptor-schema fixes and an ENFORCED ADR-086:248 C3 gate (oracle schema 2: N = 2 x min(100,U), paired questions, repository-exact attribution). The committed 576-label oracle is schema 1 and is DIAGNOSTIC ONLY, so corpus sealing and publication fail closed until a compliant oracle (22,310 questions over 194 repositories) is produced. Steps 10, 11, 19 are owner-gated. The per-step table and currency log are the record.
date: 2026-09-13
updated: 2026-09-14
authors: [Stuart Kerr, Claude Fable 5.1]
tags: [corpus, release, consolidation, provenance, gists, assembly, dual-review, living-plan, acceptance-criteria]
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

**Status**: Proposed

This is a LIVING PLAN, not a completed decision. Steps 0–4 are merged to `main`; Step 5 is
committed on a worktree branch and failed its independent Dual review; Step 6 is in progress and
uncommitted; Steps 7–19 have not started. Nothing in this plan has run end to end. The per-step
table below is the only checkable definition of "production-ready" — originally "through Step 11",
now "through Step 19" after the owner's four acceptance criteria were put to Dual (see "Amended
scope").

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
boundaries and risks **verbatim** (not paraphrased), then the acceptance deliberation's seven added
steps and gate definitions verbatim, and adds the one thing Dual could not supply: each step's
status, verified against git rather than recalled.

## Provenance of this contract

| Deliberation | Roles | Verdict | Grounded at | Record |
|---|---|---|---|---|
| Full rearchitect (the original 12-step plan) | scribe: codex · verifier: claude-code | Synthesis; verifier returned **ACCEPT_WITH_CORRECTIONS** (C1–C6, below) | HEAD `a4e35546` | `/tmp/dual-full-rearchitect-out.json` (top-level `artifact` key) |
| Step 5 adversarial review | scribe: claude-code · verifier: codex | **FAIL** — "Do not merge. All four reviews independently reach FAIL" | main `39e4eb32`, worktree `86cbe798` | `/private/tmp/claude-501/-Users-stuartkerr-Code-ruvnet-brain/7bb97bf0-8fc0-415c-999f-2e0290b2350e/scratchpad/dual-step5-review-out.json` |
| Owner acceptance criteria C1–C4 (steps 12–19, C3 gate, C4 resolution) | scribe: codex · verifier: claude-code | Synthesis; verifier returned **CONFIRMED WITH CORRECTIONS** (A1–A7, below) | main `39e4eb32`; rUv source via `search_ruvnet` receipt `2eee64b7a574` | `/private/tmp/claude-501/-Users-stuartkerr-Code-ruvnet-brain/7bb97bf0-8fc0-415c-999f-2e0290b2350e/scratchpad/dual-acceptance-spec-out.json` (`artifact` keys `1`–`6`; `verification.answers/corrections/unverified`) |

All three deliberations record `verifiedOutcome: false` and `status: unresolved` at the envelope
level: none executed tests, opened a seed archive, read GitHub settings, or ran the pipeline.
Everything below is a read-only specification and read-only review, not runtime proof.

## Decision (verbatim from the rearchitect artifact)

> "Replace the mutable shared-assets pipeline with fresh reconciliation rounds, one producer per
> source fact, one immutable finalized corpus, and one archive assembly. Retain RVF-GENERATIONS.json
> and ARCHIVE-MANIFEST.json; do not add CORPUS-MANIFEST.json."

The acceptance deliberation's decision, appended 2026-09-13 (verbatim): "The previous plan was an
incomplete contract. It explicitly excluded C4 and never defined C3. Completing it would not satisfy
the owner. Keep the foundation; replace the acceptance contract and implementation ordering now."

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
  and are not implied by seed publication." **Superseded for customer releases by the C4 resolution
  below (S1): bootstrap-only releases may remain prereleases; customer corpus releases may not.**

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

The acceptance deliberation confirmed the skeleton (verbatim): "corpus-seed.yml → reconcile →
candidate → assembleBundle → protected-release.yml → release.mjs --corpus-seed → forge-update.mjs
polling releases/latest survives every criterion. No layer is scrapped. Steps 0-5 are foundation,
not waste. The two structural additions are a corpus-only authority path inside protected-release.yml
and an accuracy receipt in the candidate seal."

## The steps — twelve original (0–11) plus seven added by the acceptance deliberation (12–19)

Work and Proof columns are quoted verbatim: Steps 0–11 from the rearchitect
`ordered_implementation_plan`, Steps 12–19 from the acceptance synthesis `artifact["2"]`. The
Status column is what `git log --oneline -40 main`, `git log --oneline --all --grep=step -i`, and
`git branch -a --contains <sha>` actually showed on 2026-09-13; briefing SHAs that differed are
called out. Timestamps are commit author times (EDT). Verifier corrections A1–A7 that amend a step's
text are named in its Status cell.

**Ordering (verbatim, acceptance synthesis)**: "Amend step 6 immediately. Steps 12–15 precede the
old full rehearsal and qualification. Step 16 must be installed-verified before enabling public
unattended promotion. Integrate steps 17–18 with old step 9, then finish with step 19. Do not finish
the deficient plan first." Verifier: "Ordering stands: amend step 6 now, then 12-15, then 16 before
18, then 17-18, then 19."

| Step | Work | Proof | Status (verified against git, 2026-09-13) |
|---|---|---|---|
| 0 | Create an isolated implementation checkout and capture baseline tests. Add detail-fetch fallback and root/kb dependency setup. Specify disjoint output paths. Preserve the committed list fallback exactly. | Transport fixtures cover integration rejection, ordinary failures, rate limits, cancellation and moved detail. A real local embedding/RVF smoke build proves dependency resolution. | **Merged to main** as `cb988108` (13:36, "step 0 — kb dep install + gist-detail transport hardening"). Worktree original `eae7e142`. |
| 1 | Add shared receipt/identity validation and archive-root semantic verification. Update candidate schema readers/writers together. Add the external seed-tag versus internal product-tag contract. | Reject schema downgrade, arbitrary passage binding, inconsistent commits, unsafe paths and content-addressed baseline tag confusion. | **Merged to main** as `673a26c7` (14:38, "step 1 — schema-2 candidate receipt, archive-root verification, external/internal tag split"); follow-up `35a4c64c` (18:02) wired the RVF HNSW index audit into candidate verification. Worktree original `c78d3413`. The brief cited only `35a4c64c`; the step commit is `673a26c7`. Verifier correction C5 **landed in `673a26c7`**: `git blame` shows `scripts/release.mjs:155-156` now requires `receipt.schemaVersion === 2` plus generator identity, and `tests/unit/corpus-seed-release-authority.test.mjs:178` pins rejection of the schema downgrade. |
| 2 | Implement canonical gist capture/render/vector construction and repoint all gist corpus entrypoints. Delete obsolete binding/materialization functions and their wired-check entries. | Unchanged observation leaves finalized bytes untouched; changed detail takes bounded retry; tampered cache fails; removed gists disappear; failed vector build exposes no finalized receipt. | **Merged to main** as `cbee06fc` (16:16, "step 2 — one canonical gist capture/render/build pipeline"); fix `50553752` (17:55, "reusableCachedGist must check file inventory, not just updatedAt+hashes"). Worktree originals `48a8c37f` / `1496ac7b` — `1496ac7b` exists only on `worktree-agent-a67cb0fb4e392f315`, not on main. The brief cited `50553752` as the step commit; it is the fix. |
| 3 | Consolidate public-input selection and concepts construction; derive class registry. | Private fixtures are excluded, ambiguous ownership fails, deleted seed inputs disappear, and every declared input survives packaging byte-identically. | **Merged to main** as `7598a68e` (17:20, "step 3 — one canonical public-prose selection pipeline"); follow-up `c8464e8b` (17:58, "packaging must never re-derive public inputs"). Worktree originals `52b94c7c` / `06cc9b14` — `06cc9b14` exists only on `worktree-agent-a5367003478840cad`, not on main; the brief cited it as the merged follow-up. |
| 4 | Implement fresh reconciliation rounds and StoreResult integration. Preserve explicitly validated legacy reuse. Pass stabilized coverage into preparation. | No-op stability, source movement, round exhaustion, worker cancellation, removed repositories and legacy provenance limitations are exercised. | **Merged to main** as `72e7718e` (19:15, "step 4 — real prune, no-live-observe candidate prep, worker cancellation, path isolation"). Worktree original `9a608bf3`. Acceptance crosswalk: F7 and F8 CLOSED in source here (`scripts/corpus-reconcile.mjs:298, :541`). |
| 5 | Replace bundle copy/projection paths with one assembly pass and one provenance projection. | Poison checkout receipts/SOURCE/cards and verify that supplied corpus bytes win exclusively. Assert unchanged input hashes, exact selected stores, consistent explicit version and one ZIP invocation. | **MERGED to main 2026-09-14** as `0367f476` + remediation `8caa1579` (worktree `86cbe798`+`d673d5e0`). FAILED its first Dual review — the seal was `fs.existsSync`, a toggle not a proof. Remediation binds every sealed file's BYTES (schema 2) and verifies kind / schemaVersion / recomputed `receiptSha256` / per-file bytes / bidirectional membership / unsealed-prose leak on read (`scripts/public-inputs.mjs:127-171`, enforced at `scripts/build-bundle.mjs:424-428`). `ci.yml` reverted byte-for-byte; consumer switch stays at step 11. **Dual re-review: CONDITIONAL, not PASS** — three P1s open, see currency log 2026-09-14.|
| 6 | Reconcile ADR-085's main decision text with its currency corrections. Update wired-check, authority declarations and affected tests in the same changes. Remove the redundant publication wrapper. | No live caller references deleted functions; wired and authority checks pass; ADR does not claim unattended customer delivery or completed runtime proof. | **MERGED to main 2026-09-14** as `2ab9c407`. ADR-085 body reconciled with its own currency corrections; `scripts/corpus-seed-publish.mjs` deleted after confirming zero executable references — but its deep `verifyCorpusReceipt` re-derivation was **moved, not dropped**, into `runProtectedCorpusSeed` (`scripts/release.mjs:170-181`, now async, before any `gh` call), proven by a test that forges one per-store digest under an otherwise-valid archive.|
| 7 | Inventory independent oracle coverage for the actual eligible set and supply missing source-grounded rows before the consuming candidate commit. | Strict-ancestor oracle checks pass. Missing evidence remains a failure; do not generate expected answers from the candidate's own retrieval output. | **MERGED to main 2026-09-14** as `149b290c` (payload) + `44a6c5f6` (seal) + `dfd1f9e5` (ancestry fix). NOTE: the payload's worktree SHA was `a14bb491`; cherry-picking onto main reassigned it to `149b290c`, and the seal still named the worktree SHA — so `verifyQueryOracleSource` FAILED on main until the fix. The integration owner's first verification missed it by running `--audit` WITHOUT `--candidate-sha`, which skips the strict-ancestor half. Lesson: a content digest cannot see ancestry; every cherry-pick/rebase/squash rewrites SHAs and re-breaks a seal that names one. Always verify with `--candidate-sha`. F9 CLOSED: the 12 missing stores supplied with source-grounded rows, oracle sealed against its own commit, and a fast standalone `--audit` added (`scripts/retrieval-canary.mjs`) that answers in milliseconds instead of six minutes into release-qe. Integration owner verified independently: `{"ok":true,"eligible":194,"covered":194,"missing":[],"exempt":[],"extra":[]}`. Exemptions require reason + upstream SHA + inspected evidence paths; none are taken today.|
| 8 | Run the complete preparation and future product-consumption path in a disposable checkout before any real CI dispatch. | Use real seed import, source acquisition, local embeddings and RVF indexes. Assemble once, remove access to original assets, verify extracted bytes, then import candidate N as seed N+1. Stub publication mutations with a command recorder. | **MERGED to main 2026-09-14** as `2858cadd`. `scripts/rehearse-corpus-pipeline.mjs` + `npm run rehearse:corpus` runs the whole pipeline in a disposable checkout in **~7m45s** (vs a ~6-hour CI dispatch). Two real runs, both PASS, two generations each: real 567MB seed download (digest-verified), real clones, real bge-base embeddings, real RVF ingest, assemble-once, originals revoked (renamed + chmod 000, proven unreadable) then 112 extracted files recomputed against ARCHIVE-MANIFEST.json, `corpus-candidate --verify` exit 0 — and **candidate N accepted as seed N+1 in all four generations, so the chain closes**. Publication mutations: 2 recorded, **0 executed**. Tamper proofs fail closed: a corrupted extracted byte exits 1 BEFORE publication with `recordedPublicationCommands: 0`; a deliberately-bypassed interception is DETECTED (`intercepted: false`) rather than proceeding. Bounded, and says so: 2 repos + 3 gists of 228/492, printed in every receipt. Found the symlink CLI no-op (see currency log).|
| 9 | Wire protected corpus import/publication and test both workflow operations. | Wrong workflow/run attempt/repository/SHA/artifact/digest fails before publication. All payloads stay outside tracked paths. Corpus operation cannot invoke npm publication. | **MERGED to main 2026-09-14** as `d2776d35` (with 17+18, per the amended ordering). 27 MUST-FAIL refusal cases in `tests/unit/protected-corpus-provenance.test.mjs`, VM-executing the real guard lifted from the YAML: wrong workflow identity/path/resolved path, schedule- or push-triggered run, stale or non-numeric run attempt, substituted run identity, wrong SHA, unprotected ref, foreign repo, fork source, wrong artifact name, artifact bound to another run/SHA/repo/fork/branch, expired, absent, duplicate second-attempt, and artifact/run substitution. **Load-bearing control**: with the trust predicates removed a foreign-repository run sails through — the matrix is not theatre. Payloads are `RUNNER_TEMP`-only (`release-evidence` absent from every corpus job); `release.mjs:104` refuses `--corpus-seed --publish`.|
| 10 | Run exact-source qualification, preparation CI and protected corpus publication. Verify downloaded public bytes. | Retain source, observation, archive, receipt and producer identities. No success claim before public download verification. | **Not started.** |
| 11 | Commit the verified seed pointer and switch ci.yml/public-verification consumers to the consolidated seed path. Run existing full product qualification. | The new content-addressed seed passes baseline verification, product assembly occurs once, installed-profile behavior survives, and existing product release gates remain intact. | **Not started.** |
| 12 | Close source completeness using the existing observer. Collect public forks and archives as required by ALL. Revalidate pushedAt-bound exclusions against independent source-file evidence; zero extracted chunks is not proof of an empty source. Remove the temporary self-store exclusion as policy debt. Follow pagination to its actual end, verify unique stable identities and independent totals, and seal exact revisions, file inventories, extraction dispositions and observation times. Preserve explicit records for genuinely empty sources. | The freshly observed upstream identity set equals the collected source set, with zero unexplained omissions. Test additions, forks, archives, renames, deletion, visibility changes, empty sources, more than 1000 gists, partial responses and collection-time source movement. Inaccessible required content blocks completeness. | **MERGED to main 2026-09-14** as `7d3ecf06`. Forks dispositioned by real `ahead_by` via the compare API (`fork:original-content` / `fork:no-original-content`, upstream identity + both heads + merge base sealed); archives eligible unconditionally; gist pagination runs to a genuine end with a throwing ceiling, leaving `rows.length===public_gists` as the completeness proof (A1); exclusions now require evidence or are rejected, and the inert `ruvnet-brain` self-exclusion was removed as dead policy debt. `policyVersion 2` makes an older-policy measurement **detectably** stale rather than silently wrong. RED: 23 of 26 new tests fail against main. **C1 remains PARTIAL** — `fork:original-content` is deliberately NOT spelled `eligible`, because `corpus-reconcile.mjs` full-clones every `eligible` row and that would credit upstream authors' commits to rUv; the delta-only build is unowned work.|
| 13 | Complete C2 verification with the retained RVF engine: reopen persisted stores, verify vector/ID-map/passage/source-span correspondence, execute queries, and test private exclusion across the complete archive. Inspect the installed SDK's actual index capabilities. Require demonstrable HNSW operation for nonempty stores under the stated contract; an unavoidable small-store exception must be exposed as an acceptance change, never silently scored PASS. | Swapped ID maps, omitted passages, altered source mappings, damaged indexes and private content each cause rejection. Receipts record actual engine/index state and persisted-query results. Segment presence alone cannot satisfy this gate. | **MERGED to main 2026-09-14** as `e87162d1` + probe correction `42c6873f`. Measured recall replaces presence: `auditCorpusStores` reopens each store read-only and compares the SDK's k-NN against exact neighbours brute-forced from the store's own `VEC_SEG` bytes (no embedding-determinism assumption in the recall path). RED: 5 of 7 damage cases PASS against main's gate. Integration owner re-measured: `ruvector` 29,872x768 recall@10 **1.0000** (p50 1.31ms), `2bottalk` PASS-SMALL-STORE; 206 stores = 24 PASS / 180 PASS-SMALL-STORE / 2 FAIL, lowest recall 0.9950. Two measured corrections to the brief: rUv floors `ef_search` at `INDEX_MIN_EF_SEARCH=256` so the efSearch knob is inert downward; and an absolute cosine cutoff cannot gate the passage probe because correct pairings (min 0.9326) and mis-pairings (max 0.9462) OVERLAP — rank<=1 separates cleanly, verified on `agentdb` whose correct pairing sits at cosine 0.943. **Found a real shipped defect**: `ruv-gists` passage `2740` ships with no vector (3,055 passages vs 3,054 vectors) and is permanently unretrievable. Receipt schema untouched; measured recall lands in `<bundle>.rvf-audit.json` for step 15.|
| 14 | Implement the source-grounded benchmark below, beginning with an unattended oracle-production feasibility spike. Freeze the sampling policy and independently validate questions before candidate retrieval. Keep deterministic identifier probes as machinery diagnostics and the legacy canary as regression coverage; neither substitutes for semantic retrieval acceptance. | Every repository, nonempty gist partition and shipped store has a disclosed denominator. Labels trace to immutable upstream bytes independently of candidate passages. Demonstrate valid automatic oracle regeneration for a changed source and a previously unseen repository without a provider API key or recurring human GO. | **MERGED to main 2026-09-14** as `edc0bcd2` — a SPIKE, deliberately not a gate. Verdict **POSITIVE**: the subscription-only producer (`claude -p` claude-fable-5-1 + `codex exec` gpt-6-astra, 15 calls each) returned a **byte-exact verbatim supporting span for 298 of 298 units (100%)**; end-to-end label validity 291/298 (97.7%) across hello_world_agent @42584fa155, a 20-gist partition @4f3cf1ac04 and ruflo @b02c0cacec; cross-vendor both-yes 295/298 (99.0%). Zero producer errors, zero timeouts, zero skips. **$0.00 out of pocket** — every provider key proven stripped from the child env (`childHadBillingKeys: []`). Of the 7 failures, 5 are the spike's own non-triviality rule over-rejecting short code spans; the weakest component measured is the validator, not the producer. **TWO LIMITS, both load-bearing**: (a) ~627s and ~10 calls per source = **~33.8h / ~1,940 calls for 194 sources** — NOT nightly-viable without regenerating only changed `blobSha` units; (b) **C3 remains entirely unproven — no retrieval was executed in this spike at all**, and ruflo's sample is 1.0% of its 10,023 units.|
| 15 | Wire the benchmark into prepareCorpusCandidate after single-pass assembly. Run against the extracted final archive through the customer query path. Produce a detached retrieval-accuracy receipt bound to the final archive digest; the corpus receipt binds that report's digest. Extend candidate verification and runProtectedCorpusSeed to require and validate both bindings and every partition's PASS result. | One below-threshold repository, missing partition, timeout, changed oracle, altered archive or missing accuracy report blocks candidate acceptance and publication. Re-run after retrieval-affecting changes. Reverify the downloaded final artifact against the measured identity. | **MERGED to main 2026-09-14** as `e57968ca`. The C3 gate and its binding are COMPLETE and fail-closed: evidence-supporting Hit@5, exact integer threshold 20*successes >= 19*N per partition AND per query mode (never pooled, never rounded), errors and timeouts counted as failures and never excluded from the denominator, a timeout additionally failing the run outright, N=0 recorded as NOT MEASURED rather than a pass. Measured against the EXTRACTED archive through the customer query path (`searchAll`), never the build directory. Receipt bumped **schema 2 -> 3** per correction A6 with `accuracyReport {file, sha256, bytes}`, detached as `<archive>.accuracy.json` so one assembly still suffices; `verifyCorpusReceipt`, `runProtectedCorpusSeed`, `corpus-seed.yml`'s loader and `corpus-next-seed.mjs` were updated together. **SCHEMA-2 SEEDS ARE NOW UNPUBLISHABLE** — `data/corpus-seed.json` must be re-pointed at a schema-3 seed in the same change that publishes one (step 11's job, NOT done here). Bounded modes exist (`--accuracy-stores`/`--accuracy-sample`) because step 14 measured ~627s and ~10 model calls per source, but the single shared reader refuses `complete !== true`, so **a bounded run can never seal a publishable receipt** — verified live: a complete run reported `complete=true state=FAIL` over 40 real queries, `--sample 3` reported `complete=false` with its bounds named; both exited 1. **THE GATE'S INPUT DOES NOT EXIST**: `data/retrieval-accuracy-oracle.json` was deliberately NOT fabricated (a fake ground-truth artifact in production data is worse than an absent one), so corpus publication is blocked AND `npm run rehearse:corpus` can no longer complete a generation. That is the gate working as designed; it clears when a real oracle is produced with step 14's producer. **CORRECTION to step 13's reported gap**: the extracted-archive audit call site already exists (`corpus-candidate.mjs:318-319` calls `auditCorpusStores({ dir: root })` on the `extractZip` output); and `<bundle>.rvf-audit.json` is deliberately NOT receipt-bound because it records wall-clock p50/p95 and so is not byte-reproducible — C2 is re-run at every verification boundary instead, which is stronger.|
| 16 | Fix customer compatibility and update identity, then ship the fix through one owner-gated code release. Persist the authenticated corpus transport identity atomically with installation; keep runtime version distinct. Enforce compatibility with the installed approved runtime. Enumerate every latest-release consumer and prove fresh installation, repeated updates and supported profiles. Exercise the existing launchd, cron and Task Scheduler adapters, including explicit noninteractive enablement. | Install corpus A, then report current without another download; install B once, then report current. Fresh installation succeeds when latest is a compatible corpus tag. Older clients cannot enter a redownload loop or receive an incompatible runtime. The prerequisite code release is installed-verified before unattended corpus promotion is enabled. | **MERGED to main 2026-09-14** as `28f6bd14`. Found and fixed three real customer-facing defects with measured before/after: (1) **a redownload loop** — 4 consecutive `--apply` against ONE unchanged corpus release downloaded 1/2/3/4 times and stayed BEHIND, with `--check` permanently exit 10; now 1 download then `current`. (2) **a silent incompatible install** — a corpus release built by runtime 4.10.0 applied to a 4.9.0 client printed `=== DONE ===` and exited 0, exactly what the compatibility_boundary forbids; now exit 5 with the live tree untouched. (3) `cmpTag("4.9.0", "corpus-sha256-…") = 1` → "installed is NEWER than latest" → download skipped forever. Runtime pin binds to `coverage-integrity.mjs` (the one executable a bundle cannot supply). **It also found the S1/S2 release-blocking conflict** that steps 17/18 then resolved.|
| 17 | Inspect live environment protections and signing-secret scope before workflow changes. Add an explicitly corpus-only job chain within protected-release.yml with authenticated preparation-run/artifact provenance. Preserve the existing invocation identity predicate and code-release authorization. Pin brainVersion and every executable/runtime file to the owner-approved shipped code artifact, separately from builderSourceSha. Publish complete signed corpus assets as an ordinary release explicitly marked latest, with serialized code/corpus promotion. | A genuine corpus workflow_dispatch passes without human GO; code publication still requires owner authority. Wrong producer, SHA, ref, digest, runtime bytes or mode fails. The detached .sig verifies using the existing signing implementation. All assets are complete before promotion, and stale or concurrent promotion cannot move customers backward. | **MERGED to main 2026-09-14** as `d2776d35`. `mode` input (code|corpus) with all 6 code jobs gated `if: inputs.mode != 'corpus'`; the corpus chain binds **`Production – corpus`** (`protected-release.yml:752`), never the npm-scoped environment. Integration owner verified the capability boundary by reading the file: the only EXECUTABLE `NPM_TOKEN`/`registry-url` lines are `:329`/`:349`, inside the code job on `Production – ruvnet-brain` (pinned at exactly 3 occurrences); the rest are comments. Runtime pin enforced by byte equality both directions (`scripts/approved-runtime.mjs:103-130`), checked BEFORE signing. **S1 resolved architecturally**: rather than six patches, `scripts/release-channel-kind.mjs` lets `releases/latest` keep meaning "what a customer downloads" while every question about the PRODUCT generation resolves the latest CODE release — this is what stops a corpus release breaking the owner's own `release.mjs` preflight step E.|
| 18 | Add the low-privilege scheduled dispatcher using the built-in Actions token, contents:read and actions:write. It dispatches protected-release.yml on protected main in corpus mode, whose preparation path seals exact candidate identities. Resolve the previous compatible, verified corpus generation at runtime as the next seed; retain the committed exact seed as bootstrap/recovery input. Do not commit a new pointer every night. | A real schedule creates a target run with event=workflow_dispatch. The dispatcher has no signing or publication authority. Night N+1 reuses the verified previous generation, rejects incompatible or unverified releases, and handles no-change rounds without inventing a new content generation. | **MERGED to main 2026-09-14** as `d2776d35`. `.github/workflows/corpus-nightly-dispatch.yml`: `contents:read` + `actions:write` only, no secrets, no environment, no signing — proven invisible to the one-publisher gate by running the real `detectPublisherActions`. `validateProtectedPublishEnvironment` is **UNCHANGED** (`'schedule'` appears nowhere in it), per Dual's instruction to preserve rather than weaken it. Runtime next-seed resolution (`scripts/corpus-next-seed.mjs`) never rewrites the committed pointer. **S2 is NOT resolved and is stated as a design, not a resolution** (A5): the `event=workflow_dispatch` run record does not exist because the hard fence forbids dispatching. The dispatcher's "Record the target run" step FAILS the job if `gh workflow run` produces no such run, so the record is mandatory rather than assumed. Disarmed until step 16's code release ships.|
| 19 | Complete the old rehearsal, qualification, CI and consumer-consumption gates under the amended contract, followed by unattended operational acceptance. Set a measurable discovery-to-install freshness budget, bounded retries and a red overdue state. Recover the original eleven-correction artifact and close its exact crosswalk before declaring completion. | Two successive scheduled cycles complete without human GO, with at least one real upstream change reaching an already installed client; a subsequent no-change check avoids redownload. Exercise new-repository discovery, changed gists, deletion, rejected retrieval, interrupted installation, signature failure, private-overlay preservation, rollback and code/corpus publication contention. Verify landed bytes and customer-visible retrieval after activation. | **Not started — added by acceptance deliberation 2026-09-13.** Calendar-bound: cannot complete before 3 nights after Step 18 lands (A7). |

### Sequencing consequence found by the Step 5 review

Step 5 cannot merge on its own: "no single X makes it safe: fixing the seal leaves release-qe red;
re-pinning the seed leaves the seal unproven." Blocker (1) requires publishing a Step-4-produced
seed sealed from the identical coverage observation and re-pinning `data/corpus-seed.json` in the
same change — work the plan had placed in Steps 10–11. Until that seed exists, Step 5's `ci.yml`
rewrite is "structurally red against the seed it pins, by code path, not hypothesis":
`data/corpus-seed.json` pins `v4.2.1-dev` (sourceCommit `63e0b123`, pre-Step-3), whose gist
receipt observation digest cannot equal `data/source-coverage.json`'s, and
`plugin/scripts/coverage-integrity.mjs:253-254` compares them unconditionally, throwing at `:64-65`.

## Verifier corrections carried into this contract (rearchitect pass, C1–C6)

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
- **C5** — `runProtectedCorpusSeed` (`scripts/release.mjs:133-155`) rejected
  `receipt.schemaVersion !== 1` and requires `generator.corpusCandidateSha256 === sha256(scripts/corpus-candidate.mjs)`
  at the exact target SHA; `tests/unit/corpus-seed-release-authority.test.mjs` pins this. Landed in
  `673a26c7` (Step 1) — main now requires schema 2. A6 below bumps it again to schema 3.
- **C6** — The gists 403 exists because Actions' `GITHUB_TOKEN` lacks gist scope. A repository
  secret holding a read-only gist-scoped token, exported as `GH_TOKEN` for the reconcile step only,
  is the primary transport; the anonymous fallback is retained for forks. Provisioning the secret is
  a human action behind the hard fence.

## Amended scope — owner acceptance criteria (C1–C4)

Landed 2026-09-13 from the acceptance deliberation (provenance row 3). The verifier's summary: "The
synthesis is right on every load-bearing claim: the completed 12-step plan does not satisfy C3 or
C4, C1 and C2 are partial, the skeleton is correct, and steps 0-5 are not wasted. Every code claim I
could check against main at 39e4eb32 held."

### Per-criterion verdict (`artifact["1"]`; verifier `answers["1"]` concurs)

| # | Criterion | Verdict | Reason (verbatim) |
|---|---|---|---|
| C1 | Collects ALL rUv repos and gists | **PARTIAL** | "Fresh enumeration and disposition accounting exist, but forks and archives are classified INELIGIBLE, and the anonymous gist fallback stops at ten pages; the completed plan does not establish collection of ALL public sources." (A1 corrects the ten-page point: it fails closed, it does not silently omit. A2 narrows what "ALL" requires of forks.) |
| C2 | Stores them correctly (RVF / HNSW / provenance) | **PARTIAL** | "Archive and provenance binding exist, but the RVF audit checks index-segment presence and allows fewer than 1024 vectors without an index; it does not prove correct vector-to-source correspondence or HNSW operation for every store." (Strengthened by A4's rUv-source grounding.) |
| C3 | Verifies ≥95% retrieval accuracy PER REPO | **NO** | "Step 7 repairs canary inventory, but the existing canary sampling and machinery round-trip contract do not define or enforce a source-grounded 95% denominator per repository." |
| C4 | Automatically updates itself (unattended nightly corpus → customers) | **NO** | "The plan explicitly excludes unattended delivery, and the publisher creates a prerelease with --latest=false, uploads no detached signature, and requires workflow_dispatch." |

### The C3 gate — definition (verbatim, `artifact["2"].C3_definition`)

- **metric** — "Evidence-supporting Hit@5: a question succeeds only when the first five customer-visible results contain correctly attributed source evidence sufficient to answer it. A matching file path without the supporting span fails. This is empirical retrieval accuracy on the disclosed benchmark, not ANN neighbor recall or generated-answer accuracy."
- **denominator** — "For each repository, independently enumerate U meaningful source units from the upstream snapshot: substantive sections, documented behaviors and APIs. Deterministically stratify and select min(100, U) units across modules and source types. Each selected unit receives one direct and one meaning-preserving paraphrased question, so N = 2 × min(100, U). Publish U, N, sampling coverage and uncovered files. The pair is one clustered source unit for uncertainty reporting, not two independent population samples."
- **threshold** — "Require 20 × successes >= 19 × N independently for each repository and each query mode. Errors and timeouts count as failures. No pooled average, rounding, excluded failed queries or post-failure denominator changes. N=0 is NOT MEASURED; only independently verified empty sources can lack a retrieval score."
- **ground_truth** — "Build labels from exact upstream bytes, not the candidate's passage sidecars. Bind expected evidence to stable source identity, revision, path, blob digest and supporting spans. Validate paraphrases independently of candidate output. Hold questions and labels out of indexing and tuning; keep answer-bearing documents indexed. Predeclare acceptable equivalent spans before scoring."
- **modes_and_partitions** — "Run explicit-repository queries and ordinary full-corpus routed queries separately. Gate each shipped store, each repository and each nonempty gist partition; an aggregate score cannot hide one missing gist. A gist partition is not automatically a separate physical store."
- **unattended_oracles** — "Deterministic source parsing supplies the independent inventory. Semantic question generation and independent validation require a locally executable, pinned, source-grounded producer proven during step 14. No suitable producer was verified in this review, so this is an explicit engineering deliverable, not an assumed capability. If it cannot produce trustworthy labels unattended, C3+C4 remain incomplete; identifier-only queries are not an acceptable substitute."
- **existing_harness** — "Do not use grade-*.json averages as ground truth. The inspected grading script calls OpenRouter, and its mechanical source check is existence of the retrieved top path. It cannot serve this subscription-only gate unchanged." (`scripts/brain-grade-groundtruth.mjs:29-32,41,56,66`; `scripts/retrieval-canary.mjs:384,400-421`; ADR-064.)

### The C4 resolution (verbatim, `artifact["2"].C4_resolution`, with verifier A5)

- **S1** — "Remove both --prerelease and --latest=false for customer corpus releases, explicitly promote latest, and attach the exact archive's real detached .sig. Bootstrap-only releases may remain prereleases. Use scripts/sign-bundle.mjs, which signs the raw SHA-256 digest bytes." (Verifier confirmed: `scripts/release.mjs:185-193` uploads bundle+receipt only; `kb/forge-update.mjs:1275,1284-1285,66-73` fails closed without `.sig`; `scripts/sign-bundle.mjs:61-62`.)
- **S2** — "The separate scheduler must call gh workflow run protected-release.yml --ref main with corpus mode. That produces a genuine workflow_dispatch; preserve validateProtectedPublishEnvironment unchanged. GitHub permits GITHUB_TOKEN-triggered workflow_dispatch runs." **Verifier A5: this GitHub-docs claim "was not verified live in this session … Step 18 proof must include the actual run record: a schedule-fired dispatcher whose `gh workflow run` produces a target run with event=workflow_dispatch. Until that record exists, S2 is a design, not a resolution."**
- **authorization** — "workflow_dispatch proves event identity, not human approval. Enforce corpus-only and owner-approved code authority separately in the target workflow. actions:write is broader than one workflow; a hardcoded dispatcher command is not the security boundary."
- **brainVersion** — "Pinning survives only through enforced equality to the approved shipped runtime and its executable hashes. Copying current-main package.json or preserving a version string alone is insufficient."
- **environment_unknown** — "The existing workflow uses the Production environment for signing/publishing. Reviewer settings and signing-secret scope could block unattended execution. Check them first; do not weaken the code environment. Any needed corpus environment must preserve signing containment and the corpus-only capability." (`.github/workflows/protected-release.yml:207,293,485` `environment: Production – ruvnet-brain`; `:229 RUVNET_SIGNING_KEY`.) **Checked 2026-09-13 by live `gh api` (see "Open items", item 1): the environment's only protection rule is `branch_policy` with zero reviewers — no approval gate blocks unattended execution. But the same environment scopes `NPM_TOKEN` (read at `:328`), so a corpus job bound to it would hold npm capability; the corpus-only path therefore needs a separate `Production – corpus` environment holding only `RUVNET_SIGNING_KEY` — an owner action, recorded there.**
- **compatibility_boundary** (`artifact["3"]`) — "One releases/latest pointer cannot represent independent newest corpora for multiple incompatible runtimes. Either explicitly support the current approved runtime with safe rejection for older clients, or add version-aware discovery. Never silently install incompatible code."

### Acceptance synthesis's resolved disagreements (verbatim, `artifact["2"].resolved_disagreements`)

- "Forks are included. Asking the owner whether ALL includes forks repeats the original scope failure." (Narrowed by A2.)
- "Retain fresh enumeration and revision-bound empty-source accounting. Do not rebuild them. A temporary exclusion record is not necessarily active: classifyRepository applies it only when pushedAt matches."
- "Reject identifier-only path recovery as the 95% semantic acceptance gate. It is useful diagnostic coverage but weakens the promised result."
- "Reject the claim that RVF ANN recall@10 establishes semantic Hit@5 feasibility. They measure different things. No unverified Layer C API becomes a requirement."
- "Do not insert a report into an already measured ZIP and keep its old digest. A detached, digest-bound accuracy receipt preserves single assembly and exact-artifact identity."
- "Keep existing scheduler adapters; prove them. bin/install.mjs permits explicit --enable-nightly without a TTY, so 'non-TTY never schedules' is false."
- "The existing index audit is insufficient for a C2 YES. Its small-store exception and presence-only check require explicit closure."

### Verifier corrections to the acceptance synthesis (A1–A7, verbatim `verification.corrections`)

The verifier returned CONFIRMED WITH CORRECTIONS: "Six corrections below change specific
recommendations, not the decision." The record contains seven entries; the seventh (feasibility) is
reproduced as A7. Labels A1–A7 are this document's, in record order.

| # | target | issue | evidence | amended_text |
|---|---|---|---|---|
| A1 | 1.C1 and 2.step 12 | The ten-page gist cap does not cause silent omission. observeGists compares rows.length to the account's public_gists count and throws on mismatch, so beyond 1000 gists the run fails closed rather than shipping an incomplete set. | scripts/source-coverage.mjs:234-235 | Keep the ceiling fix in step 12 but state it correctly: raise the page bound so the existing rows.length===expected check remains the completeness proof. No new gist completeness invariant is needed. |
| A2 | 2.resolved_disagreements[0] (forks) | Blanket fork inclusion is the wrong default. A fork with zero commits ahead of upstream contains none of rUv's code, and shipping it misattributes upstream authors' content to rUv in retrieval, the failure the #286 RC3 repo-attribution guard (31ff7b10 on main) exists to stop. 'ALL' is satisfied by accounting, not by ingestion. | git log at main: 31ff7b10; scripts/source-coverage.mjs:67 records upstreamIsFork, :131-133 isFork/isArchived | Step 12: archives are included unconditionally. Forks are enumerated and dispositioned every run; a fork is ingested only when ahead_by>0 via the compare API, and only the rUv-authored delta is credited. Forks with ahead_by=0 are recorded as 'fork:no-original-content' with the upstream identity. Cheapest-to-reverse reading; needs no owner question. |
| A3 | 2.step 6 and 3 (corpus-seed-publish.mjs) | corpus-seed-publish.mjs is not dead code. It re-verifies the receipt and delegates to release.mjs --corpus-seed; ADR-085's 2026-09-12 row (S6) already corrected the 'dead code' claim. It also hardcodes prerelease:true. | scripts/corpus-seed-publish.mjs:48-51, :71-79, :86; docs/adr/0085:128 | Step 6: either make corpus-seed-publish.mjs the single corpus entry point, or delete it and move verifyCorpusReceipt into runProtectedCorpusSeed. Do not leave two callers. Whichever survives must not report prerelease:true for customer releases. |
| A4 | 2.C2 and step 13 (strengthened by grounding) | rUv's rvf-index has three progressive layers with recall targets ~0.70 (A), ~0.85 (B), >= 0.95 (C). The JS segments() shape returns segType only, no layer or tier. Presence of one 'index' segment cannot distinguish Layer A from Layer C, so it proves no recall figure. | ruvector/crates/rvf/rvf-index/src/lib.rs; ruvector/npm/packages/rvf/README.md (segments() shape); scripts/rvf-index-audit.mjs:30 | Step 13 must prove HNSW operation by executing persisted queries against reopened stores and comparing to exact neighbors on a sample, not by any segment inspection. Record the measured recall per store in the C2 receipt. |
| A5 | 2.C4_resolution.S2 | The GitHub-docs claim that GITHUB_TOKEN-fired workflow_dispatch creates a run was not verified live in this session (no network tool; the synthesis reported api.github.com failures). | none read this session; UNVERIFIED | Step 18 proof must include the actual run record: a schedule-fired dispatcher whose `gh workflow run` produces a target run with event=workflow_dispatch. Until that record exists, S2 is a design, not a resolution. |
| A6 | 2.step 15 (receipt binding) | Adding an accuracy-report digest to the corpus receipt is a schema change; runProtectedCorpusSeed rejects schemaVersion!==2 and any receipt whose generator hash differs from the committed corpus-candidate.mjs. | scripts/release.mjs:152-161 | Step 15: bump the corpus receipt to schemaVersion 3 with accuracyReport {file, sha256, bytes}; update verifyCorpusReceipt, runProtectedCorpusSeed and corpus-seed.yml's committed-seed loader together; state that schema-2 seeds become unpublishable and data/corpus-seed.json must be re-pointed in the same change. |
| A7 | 5 (feasibility) | The binding constraint is calendar, not effort. Step 19 needs two consecutive real scheduled cycles plus a no-change cycle; step 16 needs an owner-gated code release installed before step 18 is enabled. | synthesis steps 16, 18, 19; .github/workflows/protected-release.yml:293-297 | 8-14 working sessions is consistent with steps 0-5 taking one session, but completion cannot precede 3 calendar nights after step 18 lands. Riskiest step remains 14. Second riskiest is the unread Production environment reviewer setting. |

### Open items the deliberation could not verify (verbatim, `verification.unverified`)

| item (verbatim) | why (verbatim) | status as of this ADR |
|---|---|---|
| Production environment required-reviewers and RUVNET_SIGNING_KEY scope | GitHub settings not readable here; a required reviewer on 'Production – ruvnet-brain' makes C4 impossible without a corpus-only environment holding the signing key | **VERIFIED 2026-09-13** by live `gh api` reads (details below). No required-reviewer rule exists; C4 is NOT blocked by environment protection. A different constraint was found instead: `NPM_TOKEN` shares the signing environment. Owner action required before Step 17 — see below. |
| GITHUB_TOKEN-fired workflow_dispatch creates a run | not fetched live; see correction 5 | OPEN — Step 18 proof (A5). |
| F3, F4, F5, F6, F10 closure and the seven unnamed corrections | docs/adr/0085:127 names F1-F10 by one line each and only four of eleven corrections; no repo artifact enumerates the rest | OPEN — Steps 6, 8, 19. |
| Whether a local, subscription-only oracle producer can generate trustworthy semantic questions | no such producer exists in scripts/; the only grader reads OPENROUTER_API_KEY (scripts/brain-grade-groundtruth.mjs:29-56); step 14's spike is the correct first move | OPEN — Step 14 spike. |
| Whether @ruvector/rvf as installed persists Layer C or only Layer A for the project's stores | the JS segments() shape exposes segType only (ruvector/npm/packages/rvf/README.md); resolution requires the persisted-query measurement in step 13 | OPEN — Step 13 measurement. |

**Resolution of item 1 — read live from the GitHub API on 2026-09-13 (two independent sessions,
identical results; this author's read at 21:42:30 EDT).** Endpoints: `gh api
repos/stuinfla/ruvnet-brain/environments`, `…/environments/Production%20%E2%80%93%20ruvnet-brain`,
`…/environments/Production%20%E2%80%93%20ruvnet-brain/secrets`, `…/actions/secrets`.

1. Environments present: Preview, Preview – explainer, Preview – ruvnet-brain, Production,
   Production – explainer, Production – ruvnet-brain. Only `Production – ruvnet-brain` has any
   protection rule.
2. `Production – ruvnet-brain` protection rules: exactly one, type `branch_policy`, reviewers 0.
   There is **no `required_reviewers` rule**. Dual's concern "a required reviewer on Production
   makes C4 impossible" does not apply — the human gate on code publish is the `workflow_dispatch`
   trigger plus `validateProtectedPublishEnvironment`, not an environment approval.
3. Secrets: environment scope `Production – ruvnet-brain` holds exactly two — `NPM_TOKEN` and
   `RUVNET_SIGNING_KEY` (both updated 2026-08-02). Repository scope holds exactly one — `NTFY_TOPIC`
   (2026-07-10). No other secrets at either scope.
4. `.github/workflows/protected-release.yml` reads `secrets.RUVNET_SIGNING_KEY` at `:229`, `:330`,
   `:514`, each inside a job bound to `environment: Production – ruvnet-brain` (`:207`, `:293`,
   `:485`). `secrets.NPM_TOKEN` is read at `:328` in the same environment.

**Consequence for Step 17.** A corpus-only publish job cannot simply bind to
`Production – ruvnet-brain`: that puts `NPM_TOKEN` in scope of an unattended job, violating the
protected-publication contract's "corpus routing must never enter npm publication" as a
*capability* boundary, not merely a code-path one. The design that satisfies the C4 resolution's
"any needed corpus environment must preserve signing containment and the corpus-only capability" is
a **separate environment (`Production – corpus`) holding ONLY `RUVNET_SIGNING_KEY`**, with its own
`branch_policy` (main only) and no `NPM_TOKEN`; the corpus-only job binds to it. Signing stays
environment-scoped (containment preserved); npm is unreachable from the corpus path by construction.

**OWNER ACTION REQUIRED before Step 17 can be enabled**: create the `Production – corpus`
environment and add `RUVNET_SIGNING_KEY` to it. The key value is not API-readable and the
implementer will not create or copy secrets — this repo's secrets chain is SOPS+age per the owner's
global-secrets architecture. Not urgent (Step 17 is several sessions out), but it is in the plan now
rather than discovered then.

### F1–F10 and prior-corrections crosswalk (verbatim, `artifact["4"]`; verifier `answers["4"]` concurs)

Status rule: "CLOSED means the named source defect is visibly addressed, not that hosted or customer
acceptance passed. Historical issue identities come from docs/adr/0085-nightly-corpus-release-channel.md.
Unrecovered corrections remain UNVERIFIED."

| item | status | steps | evidence |
|---|---|---|---|
| F1 | CLOSED for inspected cache file-set reuse defect; full fetch-path closure UNVERIFIED | 2; rehearsal 8 | scripts/gist-receipts.mjs: reusableCachedGist |
| F2 | CLOSED in workflow wiring; hosted execution UNVERIFIED | Existing kb dependency install; rehearsal 8–10 | .github/workflows/corpus-seed.yml: Install kb deps |
| F3 | UNVERIFIED | Addressed by supplied steps 2/4; prove in 8 | docs/adr/0085-nightly-corpus-release-channel.md: F3 description |
| F4 | UNVERIFIED | Addressed by supplied steps 1/4; prove successive-seed reuse in 8 | docs/adr/0085-nightly-corpus-release-channel.md: F4 description |
| F5 | UNVERIFIED | 1 and 9–11 must prove seed-to-code-release identity consumption | docs/adr/0085-nightly-corpus-release-channel.md: F5 description |
| F6 | UNVERIFIED end to end | 2/3/5 address packaging; 8 proves archive closure | .claude/worktrees/agent-a8db1bb2b21ce2564/scripts/build-bundle.mjs: kind-specific sidecar copying |
| F7 | CLOSED in source | 4 | scripts/corpus-reconcile.mjs: pruneIneligibleStores |
| F8 | CLOSED for redundant preparation observation | 4 | scripts/corpus-reconcile.mjs: prepareCorpusCandidate requires measured coverage |
| F9 | Covered by old step 7, not closed; C3 covered by NOTHING sufficient in the old plan | 7 plus amendments 14–15 | scripts/retrieval-canary.mjs; docs/adr/0085-nightly-corpus-release-channel.md |
| F10 | UNVERIFIED; three specific tests not identified and rerun here | 6/10 | docs/adr/0085-nightly-corpus-release-channel.md: F10 description |
| Correction: publisher import dirties checkout | UNVERIFIED | 9/17 must import under runner temporary storage and prove clean checkout | .github/workflows/protected-release.yml; docs/adr/0085-nightly-corpus-release-channel.md |
| Correction: CI requires absent oracle | UNVERIFIED closure; covered by ordering | 7/14 before mandatory qualification | docs/adr/0085-nightly-corpus-release-channel.md |
| Correction: gist receipt absent from archive | UNVERIFIED end to end | 2/5 then archive rehearsal 8 | .claude/worktrees/agent-a8db1bb2b21ce2564/scripts/build-bundle.mjs: EXTRA_SIDECARS_BY_KIND copying |
| Correction: anonymous API budget | UNVERIFIED | 12/19 must prove authentication availability, rate-limit handling and freshness | scripts/source-coverage.mjs: listGistsUnauthenticated; docs/adr/0085-nightly-corpus-release-channel.md |
| Remaining seven corrections | UNVERIFIED; exact identities unavailable | Recover original artifact in amended step 6; close before 19 | docs/adr/0085-nightly-corpus-release-channel.md names only four examples |
| S1/S2, exhaustive collection, meaningful per-repository 95%, complete storage proof and automatic customer acceptance | Covered by NOTHING sufficient in the original contract | 12–19 | scripts/source-coverage.mjs; scripts/rvf-index-audit.mjs; scripts/release.mjs; scripts/protected-release-invocation.mjs |

### The amended contract (verbatim, `artifact["6"].amended_contract`, plus the verifier's one added sentence)

> "We will finish the existing foundation into one verified path from fresh public upstream
> discovery to automatic customer installation. Every public repository, including forks and
> archives, and every public gist will be collected or explicitly proved empty, with no silent
> omissions. Stored content will pass byte-provenance, persisted RVF/HNSW, source-mapping and
> private-boundary checks. Every nonempty repository and required store partition will achieve at
> least 95% evidence-supporting top-five retrieval success on a disclosed, independently
> source-grounded benchmark, with denominators and failures reported separately. Corpus changes will
> pass these gates, be signed, published and installed automatically within a measured freshness
> budget; executable changes remain owner-approved. One verified code release will deliver the
> updater changes before unattended corpus promotion starts. Completion requires real scheduled
> delivery, stable repeat checks and failure recovery. Private publication, forced updates for
> opted-out clients, correctness on every imaginable question and unrelated whole-codebase perfection
> are not claimed."

Verifier (`answers["6"]`): "Concur with the amended contract, adding one sentence: forks ship only
where rUv has original commits, and every fork is still accounted for by name and disposition each
night."

## Scope, boundaries, risk — AMENDED 2026-09-13

- **Rewrite boundary** (rearchitect, verbatim, unchanged): "Rewrite orchestration, receipt
  ownership, public input selection, provenance projection, assembly and candidate
  import/verification. Preserve vector engines, extraction mechanics and the existing product
  transaction."
- **Completion boundary — ORIGINAL (Steps 0–11, verbatim)**: "A single verified corpus seed path plus
  its next-code-release consumption. This does not establish an unattended nightly customer-update
  channel." **AMENDED**: that boundary explicitly excluded C4 and never defined C3. Steps 12–15 add
  the C1/C2 closure and the C3 gate; Steps 16–19 add C4 (signed `releases/latest` corpus promotion,
  corpus-only protected authority, scheduled dispatcher, two real unattended cycles). Completion is
  now Step 19's proof, under the amended contract above.
- **Estimate — original**: "Approximately 16–24 implementation/workflow files plus 10–15 test/fixture
  files; roughly 1,500–3,000 production lines … Planning estimate, not a measured diff or ETA."
  Rearchitect verifier: "2,000–3,500 is the honest band"; "a multi-day rewrite, not a single pass."
- **Feasibility — amended (`artifact["5"]`, verifier `answers["5"]`, A7)**: synthesis budgets "10–15
  focused sessions of 6–8 hours, approximately 60–120 engineering hours, plus elapsed hosted runs and
  two scheduled cycles"; the verifier's reading is "8-14 working sessions is consistent with steps
  0-5 taking one session, but completion cannot precede 3 calendar nights after step 18 lands." The
  **binding constraint is calendar, not effort**. **Riskiest step: 14** (trustworthy unattended
  semantic ground truth, then reaching 95% for the worst repository without weakening the benchmark).
  Second riskiest: the unread Production environment reviewer setting — "must be inspected in session
  one." **Inspected 2026-09-13 ("Open items", item 1): no required-reviewer rule exists. The residual
  risk moved from "approval gate" to "`NPM_TOKEN` shares the signing environment", resolved by design
  (separate `Production – corpus` environment) pending one owner action.** Estimate boundary (verbatim): "This is a planning range, not an upper bound. No fresh semantic
  baseline or validated local oracle producer exists in this review. If those fail, the remaining work
  expands; the acceptance spec does not shrink."
- **Remaining historical gap**: "The complete eleven-correction crosswalk remains unverified." Step 19
  now requires recovering the original artifact and closing the crosswalk before completion.
- **Highest risks** (rearchitect, verbatim list): Legacy seed evidence quality · Privacy filtering and
  derivation input closure · First product release consuming a content-addressed seed · Anonymous
  detail-fetch quota and resumability · Full-corpus disk, memory and build duration · Independent
  oracle coverage · SOURCE updater and installed-profile compatibility.

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
  asynchronous; resolve `corpus-seed-publish.mjs` per A3 (single entry point or delete-and-move, never
  two callers); **for customer releases, drop prerelease/non-latest per S1** (bootstrap seeds keep
  it); immutable no-overwrite semantics; if a tag exists, verify its public bytes or report an
  explicit conflict — never overwrite; report corpus-published-verified separately from product
  install-verified.
- Preparation: install both root and `kb` lockfile graphs; preserve `GH_TOKEN` propagation and the
  corrected list fallback; put all generated coverage, receipts, logs and artifacts outside the
  checkout; assert tracked source paths unchanged after preparation and before publication.

## What this ADR does NOT claim

Per PRINCIPLES P6 ("Derive; never assert") and P7 ("Built is not shipped; shipped is not wired"):

- No step is production-proven. Steps 0–4 are merged and unit-tested; none has run against real
  data end to end. Step 8's disposable-checkout dry run is the hard gate before any real dispatch.
- Unattended nightly customer delivery is now IN scope (Steps 16–19) but NOT built, and S2 is "a
  design, not a resolution" until Step 18 produces a real `event=workflow_dispatch` run record (A5).
  ADR-085's S1/S2 blockers remain unfixed.
- Per-repo retrieval accuracy is now DEFINED (the C3 gate) but NOT measured. No semantic baseline
  exists; no local, subscription-only oracle producer has been shown to exist (unverified list).
  Identifier-only queries do not satisfy the gate.
- The three Dual records are read-only reviews (`tests_executed: false`, `seed_archive_opened:
  false`, GitHub settings unread by Dual — environment protection and secret scope were read live
  afterwards by this ADR's author, "Open items", item 1). "Measured N under conditions D"
  statements in this ADR come from git, from reading source, and from those `gh api` reads — not
  from running the pipeline.

## Relationship to other ADRs

- **ADR-085** (nightly corpus release channel, Proposed) — this ADR is the implementation contract
  for the corpus-seed side ADR-085 depends on, and Steps 16–19 now carry ADR-085's S1/S2 fixes as
  concrete work. Step 6 reconciles ADR-085's decision text with its own currency corrections (in
  progress). The bootstrap-seed-vs-customer-release distinction (S1) must be stated identically in
  both documents.
- **ADR-069, ADR-070, ADR-072** (Accepted) — record the seeded-scoping design (projection-time
  gist-row scoping to the seed receipt) that Step 5 retires. Step 5 review blocker (7) asked for
  either amendments to those three or this consolidation ADR; this ADR satisfies the "or". Each of
  the three still needs a currency-log row pointing here when Step 11 actually switches consumers.
  `amends:` is deliberately empty until then — nothing has been switched yet.
- **ADR-058** (The 95 contract) — the standing per-dimension observable/mutant contract that the C3
  gate (Steps 14–15) instantiates for retrieval: one observable per repository per mode, threshold
  20 × successes ≥ 19 × N, no pooling.
- **ADR-064** (corpus-QA proves machinery, not ranking; amended by ADR-085) — the C3 definition keeps
  ADR-064's canary as "regression coverage" and "machinery diagnostics" and explicitly refuses to let
  it stand in for semantic acceptance.

## Currency log
| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-14 (evening) | **Two stacked guards made every corpus-seed dispatch die before the seed download, and the C3 gate did not enforce the ADR's own denominator. All fixed on `main`; C3 is now enforced and correctly NOT established.** (1) `18f63b02`: the seed-download step required `ruvnet-brain.zip.accuracy.json` unconditionally, but the pinned bootstrap seed `v4.2.1-dev` ships only `.zip` and `.sha256` and the only producer of that report is the same workflow. The requirement now applies to digest-derived `corpus-sha256-<sha>` seeds only; a tag that CLAIMS that form but does not match its digest aborts (the first draft of the fix was fail-open on exactly that case, caught by executing the guard). (2) `d87dd702`, raised by Dual and verified in both files: the bind step demanded descriptor `schemaVersion 3` while `corpus-next-seed.mjs` validateBootstrapSeed requires 1. Schema 3 is the RECEIPT schema, not the DESCRIPTOR schema, so the same file had to be both; fix (1) was unreachable until this landed. (3) `43bf3915`: the last 13 old-form entry-point guards closed; a repo-wide grep now finds zero. The earlier ~90 figure counted occurrences, not files. (4) **Correction to the record:** `6dad0c3d` committed a 576-label, 194-partition oracle and its commit message called it step 14's producer deliverable. That was wrong. It has 1-12 unpaired labels per partition and no unit inventory, so it does not meet this ADR's denominator (N = 2 x min(100,U), one direct plus one paraphrase per stratified unit); `validateAccuracyOracle` accepted it only because the gate did not enforce the denominator. History is not rewritten; it is recorded here. (5) **Gate strengthened** (this change), per an Astra-only Dual deliberation (both seats gpt-6-astra because the Fable weekly quota is exhausted; cross-vendor independence absent and disclosed; verifier ACCEPT_WITH_CORRECTIONS): oracle schema 2 enforces U, exactly min(100,U) selected units, N = 2 x min(100,U) from the inventory never from surviving labels, one direct plus one distinct paraphrase per unit sharing one upstream evidence identity, and every selected unit accounted for as produced or unproduced; unproduced units stay in N and score as misses. `scoreEvidenceHit` now requires the result's repository to equal the partition's store and the path to be exactly the labelled path; the old version ignored the repository and matched suffixes both ways, crediting another repository's file or any bare `README.md`. Schema-1 oracles and their reports remain readable but are classified DIAGNOSTIC and refused by `validateAccuracyReport` for acceptance and publication even at 100%. Consequence, intended: the committed oracle is diagnostic, so `prepareCorpusCandidate` fails closed until a schema-2 oracle exists. (6) **Measured inventory:** `scripts/oracle/source-units.mjs` over all 194 repositories at their pinned commits, 194 ok, 0 errors; total U 157,250; compliant N = 22,310 questions. 11 repositories have U=0 but are NOT empty (READMEs without H2/H3 sections or under 40 words, non-exported JS, shell, SVG); they need explicit dispositions, never automatic emptiness. (7) **Production plan (Dual):** path B, Astra generates and Claude judges, only after a predeclared 20-unit qualification pilot with negative controls; Astra-only production rejected for acceptance; Claude generation at scale deferred. Open producer defect: units over 6,000 characters are truncated before generation (`produce-questions.mjs` MAX_UNIT_CHARS). Measured quota fact: a plain `claude -p` call loads ~303,673 context tokens; with context-shedding flags it loads 2,334. `produce-questions.mjs` already sheds; `dual-host-deliberation.mjs`'s Claude seat does not. (8) **Owner actions, re-derived:** `RUVNET_GISTS_TOKEN` is RECOMMENDED, not required (unauthenticated fallback at `gist-receipts.mjs:185`, rate-limited on shared runners); create environment `Production – corpus`; cut an owner-gated code release; emit `data/approved-runtime.json` from the AUTHENTICATED SHIPPED archive manifest, never a local build (integrating it arms the scheduler). A full local corpus build at `6dad0c3d` is in flight; its number will be labelled LOCAL DIAGNOSTIC BENCHMARK, LEGACY 576-LABEL ORACLE, NOT ADR-086 C3 ACCEPTANCE. | Commits `18f63b02`, `6dad0c3d`, `43bf3915`, `d87dd702`; `tests/unit/corpus-seed-bootstrap-exemption.test.mjs` (8, executes both workflow guards and fails on each regression); `tests/unit/corpus-accuracy-gate.test.mjs` (56, mutation-proven: the old scorer, the label-count denominator and diagnostic acceptance each make their test fail); seven dependent suites 175/175; `scripts/oracle/source-units.mjs` inventories of 194 repositories; Dual receipts in AgentDB `dual-verdict-oracle-strategy-20260914` and `ship-progress-20260914-2000`; `lesson-claude-p-context-shedding-20260914`; live `searchAll` rows showing `repo` present in both query modes. |
| 2026-09-14 | **Step 15 merged (`e57968ca`) — 19 of 20 steps now on `main` and CI-green (head `dd435b6b`).** The C3 retrieval-accuracy gate is complete, fail-closed at both boundaries, and its measurement is digest-bound to the exact archive it measured; the corpus receipt goes to schema 3. **TWO CONSEQUENCES THE OWNER MUST KNOW.** (1) **Schema-2 seeds are now unpublishable** — every reader refuses them, so `data/corpus-seed.json` must be re-pointed at a schema-3 seed in the same change that publishes one (step 11). (2) **The gate's input does not exist.** `data/retrieval-accuracy-oracle.json` was deliberately not fabricated — a fake ground-truth artifact sitting in production data and gating publication is worse than an absent one — so corpus publication is blocked AND `npm run rehearse:corpus` can no longer complete a generation, having completed two full runs earlier the same night. Producing a real oracle needs step 14's model-backed producer at ~627s and ~10 subscription calls per source; for the rehearsal's own 1-3 bounded stores that is minutes, not the ~33.8h a 194-source corpus would take. The integration owner deliberately did NOT generate it unsupervised at 04:50: it is production ground truth that gates publication, and it deserves the owner's awareness rather than an overnight agent's judgement. **A correction to the record**: step 13 reported an extracted-archive audit gap; it does not exist — `corpus-candidate.mjs:318-319` already audits the `extractZip` output — and `<bundle>.rvf-audit.json` is deliberately not receipt-bound because it records wall-clock p50/p95 and is therefore not byte-reproducible; C2 is re-run at every verification boundary instead, which is stronger than binding a digest. | `scripts/oracle/retrieval-accuracy.mjs`; `tests/unit/corpus-accuracy-gate.test.mjs` (13 MUST-BLOCK cases); commits `e57968ca`, `dd435b6b`; live check that `data/retrieval-accuracy-oracle.json` is absent and that the rehearsal reaches embedding then cannot seal. |
| 2026-09-14 | **Steps 8, 9, 14, 16, 17 and 18 merged; Dual's step-5 CONDITIONAL closed; 18 of 20 steps now on `main` and CI-green (head `4242050e`).** Each was re-verified by the integration owner before merge — diff read, tests re-run, measurements re-taken — never accepted on its agent's report. **A LOCAL LOOP NOW EXISTS**: `npm run rehearse:corpus` runs the whole pipeline in a disposable checkout in ~7m45s instead of a ~6-hour dispatch, and proved the generation chain closes (candidate N accepted as seed N+1) in four consecutive generations. **THE ORACLE QUESTION IS ANSWERED**: 298/298 byte-exact verbatim spans at \$0.00, subscription-only — but C3 itself stays unproven because that spike ran no retrieval, and at ~33.8h for 194 sources it is not nightly-viable without incremental `blobSha` regeneration. **A SILENT-SUCCESS CLASS WAS FOUND AND PARTLY CLOSED**: `path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)` compares a non-realpath'd argv[1] against a realpath'd module URL, so through ANY symlinked path (on macOS, every `os.tmpdir()`) the CLI block never runs and the process EXITS 0 having done nothing — `prepareCorpusCandidate` reported SUCCESS with no archive and no receipt on disk. Fixed in 10 pipeline scripts (`6eead7bc`) using the remedy this repo had already written down on 2026-07-27 in `plugin/scripts/hook-input.mjs:518-542` ("Resolving both sides through realpath is the entire fix"), and pinned by extending `tests/unit/entrypoint-symlink.test.mjs` (`4242050e`) per that file's own stated practice. **~90 further occurrences of related entry-point-guard shapes remain repo-wide and are NOT addressed.** Two scripts are excluded from that test because invoked with no arguments they REWRITE tracked `kb/` files — measured, not assumed. **THREE OWNER ACTIONS now block all remaining progress**: (1) create repo secret `RUVNET_GISTS_TOKEN` (read-only gist-scoped PAT) — `corpus-seed.yml:132` already reads it, and without it every corpus-seed dispatch dies at the per-gist detail fetch (`github.token` has no gist scope; the anonymous fallback is rate-limited on shared runner IPs; the committed receipt is body-free and "can never supply reuse"); (2) create environment `Production – corpus`, main-only, holding ONLY `RUVNET_SIGNING_KEY` — the existing environment also holds `NPM_TOKEN`; (3) cut one owner-gated code release emitting `data/approved-runtime.json`, without which the corpus chain refuses and the dispatcher stays disarmed. **KNOWN DELTA**: the repaired legacy CI rail ships 182 stores, not 184 — no `concepts`, no `ruv-gists` — because the previous green only passed by FABRICATING their receipts, which step 3 deliberately deleted and this work refused to restore. That matters more than two stores: `scripts/ingest-gists.mjs` calls indexing gists "the whole premise of this project". It bites only if a code release is cut before steps 8-11 retire that rail. | Two rehearsal receipts (`/tmp/step8-A-receipt.json`, `/tmp/step8-B-receipt.json`) and two tamper receipts; `docs/qe/STEP14-ORACLE-SPIKE-2026-09-13.md`; commits `2858cadd`, `d2776d35`, `edc0bcd2`, `28f6bd14`, `22931c85`, `12603669`, `6eead7bc`, `4242050e`; live `gh api` reads of repository and environment secrets; `plugin/scripts/hook-input.mjs:518-542`; `tests/unit/entrypoint-symlink.test.mjs`. |
| 2026-09-14 | **Steps 5, 6, 7, 12 and 13 merged to `main` and CI-green** (`0367f476`, `8caa1579`, `2ab9c407`, `a14bb491`, `44a6c5f6`, `7d3ecf06`, `e87162d1`, `42c6873f`; head `bfe28c97`) — 10 of 20 steps now landed. Each was independently re-verified by the integration owner (diff read, tests re-run, measurements re-taken) before merge, not accepted on its agent's report. **F9 is CLOSED**: the retrieval oracle covers 194 of 194 eligible stores, verified by running `retrieval-canary.mjs --audit` directly. **The corpus has its first measured recall figures**: 206 stores audited, 24 PASS / 180 PASS-SMALL-STORE / 2 FAIL, lowest recall 0.9950; `ruvector` 29,872x768 recall@10 1.0000. **A real shipped defect was found and independently confirmed**: `ruv-gists` carries 3,055 passages against 3,054 vectors — passage `2740` ("Jailbreak any LLM using MathPrompt", 2,326 chars) has no vector and is permanently unretrievable; `idToLabel` has 3,054 entries against `nextLabel` 3,055, so the id was allocated and the embedding dropped at ingest. It will block a real archive until that store is rebuilt. **Dual re-reviewed step 5's remediation and returned CONDITIONAL, not PASS** — "The original existence-toggle FAIL is closed. Main is not sound enough for PASS." Three P1s are open and being fixed forward: (a) standalone assembly PRUNES its own tracked `kb/` checkout, because materialization is now unconditional (`build-bundle.mjs:408` passes `kb` as output; `public-inputs.mjs:363-366` deletes excluded entries and replaces `l2/`) — the three fenced files are still intact on main, so no damage was committed, but it fires on every standalone run; (b) privacy-fence drift ships prose for a store fenced AFTER sealing, and the fix must cover primers, topics, L2 slugs AND capability cards, plus force a concepts rebuild since `corpus-aggregates.mjs:59-65` has already embedded the text; (c) `.github/workflows/ci.yml:264` invokes a CLI that now exits 1 unconditionally — "Documenting expected failure does not repair this release gate." Note that (c) is newly winnable: step 7 closed the OTHER reason `release-qe` has been red for days (`claude canary rejected: retrieval canary acceptance failed`, run 34738677342). Two measured corrections to the step-13 brief are recorded in its row: rUv floors `ef_search` at 256, and no absolute cosine cutoff can gate the passage probe because correct and incorrect pairing populations overlap. A real `corpus-seed.yml` preparation run (34811785987) was dispatched on `e9b084fc` and is executing. | Dual step-5 remediation review (verdict CONDITIONAL at head `067def3e`, answers 1-8); `gh run view` on runs 34811785987, 34738677342, 34813870454, 34814126085; independent re-runs of `retrieval-canary.mjs --audit`, `auditCorpusStores` against `~/.cache/ruvnet-brain/kb`, and a direct `idToLabel`/`passages.jsonl` reconciliation for `ruv-gists`. |
| 2026-09-13 | **Unverified item 1 (Production environment required-reviewers and `RUVNET_SIGNING_KEY` scope) resolved by live GitHub API reads** — two independent sessions on 2026-09-13, identical results; this author's read at 21:42:30 EDT. Six environments (Preview, Preview – explainer, Preview – ruvnet-brain, Production, Production – explainer, Production – ruvnet-brain); only `Production – ruvnet-brain` carries a protection rule — exactly one, type `branch_policy`, zero reviewers, **no `required_reviewers`**. Environment secrets: `NPM_TOKEN` and `RUVNET_SIGNING_KEY` (both 2026-08-02); repository secret: `NTFY_TOPIC` (2026-07-10); nothing else at either scope. `protected-release.yml` binds `environment: Production – ruvnet-brain` at `:207`/`:293`/`:485`, reads `RUVNET_SIGNING_KEY` at `:229`/`:330`/`:514` and `NPM_TOKEN` at `:328`. Written into the Step 17 and Step 18 rows, the C4 `environment_unknown` bullet, the feasibility note and the "does NOT claim" caveat: C4 is NOT blocked by environment approval; a corpus-only job must NOT bind to `Production – ruvnet-brain` (it would put `NPM_TOKEN` in scope of an unattended job — "corpus routing must never enter npm publication" as a capability boundary); design = separate `Production – corpus` environment holding ONLY `RUVNET_SIGNING_KEY`, `branch_policy` main-only. **OWNER ACTION REQUIRED before Step 17 is enabled**: create that environment and add the key (value not API-readable; the implementer will not create or copy secrets; the secrets chain is SOPS+age). Open-items table gained a status column; the other four items remain OPEN. | `gh api repos/stuinfla/ruvnet-brain/environments`; `gh api repos/stuinfla/ruvnet-brain/environments/Production%20%E2%80%93%20ruvnet-brain` and `…/secrets`; `gh api repos/stuinfla/ruvnet-brain/actions/secrets`; `.github/workflows/protected-release.yml:207,229,293,328,330,485,514` (confirmed against `main` `b250e808`); `scripts/protected-release-invocation.mjs` (the real human gate); ADR-085 (S2 analysis); acceptance record `verification.unverified[0]` and `artifact["2"].C4_resolution.environment_unknown`. |
| 2026-09-13 | **Amended scope landed: 12 steps → 19.** The owner acceptance-criteria Dual deliberation (scribe codex, verifier claude-code, verdict CONFIRMED WITH CORRECTIONS) populated after this ADR's first commit. Recorded verbatim: per-criterion verdicts C1 PARTIAL, C2 PARTIAL, C3 NO, C4 NO with reasons; Steps 12–19 as table rows (Status "Not started — added by acceptance deliberation 2026-09-13"); the C3 gate definition (evidence-supporting Hit@5; per-repo and per-mode 20×successes ≥ 19×N; N = 2×min(100,U); labels bound to upstream bytes; held out of indexing); the C4 resolution S1/S2 plus verifier A5 (S2 is a design until a real `event=workflow_dispatch` run record exists); seven verifier corrections A1–A7 (target/issue/evidence/amended_text); five unverified items including the Production-environment required-reviewer question; the F1–F10 + corrections crosswalk; the amended-contract paragraph and the verifier's added fork sentence. Completion boundary re-stated as AMENDED (original excluded C4; Steps 16–19 add it); feasibility per `answers["5"]`/A7 (8–14 sessions consistent; calendar floor 3 nights after Step 18; riskiest Step 14). Provenance row 3 replaced PENDING. Step 6 row notes A3; Step 12 A1/A2; Step 13 A4; Step 15 A6; Step 18 A5. Also fixed a defect in this document's own first commit: the `**Status**:` line carried trailing prose, so `tests/unit/adr-format.test.mjs` ("has a Status line ruflo-adr can parse") FAILED on 0086 as merged to main in `4aa9c5de` — now `**Status**: Proposed` alone, explanation moved below it. | Acceptance record `dual-acceptance-spec-out.json` (`artifact["1"]`–`["6"]`, `verification.answers/corrections/unverified/confirmed/grounding`); rUv grounding `search_ruvnet` receipt `2eee64b7a574` (ruvector `rvf-index/src/lib.rs`, `npm/packages/rvf/README.md`); `scripts/source-coverage.mjs:234-235,67,131-133`; `scripts/rvf-index-audit.mjs:30`; `scripts/release.mjs:152-161,185-193`; `scripts/corpus-seed-publish.mjs:48-51,71-79,86`; `scripts/retrieval-canary.mjs:384`; `scripts/brain-grade-groundtruth.mjs:29-56`; `scripts/sign-bundle.mjs:61-62`; `kb/forge-update.mjs:1275,1284-1285`; `.github/workflows/protected-release.yml:207,229,293-297`; commits `31ff7b10` (#286 RC3 attribution guard), `4aa9c5de` (first commit of this ADR on main); `tests/unit/adr-format.test.mjs`; ADR-064, ADR-085. |
| 2026-09-13 | **Step 5 (`86cbe798`, branch `worktree-agent-a8db1bb2b21ce2564`) FAILED independent Dual review; status set to "Committed on worktree; FAILED Dual review; remediation in progress; NOT merged."** Core defect, agreed by all four reviews: the sealed-input boundary is `if (fs.existsSync(sealedSelectionFile))` at `scripts/build-bundle.mjs:369` — "a file-existence toggle, not a verified seal. No kind/schemaVersion check, no receiptSha256 recompute, no included-name membership check, no content binding. `{}` takes the trusted branch." The else-branch (`materializePublicInputs`) fires for any corpus directory lacking the receipt, including the immutable seed; `SELECTION_FILE` is never copied into `out`, so no archive this code produces carries one and the CI seed path re-derives prose from the checkout every run. Coverage is read unconditionally from `runtimeRoot/data/source-coverage.json` (`:417-421`) with no association to the supplied corpus; `--coverage`/`--projection` are accepted and silently ignored. **Two customer-facing regressions**: (a) `scripts/build-bundle.mjs:454-455` — `try { updaterConfig = JSON.parse(corpus/SOURCE.json) } catch {}` "turns a previously REQUIRED file into silent null canonical URLs, i.e. self-update unconfigured for every installer"; (b) `:440-445` — `try { classes = JSON.parse(public-store-classes.json) } catch {}` "silently reclassifies concepts as kind 'repository' (SOURCE.json row, manifest row, gradeFor, mcp entry)". Also: partial `seedIdentity` silently downgrades to a non-release build instead of rejecting (`:617-619`); `release-projection.mjs:93` reserializes coverage with `JSON.stringify` (P3, latent). Tests: every assembly fixture writes `receiptSha256: 'unused-in-fixture'` (`tests/unit/assemble-bundle.test.mjs:113`), so passing REQUIRES the seal to be unvalidated; none removes the receipt, supplies `source-coverage.json`, or supplies `seedIdentity`. **Remediation order (q6, verbatim)**: (1) publish a Step-4-produced seed sealed from the identical coverage observation and re-pin `data/corpus-seed.json` in the same change; (2) propagate SELECTION_FILE into the archive; validate on read (kind, schemaVersion, recomputed receiptSha256, included names ⊆ on-disk, extra managed files rejected) and extend the receipt to bind included file bytes, since today it hashes names only; (3) run materializePublicInputs ONLY under an explicit standalone condition (corpus === runtime/kb), never against an external directory, never destructively against tracked source without opt-in; (4) make corpus SOURCE.json and public-store-classes.json fail-loud again; reject partial seedIdentity; reject non-canonical --coverage / any --projection; (5) do not commit the three deletions or kb/PUBLIC-INPUT-SELECTION.json; gitignore the latter; (6) tests: missing receipt → rejection for external corpus / success for kb, tampered receipt, full-seed assembly through bindAssembledReleaseProjection, coverage drift rejection, candidate-archive → re-assembly round-trip preserving the receipt; (7) update ADRs 0069/0070/0072/0058, which record the retired seeded-scoping design as Accepted, or add the consolidation ADR. Verifier corrections to the synthesis: `plugin/scripts/coverage-integrity.mjs:56-57` returns `validateLegacyGistAggregateReceipt` for schema 2 BEFORE the observation comparison, so the claimed unconditional rejection is false for schema-2 receipts; the checkout receipt has 492 gist IDs (not 491), digest `de8f5a4f…` vs coverage `94051916…`; the 17–32-hour estimate is an assumption, not a verified feasibility result. This ADR's author spot-checked the five `build-bundle.mjs` citations against `git show 86cbe798:scripts/build-bundle.mjs` — `:369`, `:417-421`, `:440-445`, `:454-455`, `:617-619` all match. | Step 5 Dual review record `dual-step5-review-out.json` (`verification.answers` q1–q7; `artifact.text` fenced JSON `consensus.agreed_by_all_four`, `disagreements_resolved`, `answers` q6); `scripts/build-bundle.mjs` and `scripts/release-projection.mjs` as committed in `86cbe798`; `plugin/scripts/coverage-integrity.mjs`; `data/corpus-seed.json`; `tests/unit/assemble-bundle.test.mjs`; ADR-069, ADR-070, ADR-072, ADR-058. |
| 2026-09-13 | **Initial: written as the contract for the in-flight consolidation, at Dual's explicit demand.** Decision, invariants, call graph, retained components, all 12 steps, rewrite/completion boundaries, highest risks, and verifier corrections C1–C6 reproduced verbatim from the rearchitect record. Per-step status verified against `git log`/`git branch --contains` rather than the briefing: Step 1's step commit is `673a26c7` (brief cited only follow-up `35a4c64c`); Step 2's step commit is `cbee06fc` (brief cited fix `50553752`; `1496ac7b` is that fix's worktree-only original); Step 3's merged follow-up is `c8464e8b` (brief cited `06cc9b14`, which is worktree-only); Step 4 `72e7718e` and Step 5 `86cbe798` match. Step 6 worktree (`worktree-agent-step6`) confirmed at `39e4eb32` with 0 commits ahead and 7 uncommitted files. Verifier correction C5 confirmed landed in `673a26c7` via `git blame` on `scripts/release.mjs:155-156` (schema-2 receipt required) and `tests/unit/corpus-seed-release-authority.test.mjs:178` (downgrade rejected). `node scripts/doc-currency.mjs --check` on this document: 2 pre-commit warnings only (`no-git-history`, `stamp-unverifiable-dirty`); the 10 `presumed-stale` BLOCKs the gate reports are on ADR-054/056/058/060/062/069/070/072/084/085 and are identical on the primary `main` checkout — pre-existing, not caused here. `tests/unit/doc-currency.test.mjs`, `doc-currency-review.test.mjs`, `adr-currency-gate-parity.test.mjs`: 75/75 passed. All 12 `governs:` paths confirmed present on main; all 6 `relates:` ADRs confirmed present and on-topic. `docs/adr/README.md`'s index stops at 0010 (last updated 2026-07-27) and lists none of 0011–0085, so no 0086 row was added — an out-of-sequence single row would misrepresent the index as current. Owner acceptance-criteria deliberation output was empty at both checks; section left as a marked placeholder. | Rearchitect record `dual-full-rearchitect-out.json` (`artifact.decision`, `.target_architecture`, `.ordered_implementation_plan`, `.scope_and_risk`, `.protected_publication`; `verification.text` corrections C1–C6); `git log --oneline -40 main` at `39e4eb32`; commits `cb988108`, `673a26c7`, `35a4c64c`, `cbee06fc`, `50553752`, `7598a68e`, `c8464e8b`, `72e7718e`, `86cbe798`; `git -C .claude/worktrees/agent-step6 status --short`; ADR-085 (shape reference); `docs/PRINCIPLES.md` P6/P7. |
