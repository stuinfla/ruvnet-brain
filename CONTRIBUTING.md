# Contributing to RuvNet Brain

Thanks for helping improve the brain. This guide is the practical map of how the repo is built,
tested, versioned, and published. Everything here is accurate to the scripts in `scripts/` and
`kb/` — when in doubt, read the script (each one has a header comment explaining exactly what it does).

## Prerequisites

- **Node.js ≥ 18** (see `engines` in `package.json`).
- **git** and, for publishing, the **`gh`** GitHub CLI.
- A **local ONNX model cache** for the embedders. Point `KB_MODEL_CACHE` at a warm cache dir to
  avoid a first-run download of `Xenova/all-MiniLM-L6-v2` (384-dim) and the bge-768 model:
  ```bash
  export KB_MODEL_CACHE=/path/to/models-cache
  ```
  If unset, the build scripts default to a repo-local `kb/models-cache` and download on demand.

The heavy vector artifacts (`kb/*.rvf`, `kb/*.big.rvf`) ship via GitHub Releases, **not** git — a
fresh clone is lightweight, and end users get the ~512 MB bundle through `npx ruvnet-brain`.

## What the pieces are

| Area | Where | Purpose |
|---|---|---|
| The brain (query-time) | `kb/` | Per-repo `.rvf` (MiniLM-384) + `.big.rvf` (bge-768) stores, full-passage sidecars, symbol indexes, primers, the concepts store, and the `forge-*` query tools (CLI `forge-ask-all.mjs` + MCP `forge-mcp-all.mjs` / `search_ruvnet`). |
| The plugin | `plugin/` | Claude Code plugin: MCP server, grounding skill, the three hooks (`session-start.sh`, `ground-ruvnet.sh`, `hijack-ruvnet.sh`), marketplace manifest, and the test suite. |
| Build / publish tooling | `scripts/` | The pipeline below. |
| Coverage registry | `data/registry.tiers.json`, `data/manifest.json` | Which repos are in scope (T0–T3) and what was actually built (per-repo commit SHA, coverage counts). |
| Nightly LaunchAgent | `deploy/com.ruvnet.brain-nightly.plist` | The macOS scheduler that runs the nightly evergreen + publish. |

## Building the brain (scripts/ overview)

The expensive work happens **once, at build time**. The pipeline, in the order it runs:

1. **Embed a repo** — `kb/forge-build.mjs` deep-walks a cloned repo (whole files, full function
   bodies) and embeds it into the MiniLM-384 store; `kb/forge-big.mjs both` re-embeds the same
   passages into the bge-768 (`*.big.rvf`) store. `scripts/build-symbols.mjs` adds a symbol index.
2. **Concepts / capability layer** — `scripts/build-concepts.mjs` (capability cards + L2), plus
   `scripts/build-primer.mjs` and `scripts/build-l2.mjs` for per-repo prose. These let the model
   ground *capability* claims and route a described need to the right repo, not just do file lookups.
3. **Stamp** — `scripts/brain-stamp.mjs` writes `data/manifest.json` (build date + per-repo commit
   SHA + coverage counts) and injects the stamp into the primer header and each store's `SOURCE.json`.
4. **Assemble the shippable bundle** — `scripts/build-bundle.mjs` copies the query-time artifacts
   into `dist/ruvnet-brain/`, applying the private-store fence (see below).
5. **Prove it** — the test/grading scripts (`scripts/gate.sh`, `scripts/prove.mjs`,
   `scripts/behavioral-l1-l4.mjs`, `scripts/brain-capability-check.mjs`,
   `scripts/brain-grade-groundtruth.mjs`, and `plugin/test/run-tests.mjs`).

`scripts/gen-images.mjs` regenerates the explainer/diagram assets. `scripts/version.mjs` /
`scripts/sync-version.mjs` handle versioning (see below).

## Adding a repo to the brain

To pull any `github.com/ruvnet/<name>` repo (or a rUv-collaborator org repo) into the brain **on
demand**:

```bash
node scripts/ingest-repo.mjs --name <repo> [--org <github-org>]
```

`--org` defaults to `ruvnet`; pass it to ingest an ecosystem repo that lives in a collaborator org
(e.g. `--name agentic-qe --org proffesor-for-testing`). This clones (shallow), embeds both variants
(MiniLM-384 then bge-768), and builds the symbol index. The new `<name>.rvf` is discovered at query
time by `search_ruvnet` / `forge-ask-all`, so it is **searchable immediately — no server restart**.

