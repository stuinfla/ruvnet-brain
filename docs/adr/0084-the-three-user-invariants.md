---
id: ADR-084
title: The three user invariants — complete-and-current corpus, enforced hooks, an end-user console
status: Proposed
date: 2026-09-12
updated: 2026-09-12
version: 1.0.1
reviewed_digest: PENDING
authors: [Stuart Kerr, Claude]
tags: [product, corpus, hooks, console, north-star, invariants]
supersedes: []
amends: [ADR-064]
relates: [ADR-001, ADR-009, ADR-012, ADR-040, ADR-054, ADR-064, ADR-069, ADR-070, ADR-072, ADR-085]
governs:
  - docs/ddd/0021-corpus-supply-chain-context.md
  - scripts/source-coverage.mjs
  - console/scope.html
  - console/index.html
  - plugin/hooks/hooks.json
  - plugin/hooks/codex-hooks.json
  - plugin/scripts/continuity-hook-policy.mjs
---

# ADR-084 — The three user invariants

**Status**: Proposed (downgraded from Accepted same-day — Dual verification 2026-09-12 found 4 blocking + 10 major/minor defects; see Currency log)

**Date**: 2026-09-12

## The owner's definition of working, verbatim, and why it is the whole ADR

> "If the application doesn't have a database that's updated, it's worthless. If the configurator
> doesn't show relevant information to an end user and respond to whatever choices they make, it's
> worthless. If the tool itself doesn't enforce hooks that ensure that you do the right thing as per
> the way rUv recommends you do development, it's worthless."

Every prior status report in this project scored dimensions, counted gates, and named commits. None
of that is what the sentence above asks for. This ADR restates the product as exactly three
invariants, each stated so it can only be answered by running a command and reading its output —
never by a narrative.

## Why now (the measured failure, 2026-09-12)

The corpus every release has shipped since 2026-08-21 is the same immutable seed
(`data/corpus-seed.json`, tag `v4.2.1-dev`). Nothing has published a fresher one since:

