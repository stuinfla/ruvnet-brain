Updated: 2026-09-05 14:10:00 EDT | Version 1.0.0
Created: 2026-09-05 14:10:00 EDT

# Reversible development maintenance

Run from this checkout, or supply an explicit working-tree path:

```sh
node scripts/development-maintenance.mjs status --project /path/to/project
node scripts/development-maintenance.mjs suspend --project /path/to/project
node scripts/development-maintenance.mjs resume --project /path/to/project
```

The configuration is stored in the repository's Git common directory. Linked worktrees share
one choice; another repository has a different choice. The command writes user-owned configuration
and decision receipts with mode 0600, in metadata excluded from commits. It rejects symlink state.
No host settings are rewritten. Resume removes only the maintenance choice, restoring the existing
Brain on/off preferences and hook registrations, including ones previously disabled.

Updated Claude shims, Codex wrappers/adapters, and the development version hook read this choice
before executing hook bodies. This includes protection, automatic updates, capture, and Stop
continuation: none of those bodies runs while suspended. Therefore automatic continuity is paused
too; record the work checkpoint explicitly before suspension and before handing off.

The Git pre-push hook retains its secret scan, then skips development checks during maintenance.
Explicit QA and publication commands never consult maintenance state. Maintenance does not grant
release authorization and is not evidence that a candidate passed QA.

`status` reports the configuration marker, **not** a complete inventory of effective host hooks.
Already loaded old shims, copied wrappers without the helper, absolute paths into old checkouts,
unrelated hooks, scheduled jobs, and already running processes cannot be suspended by code they
have not loaded. Before declaring maintenance effective, inspect each host's effective registration,
install the updated dispatcher and helper, and test a fresh invocation. The installer must colocate
`development-maintenance.mjs` beside the standalone `codex-hook.mjs`. Alternatively, disable the
old host registration with a backup and restore that exact backup on resume. Do not enable every
global hook as a substitute for restoring the previous settings.

Development hook tests intentionally execute real hook bodies. Run them from a repository without
active maintenance, or resume before testing. Suspending a shared common directory also suspends
its test worktrees. A silent hook is suspension evidence only when the same fixture executes the
body before suspension and again after resume.

Malformed state is reported as an error by the CLI and does not authorize a hook bypass. Resolve
the invalid configuration explicitly; do not interpret a CLI error as successful suspension.