For full capability-confidence on the new repo (so it's never wrongly doubted), also build its
primer + refresh the concepts store afterward:

```bash
node scripts/build-primer.mjs --name <name> --variant big
node scripts/build-concepts.mjs && node kb/forge-big.mjs both --dir kb --name concepts
```

> If the repo you ingest is **private**, you must also add its store name to `kb/PRIVATE-STORES.json`
> before building any publishable bundle — see the private fence section.

## Version: single source of truth

There is **exactly one** hand-edited version number: the `version` field in
`plugin/.claude-plugin/plugin.json`. Every other surface inherits it.

1. Bump `version` in `plugin/.claude-plugin/plugin.json` (that is the only place you type it).
2. Run:
   ```bash
   node scripts/sync-version.mjs
   ```
   This writes the version into `package.json`, `data/manifest.json` (`brainVersion`), and
   `kb/package.json`. Code paths read it at runtime via `getVersion()` in `scripts/version.mjs` —
   never hardcode a version string anywhere else.
3. CI (and you, before a PR) verify no surface has drifted:
   ```bash
   node scripts/sync-version.mjs --check   # exits 1 on any drift; also npm run version:check
   ```
   `--check` also fails if a code path carries a stray hardcoded `vX.Y.Z-dev` literal instead of
   calling `getVersion()`.

The README's blue version badge and heading are regenerated by the nightly publisher; do not
hand-edit the badge line.

## Running the tests

```bash
npm test                              # plugin QA over real JSON-RPC (plugin/test/run-tests.mjs)
npm run version:check                 # fail if any surface drifted from plugin.json's version
bash scripts/gate.sh                  # rebuild concepts + the three pass/fail routing gates
node scripts/behavioral-l1-l4.mjs     # the 4-level behavioral harness (route/recall/implement/orchestrate)
```

- `npm test` verifies manifests/structure, that the grounding hook fires on RuvNet prompts (and
  stays silent otherwise — the always-on status footer is expected, not a leak), the MCP launcher
  (`initialize` / `tools/list`), and the capability battery. Sections that need the brain skip
  cleanly if it isn't installed at `$RUVNET_BRAIN_KB` or `~/.cache/ruvnet-brain/kb`.
- `scripts/gate.sh` is designed to be **able to fail** (SEC-0010 #1): each gate's real exit code is
  captured via `PIPESTATUS`, so a miss makes the whole script exit non-zero. Reports land in
  `DESCRIBED-PROOF.md`, `PROOF.md`, and `HELIX-DEMO-NOHELIX.md`.

Set `KB_MODEL_CACHE` before running the grading scripts to avoid a first-run model download.

## How the nightly publish works

The nightly evergreen keeps the shipped bundle current and pushes it out to users automatically.

- **Driver:** `scripts/self-update.mjs` compares each in-scope repo's live `git ls-remote HEAD`
  against the SHA stamped in `data/manifest.json`, then rebuilds only what changed.
  - Dry-run (prints the rebuild plan, writes nothing): `node scripts/self-update.mjs`
  - Apply: `node scripts/self-update.mjs --apply` — rebuilds stale/changed **already-built** repos
    serially (embedding is CPU-bound), re-stamps, and re-assembles `dist/ruvnet-brain`.
  - Scope flags: `--tier T0`, `--repo ruflo`. Building **brand-new** repos is a supervised,
    multi-hour job and is gated behind `--include-new` so the cron can't silently deep-walk 40+
    repos on its first run. T3 is deep-walked on demand, not nightly.
- **Publish (the last mile):** `node scripts/self-update.mjs --apply --publish`. Only when
  something was actually rebuilt this run, it bumps `plugin/.claude-plugin/plugin.json` (patch),
  regenerates the README version badge, zips `dist/ruvnet-brain` → `dist/ruvnet-brain.zip`, runs
  `gh release create <tag>` (so `releases/latest` advances), then commits the version bump +
  stamped manifests and pushes `main`. One product version — plugin and knowledge bundle ship
  under a single tag, and users' session-start heartbeats pick both up. It is fail-loud: any error
  exits non-zero into the nightly log; nothing is half-published.
- **Scheduler:** `deploy/com.ruvnet.brain-nightly.plist` runs
  `node scripts/self-update.mjs --apply --publish` at **03:15** local time. It is **NOT
  auto-installed** — system schedulers require explicit owner approval. To enable / disable:
  ```bash
  cp deploy/com.ruvnet.brain-nightly.plist ~/Library/LaunchAgents/
  launchctl load  ~/Library/LaunchAgents/com.ruvnet.brain-nightly.plist   # enable
  launchctl unload ~/Library/LaunchAgents/com.ruvnet.brain-nightly.plist  # disable
  ```
  Output goes to `logs/nightly*.log`.

> The primer / L2 / concepts layer and answer-quality grading are **supervised** steps — the
> nightly refreshes deep source + re-assembles the bundle, but re-run those by hand when a repo
> changes materially.

## The fail-closed private fence

Some KBs are built from **private** source (the `cognitum-one` org) and must never ship in a public
bundle. `kb/PRIVATE-STORES.json` is the allow-list-inverse: it names those stores, and
`scripts/build-bundle.mjs` drops them (and their raw L2 `.md` files) during assembly.

The fence is **fail-closed** (security-critical, SEC-0010 #4). `build-bundle.mjs` **aborts the
build** if `PRIVATE-STORES.json` is:

- **missing** — unless you explicitly opt out with `ALLOW_NO_PRIVATE_FENCE=1` (the escape hatch a
  genuine no-private public fork needs, never the silent default);
- **present but unparseable/corrupt**; or
- **missing a valid `privateStores` array**.

A fence that degraded to an empty set on error would silently ship every store, including private
source — so it refuses to build instead. **When you ingest a private repo, add its store name to
`kb/PRIVATE-STORES.json` in the same change.** Zero-leak is verified in the assembled + zipped
bundle on every publish.

## Pull requests

- Keep changes surgical. Run `npm run version:check` and `npm test` before opening a PR.
- **Do not** hand-edit generated version surfaces (README badge line, `package.json`,
  `data/manifest.json` `brainVersion`, `kb/package.json`) — bump `plugin.json` and run
  `sync-version.mjs` instead.
- If you touch a doc, version it per the header convention used across `docs/`.
