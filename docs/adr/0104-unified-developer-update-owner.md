---
id: ADR-104
title: One source-bound coordinator for installed developer updates
status: Accepted
date: 2026-10-10
updated: 2026-10-10 07:15:00 EDT
version: 1.0.2
authors: [Stuart Kerr, Codex]
tags: [updates, install-identity, scheduler, receipts, footprint]
amends: [ADR-098]
---

# ADR-104 — One installed-owner update coordinator

**Status**: Accepted (design and implementation authorization)

Acceptance records the coordination decision; native execution and public release verification remain separate gates.

Updated: 2026-10-10 07:15:00 EDT | Version 1.0.2
Created: 2026-10-10 04:45:00 EDT

The owner requested one nightly update job, one copy of each installed tool, preserved package/plugin ownership, and an explicit latest/alpha choice. Independent Brain, Kit, native-CLI and package-manager jobs could race, downgrade each other's channels, or report success for an unused copy. This decision adds a coordination boundary; it grants no deployment, inference-spend or fresh-install authority.

The canonical implementation lives in the self-contained plugin payload as `developer-update.mjs` with pure policy, shared lock, optional provider maintenance and bounded cache cleanup modules, plus the immutable `plugin-artifact-proof.mjs` verifier. The npm installer and public CLI reach those same bytes. Brain's existing scheduler retains its identity and platform adapters, but its production registration binds the complete content-addressed module closure and invokes the coordinator at 03:30 local. Proof registrations retain the sealed local-package/bundle route; they cannot substitute a production download. Old registrations remain inspectable until a deliberate scheduler refresh.

Public defaults are latest, the existing RuvNet family, and provider maintenance disabled. Alpha selects a published alpha or latest, whichever is higher, only for RuvNet-family packages. Kit retains its next/latest ordering contract. Scope all explicitly expands to existing npm CLI packages and installed plugin scopes. Explicit preservePackages entries protect locally modified global packages and report preservedLocalModification; they cannot claim currency. Optional Homebrew formulas, unpinned uv registry tools, Cargo registry installs, native tool owners and an owner-reviewed application callback are enabled separately. No absent tool is installed. Symlinked source packages, shadowed wrappers, local wheels, pinned/path/git Cargo builds and managed plugin scopes are preserved with receipt exclusions. Source projects and worktrees are outside this updater's authority.

Pinned Claude targets may be accepted when cached Git metadata is stale only after the immutable manifest, default resources, declared references and bounded literal local dependencies match the pinned Git blobs. Reverse inventory rejects extra cached active resource files. Receipts distinguish the active Claude artifact proof, stale provider metadata, compared paths, verified resource inventory and outside-proof paths. Dynamically computed references, other cached files and other host artifacts remain unverified. This does not establish whole-repository equality, arbitrary transitive runtime closure, hosted MCP currency or a Codex installed-plugin update.

The shared `developer-update.lock` directory contains `owner.json` with a PID and random token. Atomic directory creation excludes concurrent owners. A child may inherit a live matching token through `RUVNET_DEVELOPER_UPDATE_TOKEN`; it never releases its parent's claim. Stale or unknown ownership fails closed rather than being silently stolen. Kit and Brain use the same protocol. Package installs are bound to npm's live global prefix/root, their original manifest and executable ownership. Reviewed lifecycle-script policy ships with Brain rather than depending on an imported, potentially overwritten Kit implementation.

The atomic coordinator receipt begins running with ok:false and ends checked/completed or failed. It binds exact coordinator bytes, owner PID/token, config, discovered npm prefix, per-package before/after manifest/executable identities, provider snapshots and exclusions. A successful command without a matching package identity/version cannot complete a step. Any failed provider prevents later mutations. Partial completed mutations remain recorded; they are not automatically reverted. A currency check is separate from an applied nightly run and cannot make nightly health green. Running health requires the live matching lock owner, and applied nightly health requires the registered source digest and scheduler identity.

Brain knowledge is checked using its existing installed KB updater and a fresh machine receipt. CURRENT skips; REFUSED preserves an ahead identity; UPDATE_AVAILABLE invokes only the installed global Brain installer with --update --no-nightly-prompt --no-stack, then requires convergence. UNKNOWN or nonzero/unverified paths fail. This avoids anonymous npx installs and retains the signed corpus updater's own compatibility, lease and footprint boundaries.

ADR-098's known-generation footprint guarantees remain in force. Additional npx cleanup is explicit: only attributed Brain/Ruflo installer-cache roots with an existing global counterpart, known cache contents and no live process/open-file owner qualify. Unknown files, aliases and ownership remain intact. No plugin generation, signed application, project dependency tree, KB backup or git worktree is removed by this coordinator.

Validation covers absent tools, same-prefix binding, latest/alpha ordering, downgrade rejection, shadowed launchers, inherited lock ownership, failed receipts, original plugin scopes, local uv/Cargo sources, safe npx cleanup and immutable scheduler-module registration. Provider apply receipts and real platform activation are separate acceptance evidence, collected by integration against the final candidate source.
