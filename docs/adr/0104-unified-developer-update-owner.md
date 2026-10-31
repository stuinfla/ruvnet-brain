---
id: ADR-104
title: One source-bound coordinator for installed developer updates
status: Accepted
date: 2026-10-10
updated: 2026-10-30 17:30:00 EDT
version: 1.1.0
authors: [Stuart Kerr, Codex]
tags: [updates, install-identity, scheduler, receipts, footprint]
amends: [ADR-098]
---

# ADR-104 — One installed-owner update coordinator

**Status**: Accepted (design and implementation authorization)

Acceptance records the coordination decision; native execution and public release verification remain separate gates.

Updated: 2026-10-30 17:30:00 EDT | Version 1.1.0 (4.7.25: the nightly converges or says why, retries once, pages)
Created: 2026-10-10 04:45:00 EDT

The owner requested one nightly update job, one copy of each installed tool, preserved package/plugin ownership, and an explicit latest/alpha choice. Independent Brain, Kit, native-CLI and package-manager jobs could race, downgrade each other's channels, or report success for an unused copy. This decision adds a coordination boundary; it grants no deployment, inference-spend or fresh-install authority.

The canonical implementation lives in the self-contained plugin payload as `developer-update.mjs` with pure policy, shared lock, optional provider maintenance and bounded cache cleanup modules, plus the immutable `plugin-artifact-proof.mjs` verifier. The npm installer and public CLI reach those same bytes. Brain's existing scheduler retains its identity and platform adapters, but its production registration binds the complete content-addressed module closure and invokes the coordinator at 03:30 local. Proof registrations retain the sealed local-package/bundle route; they cannot substitute a production download. Old registrations remain inspectable until a deliberate scheduler refresh.

Public defaults are latest, the existing RuvNet family, and provider maintenance disabled. Alpha selects a published alpha or latest, whichever is higher, only for RuvNet-family packages. Kit retains its next/latest ordering contract. Scope all explicitly expands to existing npm CLI packages and installed plugin scopes. Explicit preservePackages entries protect locally modified global packages and report preservedLocalModification; they cannot claim currency. Optional Homebrew formulas, unpinned uv registry tools, Cargo registry installs, native tool owners and an owner-reviewed application callback are enabled separately. No absent tool is installed. Symlinked source packages, shadowed wrappers, local wheels, pinned/path/git Cargo builds and managed plugin scopes are preserved with receipt exclusions. Source projects and worktrees are outside this updater's authority.

Pinned Claude targets may be accepted when cached Git metadata is stale only after the immutable manifest, default resources, declared references and bounded literal local dependencies match the pinned Git blobs. Reverse inventory rejects extra cached active resource files. Receipts distinguish the active Claude artifact proof, stale provider metadata, compared paths, verified resource inventory and outside-proof paths. Dynamically computed references, other cached files and other host artifacts remain unverified. This does not establish whole-repository equality, arbitrary transitive runtime closure, hosted MCP currency or a Codex installed-plugin update.

Unattended scheduler runs preserve project/local plugin scopes before accessing their project settings, targets or command working directories. Their receipts remain unsupported and unverified; they cannot claim project plugin currency. Managed scopes remain owned by their administrator. Global user scopes retain stock provider updates and exact target proof. Foreground runs retain the existing explicit project/local update path. Source package links are classified lexically before opening their targets; missing or inaccessible linked source remains preserved with no version claim.

Claude provider commands may select an already-installed native binary when the canonical npm entry exactly matches the known stock placeholder. The original global prefix, physical package owner, matching native package/version/platform and actual version command must all agree. The receipt names the canonical entry and selected native path; unknown placeholders, external aliases and mismatched owners fail closed. This provider fallback performs no installation, download, alias change or canonical-entry repair.

The shared `developer-update.lock` directory contains `owner.json` with a PID and random token. Atomic directory creation excludes concurrent owners. A child may inherit a live matching token through `RUVNET_DEVELOPER_UPDATE_TOKEN`; it never releases its parent's claim. Stale or unknown ownership fails closed rather than being silently stolen. Kit and Brain use the same protocol. Package installs are bound to npm's live global prefix/root, their original manifest and executable ownership. Reviewed lifecycle-script policy ships with Brain rather than depending on an imported, potentially overwritten Kit implementation.

The atomic coordinator receipt begins running with ok:false and ends checked/completed or failed. It binds exact coordinator bytes, owner PID/token, config, discovered npm prefix, per-package before/after manifest/executable identities, provider snapshots and exclusions. A successful command without a matching package identity/version cannot complete a step. Any failed provider prevents later mutations. Partial completed mutations remain recorded; they are not automatically reverted. A currency check is separate from an applied nightly run and cannot make nightly health green. Running health requires the live matching lock owner, and applied nightly health requires the registered source digest and scheduler identity.

