---
id: ADR-085
title: The nightly corpus release channel — wire the already-built publisher, don't build a second one
status: Proposed  # 2026-09-13: pipeline dispatched for real for the first time. 3 live defects found+fixed; a full Dual pipeline trace then found 21 more (undispatched, unfixed). No unattended nightly customer delivery exists or is proven. Main body reconciled same day (step 6, corpus-seed-pipeline-rewrite) to state this directly instead of leaving it stranded in the currency log; corpus-seed-publish.mjs deleted as a confirmed-dead redundant wrapper. See currency log for full detail.
date: 2026-09-12
updated: 2026-09-13
authors: [Stuart Kerr, Claude Sonnet 5]
tags: [corpus, release, nightly, currency, completeness]
supersedes: []
amends: [ADR-064]
relates: [ADR-058, ADR-070, ADR-084]
governs:
  - .github/workflows/corpus-seed.yml
  - .github/workflows/protected-release.yml
  - scripts/release.mjs
  - scripts/corpus-reconcile.mjs
  - scripts/release-authority.mjs
  - kb/forge-update.mjs
  - data/corpus-seed.json
---

# ADR-085 — The nightly corpus release channel

**Status**: Proposed

The pipeline was dispatched for real for the first time on 2026-09-13, is not yet reliable end to
end, and has never delivered corpus content to a customer unattended. See "Where this actually
stands, 2026-09-13" below.

## The owner's mandate

"Make sure it works every single night and it has all of rUv's data and all of his code and all
of his repos and all of his gists, period." Not a rollback to any prior code — a standing,
mechanically-checkable invariant. Code releases (npm/plugin version) stay owner-gated exactly as
ADR-058/release-authority require; only the **corpus** must move nightly without a human GO.

## The finding that changes the shape of this fix

The brief that produced this ADR assumed a nightly corpus publisher had to be built. It does not.
**It was already built and unit-tested — but, as of 2026-09-12, never connected, and, as of
2026-09-13, never successfully run end to end either.** The table below states the CURRENT verified
state, folding in every correction from the currency log rather than leaving them stranded there:

