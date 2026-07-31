---
id: ADR-054
title: Brain on/off and per-part scope — a user-controlled brain that can never silently lie about being off
status: Accepted
date: 2026-07-26
updated: 2026-07-31
impl: verified
verified: 2026-07-31
verified_digest: 7e4e5c249715
authors: [Stuart Kerr, Claude Code]
tags: [settings, console, scope, retrieval, hooks, honesty]
supersedes: []
relates: [ADR-052, ADR-053, ADR-023]
governs:
  - scripts/user-settings.mjs
  - kb/forge-ask-all.mjs
  - plugin/mcp/server.mjs
  - plugin/scripts/hook-shim.mjs
  - plugin/scripts/session-start-core.mjs
  - scripts/onboarding-console.mjs
  - kb/brain-profile.mjs
  - kb/forge-update.mjs
  - bin/install.mjs
---

# ADR-054: Brain on/off and per-part scope

**Status**: Implemented (master switch plus Complete Brain / RuVector Only storage profiles)
**Date**: 2026-07-26
**Related**: ADR-052 (proactivity-you-control), ADR-053 (experience QA), ADR-023 (stable spine)

> **Implemented 2026-07-26, v3.9.84-dev.** v1 = ON/OFF only; per-family scope stays measure-first per
> §1 and NO scope plumbing was built. All 8 gate tests live in `tests/unit/brain-off.test.mjs` (54
> assertions, green); gates 1 and 3 were written and RUN RED first and their verbatim failing output
> is recorded in that file's header. Surfaces: `scripts/brain-state.mjs` (the sentinel),
> `scripts/user-settings.mjs` (`brainEnabled` mirror), `plugin/scripts/hook-shim.mjs` (per-entry
> `offBehavior`), `session-start-core.mjs` (internal split; `session-start.sh` is only a compatibility
> launcher), `ground-before-write.sh`, `grounding-stamp.sh`
> (stamp-on-result), `plugin/scripts/protect-brain-state.sh` + `hooks.json` (the consent guard —
> a SHELL change, requiresRestart, flagged), `kb/forge-mcp-all.mjs` (disabled soft answer),
> `bin/install.mjs` (uninstall removes the sentinel), and the console's own on/off section.
> One finding the build added to the design: `fs.existsSync` / `[ -f ]` return FALSE rather than
> throwing on an unreadable state directory, so the first draft of the sentinel reader reproduced the
> very fail-open polarity §2 chose the sentinel to dissolve. Gate 5 caught it. All five readers now
> treat only genuine absence (ENOENT/ENOTDIR, or a readable dir with no file) as ON.

## Context

A user feature request (2026-07-26, relayed by the owner): (1) turn RuvNet-Brain on and off;
(2) turn parts of it on and off — their use case is a RuVector-only brain, with the bet that a
scoped brain answers RuVector questions better. The precedent is rUv's own cognitum-learn: one
`.rvf` per topic, queried per-topic. Our corpus is ALREADY one store per repo, discovered by
readdir at query time (`kb/forge-ask-all.mjs`), so scope is a query-time filter, not a rebuild.

The owner's build mandate: review every angle; **nothing bad may happen because something can be
turned off**. That inverts the usual feature framing — the design's primary artifact is the risks
register below, and the duel's brief is to attack it.

## Decision (v2 — the duel's converged design; v1 draft superseded in place)

### 1. v1 ships ON/OFF ONLY. Per-family scope is measure-first, build-second.

