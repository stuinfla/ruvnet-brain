Updated: 2026-10-10 12:34:24 EDT | Version 1.0.0
Created: 2026-10-10 12:34:24 EDT

# RuvNet Brain 4.6.2 — native update ownership and nightly evidence

Native Codex maintenance now recognizes the exact registered Brain terminal wrapper,
verifies its owned configuration and full runtime, updates the underlying standalone
executable, then restores the trusted wrapper using the existing terminal installer.
Shared Claude configuration and shell preferences stay preserved. Failed commands,
unknown replacements and restoration failures cannot complete the provider. Recovery
preserves the wrapper and previous native reference; vendor files are not rolled back.

The developer-suite nightly runner forwards its verified registration, Node executable,
runner path and SHA-256 to the coordinator. This keeps the installed update verifier
bound to the content-addressed scheduled runner instead of omitting required identity.

Currency checks and manual runs retain their own latest-operation receipt. Scheduled
health uses a separate bounded last-attempt receipt, including failures and running
state, so checking currency does not erase a scheduled outcome. A newer failed apply
cannot be hidden by an older success; registration, source, age and live-owner evidence
remain required.

This release does not refresh the upstream knowledge corpus. Fixture results, public
installation and actual customer scheduled execution remain distinct evidence; source
qualification alone does not establish those outcomes. Existing SDK sessions need a
restart to load a newly installed generation.