| Piece | State | Evidence |
|---|---|---|
| Candidate build + reconcile | Built, unit-tested. Its first-ever real invocation (2026-09-13) failed twice on defects in this exact path (missing `kb/public-store-classes.json` on main; the reconcile step had no `GH_TOKEN`) — both fixed live (commits b8d68020, f95a1a56) and Dual-verified. The same day's full Dual pipeline trace found several more deterministic defects touching this and adjacent scripts (F1-F10, see "Where this actually stands" below) that have **not** been exercised by a real run and are **not** fixed — this row's own attribution of which F-item lands in which file is not independently re-verified here; see the currency log for the trace's own attribution. | `scripts/corpus-reconcile.mjs`; currency log 2026-09-13 |
| Read-only preparation workflow | Built, tested, dispatched manually 3 times on 2026-09-13 (runs 34747861280/34748047534/34748219614) — each failed on a sequential defect, all 3 now fixed. Still has no `schedule:` trigger; a nightly cadence does not exist yet even as a mechanism. | `.github/workflows/corpus-seed.yml` — `workflow_dispatch`/`workflow_call` only |
| Canonical publish mode | Built, unit-tested, **still ZERO live callers** — this has not changed since 2026-09-12. | `scripts/release.mjs --corpus-seed` / `runProtectedCorpusSeed()`; proven correct by `tests/unit/corpus-seed-release-authority.test.mjs` and `tests/unit/corpus-seed.test.mjs`, but `grep -n "corpus-seed" .github/workflows/protected-release.yml` returns only `corpus-seed.json` **path** references (evidence upload) plus `node scripts/release.mjs --publish` for the unrelated code-publish job — the workflow never invokes `release.mjs --corpus-seed` |
| Publication wrapper (`scripts/corpus-seed-publish.mjs`) | **Deleted 2026-09-13 (this step).** The 2026-09-12 body below had called it dead code to be left alone; that same day's currency log (S6) corrected the record — it was real, functioning, unit-tested code (verifies the receipt/archive, then delegates to `release.mjs --corpus-seed`), not inert. Both things are true at once: it was never dead, and it was never called by anything live either. Fresh investigation this step (`grep -rn "corpus-seed-publish"` across every `.mjs`/`.yml`/test/doc in the repo) confirms zero live callers remain — `protected-release.yml` never invokes it, `corpus-seed.yml` only *printed* its name in an operator-facing message (never executed it), and it is correctly absent from `CANONICAL_PUBLISHERS`. Of its four steps, three were already duplicated inside `runProtectedCorpusSeed()` — archive sha256/byte-length vs receipt, tag-digest binding, and tag-absence via `gh release view` (`scripts/release.mjs:164-168, 183-189`). The fourth was **not**: the deep `verifyCorpusReceipt` re-derivation of the whole candidate from the sealed archive's own bytes — per-store file digests, private fence, generation ledger, RVF index audit (`scripts/corpus-candidate.mjs:361-392`). Dual's acceptance-criteria verification caught that a bare deletion would silently drop that step (an earlier draft of this row wrongly called the wrapper "fully duplicated"). So it was **moved**, not dropped: `runProtectedCorpusSeed()` now awaits `verifyCorpusReceipt` itself (`scripts/release.mjs:170-181`), before any `gh` call, and is `async` as a result; `tests/unit/corpus-seed-release-authority.test.mjs` proves it with a receipt carrying one forged per-store digest over an untouched archive — that receipt passes every shape/identity check and is rejected only by this step, with no `gh` call recorded. That test suite now runs against a genuine sealed bundle (`tests/helpers/corpus-seed-fixture.mjs`, shared with `corpus-seed.test.mjs`) because a text file with a matching outer digest can no longer reach the publisher. The wrapper also hardcoded `prerelease: true` in its result (old `:86`); `runProtectedCorpusSeed`'s own `--prerelease --latest=false` (`scripts/release.mjs:201`) is preserved for now per Dual's resolved disagreement that seed publication is not customer delivery — changing it is later C4 work, not this step's. Its dedicated tests, `corpus-reconcile.mjs`'s header comment, `corpus-seed.yml`'s operator message, and `wired-check.mjs`'s STANDALONE exemption entry were all updated/removed in the same change. |
| Hard identity lock | Real, deliberate, unchanged. | `scripts/protected-release-invocation.mjs::validateProtectedPublishEnvironment` requires `env.GITHUB_WORKFLOW === PROTECTED_WORKFLOW` (the literal workflow **name**, which GitHub sets from the `name:` field — `protected-release`). `release.mjs --corpus-seed` can only ever run **inside a workflow named `protected-release`**. A brand-new sibling workflow file cannot call it, however it schedules itself. |

This means: don't build a second publisher. **Extend `protected-release.yml` with a second, nightly, unattended job path that runs only the corpus-seed publish, and leave the existing manual code-publish job exactly as it is.** That conclusion still holds. What has changed is that this is now known to be a **substantial, multi-day remaining effort**, not a near-complete wiring task — see "Where this actually stands, 2026-09-13" below.

### Where this actually stands, 2026-09-13

The 2026-09-12 version of this ADR (below, in "Decision") described a design and believed only two
defects (S1, S2) stood between it and being ready to implement. Neither belief survived contact with
a real run:

- **S1/S2 re-evaluated against the narrower goal actually attempted today** (refresh the bootstrap
  seed pointer for the next code release, via a manual `workflow_dispatch` — not yet the harder
  unattended-nightly-customer-channel goal this ADR is actually about): neither blocks that narrower
  goal. They **do** still block the broader goal this ADR proposes (a `schedule:`-triggered,
  no-approval nightly job) exactly as originally found — S1 (prerelease/missing-signature makes a
  real nightly publish invisible/rejected to customers) and S2 (a `schedule:`-fired event cannot pass
  `validateProtectedPublishEnvironment`'s `workflow_dispatch` check) are unfixed and undesigned-for.
- **A full Dual pipeline trace** (2 scribe/verifier rounds across `corpus-reconcile.mjs`,
  `corpus-candidate.mjs`, `corpus-aggregates.mjs`, `build-bundle.mjs`, `release-projection.mjs`,
  `gist-receipts.mjs`, `protected-release.yml`, and this ADR) found **10 further deterministic
  defects (F1-F10)** that would surface on the very next run, and **11 more corrections** needed in
  the proposed fixes for those defects — 21 items total, **none fixed, none dispatched against real
  data**. Full detail is in the currency log's 2026-09-13 row; it is not repeated here to keep this
  section from drifting out of sync with it a second time.
- **Explicit unverifiable-by-reading risks remain flagged**, not resolved: CI timeout sufficiency for
  ~194 repos' clone+embed time, runner disk/RAM under concurrent embedding workers, and GitHub's
  anonymous gist-API rate limit under hosted-runner tenancy.
- **Dual's own recommendation, not yet acted on**: a full dry run in an isolated, disposable checkout
  before any further real dispatch. This is explicitly a multi-day remaining effort, matching this
  ADR's own 2026-09-12 closing line ("deserves its own dedicated, tested pass — not a rushed addition
  at the tail of a research-heavy session") — it was correct then and remains correct now.

**What this ADR does NOT claim, and must not be read as claiming**: unattended nightly delivery to a
customer, or completed runtime proof of the pipeline described in "Decision" below. What is actually
true: three real defects were found and fixed via live dispatch attempts; the underlying units
(receipt/archive verification, identity lock, candidate build) are genuinely tested in isolation; and
the end-to-end path from a `schedule:` trigger to a customer-visible corpus release has never run
once, successfully, in full.

## Phase A answer: does `releases/latest` work for a corpus-only release, unmodified?

**Yes — no change needed to `kb/forge-update.mjs` or `bin/install.mjs`.** Verified at
`kb/forge-update.mjs:504,527-537`: the canonical manifest customers poll is `releases/latest`
(GitHub Release payload, shape 3), and `isBehind()` treats **release-tag identity as authoritative
when both sides carry a tag**: `canon.releaseTag !== local.releaseTag` — a plain string
inequality, not a semver comparison. A `corpus-sha256-<64-hex>`-tagged release marked "latest" is
therefore picked up as "behind" the moment its tag differs from whatever the customer currently has
installed, exactly like a version-tagged release is today.

The one thing that must hold, and is a **policy**, not a code change: the corpus release's shipped
`SOURCE.json.brainVersion` must equal the currently-shipped npm/plugin code version. `bin/install.mjs`'s
fresh-install path validates `expectedVersion: PACKAGE_VERSION` against the staged tree — if a corpus
release ever shipped a `brainVersion` that didn't match the live npm package, a fresh install would
reject it. A corpus-only release changes tag and content; it must **never** change `brainVersion`.
`release.mjs --corpus-seed`'s receipt/candidate machinery already carries `builderSourceSha` — verify
the corpus-seed generator pins `brainVersion` from that source SHA's own `plugin.json`, not the
seed's frozen value, before this ships (unverified in the time available for this pass — flagged, not
fixed).

## Decision

**Status of this plan, 2026-09-13: none of it is built, and it is not ready to build as written.**
It requires, at minimum, all of: the S1/S2 redesign from the 2026-09-12 currency log (drop
`--latest=false` and attach a real signature; a separate low-privilege dispatcher workflow that
fires a genuine `workflow_dispatch` event) — neither designed nor built; resolving the 21 further
defects found 2026-09-13 (see "Where this actually stands" above) — none fixed; and, per Dual's
explicit recommendation, an isolated dry run before any of it touches the real nightly schedule.
The design below is retained because its shape (extend `protected-release.yml`, don't build a second
publisher) is still believed correct — not because it is close to done.

Amend ADR-064's 2026-08-31 row ("nightly convergence is now report-only and cannot dispatch a
publisher") **for corpus content only**: `protected-release.yml` gains a second job,
`corpus-nightly`, triggered by `schedule:` (and `workflow_dispatch` for manual runs), that:

1. Resolves `origin/main`'s current SHA and calls `corpus-seed.yml` via `workflow_call` to prepare
   and seal a fresh candidate — exactly the existing, already-tested, read-only path.
