Updated: 2026-10-10 05:06:39 EDT | Version 1.0.1
Created: 2026-10-10 04:39:18 EDT

# RuvNet Brain 4.6.0 — coordinated installed-tool updates

Manual and overnight updates use one coordinator, saved policy and shared owner lock. The
installed `ruvnet-brain-update --check` and `--apply` commands expose that coordinator. Configured
automatic lifecycle paths join its immutable registered closure; unconfigured legacy/proof paths
retain their compatibility setting. RNBC
presents **Keep all tools updated** with **Latest (recommended)** or **Alpha**, and reports the
saved choice, native scheduler state and actual run evidence separately. The scheduled run is
03:30 in the user's local time. The public default covers installed RuvNet-suite tools; broader
developer-tool maintenance is an explicit choice.

The coordinator discovers the existing package prefix, commands and plugin scopes before
applying updates. It preserves their owner and path, refuses downgrades and records targets,
before/after snapshots and exclusions. Enabled maintenance stages use existing managers rather
than installing absent tools. Legitimate project dependencies, active leased generations,
signed apps' embedded runtimes, pinned toolchains, local builds and local Python wheels remain
owned by their existing lifecycle. Cleanup has a separate opt-in and preserves active or
unclassified sources.

Activity uses the source-bound run receipt. A check remains a check, a failed stage stays
visible, and an excluded or unverified tool is not reported as current. Hosted MCP software
updates remain the provider's responsibility; checking a connection does not prove software
currency. The Brain's signed corpus update still preserves private and local-ingest stores.

## Evidence and limits

This document describes the 4.6.0 source. Publication and public installation require the
protected release transaction's `install-verified` receipt on its exact candidate; a version
stamp, passing unit tests or scheduler registration does not establish that outcome. Native
scheduled execution and every enabled maintenance stage require their actual run receipts.
The operating contract and developer-checkout commands live in `CONTRIBUTING.md` under
"Coordinated developer updates (4.6.0)".

Agentic Kit's upstream updater ownership integration remains separate work, tracked as issue
469 in pacphi/agentic-kit. A private patched installation is not evidence of an upstream Kit
release. Local RuOS OAuth scope and editor command preferences are machine repairs, not
features shipped by this Brain release.