- 2026-08-22: the primary-checkout nightly that rebuilt the corpus was retired (it mutated the
  developer's working tree — a real defect, correctly fixed).
- 2026-08-31: the remaining nightly convergence was made report-only, unable to dispatch a publisher
  (ADR-064 currency row, correctly closing a different defect — an unauthorized publish path).

Both changes were individually correct and neither one restored a publisher for the corpus. The gap
between them was never named, so every "nightly ran" receipt after 2026-08-22 was true of a job
firing and false of anything getting fresher — measured 2026-09-12: 15 rUv repos never ingested
(`rultra`, `ruClip`, `rGi` newest), 18 stores stale against upstream HEAD, 13 gists published after
the sealed receipt. The console, the watchdog, and every status report through 2026-09-11 said
nothing about this, because nothing measured "as-of" against the live org — only against the last
receipt the pipeline itself wrote.

The same session found two more instances of the identical shape: `ground-ruvnet.sh` fires a nudge on
every relevant prompt but cannot verify compliance (asserting an answer is not a gated action, only
writing a file is); the real gate (`decision-gate`, `grounding-stamp`) is registered for Claude only,
not Codex, so "hooks enforce the RuvNet way" was true on one host and false on the other without
either host's plugin manifest saying so.

**The pattern this ADR exists to close: a component can be individually correct and the product can
still be false, when nothing checks the seam between components.** Each invariant below is written at
that seam.

## Decision

Three invariants. Each has a named artifact that is the only acceptable evidence, and a command any
engineer can run to get a PASS/FAIL, never a "should be" or "was working as of."

### Invariant 1 — COMPLETENESS AND FRESHNESS (the database is updated)

**Statement:** every rUv repository and gist that exists on the live GitHub org is represented in the
installed brain's coverage, and the gap between "rUv changed it" and "the brain read it" is bounded
and visible — never silently absorbed into a `status: CURRENT` word that does not mean what it says.

**Evidence:** `docs/RUVNET-COVERAGE.md` / `data/source-coverage.json`, produced by
`node scripts/source-coverage.mjs`, which enumerates the **live** org (not a cached list) and compares
`artifact.sourceCommit === upstream.sha` per row — never the shipped `status` field, which
`release-projection.mjs` stamps `CURRENT` on every seeded row regardless of drift (a known, accepted,
separately-tracked gap in ADR-0069's amendment).

**Command:** `node scripts/source-coverage.mjs --check` exits 0 only when every eligible row is
CURRENT by the `sourceCommit` test, with observedAt within the freshness bound. It exits non-zero and
NAMES every non-current row otherwise — no row is ever silently dropped from the count.

**Mechanism (nightly, unattended, no human GO):** ADR-085 found that the publish mechanism for this
already exists — built, unit-tested, and never wired into a live workflow
(`scripts/release.mjs --corpus-seed`, `.github/workflows/corpus-seed.yml`). The remaining work is one
new unattended job inside `protected-release.yml` and closing the completeness question ADR-085 leaves
open (whether `corpus-reconcile.mjs` discovers brand-new repos, or only refreshes known ones — if the
latter, `ingest-new-repos.mjs` must run in the same night, before it). A corpus supply chain
(DDD-0021) nightly (a) enumerates the live org fresh, (b) rebuilds every store whose upstream moved and
ingests every repo/gist missing entirely, (c) validates the result against the same evidence the
release rail checks, and (d) publishes a **corpus-only** release through the existing customer update
path, with **code releases (npm version, plugin version) staying under separate, owner-gated
authority** (ADR-085 confirms `releases/latest` tag-truth already accepts a corpus-only release under
an unchanged code version — no customer-side change needed). This ADR does not reopen who may publish
code; it establishes who — unattended, nightly, by design — publishes corpus.

**Completeness is a nightly invariant, not best-effort.** A night that cannot finish ingesting
everything must carry the remainder to the next night and say so in its receipt
(`"incomplete": N`) — it must never report "up to date" while incomplete. A corpus that silently
truncates its own scope is the exact failure this ADR exists to close.

### Invariant 2 — ENFORCED HOOKS (the tool does the right thing without being asked)

**Statement:** every install — every host — has hooks that structurally prevent the model from
asserting or building against the RuvNet/rUv stack without having actually consulted the brain. A
recommendation the model can rationalize past does not satisfy this invariant; only a hook that fires
regardless of the model's judgment does.

**Evidence:** `plugin/scripts/continuity-hook-policy.mjs`'s `CONTINUITY_EVENTS` registry is the single
source of truth for which hook fires on which event, for which host. A hook exists in this ADR's sense
only when it is (a) registered there, (b) capable of altering the outcome of the turn (a gate), not
merely printing advisory text (a nudge), and (c) proven live, per host, with a real command and real
output — not code review.

**Command:** `npm run hooks:check` (internal consistency of the manifest) is necessary and not
sufficient. The additional bar this ADR sets: a fixture turn matching the RuvNet-relevance gate, with
no `search_ruvnet` call, must be **caught before the turn ends** — on every host the plugin claims to
support — or the plugin must not claim that host.

**Known gap this ADR names, not yet closed as of this writing:** `decision-gate` and
`grounding-stamp` — the only two hooks in the plane capable of altering an outcome — are registered
`['claude']` only. `ground-ruvnet` is registered `['claude', 'codex']` but is advisory-only on both:
it cannot block a plain-text answer, only `decision-gate` can block a file write. Closing this gap
(Codex parity for the real gate, and a Stop-time check for the assert-without-searching case) is
in-flight work this ADR governs going forward; it is not yet Implemented.

**Grok CLI is out of scope until researched.** `tri-smart-skill/` already installs a *skill* to Grok
(engaged only when the model chooses to invoke it); whether Grok CLI has any *hook* mechanism
(fires regardless of model choice) is, as of this writing, unverified. This ADR does not claim Grok
parity until that research produces a named mechanism to target.

### Invariant 3 — THE CONSOLE SHOWS AND APPLIES THE USER'S CHOICES (the configurator is for them)

**Statement:** the default view of the onboarding console contains only what a customer needs to see,
understand, and decide — never a maintainer's own release-verification tooling. Every choice a user
can make is either reflected live in how the brain behaves, or the console says plainly that it is
not yet wired to do so.

**Evidence:** `console/index.html`'s default flow vs. its maintainer-only sections (a card belongs in
the default flow iff a customer, not the product's own developer, would use it to decide something);
`console/scope.html` / `/api/scope`, which answers the single question a customer actually asks — "is
the thing rUv just shipped in here" — sorted by recency, searchable by name and by what a repo does.

**Command:** none is purely mechanical here by nature (this invariant is partly a judgment about
audience, not only a data check) — but `tests/unit/console-index-structure.test.mjs` pins the
release-verification card outside the default flow as a regression test, and
`tests/unit/console-scope-client.test.mjs` pins the scope page's search/sort behavior. A reviewer
reading the rendered page as a first-time customer, not as the maintainer, is still required.

## What this ADR explicitly does NOT reopen

- **Code-release authority stays exactly as ADR-064 and the release-authority contract define it.**
  This ADR authorizes an unattended **corpus** publisher; it does not authorize any unattended
  **code** publisher. `release-authority.mjs`'s enumeration of publishers gains one new corpus-only
  entry; it does not lose the human-GO requirement for anything that bumps a version.
- The private-store fence (`PRIVATE-STORES.json`, `updateManaged:false`) is unchanged — corpus
  publication carries only public, bundle-eligible stores.
- The 57-row "shipped `status` says CURRENT regardless of drift" gap (ADR-0069's own amendment) is
  not closed by this ADR. It is named here so it is not mistaken for something this ADR fixes.

## Consequences

- A release that ships a stale corpus becomes a release that fails Invariant 1's command, not a
  release nobody thought to ask about.
- A plugin version that claims hook enforcement on a host where the real gate isn't registered fails
  Invariant 2's per-host proof, not a claim taken on the manifest's word.
- The console's default view is measured against a customer's question, not a maintainer's checklist.

## Currency log
| 2026-09-12 | **Downgraded Accepted → Proposed.** Dual verification (Fable 5.1 scribe + Codex/Astra verifier, both re-reading cited source directly) found 4 blocking + 10 major/minor defects, synthesized with no surviving disagreement. Blocking, this document: Invariant 1's named command (`source-coverage.mjs --check`) does not actually enforce universal currency or a freshness bound, and prints a count not names even under `--strict` (S3); Invariant 1's mechanism is delegated entirely to ADR-085, which itself has 2 blocking defects, so accepting this ADR accepted an unreachable publish path (S14); this ADR and ADR-085 directly contradict each other on whether `release-authority.mjs`'s canonical-publisher set may grow (S4); `governs:` names two files that do not exist and the wrong path for `codex-hooks.json` (S5). Major: Invariants 2 and 3 have no real PASS/FAIL command despite the claim (S11); the "57-row" gap is misattributed — ADR-0069 records 63 mismatched-SHA-under-CURRENT rows and a separate 57 UNVERIFIED rows; this document conflated them (S12). None of this invalidates the three invariants as a *statement of what matters*; it invalidates the claim that each is *already* mechanically checkable today. Full defect list preserved in the session record; revision owed before re-acceptance. | Dual verification pass, 2026-09-12, reading `scripts/source-coverage.mjs:419-432`, `scripts/release-authority.mjs:10-13`, `docs/adr/0069-source-coverage-contract.md:244-250`, `plugin/scripts/continuity-hook-policy.mjs:76-94` directly. |
| 2026-09-12 | Initial acceptance (superseded same day by the row above — kept for the record, not the current status). | This document; the incident measured 2026-09-12 across the corpus staleness, the Codex hook asymmetry, and the console's maintainer-card placement. |
