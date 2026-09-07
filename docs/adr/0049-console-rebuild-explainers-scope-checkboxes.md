---
id: ADR-049
title: The console rebuild — explain every section, scope every suggestion, and make the safe ones checkable
status: Accepted
date: 2026-07-24
updated: 2026-08-30
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


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `bin/install.mjs` now exits non-zero when `--update` lands nothing (issue #106), `kb/forge-update.mjs` releases its rollback on the no-op path and keeps it on the damaged path (#108), and `scripts/health-repair.mjs` no longer reports a hollow "fed 0" (#104). Checked against this decision: these changes implement its honesty requirement — no clause here is contradicted or superseded.


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `scripts/console-runtime-identity.mjs` now defines `CONSOLE_RUNTIME_SURFACE` as the single enumeration serving BOTH the installer copy list and the runtime digest, and `scripts/onboarding-console.mjs` derives its generation identity from it (issues #76/#79). Checked against this decision: the Console scope and checkbox model are unchanged — this replaces a one-file sha256 proxy with an identity over the real runtime surface. Nothing here is contradicted.

> **Reviewed 2026-08-06 (ADR-063).** Governed code moved for ADR-063 / issue #103: plugin/scripts/hijack-ruvnet.sh can now REFUSE a direct invocation against a Ruflo-managed store, hook-shim.mjs declares it mode:'blocking' and codex-hook-wrapper.mjs adds it to blockingHooks, and runtime-preferences.mjs reads the new managedMemoryBoundary setting. Checked against this decision: the shipped default is `advise`, which reaches none of the enforcement path, so behaviour is byte-identical for anyone who changes nothing; the hook's fail-open posture and its speech channel are unchanged. This raises the CEILING of what the hook may do, not what it does. No clause contradicted.

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

| 2026-08-30 | The configurator’s ordinary settings are rendered and saved through one validated user-settings endpoint; stale explanatory text was corrected. | `console/app.js` and `scripts/onboarding-console.mjs` now agree with `plugin/scripts/runtime-preferences.mjs` consumers. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-21 | Re-read after issue #153 changed plugin-cache retirement; Console behavior is unchanged. | `bin/install.mjs` now retains unregistered version roots while an exact process-incarnation lease may still hold them and fails closed on ambiguous liveness. The change protects already-running host sessions; it does not alter Console recommendations, controls, scope, consent, or runtime ownership. `tests/unit/plugin-generation-prune.test.mjs` exercises the frozen A-to-B-to-C path. |
| 2026-08-13 | **The console's learner probe stopped hardcoding a working directory.** | Per issue #139 (@ObiWanKenobi) the probe now calls `learnerCwd()` rather than pinning `process.cwd()` (or, before #136, `SYSTEM_HOME`). Both were hardcodes; the second was right only because `project` is the default and inverted under `RUVNET_LEARNING_SCOPE=user`. The console now measures whichever store the configured scope actually uses, so its card and the remedy behind it refer to the same learner by construction. A test that had pinned `cwd: process.cwd()` verbatim was updated to require RESOLUTION instead — a test defending a hardcode is a test defending the bug. |
| 2026-08-10 | **Re-read after the derived Codex dependency walk; the Console contract is unchanged.** | `bin/install.mjs` is governed here. The change is confined to `wireCodexHost`: its dependency copy list is now derived from `plugin/mcp/server.mjs`'s real imports instead of hand-listed, after one added import shipped a Codex server whose sibling was absent. `runtime-preferences.mjs` is now copied because the walk found it, not because a literal named it — the same file, the same destination, arrived at by derivation. Nothing the Console renders, explains, scopes, or offers was touched, and its consent-gated Apply is untouched. |
| 2026-08-10 | **Re-read after #128/#129; the Console contract is unchanged.** | `bin/install.mjs` is governed here. Two additions: `NIGHTLY_ARGV`/`cronExample`/`enableNightly` now schedule the host-convergent entrypoint (issue #129), and `prunePluginGenerations()` removes plugin-cache generations the registry does not reference (issue #128). Neither touches what this ADR decides. The prune runs in the same `okApplied` branch as `runtimeTransaction.activate()` but deletes only directories under a registered `installPath`'s parent that carry their own `.claude-plugin/plugin.json`; the Console runtime lives under its own receipt dir and is excluded by construction. The explainers, the scoped suggestions, the checkboxes and the consent-gated Apply are untouched. |
| 2026-08-08 | **Re-read after the #123 convergence fix; the Console contract is unchanged.** | `bin/install.mjs` and `console/app.js` are governed here. The change is confined to how host convergence COMPARES two version strings — `installed === expected` became `installed >= expected`, so a `-dev` build ahead of the published release stops being reported as broken (`--update` exited 1, `--doctor` printed FAILING, and the prescribed repair was a no-op while every check was green). The Console's rebuild, its explainers, its scope checkboxes and its consent-gated Apply are untouched; what moved is a predicate feeding the doctor's verdict, not anything the Console renders or offers. |
| 2026-08-02 | Re-read the governed installer after the 4.0.8 release-process change; Console scope and user controls are unchanged. | Commit `8608cfd` changes `bin/install.mjs` only so `--doctor --hooks` fails closed when packaged selfcheck is unavailable. It does not change Console actions, defaults, or consent boundaries. |
| 2026-08-02 | Re-read the final 4.0.7 Console and installer changes; the explainer, scoped recommendations, evidence-backed controls, project cache, and profile decisions remain unchanged. | Commits `3668b1b`, `5a638f6`, and `78e897b` add runtime provenance, owner-only issue inventory, provider availability, and a remotely durable release transaction through `console/app.js`, `scripts/onboarding-console.mjs`, and `bin/install.mjs`. Those changes expose state and protect delivery; they do not broaden recommendation scope, consent, Fix All, undo, cache, or profile semantics. Exact-SHA CI and public-artifact proof remain release gates. |
| 2026-08-02 | Re-read the Console timing receipt, explicit fixture-root boundary, and dual-host update-test seam. The explainer, per-recommendation scope, evidence-backed checkbox, project-keyed cache, and two-profile decisions remain unchanged. | `scripts/onboarding-console.mjs` now returns aggregate `revalidationMs`, `undoJournalMs`, `childRemedyMs`, and `totalMs` from the existing revalidate → journal → remedy path; it does not change recommendation construction, scope, consent, or undo. Commit `8f06287` adds the absolute, normalized `RUVNET_CONSOLE_ROOT` fixture boundary with the production default still `os.homedir()`; global binaries and credentials remain on the system home. Commit `c1f5b45` makes `bin/install.mjs` host-update collaborators injectable for the dual-host matrix while retaining its production defaults. |
| 2026-08-01 | Completed issue #79's installer/update transaction for the persistent Console runtime. | `bin/install.mjs` now stages and syntax-checks the exact candidate runtime, records `runtime-identity.json`, activates only after host/Stable-Spine convergence, rolls back on failure, and binds the identity plus `ready` or `pending-console-restart` into `host-convergence.json`. This changes runtime delivery, not the explainer, recommendation-scope, consent, cache, or profile decisions governed here. |
| 2026-08-01 | Re-read the governed Console and installer changes on the clean integration candidate. The explainer, recommendation-scope, evidence-backed checkbox, and project-keyed cache decisions remain unchanged. | `scripts/onboarding-console.mjs` now identifies a running Console by a private scoped receipt plus `/api/runtime` identity before reuse or owned replacement; it does not alter recommendation rendering, scope, apply, or cache semantics. `bin/install.mjs` now delegates What's New to the installed payload's `plugin/scripts/whats-new.mjs`; it does not change Console controls or install profiles. Focused candidate tests exist for both changes, but exact-SHA cross-platform and published-artifact proof remain outside this currency review. |
| 2026-07-30 | Kept Fix All fail-closed while removing unrelated full-machine probes from each per-item revalidation. | Each remedy is still re-read immediately before execution, but `scripts/onboarding-console.mjs` now invokes only the recommendation builder capable of issuing that id. Unknown id families fall back to complete validation; `tests/qe/release/console-control-completeness.test.mjs` pins the per-id call. |
| 2026-07-30 | Reconciled the 4.0.2 Console controls, bounded Fix All, and clean-install runtime with the original capability-checkbox decision. | `console/app.js` renders only evidence-backed recommendations into Fix All; `scripts/onboarding-console.mjs` revalidates each selected id and records per-item undo. Unsupported runtime owners are surfaced instead of presented as dead switches, while `plugin/scripts/runtime-preferences.mjs`, `scripts/nightly-controller.mjs`, and `bin/install.mjs` persist the supported choices. |
| 2026-07-28 | Recorded the implemented two-profile console selector; kept the broader granular checklist open | The 2026-07-28 owner request approved exactly Complete Brain and RuVector Only; `console/app.js` now exposes that two-choice physical RVF profile. Arbitrary per-capability install checkboxes remain deferred. |
| 2026-07-27 | **Re-read against the governed code; one stale claim corrected.** Verification said *"Not yet merged to main — staged for the owner's review"*; it merged (`b13cab1`, `3e766f6`, both ancestors of `origin/main`). The rest of the document still describes the code | Flagged `presumed-stale` by `doc-currency`: `console/app.js` (+25) and `scripts/onboarding-console.mjs` (+180) moved 3 commits / 2 days after this document's last commit (`9665c12`, 2026-07-24). Those additions are ADR-054's master switch — **additive and conforming**: the new section renders through the shared `buildSettingsForm` widget this ADR specifies rather than a bespoke control, and is placed first *because* it is the switch every other setting is conditional on. No claim here is contradicted by them |