Both reviewers independently: scope-as-store-filter cannot keep the honesty invariant (the
`concepts` meta-store holds every repo's primers; `searchAll()` bypasses discovery when callers
pass repos; scope is provenance-based while the user's expectation is subject-based — a RuVector
question's best evidence may live in a ruflo ADR or a meeting transcript). So: the requester's
RuVector-only bet is MEASURED FIRST with the mechanism that already exists (`KB_REPOS` /
`searchAll({repos})` + the eval harness), scoring completeness, recall, abstention and cross-repo
slices — not just on-domain precision (which can improve while answers get worse). Only a real
positive result triggers the scope build, and then as RERANK BIAS with labeled out-of-scope
results (search everything, prefer in-scope, mark the rest), path-level for `concepts`,
multi-family membership allowed. No aggregate "+N%" marketing number in the console — slices or
nothing.

### 2. OFF's enforcement artifact is a SENTINEL FILE, not settings JSON

`~/.config/ruvnet-brain/brain-off` (reason + timestamp inside; created/removed atomically by the
console). Present = off, absent = on — no third state. Readable by `[ -f ]` from bash-3.2 gates,
`fs.existsSync` from any node vintage, any code age. This dissolves the duel's worst findings:
older `validate()` deleting unknown settings keys and silently re-enabling (skew), corrupt/EACCES
settings failing open, and bash gates that cannot parse JSON. `settings.json` keeps a mirror key
as the UI record; the sentinel is the switch; when they disagree the sentinel wins and the console
shows the disagreement.

### 3. OFF is a CONTRACT PER PLANE, never one early-exit

A single boolean kill-switch either lies about "off" or removes protections unrelated to the
brain. The contract, per plane:
- **Retrieval**: `search_ruvnet` soft-answers "disabled by the user's setting — tell the USER to
  use /rvbc" (never instructions the model could follow to re-enable it; agent-initiated flips
  are a consent violation, and a PreToolUse guard blocks agent writes to the sentinel/settings
  paths). The soft result must carry machine-readable `disabled:true` so telemetry never counts
  it as success or outage.
- **Hooks — per-entry `offBehavior` in the shim's table** (silence / run / partial): advertising,
  grounding, and the advisory legacy `verify-interface` notice go silent; the NON-brain safety
  walls (route-dispatch cost wall and design-wall) STAY ON — they guard money and honesty, not
  retrieval. Issue #48 moved interface enforcement to structured MCP arguments.
- **session-start splits internally**: auto-updater heartbeat, GONG health alarm and SLA banner
  keep running (an off machine must still receive fixes — otherwise the fix for an off-state bug
  can never arrive); ALL advertising dies; exactly ONE dim state line remains: "brain OFF by your
  setting (since <date>)" — legibility, not advertising, resolving the silence-vs-legibility
  contradiction both reviewers flagged.
- **Brain-DEPENDENT gates disarm via the sentinel**: `ground-before-write.sh` (wired in the
  USER's settings.json, outside the shim — both reviewers caught that the drafted chokepoint
  never reached it) checks `[ -f brain-off ]` first and degrades to a one-line advisory.
