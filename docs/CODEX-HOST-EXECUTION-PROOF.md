Updated: 2026-10-05 EDT | Version 1.0.0
Created: 2026-10-05 EDT

# Owned Codex execution diagnostic

`npm run host:codex:execution-proof -- --help` prints usage without launching a native client. This diagnostic is separate from the default declaration-only doctor.

Explicitly authorized execution uses:

```bash
npm run host:codex:execution-proof -- --authorize-owned-startup --options /absolute/proof-inputs.json
```

This runs ordinary production startup maintenance, one tiny native subscription turn, and one same-thread Brain search. It is not a read-only operation. The native gateway retains subscription, provider, authentication, permission and Standard allocation guards. The expected model and effort come from the canonical ordinary-work route in `config/model-router/routing-policy.template.json`; this command defines no separate model allocation and never changes the user's policy.

The options JSON contains absolute `binary`, `codexHome`, `cwd`, `brainHome`, `releasedPluginRoot`, `packageArchive`, `mcpShell`, and `terminalConfig` paths; released `version`; and `packageSha256`, `workerSha256`, and `expectedRoutingDigest`. Authenticate these hashes independently from protected public release receipts before invoking the command. A locally edited manifest is not an authority. Optional `timeoutMs` defaults to 90000 and must be between 3000 and 120000. Environment, dependency injection and embedded authorization fields are rejected. Missing release diagnostics, foreign enabled handlers, native registry warnings, suspended development hooks and uncertain source identity refuse execution proof.

The printed receipt reports scoped execution evidence separately from overall convergence. Ancestry sampling cannot account for every detached startup descendant, so overall convergence remains UNPROVEN and execution currently exits 1 even when scoped milestones pass. Cleanup describes discovered owned processes only. Existing windows, other hooks, ongoing liveness and overall startup health remain unproven or unknown. Historical failed receipts are preserved. No shared daemon is stopped.

Exit 0 is reserved for help or a proven overall result; exit 1 means an unproven result; exit 2 means invalid command inputs or command failure. This diagnostic is not a release gate or a full issue-391 closure claim.
