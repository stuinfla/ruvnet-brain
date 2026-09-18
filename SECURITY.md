# Security Policy

Updated: 2026-09-17 18:31:22 EDT | Version 1.0.2
Created: 2026-07-06

RuvNet Brain runs on your machine, downloads a knowledge bundle, and (with your consent) can update
itself — so we take reports seriously and fix them in the open. This policy exists because the project's
first security review was a private, responsible disclosure; the next reporter should have a clear path.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Instead:

- Use GitHub's **[private vulnerability reporting](https://github.com/stuinfla/ruvnet-brain/security/advisories/new)**
  (Security tab → "Report a vulnerability"), or
- Email the maintainer at the address on the [GitHub profile](https://github.com/stuinfla).

Include: what you found, a `file:line` or reproduction, the impact, and (if you have one) a suggested fix.
"Confirmed" reports — where you ran the exact command or read the exact line — are the most actionable.

## What to expect

- We verify every report against the real code before acting (we do not dismiss, and we do not
  rubber-stamp). Fixes are proven with a real command before they're called done.
- Each finding is tracked with a `file:line` root cause, the exact fix, and its verification — see
  [`docs/adr/0010-security-hardening-sec-0010.md`](docs/adr/0010-security-hardening-sec-0010.md) for the
  format (that ADR is the record of the first review).
- We credit reporters unless you ask us not to.

## What runs automatically, and when

The current registrations live in `plugin/hooks/hooks.json` (Claude) and
`plugin/hooks/codex-hooks.json` (Codex). Installing a script does not register it as an automatic
hook. These manifests retain the continuity and grounding paths below:

| Event | Registered responsibility |
|---|---|
| SessionStart | `session-start` restores session context. |
| UserPromptSubmit | `unprompted-speech`, `ground-ruvnet`, and `grounding-turn-mark` provide context and mark grounding obligations. |
| PreToolUse, write tools | `decision-gate write` checks the write decision. Codex also matches `apply_patch`. |
| PostToolUse, successful search | `grounding-stamp` records the grounding evidence. |
| Stop | `continuation-gate` and `grounding-turn-gate` can request continued work; Claude also captures `session-snapshot`. |
| PreCompact | Claude captures `session-snapshot`; Codex has no registered PreCompact handler. |
| SessionEnd | Both hosts capture `session-snapshot`. |

The legacy broad Bash/Task interceptors are not registered by these manifests. Their retained
scripts may still be explicitly invoked by user-owned configuration. The removed
`verify-interface.sh` has no executable body; the current shim handles its former ID as a silent
no-op without resolving or dispatching an older body. An already-running host with a frozen older
shim requires an update/reload to acquire that behavior.

Managed CLI interface enforcement is explicit: `ruvnet_cli_help` followed by `ruvnet_cli_run`.
The MCP boundary validates executable names, help freshness, and literal argv, uses `shell:false`,
and refuses adopted-project execution without trusted host identity and durable progression capture.
This does not intercept arbitrary shell commands.

Automatic execution is defined by the current hook manifests and their dispatcher. The dormant
Kling preflight product copy has been removed; Kling-specific policy belongs to the separately
installed Kling skill. Its private files are not part of this cleanup. The retained
`version-bump-gate.sh` is an unregistered legacy interceptor, not an automatically installed gate.
Grounding policies remain on the active decision-gate and successful-search paths.

## What leaves your machine — and what never does

Everything below is a plain, unauthenticated `GET`/`POST` to a public endpoint — none of it carries an
API key, a machine identifier, your prompts, your code, or file contents. Grep the cited file yourself;
that's the point of this section.

**Version / update checks (read-only, no payload beyond the HTTP request itself):**
- `plugin/scripts/session-start.sh` — `curl` to `raw.githubusercontent.com/.../plugin.json`, rate-limited
  to once per ~15 min, 3 s timeout, to detect a newer plugin version.
- `plugin/scripts/ground-ruvnet.sh` — `curl` to `registry.npmjs.org/<pkg>/latest` for a handful of stack
  packages, rate-limited to once per ~6 h, backgrounded so it can never block a prompt.
- `bin/install.mjs` — `api.github.com/repos/.../releases/latest` (find the current release) and the
  matching `github.com/.../releases/download/...` asset URL (download the ~500 MB knowledge bundle zip).
- `scripts/onboarding-console.mjs` (`gatherTrust`, serving the local Console's Trust card) —
  `api.github.com/repos/.../releases/latest` plus the published `.sha256` asset, to show you the release
  bundle's fingerprint. The Console server itself binds `127.0.0.1` only and rejects any request whose
  `Host` header isn't loopback (DNS-rebinding guard) — nothing it serves is reachable off your machine.

**Optional, consent-gated usage counts (`kb/telemetry-ping.mjs`, `bin/install.mjs`):**
- Nothing is ever sent unless `~/.cache/ruvnet-brain/.telemetry-consent` contains the literal word `yes`
  — written only after the installer explicitly asks you ("Share anonymous usage counts... [Y/n]"), and
  never written at all on a non-interactive install (so a scripted/CI install stays silent by default).
  Decline up front with `--no-telemetry`, or flip the file back to `no` / delete it at any time.
- The entire payload, always: `{ event: "install", v: <version> }` once at install time, and at most one
  daily-batched `{ event: "search"|"session", v: <version>, n: <count> }` per event type — a name, the
  installed bundle's version string, and an integer count. No query text, no repo names, no file paths,
  no code, no username, no machine ID is ever read by this code path, let alone transmitted — see the
  contract comment at the top of `kb/telemetry-ping.mjs`.
- Hard kill-switches: `RUVNET_BRAIN_TELEMETRY=0` or `RUVNET_BRAIN_TEST=1` disable the module outright.

**Model weights (first run only, then fully local)** — see **Model & data provenance** below; the short
version is: a specific pinned HuggingFace revision, only when not already cached, never on repeat runs.

**What never leaves your machine, full stop:** your prompts, your source code, the text of your
`search_ruvnet` queries, anything AgentDB/ruflo memory stores (`.swarm/memory.db` is local SQLite), the
RVF vector stores themselves, and the contents of any file the hooks touch (they log *that* a Write/Edit
happened and a basename — never the diff or the file body).

## Consent gates

Every point where RuvNet Brain can do something beyond "answer inside this session" is opt-in and
recorded as a plain file you can read or flip yourself:

- **Anonymous usage counts** — asked once, at install; default is OFF on a non-interactive install;
  `~/.cache/ruvnet-brain/.telemetry-consent`.
- **Background plugin auto-update** — asked once, at first `SessionStart`; even when enabled, a new
  version only *downloads* automatically — loading it still requires you to restart/`--continue` your
  session (Claude Code only loads plugins at process start, a hard platform constraint, not a choice this
  project makes); `~/.cache/ruvnet-brain/.auto-update-pref`.
- **Knowledge-bundle updates** — detect-and-notify only; `forge-update.mjs --apply` is never run
  automatically, by design, because it overwrites executable `.mjs` tool files from a GitHub Release (see
  the signing posture below) — you run `--apply` yourself after reviewing.
- **Model-router cost routing / dispatch-model wall** — a non-interactive install may record detected
  values in `~/.claude/model-router/profile.json`, but an entry whose provenance begins `assumed:` is
  explicitly inert. `route-dispatch.sh` does not block until router setup confirms that profile.
  The legacy interface notice follows the same consent rule but is advisory only; explicit
  `ruvnet_cli_help` / `ruvnet_cli_run` MCP calls enforce their own structured policy.
- **Console Apply flow** — every mutating action is a POST that must echo a random, per-launch token
  (never persisted to disk), and the undo is journalled *before* the mutation runs so any applied change
  is reversible; see `scripts/onboarding-console.mjs`'s header comment for the full contract.

## Known, tracked security posture (honest disclosure)

- **The knowledge bundle is Ed25519-signed with transitional enforcement.** `scripts/sign-bundle.mjs`
  emits a detached `<zip>.sig` (over the bundle's SHA-256) plus `<zip>.sha256`, and the installer
  verifies it **before extracting**, against an Ed25519 public key **embedded in `bin/install.mjs`** so
  the trust root travels with the installer code (an attacker who swaps the bundle can't also swap the
  key). A signature that is **present but invalid always fails closed** — the download is deleted and
  extraction refused. A **missing** signature currently **warns and proceeds** (`SIGNING_REQUIRED = false`)
  so releases predating signing still install; this flips to hard-required once every release is signed.
  The *unattended* code-overwrite path remains disabled (updates detect-and-notify, they do not
  auto-apply executable files).
- **Model weights** download from HuggingFace on first run only when not already cached, and are now
  **pinned to exact commit SHAs** (no longer the floating `main` branch) so the weights — and therefore
  every embedding — cannot silently change under an upstream re-publish. See **Model & data provenance**
  below.
- The grounding **hooks are POSIX shell** — on native Windows without WSL/Git-Bash they don't fire (the
  `search_ruvnet` tool still works).

## Model & data provenance

The brain's answers are only as trustworthy as the weights that produce its embeddings, so those are
pinned and loaded locally:

- **Embedding models (pinned by exact HuggingFace commit SHA, quantized ONNX):**
  - `Xenova/all-MiniLM-L6-v2` — 384-dim, the default query embedder and the *small* build
    (`kb/forge-ask.mjs`, `kb/forge-build.mjs`) — pinned at `751bff37182d3f1213fa05d7196b954e230abad9`.
  - `Xenova/bge-base-en-v1.5` — 768-dim, the sharper *big* build (`kb/forge-big.mjs`, and the query
    side of `kb/forge-ask.mjs` when a big bundle is present) — pinned at
    `4d6cd88e18e51a5e020c2c305726d76ada9c03cf`.
  - `Xenova/ms-marco-MiniLM-L-6-v2` — cross-encoder reranker (`kb/forge-rerank.mjs`) — pinned at
    `a09144355adeed5f58c8ed011d209bf8ee5a1fec` when the default model is used (an operator `CE_MODEL`
    override falls back to `main`).
- **Weights load from a local ONNX cache**, not the network by default. The loader
  (`@xenova/transformers` v2.17.2) points at a local model cache (`KB_MODEL_CACHE`, else a `kb/`-local
  `models-cache`) and permits a remote HuggingFace fetch **only** when that specific model is not already
  cached. Once cached it is fully offline. The cache lookup is revision-agnostic, so pinning a SHA never
  forces a re-download of an already-present model — it only makes the first fetch on a fresh machine
  deterministic.
- **Pin vs. package version are independent.** The pinned SHA fixes the *weights*; the
  `@xenova/transformers` npm version (bumped via Dependabot) fixes the *loader code*. A loader upgrade
  never changes the pinned weights — review such updates for API compatibility with the pinned revisions.
- **Bundle integrity** is covered by the Ed25519 signing posture described above (signed `.sig` +
  `.sha256`, public key embedded in the installer, verify-before-extract, invalid-signature fail-closed).

## What v3.3 adds

- **A CycloneDX SBOM for the shipped surfaces.** `npm run sbom` runs the standard
  [`@cyclonedx/cyclonedx-npm`](https://github.com/CycloneDX/cyclonedx-node-npm) tool (`--omit dev`, so
  test/build-only tooling like `vitest` is excluded) and writes
  [`sbom/ruvnet-brain.cdx.json`](sbom/ruvnet-brain.cdx.json) — a CycloneDX 1.6 document listing every
  production package the installer and plugin actually ship (currently `@metaharness/router` and its one
  transitive dependency, `@metaharness/flywheel`; the installer and the plugin's MCP launcher themselves
  import only Node's standard library — zero third-party runtime dependencies of their own). The
  Onboarding Console's Trust card reads this file locally and, once you've generated it, shows the real
  component count and generation date in place of the "coming v3.3" placeholder — the wiring is already
  live in `scripts/onboarding-console.mjs` (`gatherTrust`) and `console/app.js` (`renderTrust`) as of this
  change. A signed, published SBOM attached to each GitHub Release (matching the existing `.sha256`/`.sig`
  pattern) is the remaining step to make this row "coming v3.3" a full "measured from the published asset"
  the way the bundle signature row already is.
- **An npm provenance plan** (not yet executed — no publish has happened as part of this work) for the
  `ruvnet-brain` npm package, using `npm publish --provenance` over GitHub Actions OIDC (the "trusted
  publisher" flow) rather than a long-lived npm token. See
  [`docs/research/npm-provenance-plan.md`](docs/research/npm-provenance-plan.md) for the exact
  requirements and steps.

## Supported versions

Active development is on `main`; fixes land there first and flow to users via the plugin's update path.
The exact current version is on the badge at the top of the [README](README.md).