2. Downloads that exact sealed artifact, re-verifies both digests (mirroring the existing
   `protected-release` code-publish job's own re-verification step — do not skip it for corpus
   just because it's "only" content).
3. Calls `node scripts/release.mjs --corpus-seed --corpus-tag corpus-sha256-<digest> --corpus-bundle
   <path> --corpus-receipt <path> --target <sha> --repo stuinfla/ruvnet-brain` — the real, tested,
   canonical publish mode, inside the one workflow whose identity check allows it.
4. Requires **no human approval** for this job specifically (the owner-gate stays on the code-publish
   job only) — this is the one place ADR-064's "cannot dispatch a publisher" is deliberately loosened,
   and only for a channel that can never touch npm, the plugin version, or a code tag.
5. Writes a receipt the watchdog and console's nightly card can read (mirror
   `com.ruvnet.brain-update`'s `refresh-runs/*.json` shape or `job-heartbeat.sh`'s contract — pick
   whichever the watchdog already knows how to project; do not invent a third shape).

### Completeness, freshness, honesty — mechanically checkable

- **Completeness**: every live `ruvnet` org repo and every gist is enumerated fresh each run.
  **Corrected 2026-09-12 (S7), no longer open**: `corpus-reconcile.mjs` discovers the repo set by
  observing the live org directly (`source-coverage.mjs`'s `observeSourceUniverse`), not by reading
  `data/source-coverage.json`/`--coverage` as an inventory — that file is a rendered *output* of the
  observed set, not its source. So a newly-shipped rUv repo is picked up the next time this job runs,
  without needing `ingest-new-repos.mjs` to land it first. This closes the completeness question the
  2026-09-12 version of this ADR left open. It does not, on its own, close **F7** (2026-09-13):
  pruning a repo that was *renamed or deleted* upstream is a no-op in the current code — a corpus
  that only ever grows, never sheds a dead entry, is not the same claim as completeness for live
  repos, and F7 remains an unfixed defect. A night that cannot reach completeness must still say so
  in its receipt (`incomplete: N missing`, naming them) — never "up to date" while incomplete; this
  requirement itself is not yet implemented.
- **Freshness**: any store whose upstream SHA moved is rebuilt by `corpus-reconcile.mjs` every run,
  by construction — this is already the tool's stated purpose.
- **Honesty**: per-store digest verification against a candidate's own declared file identities is
  **`corpus-candidate.mjs --verify`'s job, not `release.mjs`'s** (corrected 2026-09-12, S13 —
  `release.mjs --corpus-seed` validates receipt/generator/archive identity shape, but the deep
  per-store digest check is a separate, already-invoked step, called from `corpus-seed.yml:148-152`
  during preparation). Since 2026-09-13 the same `verifyCorpusReceipt` re-derivation also runs at
  publish time inside `runProtectedCorpusSeed()` (`scripts/release.mjs:170-181`), moved there from
  the deleted wrapper — so a receipt that verified at preparation but was altered in transit is
  caught again before `gh` is invoked. This invariant is enforced at both ends, not new.
- **None of the three invariants above are proven in practice yet.** They describe the intended
  design; the 2026-09-13 full Dual pipeline trace found concrete ways today's code would violate
  them on the very next run (F1-F10, currency log) — e.g. F4 (a fresh seed's private-store fence
  gets rejected by the *next* reconcile) and F9 (the retrieval oracle silently misses 12 of 194
  eligible stores). Completeness/freshness/honesty being mechanically checkable in design is not the
  same claim as this pipeline currently satisfying them end to end.

## What NOT to change

- `release-authority.mjs`'s `CANONICAL_PUBLISHERS` set — it is already correct (`release.mjs` and
  `release-transaction-provider.mjs` are canonical; `corpus-seed-publish.mjs` was never added to it,
  and has now been deleted entirely — see the finding table above — rather than resurrected).
- `kb/forge-update.mjs`, `bin/install.mjs` — the customer side needs zero change (Phase A verdict).
  Nothing in the 2026-09-13 findings contradicts this; it is unrelated to the F1-F10/S1-S13 defects,
  all of which are on the build/publish side, not the install side.
- The existing code-publish job's human-approval gate.