Brain knowledge is checked using its existing installed KB updater and a fresh machine receipt. CURRENT skips; REFUSED preserves an ahead identity; UPDATE_AVAILABLE invokes only the installed global Brain installer with --update --no-nightly-prompt --no-stack, then requires convergence. UNKNOWN or nonzero/unverified paths fail. This avoids anonymous npx installs and retains the signed corpus updater's own compatibility, lease and footprint boundaries.

ADR-098's known-generation footprint guarantees remain in force. Additional npx cleanup is explicit: only attributed Brain/Ruflo installer-cache roots with an existing global counterpart, known cache contents and no live process/open-file owner qualify. Unknown files, aliases and ownership remain intact. No plugin generation, signed application, project dependency tree, KB backup or git worktree is removed by this coordinator.

Validation covers absent tools, same-prefix binding, latest/alpha ordering, downgrade rejection, shadowed launchers, inherited lock ownership, failed receipts, original plugin scopes, local uv/Cargo sources, safe npx cleanup and immutable scheduler-module registration. Provider apply receipts and real platform activation are separate acceptance evidence, collected by integration against the final candidate source.

## Trusted terminal wrapper and scheduled execution correction (4.6.2)

Native Codex maintenance distinguishes an exact registered Brain wrapper from the
standalone executable it delegates to. Owned configuration, complete runtime digest,
exact wrapper bytes and native standalone paths must verify before a provider update.
The existing installer restores that registered wrapper with shared Claude configuration
preserved and shell integration unchanged. Unknown replacements fail closed. Recovery
can restore the wrapper and its prior native reference; it does not roll back files the
vendor installer changed.

The verified developer-suite runner forwards all five registered execution identity
fields to the coordinator. This corrects the missing registration, Node, runner and
digest fields while retaining the existing identity verifier and scheduler contract.
Fixture acceptance does not establish a completed scheduled customer update; integration
must collect actual installed registration and execution evidence on the published build.

The latest-operation receipt continues to describe checks and manual runs. A separate
constant-space `scheduler/last-suite-attempt.json` records the last scheduled apply
attempt, including running and failed outcomes. Newer scheduled latest evidence takes
precedence over an older retained success. Under the existing lock, a check or manual
run must first preserve any newer scheduled evidence; retention failure refuses the
latest overwrite. Health retains exact registration/source and live-owner checks,
rejects stale/future evidence, and uses a valid legacy latest scheduled apply only when
appropriate. No previous proof is copied back into the latest-operation file.

## The nightly converges or says why (4.7.25, 2026-10-30)

Measured on the owner's Mac, nights of 2026-10-28, 29 and 30: every 03:30 run ended `completed-with-failures`
with the bare `knowledge: Brain installer --update exited 1`. Root causes, each reproduced:

1. `codex plugin list --json` refreshes Codex's remote plugin catalog when its cache is stale (56 MB, 38-40 s
   cold, codex-cli 0.166.0). Every Codex plugin command ran under a 30 s limit; the killed fetch writes no cache,
   so each retry, each night and each manual `--update` repeated the cold fetch and timed out the same way.
   Codex plugin commands now run under `CODEX_PLUGIN_COMMAND_TIMEOUT_MS` / `CODEX_COMMAND_TIMEOUT_MS` (180 s).
2. `syncHostsAfterUpdate` returned on the first failed host, before the Stable Spine and the convergence
   receipt: Claude Code moved to the new plugin while the runtime and Codex stayed old, with no receipt. Each
   host is now attempted independently, the runtime is activated regardless, and a failed host is recorded as
   `failed` with its reason; the run still ends not-ok.
3. A `CURRENT` corpus returned before the installer ran, so a night whose package stage installed a newer
   `ruvnet-brain` left the runtime and hosts on the old version until a corpus was next published. The knowledge
   stage now confirms `runtimeConvergence` (active.json and host-convergence.json name the installed package,
   no host failed) and runs the installer (a corpus no-op) when it does not; an installer exit 0 that leaves the
   runtime behind is a failure.
4. The installer's output was discarded and launchd wrote it into `kb/update.log`, inside the tree each update
   replaces, so no failed night left a reason. The knowledge failure now carries the installer's failing lines,
   and on macOS the job logs to `<brain home>/.last-nightly-update.log` (footprint-capped; takes effect when
   the LaunchAgent is next written by `--enable-nightly`).

Added: a scheduled night whose knowledge stage fails tries once more after `SCHEDULED_RETRY_DELAY_MS`
(20 min); a scheduled night that ends not-ok pages the owner through the shipped `scripts/notify.sh`
(topic `NTFY_TOPIC` or the owner's `<brain home>/ntfy-topic`, never recorded), and the first ok night after a
failed one pages "recovered". The result is on the receipt (`page`). The maintainer watchdog pages each new
failed night once (keyed on the receipt's `runId`) unless the coordinator's page was delivered.
Tests: `tests/unit/nightly-self-retry-and-page.test.mjs`, `install-update-exit-semantics.test.mjs`,
`nightly-scheduler.test.mjs`, `nightly-watchdog.test.mjs`, each guard proven red by removing it.

