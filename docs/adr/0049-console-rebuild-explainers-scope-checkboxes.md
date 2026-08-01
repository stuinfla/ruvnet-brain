---
id: ADR-049
title: The console rebuild — explain every section, scope every suggestion, and make the safe ones checkable
status: Accepted
date: 2026-07-24
updated: 2026-08-01
authors: [Stuart Kerr, Claude Code]
tags: [onboarding, ux, console, advocacy, capability, cache, honesty]
supersedes: []
relates: [ADR-013, ADR-027, ADR-032, ADR-045, ADR-047]
governs:
  - console/app.js
  - scripts/console-engine.mjs
  - scripts/onboarding-console.mjs
  - plugin/scripts/runtime-preferences.mjs
  - scripts/nightly-controller.mjs
  - bin/install.mjs
---

# ADR-049: The console rebuild

**Status**: Accepted
**Date**: 2026-07-24

## Context

ADR-013 built the Onboarding Console as "a mirror, an advisor, and only then a configurator." In
use, the owner hit four gaps, in his own words:

1. **He couldn't place several cards.** "What's the difference between brain activity and memory?"
   and the same for "how it's wired", "trust & provenance", "what caught Claude" — "a couple of
   sentences for each one, or at least a tooltip."
2. **He couldn't see a suggestion's blast radius.** "What's on / what do you suggest — I wonder if
   that's a user-level and a per-project level."
3. **The capabilities card was a status readout, not a control.** "Holy shit, this is all the power
   of RuvNet made simple, and I can check boxes on and off."
4. **Install was one blanket Yes/No.** "Out of the box, I'll do A, B, C, and D, but you can uncheck
   any of them, and here are the implications."

ADR-013 is **Implemented** and remains accurate about the console's shape; this ADR records the four
additions and the one honesty bug the rebuild exposed in the console itself.

## Decision

### 1. A section explainer on every card (info bubbles)

Every render section carries a one-click "i" that says, in the page's own quiet voice, what it shows
and why it matters — reusing the existing `infoBtn`/`openInfoPop` mechanism, not a new widget. One
author wrote all the copy so it reads as one voice. It disambiguates the three adjacent learning
surfaces (Memory = a quality score for the memory system; Activity = what the AI did; Lessons =
rules it now follows) and defines "provenance" as a category. A real bug fell out of this: the
wiring card's explainer lived inside a `if (total)` branch, so it vanished on a machine with zero
wiring sites — which is why that was the card the owner could never place. It now attaches
unconditionally to the static heading.

### 2. Recommendations carry their scope — the blast radius, per suggestion

`makeRecommendation()` gains an optional `scope` (`project | user | machine`), validated at the
schema gate and frozen onto the recommendation; `null` is the honest "scope not stated", never
guessed onto one side. Every builder stamps it from what it actually changes. Each rec card shows a
scope pill ("Just this project" / "Every project · this machine"). The full grouped-sections layout
(group order, whether user and machine split into two visible groups) is deliberately deferred as a
product decision the owner reserved — the per-card pill answers the core question without
pre-deciding it.

### 3. A checkbox only where the undo is proven (capabilities → recommendations bridge)