## Consequences

- **If** the remaining work below is completed and proven, the corpus can go from a
  2026-08-21-sealed seed to nightly-fresh without a second publisher, without weakening
  `release-authority.mjs`, and without any customer-side code change. None of that is true today.
- The real remaining engineering is larger than originally scoped and is now enumerated, not
  estimated: the S1/S2 redesign (prerelease/signature, genuine `workflow_dispatch` dispatcher), the
  21 items from the 2026-09-13 full pipeline trace, and an isolated dry run before any real dispatch
  — Dual's explicit recommendation, not yet attempted. This is a substantial, multi-day effort; it
  was correctly called out as deserving "its own dedicated, tested pass — not a rushed addition at
  the tail of a research-heavy session" on 2026-09-12, and that has not changed.
- As of 2026-09-13, `corpus-seed.yml` **has** been dispatched manually — three times, each failing on
  a sequential defect, all three now fixed live. That is real progress over "never run," but it is
  not the same claim as a working pipeline: no run has yet completed successfully end to end, no
  `schedule:`-triggered nightly job exists, and `protected-release.yml` has never published corpus
  content, attended or unattended. The brain's shipped corpus is exactly as fresh as its last
  successful manual `corpus-seed.yml` + code release — which, since no `corpus-seed.yml` dispatch has
  yet completed successfully, is still as stale as it was before this session.

