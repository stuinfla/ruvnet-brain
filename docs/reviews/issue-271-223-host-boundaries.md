Updated: 2026-09-09 22:42:00 EDT | Version 1.0.2
Created: 2026-09-09 21:40:44 EDT

# Host update boundaries for issues 271 and 223

## Issue 271: stale Claude hook paths

Host convergence now takes an atomic process lock at
`~/.cache/ruvnet-brain/host-convergence.lock`. Concurrent Brain installers cannot
run Claude/Codex host updates at the same time. The lock records its PID, refuses a
live owner, treats a newly incomplete publication as busy, and reclaims only a stale
owner or stale incomplete directory. Release is token-checked so one process cannot
delete another process's lock. Shell-change detection covers the shim's imported
helpers and file contents under boot-loaded skills and commands, and the boundary is
preserved across later body-only releases. This closes the Brain-side update race;
it cannot change a Claude host process that has already cached an old plugin path.
Legacy plugin generations without a liveness lease are retained rather than deleted,
so a frozen Claude session cannot be pointed at a missing directory. A fresh Claude
session remains required only when boot-level declarations changed.

## Issue 223: Codex generation leases

Codex owns its native plugin cache and the current installer API exposes no session
generation lease or safe deletion callback. The installer now compares the exact
installed payload against the candidate before an update. Body-only changes are
marked `restartRequired: false` and become available on the next hook/MCP call.
Only a changed or unlocatable boot surface is marked `sessionSafety:
restart-required` and `restartRequired: true`; the convergence classifier keeps
that host pending until one restart. This is the guarded behavior until Codex
exposes a lease API.

The regression test in `tests/unit/codex-wiring.test.mjs` asserts this boundary and
the unchanged-install behavior. It does not prove Codex's private cache behavior,
because that state is outside Brain's API boundary.