There was no bridge between the capabilities list and the apply machinery. `buildCapabilityRecommendations()`
turns an eligible OFF capability into a real, schema-gated recommendation, and the server stamps its
`recId` onto the capability row. Ticking the box never POSTs — it opens that rec card (`jumpToRec`)
with its evidence, cost, and undo, the one audited apply path; `/api/apply` dispatches it through
`remedy-registry`. **A checkbox appears only where state is exactly OFF, scope isn't machine, the
turnOn command has no blanks, AND the server vouched a recId.** IDLE, UNKNOWN, ABSENT, and
machine-scope get honest non-interactive indicators — never a checkbox that turns "we could not
check" into an unchecked box reading as "off". Today exactly one capability qualifies
(memory-distillation while OFF, the only one with a proven round-tripped undo, ADR-047's executor);
that is correct, not a gap.

### 4. The cache must be about the project you are in

Verifying the checkbox exposed the console committing its **own** signature failure — "looks on but
isn't." Two causes: the background refresh child spawned with `cwd = REPO` (the plugin dir), so it
recomputed project-scoped capabilities for the wrong directory; and the capability/state/memory
caches were one user-level file each, not project-keyed, so two projects served each other's state.
Fixed: the refresh child inherits the served project's cwd, and `serveCached()` takes a `scopeKey` —
a cache computed for a different project is treated as cold and recomputed for the current one. This
is **not** a change to the withhold-vs-recompute contract of the 2026-07-17 outage; only to which
project the data is about. A cross-project isolation test proves it, mutation-checked.

## Consequences

- The Recommendation aggregate now has a `scope` field and a fourth builder
  (`buildCapabilityRecommendations`). ADR-013's schema description is extended, not replaced.
- The checkbox's honesty rule (present only with a server-vouched recId + proven undo) means the
  control surface grows only as capabilities earn verified undos — one today. That is the intended
  rate: a checkbox is a promise that the inverse exists.
- **Partially resolved 2026-07-28:** the console now offers the owner-approved coarse install
  profile — **Complete Brain** or **RuVector Only** — and physically applies it to the installed RVF
  families. The broader granular install checklist (item 4 above) is still open — designed, with
  a static mockup (`console/install-mockup.html`) built from real `bin/install.mjs` items and their
  line-cited implications, awaiting the owner's approval before installer code is written. The
  grouped-sections recommendation layout is likewise deferred pending his call on group structure.
- **Verification:** all four shipped pieces are on `feat/console-rebuild`, each render-verified live;
  the checkbox is proven end to end (renders, click scrolls the consent-gated proposal into view with
  its Apply button). Suites green (1756 vitest, 51/51 npm). ~~Not yet merged to main — the branch is
  staged for the owner's review, per "nothing ships without my OK."~~
  **MERGED 2026-07-25 — corrected 2026-07-27 (ADR-055 re-read).** The owner approved and it landed:
  `b13cab1` (*Merge branch 'feat/console-rebuild'*) and `3e766f6` (*the console rebuild lands on main —
  explainers, scope, checkboxes, terminal install*), both ancestors of `origin/main`. The sentence
  above described the world for one day and then quietly described a world that no longer existed —
  precisely the failure ADR-055 was written to end, found by the drift check rather than by a reader.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-01 | Re-read the governed Console and installer changes on the clean integration candidate. The explainer, recommendation-scope, evidence-backed checkbox, and project-keyed cache decisions remain unchanged. | `scripts/onboarding-console.mjs` now identifies a running Console by a private scoped receipt plus `/api/runtime` identity before reuse or owned replacement; it does not alter recommendation rendering, scope, apply, or cache semantics. `bin/install.mjs` now delegates What's New to the installed payload's `plugin/scripts/whats-new.mjs`; it does not change Console controls or install profiles. Focused candidate tests exist for both changes, but exact-SHA cross-platform and published-artifact proof remain outside this currency review. |
| 2026-07-30 | Kept Fix All fail-closed while removing unrelated full-machine probes from each per-item revalidation. | Each remedy is still re-read immediately before execution, but `scripts/onboarding-console.mjs` now invokes only the recommendation builder capable of issuing that id. Unknown id families fall back to complete validation; `tests/qe/release/console-control-completeness.test.mjs` pins the per-id call. |
| 2026-07-30 | Reconciled the 4.0.2 Console controls, bounded Fix All, and clean-install runtime with the original capability-checkbox decision. | `console/app.js` renders only evidence-backed recommendations into Fix All; `scripts/onboarding-console.mjs` revalidates each selected id and records per-item undo. Unsupported runtime owners are surfaced instead of presented as dead switches, while `plugin/scripts/runtime-preferences.mjs`, `scripts/nightly-controller.mjs`, and `bin/install.mjs` persist the supported choices. |
| 2026-07-28 | Recorded the implemented two-profile console selector; kept the broader granular checklist open | The 2026-07-28 owner request approved exactly Complete Brain and RuVector Only; `console/app.js` now exposes that two-choice physical RVF profile. Arbitrary per-capability install checkboxes remain deferred. |
| 2026-07-27 | **Re-read against the governed code; one stale claim corrected.** Verification said *"Not yet merged to main — staged for the owner's review"*; it merged (`b13cab1`, `3e766f6`, both ancestors of `origin/main`). The rest of the document still describes the code | Flagged `presumed-stale` by `doc-currency`: `console/app.js` (+25) and `scripts/onboarding-console.mjs` (+180) moved 3 commits / 2 days after this document's last commit (`9665c12`, 2026-07-24). Those additions are ADR-054's master switch — **additive and conforming**: the new section renders through the shared `buildSettingsForm` widget this ADR specifies rather than a bespoke control, and is placed first *because* it is the switch every other setting is conditional on. No claim here is contradicted by them |