- **Stamps**: `grounding-stamp.sh` stamps ONLY on a successful grounded result (today it stamps
  from the QUERY, so a refusal minted a valid 24h stamp and the gate silently stopped meaning
  anything — the duel's stamp-from-refusal find, fixed as part of this ADR).
- **Maintenance is its own visible toggle**: default keeps the nightly running while off (quiet),
  disclosed in the console ("off — still auto-updating; click to pause updates too"), honoring
  both reviewers' halves of the one genuine disagreement.
- **Health**: the GONG and doctor consult the sentinel — absent-KB-while-off is
  "disabled by choice", never "THE BRAIN IS DOWN".

### 4. State is SNAPSHOTTED per operation and legible everywhere

Every search/hook invocation resolves {sentinel, settings generation} once and carries it through
(no mixed-state receipts mid-flip). The MCP parent is boot-frozen and will not re-read state
mid-session for its cached tool description — accepted residual, disclosed in the console
("Codex sees the change at its next restart"). Doctor, console, session-start line, and the
`scope-changed`/`off-changed` ledger (host, resolved settings path, generation, old/new state)
make OFF diagnosable by support in one read.

### 5. Defaults and lifecycle

Default ON, all scope — zero change for existing users. Uninstall REMOVES the sentinel (a
reinstall must never boot silently dead — the duel's inherited-invisible-OFF find). `--update`
and the nightly never touch the sentinel.

### 6. Storage profile: Complete Brain or RuVector Only

The 2026-07-28 profile selector is a disk-footprint control, not the hard query-scope mechanism
rejected in §1 and not a claim that hiding cross-repository evidence improves answer quality.
`kb/brain-profile.mjs` derives the real state from installed RVF families. **Complete Brain** keeps
every public per-repository RVF in the signed release. **RuVector Only** keeps the shared reader plus
the RuVector RVF family, removes the other public families, and filters the capability-card and
generation-ledger indexes so they do not advertise stores that are absent.

The console changes the files first and saves the preference second; if the mirror write fails, it
reports the half-failure and the on-disk RVFs remain authoritative. Complete restore copies from the
full release bundle. Fresh installs and `forge-update.mjs` reapply the durable selection after
verified extraction. The rollback reclaimer may ignore stores intentionally removed by the selected
public profile, but it still keeps any backup containing an unknown private/local RVF.

## Risks register — superseded by the duel record

The v1 register (R1-R10) stands as history; the duel produced 27 (Fable) + 42 (GPT-5.6) findings
that reshaped the design above. The load-bearing changes: sentinel over settings (skew/corruption
fail-open), per-plane contract over kill-switch, stamp-on-result over stamp-on-query, measure-first
over scope plumbing, safety walls exempt from off.

## The 8 tests that gate the build (merged, ranked; each must fail on broken code)

1. Skew round-trip: previous release's `saveSettings` cannot flip OFF back on (sentinel survives).
2. Real-wiring gate disarm: brain off ⇒ a rUv-domain Write through the USER-wired
   ground-before-write does not block; verify-interface is silent; route-dispatch/design-wall still do.
3. Stamp-from-refusal: a disabled/out-of-scope soft-answer mints NO grounding stamp.
4. session-start split: off ⇒ zero advertising bytes, one state line; updater + GONG demonstrably still run.
5. Fail-polarity matrix: corrupt/absent/EACCES/future settings never silently re-enable; sentinel decides.
6. Mid-session flip: next hook fire silent AND next tools/call soft-answers, both directions, no restart.
7. Multi-host: flip in Claude Code console; Codex + second window get coherent, disclosed state.
8. Uninstall/reinstall: sentinel removed; first session after reinstall is alive and says so.

## Adversarial duel record (2026-07-26)

Fable 5 (fresh context, code-grounded, 27 findings) × GPT-5.6-Sol (codex exec read-only, 42
findings), identical negative-ramifications briefs per the owner's mandate. CONVERGED,
independently: (1) one-boolean master-off lies or over-kills — per-plane contract; (2) versioned
settings JSON cannot enforce OFF (older validate() deletes unknown keys → silent re-enable;
corrupt/EACCES/fromFuture all fail toward ON — wrong polarity for consent) → sentinel file;
(3) grounding stamps mint from the QUERY, so refusals opened the write-gate — stamp on result;
(4) the drafted chokepoints were structurally false (ground-before-write outside the shim; Stop
hook direct; searchAll bypasses discovery; MCP parent frozen); (5) do not build scope as a store
filter — measure first; subject-vs-provenance mismatch, the unscopable concepts store, vendored
copies becoming canonical, and calibration shift make naive scoping degrade answers in ways an
on-domain precision eval cannot see; (6) off must not suppress the updater/alarms (Fable) yet
background work while "off" must be disclosed and pausable (GPT) — resolved as a separate visible
maintenance toggle. Notable singles — Fable: agent can flip the switch back on (guard the path;
never tell the model the re-enable mechanism); uninstall preserving settings boots a silently dead
reinstall. GPT-5.6: cross-session authority leakage and per-operation state snapshots;
RUVNET_SETTINGS_FILE env splits; telemetry must never count disabled soft-answers as success or
failure. v1 draft's Decision + risks register superseded above; Context stands.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-07-31 | Trimmed redundant first-load wording in the native SessionStart authority to restore cross-platform stdout headroom; no state, OFF behavior, sentinel precedence, or offered choice changed. | The old PR-head packed stranger jobs measured 4,129 bytes on macOS and 4,118 bytes on Ubuntu against the 4,096-byte contract. The corrected real packed macOS scenario passed all 76 registered hook firings, focused SessionStart/OFF/console tests passed 106/106, the plugin battery passed 60/60, and the registered wall-time gate passed at 208ms cold, 143ms p95, and 146ms max. |
| 2026-07-31 | Re-verified the complete OFF/partial/safety contract after SessionStart moved to one host-neutral Node authority. Governance now includes `plugin/scripts/session-start-core.mjs`, where the internal OFF split actually runs; `plugin/scripts/session-start.sh` is only a fail-open compatibility launcher. | Commit `5d0fe75` keeps `hook-shim.mjs`'s `offBehavior: partial` entry and forwards the resolved `RUVNET_BRAIN_OFF` snapshot into the core. Exact shell/core parity passed 5/5, including OFF with an absent KB and OFF with a present-but-broken KB; the broader SessionStart regression set passed 165/165. No master-switch, sentinel-precedence, storage-profile, maintenance, or consent decision changed. |
| 2026-07-31 | Re-verified the brain on/off and storage-profile contract after closing the release-oracle regressions. | Commit `14f654e` changes governed `kb/forge-ask-all.mjs` only in source-backed query classification, capability-card supplementation, and replayable-promotion evidence selection. It does not change `brainEnabled`, sentinel precedence, profile selection, or off-state behavior. The impacted broad gate passed 273/273, the production Top-100 gate passed 100/100 semantic and grounded/routed with 0 errors and a 3.723s maximum, and the exact rebuilt archive audited 63/63 RVFs with zero index failures; computed digest `f6d3dce9ad77`. |
| 2026-07-30 | Re-verified the brain on/off and storage-profile contract after source-grounded retrieval and release-artifact hardening. | Commit `8d20687` changes governed `kb/forge-ask-all.mjs` only in query classification, evidence selection, and bounded source retrieval. It does not change `brainEnabled`, sentinel precedence, profile selection, or off-state behavior. The production Top-100 gate passed 100/100 semantic and 100/100 grounded/routed; focused release tests passed 143/143 and `npm test` passed 60/60; computed digest `49285cc2b9d2`. |
| 2026-07-30 | Re-verified the master-off and profile authority after the Fix All validator was narrowed by remedy family. | `scripts/onboarding-console.mjs` changes only which recommendation builder revalidates a selected remedy; it does not change `brainEnabled`, sentinel precedence, storage profiles, or off-state behavior. Focused console acceptance and `npm test` passed at candidate `ba53fc9`; computed digest `1d7ac1da0d47`. |
| 2026-07-30 | Re-verified the sentinel master-off and per-plane authority after 4.0.2 preferences, project-default seeding, Console persistence, and MCP readiness warmup. | `scripts/user-settings.mjs`, `plugin/scripts/hook-shim.mjs`, and `kb/brain-profile.mjs` retain sentinel authority. New preference controls are subordinate runtime choices; `plugin/scripts/session-start.sh` seeds nonsecrets once and never copies or overrides the sentinel. `bin/install.mjs` Console persistence and `plugin/mcp/server.mjs` readiness warmup do not change off-state authority. |
| 2026-07-29 | Re-verified the complete governed set for the 4.0.0 release candidate and refreshed the machine-derived digest; the brain-off, sentinel-authority, storage-profile, and maintenance boundaries are unchanged. | Commit `e20cdf2` changed governed runtime files for worker retirement, host parity, and release hardening. The contract remains exercised by `tests/unit/brain-off.test.mjs`, the live console inspection, and the release QE evidence in `docs/qe/AGENTIC-QE-4.0-MASTER-PLAN.md`; computed digest `b5b3ea58d448`. |
| 2026-07-29 | Re-verified ADR-054 after the three governed-code commits since `4ad464e`; no architecture change required. | Commit `79573ff` changes only quiet-prompt classification/dispatch in `plugin/scripts/hook-shim.mjs`; the brain-off silence exit remains before the new fast path. Commit `c2d5ef0` makes `bin/install.mjs` count canonical `*.big.rvf` stores. Commit `ebe51a5` makes Codex wiring honor `CODEX_HOME` and decode quoted server paths; neither installer change touches sentinel lifecycle or profile reapplication. `tests/unit/brain-off.test.mjs`, `tests/unit/hook-shim-ground-fast.test.mjs`, `tests/unit/codex-wiring.test.mjs`, and `tests/integration/install-smoke.mjs` passed on 2026-07-29. |
| 2026-07-28 | Re-read the installer after making stale/current integration tests independent of GitHub API quota; the brain-state contract is unchanged. | Commit `2f420e7` adds a `RUVNET_BRAIN_TEST_LATEST_TAG` seam that is reachable only with the existing `RUVNET_BRAIN_TEST=1` guard. Production release resolution, the OFF sentinel, profile selection, and uninstall behavior are unchanged; `tests/integration/stale-install-trap.test.mjs` now proves stale/current behavior without a live unauthenticated API call. |
| 2026-07-28 | Re-read the on/off and profile paths after the Codex, grounding-stamp, installer-cache, and heavy-reader repairs; no consent or profile decision changed. | Commit `306e9b3` changes `bin/install.mjs`, `plugin/scripts/hook-shim.mjs`, and `kb/forge-ask.mjs` only to make host wiring portable and align model reads/downloads with the declared cache. `brainEnabled`, the sentinel authority, maintenance control, and Complete/RuVector profile selection are untouched. |
| 2026-07-28 | Added the Complete Brain / RuVector Only storage profile to the console and installer/update paths | The 2026-07-28 owner request is implemented in `kb/brain-profile.mjs`; it uses ADR-006's per-repo RVF boundary and does not revive the rejected claim that hard query scoping is a relevance improvement. |
| 2026-07-27 | **Re-read against the governed code; NO change required — every claim still holds.** | Flagged `presumed-stale`: 10 commits (1d) after this document's last commit (`3501ef4`), across all 5 governed files. Checked each: (1) `scripts/user-settings.mjs` — `61f9f9d` (the ADR-052 1-5 advocacy dial) only rewrites the `advocacy` schema entry; grepped `brainEnabled` — the key, its sentinel-authority comment, and the sentinel-wins-on-disagreement rule are untouched, and the enum-migration code it adds doesn't reach the boolean branch `brainEnabled` uses. (2) `kb/forge-ask-all.mjs` — `71b0be2` (symlink main-entry fix) and `a44899b`/`1a6b54d` (cross-encoder pool cap, shipped OFF by default) are unrelated to the on/off contract; grepped `disabled` — no hits in this file (the `disabled:true` soft-answer this ADR describes lives in `kb/forge-mcp-all.mjs`, governed separately). (3) `plugin/mcp/server.mjs` — `879d88e` fixes a timeout-outage health-reporting bug, does not touch the boot-frozen tool-description claim in §4. (4) `plugin/scripts/hook-shim.mjs` — `920f9ba` (mesh census) adds new table entries but the `offBehavior: silence\|run\|partial` contract and the existing 11 entries' values are byte-identical. (5) `scripts/onboarding-console.mjs` — `408b01c` moved the on/off switch from a collapsed checkbox to its own always-open card FIRST on the page (commit message: "ADR-054's on/off switch was rendered... below the things it governs, behind a chevron. It is now its own always-open card FIRST"); this is a UI relocation, not a contract change — the three redundant state channels, consent-gated OFF with downside copy, off-since-date, maintenance disclosure, and sentinel-vs-mirror disagreement line this ADR requires are all still present, just promoted to the top of the page |
| 2026-07-27 | Re-verified against `kb/forge-ask-all.mjs`, which moved under the two-stage cascade | In `kb/forge-ask-all.mjs`, the cascade adds `cascadeRerankPool` and two env-read defaults; it touches **zero** brain-off lines — measured, not assumed (`git diff` over the governed path, filtered for brain-off/sentinel/offState/disabled: 0 changed lines). The off switch, the per-call read and the sentinel authority are untouched. |
