# Security Policy

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

## Supported versions

Active development is on `main`; fixes land there first and flow to users via the plugin's update path.
The exact current version is on the badge at the top of the [README](README.md).
