# Native CLI setup

Use the bundled setup and verifier so the complete API-key and cloud-credential denylist is applied. Do not print credential files or token values.

```sh
node tri-smart/scripts/setup.mjs
node tri-smart/scripts/verify-access.mjs --mode=auto --probe
```

If a provider is not authenticated, use its official flow and ask the user to finish the browser step:

```sh
claude
codex login
grok login --oauth
```

Verify the exact models with real single-turn probes, still with API variables unset. A model-list result is not enough to claim a successful invocation. Never write tokens to AgentDB, a repository, `.env` files, logs, or shell history.