## Currency log
| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-13 | **Step 6 of the corpus-seed/release pipeline rewrite (swarm-1789347766271-b91ikw, agent-1789347776076-d4uarg): reconciled this ADR's main body with the currency corrections below instead of leaving readers to reconcile them by hand, and deleted the redundant publication wrapper.** The finding table, Decision, "Completeness/freshness/honesty" bullets, "What NOT to change", and Consequences were rewritten to state the CURRENT verified truth directly: the pipeline has been dispatched for real (3 failures, 3 live fixes) but has never completed successfully end to end; the S1/S2 defects and the 21 further F-series/correction items from the same day remain wholly unfixed; and this ADR does not claim unattended nightly customer delivery or completed runtime proof of anything in "Decision". Fresh investigation (not from ADR memory) confirmed `scripts/corpus-seed-publish.mjs` still has zero live callers — `grep -rn "corpus-seed-publish"` across every `.mjs`/`.yml`/test/doc in the repo, plus direct reads of `protected-release.yml` (no invocation), `corpus-seed.yml` (only an operator-facing echo, never executed), and `release-authority.mjs` (`CANONICAL_PUBLISHERS` never included it) — and that three of its four steps (archive digest/bytes, tag binding, tag absence) were already duplicated by `release.mjs --corpus-seed`'s own `runProtectedCorpusSeed()` (`scripts/release.mjs:164-168, 183-189`). Dual's acceptance-criteria verification then corrected this step's own first draft, which had called the wrapper "fully duplicated": the deep `verifyCorpusReceipt` re-derivation (`scripts/corpus-candidate.mjs:361-392`, wrapper `:48-51`) was **not** in `release.mjs`, and a bare deletion would have silently dropped a verification step. Fixed in the same change — `runProtectedCorpusSeed()` is now `async` and awaits `verifyCorpusReceipt` before any `gh` call (`scripts/release.mjs:170-181`); `tests/unit/corpus-seed-release-authority.test.mjs` gained a test that forges one per-store digest over an untouched archive and requires rejection with zero `gh` calls, and its fixture became a genuine sealed bundle via the new shared `tests/helpers/corpus-seed-fixture.mjs` (extracted verbatim from `corpus-seed.test.mjs`). The wrapper's hardcoded `prerelease: true` (`:86`) vs `runProtectedCorpusSeed`'s preserved `--prerelease --latest=false` (`scripts/release.mjs:201`) is recorded as later C4 work per Dual's resolved disagreement (seed publication ≠ customer delivery). Deleted the file; updated `corpus-reconcile.mjs`'s header comment and `corpus-seed.yml`'s operator message to point at the real canonical publisher (`release.mjs --corpus-seed`) instead of the deleted wrapper; removed its now-orphaned `STANDALONE` exemption entry from `scripts/wired-check.mjs`; removed its dedicated `describe` block and now-unused import from `tests/unit/corpus-seed.test.mjs` (the file's other, unrelated tests of `corpus-candidate.mjs` were untouched); corrected a stale comment in `tests/unit/corpus-release-convergence.test.mjs` that misattributed `corpusSeedTag` to `corpus-candidate.mjs`. `CANONICAL_PUBLISHERS` itself needed no change — it was already correct. No other pipeline code was touched (build-bundle.mjs/release-projection.mjs and further corpus-seed.yml defect fixing are out of this step's scope). | Live repo investigation 2026-09-13 (grep across `.mjs`/`.yml`/tests/docs; direct reads of `protected-release.yml`, `corpus-seed.yml`, `scripts/release.mjs`'s `runProtectedCorpusSeed`, `scripts/corpus-reconcile.mjs`, `scripts/wired-check.mjs`'s `STANDALONE`/`audit()`, `scripts/release-authority.mjs`'s `CANONICAL_PUBLISHERS`); `node scripts/wired-check.mjs --check` and the full regression suite re-run after the edit. |
| 2026-09-13 | **First-ever real dispatch of corpus-seed.yml, and a complete Dual re-analysis. The "Built, tested" table above is now contradicted by live evidence — the pipeline was built and unit-tested, but had never actually run.** Three sequential CI-discovered defects were found and fixed live (commits b8d68020, f95a1a56, fd0647d1): `kb/public-store-classes.json` was never committed to main (existed only on an old unmerged branch); the reconcile step had no `GH_TOKEN`, so live org-wide repo discovery failed; `observeGists()` had no fallback for the Actions-token gists 403 (a failure mode already documented and solved elsewhere in `scripts/ingest-gists.mjs`, just not reused here). All three fixes independently Dual-verified as correct. Re-verified S1/S2 from the 2026-09-12 row against the *narrower* goal (refresh the bootstrap pointer so the next code release ships current knowledge, not the harder unattended-nightly-customer-channel goal): **neither blocks this narrower goal.** S1 doesn't apply — every consumer (`ci.yml`, `corpus-seed.yml` itself) downloads the seed by exact tag+sha256, never via `releases/latest`, so `--prerelease --latest=false` is correct and should stay. S2 doesn't apply to a manual `workflow_dispatch` on a protected ref — only to an actual `schedule:` trigger, which remains out of scope. However, a full end-to-end Dual pass (2 scribe/verifier rounds) tracing `corpus-reconcile.mjs`, `corpus-candidate.mjs`, `corpus-aggregates.mjs`, `build-bundle.mjs`, `release-projection.mjs`, and `gist-receipts.mjs` completely found **10 further deterministic defects** that would surface on the very next run (F1: gist receipt reuse is broken, causing 492 individual detail fetches that 403 on the first one; F2: the runner never installs `@xenova/transformers`, so every embed fails; F3: a receipt-binding reset bug fails all 492 gists' final validation; F4: the new seed's private-store fence gets rejected by the next reconcile; F5: a content-addressed seed tag is structurally incompatible with `public-verification-inputs.mjs`'s tag-equality check, blocking the *next actual code release*; F6: derived concepts/gist inputs don't survive packaging correctly; F7: pruning renamed/deleted upstream repos is a no-op; F8: a minor double-observation inefficiency; F9: the retrieval oracle covers 182 of 194 eligible stores, missing 12 (apx, batvu, event-horizon, group-field-theory, minitoo-control, moe-foundry, openavo, rgi, ruclip, ruforecast, rultra, ruos); F10: 3 existing unit tests pin assumptions the wiring change would break) — and a second-pass verifier then found **11 more corrections needed in the proposed fixes for those defects** (most seriously: the proposed new publisher job downloads files into the git checkout and would fail its own clean-worktree check; the proposed commit order runs a CI gate that requires oracle data not yet written; the reconciled gist receipt never actually reaches the packaged archive; an anonymous-API rate-limit budget miscalculated by ~576x). Explicit unverifiable-by-reading risks flagged: whether the 360-minute CI timeout is sufficient for ~194 repos' clone+embed time, runner disk/RAM under concurrent embedding workers, and GitHub's anonymous gist-API rate limit shared across hosted-runner tenants — Dual's own recommendation is a full dry run in an isolated, disposable checkout before any real dispatch, not a blind attempt on the live 6-hour job. **Decision for tonight: land the 3 verified fixes (done), do NOT attempt the remaining 21 identified defects or re-dispatch corpus-seed.yml tonight** — this is a substantial, multi-day remaining effort exactly matching this ADR's own 2026-09-12 row's closing line ("deserves its own dedicated, tested pass — not a rushed addition at the tail of a research-heavy session"), not a same-session completion. reviewed_digest 7119bde1564f. | Live first dispatch attempts (runs 34747861280, 34748047534, 34748219614, all failed on the 3 sequential defects above, root-caused via `gh run view --log-failed` each time); full Dual end-to-end pipeline analysis (2 synthesis+verify rounds) covering `corpus-reconcile.mjs`, `corpus-candidate.mjs`, `corpus-aggregates.mjs`, `build-bundle.mjs`, `release-projection.mjs`, `gist-receipts.mjs`, `protected-release.yml`, and this ADR in full. |
| 2026-09-12 | **Dual verification found 2 blocking defects in this document's own Decision.** (S1, blocking) The proposed job publishes exactly as `release.mjs --corpus-seed` does today — `--prerelease --latest=false`, bundle+receipt only. GitHub's `releases/latest` (what customers poll) never surfaces a prerelease, and `kb/forge-update.mjs:1275,1284-1285` requires a detached `.sig` and refuses extraction without one. **"No customer-side change needed" is false as designed** — the release would be both invisible and, if somehow reached, rejected for a missing signature. (S2, blocking) The proposed `schedule:` trigger cannot work: `protected-release-invocation.mjs:28` requires `GITHUB_EVENT_NAME === 'workflow_dispatch'`, which a schedule-fired run does not carry — `release.mjs:92-95` refuses it before `gh` is even invoked. **A schedule trigger inside `protected-release.yml` is rejected by the exact check this document calls "real, deliberate."** Promising direction, not yet designed or verified: a small scheduled *dispatcher* (separate, low-privilege workflow) that calls `gh workflow run protected-release.yml` — which fires the target run as a genuine `workflow_dispatch` event, satisfying the check honestly rather than weakening it — paired with fixing `release.mjs`'s corpus mode to drop `--latest=false` and attach a real signature. Neither fix is built; this ADR's Decision section is not ready to implement as written. Also: `scripts/corpus-seed-publish.mjs` is NOT dead code (S6) — it verifies the receipt and delegates to `release.mjs --corpus-seed`; `corpus-reconcile.mjs` discovers repos by observing the live org fresh, not by reading the `--coverage` argument as an inventory (S7); `release.mjs` validates receipt/generator/archive identity but not per-store digests — that's `corpus-candidate.mjs --verify` (S13). The two cited test files (`corpus-seed-release-authority.test.mjs`, `corpus-seed.test.mjs`) exist and were confirmed passing (29/29) by direct execution after Dual's sandbox could not run them — the underlying publish mode's own correctness is real; its wiring for customer delivery and its unattended trigger are not. | Dual verification pass, 2026-09-12, re-reading `scripts/release.mjs:179-190`, `scripts/protected-release-invocation.mjs:23-31`, `kb/forge-update.mjs:1274-1285`, `kb/SOURCE.json:4`, `scripts/corpus-seed-publish.mjs:47-82`, `scripts/corpus-reconcile.mjs:412-488` directly; tests re-run by the integration owner, 29/29 passed. |
| 2026-09-12 | Initial decision, written after discovering the corpus-seed publish mode was fully built and unit-tested but never wired into any live workflow. | `.github/workflows/corpus-seed.yml`; `.github/workflows/protected-release.yml`; `scripts/release.mjs::runProtectedCorpusSeed`; `scripts/protected-release-invocation.mjs::validateProtectedPublishEnvironment`; `scripts/release-authority.mjs::CANONICAL_PUBLISHERS`; `kb/forge-update.mjs:504,527-537`. |
