---
id: ADR-084
title: The nightly corpus release channel — wire the already-built publisher, don't build a second one
status: Proposed
date: 2026-09-13
updated: 2026-09-13
authors: [Stuart Kerr, Claude Sonnet 5]
tags: [corpus, release, nightly, currency, completeness]
supersedes: []
amends: [ADR-064]
relates: [ADR-058, ADR-070]
governs:
  - .github/workflows/corpus-seed.yml
  - .github/workflows/protected-release.yml
  - scripts/release.mjs
  - scripts/corpus-reconcile.mjs
  - scripts/release-authority.mjs
  - kb/forge-update.mjs
  - data/corpus-seed.json
---

# ADR-084 — The nightly corpus release channel

**Status**: Proposed

## The owner's mandate

"Make sure it works every single night and it has all of rUv's data and all of his code and all
of his repos and all of his gists, period." Not a rollback to any prior code — a standing,
mechanically-checkable invariant. Code releases (npm/plugin version) stay owner-gated exactly as
ADR-058/release-authority require; only the **corpus** must move nightly without a human GO.

## The finding that changes the shape of this fix

The brief that produced this ADR assumed a nightly corpus publisher had to be built. It does not.
**It was already built, already unit-tested, and never connected.** Verified live, this session:

| Piece | State | Evidence |
|---|---|---|
| Candidate build + reconcile | **Built, tested** | `scripts/corpus-reconcile.mjs` ("Build a corpus candidate from one immutable seed and exact upstream repository SHAs") |
| Read-only preparation workflow | **Built, tested, never scheduled** | `.github/workflows/corpus-seed.yml` — `workflow_dispatch`/`workflow_call` only, no `schedule:` trigger |
| Canonical publish mode | **Built, unit-tested, ZERO live callers** | `scripts/release.mjs --corpus-seed` / `runProtectedCorpusSeed()`; proven correct by `tests/unit/corpus-seed-release-authority.test.mjs` and `tests/unit/corpus-seed.test.mjs`, but `grep -n "corpus-seed" .github/workflows/protected-release.yml` returns only two `corpus-seed.json` **path** references (evidence upload) — the workflow never invokes `release.mjs --corpus-seed` |
| Stale pointer | Misleading comment | `corpus-seed.yml:177-182` tells the operator to "call `scripts/corpus-seed-publish.mjs`" — that file exists but is **not** in `release-authority.mjs`'s `CANONICAL_PUBLISHERS` (only `scripts/release.mjs` and `scripts/release-transaction-provider.mjs` are). It appears to be superseded dead code from before corpus publishing was folded into `release.mjs --corpus-seed` as a canonical-publisher mode; nothing in a real workflow calls it. Do not resurrect it — extend the workflow that already calls the real canonical mode. |
| Hard identity lock | Real, deliberate | `scripts/protected-release-invocation.mjs::validateProtectedPublishEnvironment` requires `env.GITHUB_WORKFLOW === PROTECTED_WORKFLOW` (the literal workflow **name**, which GitHub sets from the `name:` field — `protected-release`). `release.mjs --corpus-seed` can only ever run **inside a workflow named `protected-release`**. A brand-new sibling workflow file cannot call it, however it schedules itself. |

This means: don't build a second publisher. **Extend `protected-release.yml` with a second, nightly, unattended job path that runs only the corpus-seed publish, and leave the existing manual code-publish job exactly as it is.**

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

- **Completeness**: every live `ruvnet` org repo and every gist is enumerated fresh each run
  (`corpus-reconcile.mjs`'s repo set is driven by `data/source-coverage.json`, passed in as
  `--coverage`). **Open, unverified in this pass**: whether `corpus-reconcile.mjs` discovers repos
  that have **never** appeared in that coverage file before, or only refreshes SHAs for repos
  already listed there. If it's the latter, `ingest-new-repos.mjs` must run and land in
  `data/source-coverage.json` **before** this job, in the same night, or newly-shipped rUv repos
  will never enter the corpus no matter how often this job fires. A night that cannot reach
  completeness must say so in its receipt (`incomplete: N missing`, naming them) — never
  "up to date" while incomplete.
- **Freshness**: any store whose upstream SHA moved is rebuilt by `corpus-reconcile.mjs` every run,
  by construction — this is already the tool's stated purpose.
- **Honesty**: `release.mjs --corpus-seed`'s receipt validation already rejects a candidate whose
  declared stores don't match its own file digests (`corpus-candidate.mjs --verify`, called from
  `corpus-seed.yml:148-152`) — this invariant is already enforced, not new.

## What NOT to change

- `release-authority.mjs`'s `CANONICAL_PUBLISHERS` set — it is already correct (`release.mjs` is
  canonical; adding `corpus-seed-publish.mjs` would be reviving dead code, not fixing anything).
- `kb/forge-update.mjs`, `bin/install.mjs` — the customer side needs zero change (Phase A verdict).
- The existing code-publish job's human-approval gate.

## Consequences

- The corpus can go from a 2026-08-21-sealed seed to nightly-fresh without a second publisher,
  without weakening `release-authority.mjs`, and without any customer-side code change.
- The real remaining engineering is narrow and high-stakes: one new job inside the single most
  protected workflow in the repo, plus closing the completeness question above. Both deserve their
  own dedicated, tested pass — not a rushed addition at the tail of a research-heavy session.
- Until that job exists, `protected-release.yml` never runs unattended for corpus content, and the
  brain stays exactly as fresh as its last manually-dispatched `corpus-seed.yml` + code release —
  which is to say, as stale as it is today.

## Currency log
| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-13 | Initial decision, written after discovering the corpus-seed publish mode was fully built and unit-tested but never wired into any live workflow. | `.github/workflows/corpus-seed.yml`; `.github/workflows/protected-release.yml`; `scripts/release.mjs::runProtectedCorpusSeed`; `scripts/protected-release-invocation.mjs::validateProtectedPublishEnvironment`; `scripts/release-authority.mjs::CANONICAL_PUBLISHERS`; `kb/forge-update.mjs:504,527-537`. |
