# Host update boundaries for issues 271 and 223

## Issue 271: stale Claude hook paths

Host convergence now takes an atomic process lock at
`~/.cache/ruvnet-brain/host-convergence.lock`. Concurrent Brain installers cannot
run Claude/Codex host updates at the same time. The lock records its PID, refuses a
live owner, and reclaims only an owner that is gone or an incomplete lock. This
closes the Brain-side update race; it cannot change a Claude host process that has
already cached an old plugin path. A fresh Claude session remains required after a
plugin update.

## Issue 223: Codex generation leases

Codex owns its native plugin cache and the current installer API exposes no session
generation lease or safe deletion callback. Brain therefore does not delete Codex
cache generations or claim that an in-process update is safe. After a native Codex
plugin install/update, the result is explicitly marked `sessionSafety:
restart-required` and `restartRequired: true`; restart Codex before using the new
plugin. This is the concrete guarded behavior until Codex exposes a lease API.

The regression test in `tests/unit/codex-wiring.test.mjs` asserts this boundary and
the unchanged-install behavior. It does not prove Codex's private cache behavior,
because that state is outside Brain's API boundary.
