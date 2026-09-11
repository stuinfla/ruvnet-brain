Updated: 2026-09-10 14:58:00 EDT | Version 1.0.0
Created: 2026-09-10 14:58:00 EDT

# Client asset handoff

For explainers, the default delivery is a public production URL. Deploy the explainer first and browser-inspect the live page; use client Downloads only as a secondary offline copy.

When Codex is running on a tunneled server, a `/Users/...` link refers to the server's filesystem. It is not a file on the Mac or browser where the user is looking. Generated files must be copied to the client before they are handed off.

Use the verified handoff command from the repository root. The default target is the M4 Mini:

```sh
node scripts/handoff-asset.mjs --asset=/absolute/path/to/generated-file
```

To target the M1 MacBook Air, use `--client=air`:

```sh
node scripts/handoff-asset.mjs --asset=/absolute/path/to/generated-file --client=air
```

The known clients are M4 Mini (`stuartkerr@100.95.179.114`) and M1 Air (`macbook-air`, from SSH config). Override `--host` and `--remote-dir` for another client. The command fails unless the remote SHA-256 exactly matches the source SHA-256, and it prints the client path only after verification.

For a web page, hand off the directory or ZIP as well as a screenshot. A `file:///` link or a server-local Markdown file link is not client proof.
