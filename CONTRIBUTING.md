# Contributing to RuvNet Brain — the one rulebook

Updated: 2026-09-30
Created: 2026-07-07

This file is the **only** place that says how to version, release, update the knowledge corpus,
and what the hooks do. `CLAUDE.md`, `AGENTS.md`, skills and memory point here instead of restating
it. ADRs in `docs/adr/` record *why* a decision was made; they are history, not operating
instructions. `npm run single-source:check` fails CI if a second, conflicting instruction appears.

## The rules at a glance

| Job | The only way | Proof it worked |
|---|---|---|
| Change code or docs | Work on a branch; land it on a `release/X.Y.Z` branch. Nothing is pushed to `main` directly. | `release-candidate-preflight` green on that SHA |
| Set the version | `npm run version:set -- X.Y.Z` (first commit of the release branch) | `npm run version:check` exits 0 |
| Release code | Preflight → fast-forward `main` → dispatch `protected-release.yml mode=code` → owner approves the `Production – ruvnet-brain` deployment | Terminal receipt `install-verified` on Linux, macOS, Windows; npm `latest` = GitHub `releases/latest` = `main` |
| Build the customer corpus | CI only: `corpus-seed.yml` → `scripts/corpus-reconcile.mjs` | Sealed candidate + receipt artifact |
| Publish the corpus | `protected-release.yml mode=corpus` (nightly dispatcher), armed unless repository variable `CORPUS_NIGHTLY` is `off` (the owner's kill switch) **and** the newest code release is `install-verified` (resolved at run time, `scripts/approved-runtime.mjs --resolve`; never a committed file, never a fallback to an older release); the corpus is built at that release's source commit, and `main` being ahead of it does not matter; a night with no upstream change publishes nothing | `corpus-sha256-*` release promoted to `releases/latest` |
| Update a user's machine | One owner per machine: the Brain's scheduler (`npx ruvnet-brain --enable-nightly`) **or** agentic-kit (`ak sync`) — never both | `SOURCE.json` `releaseTag` equals the plugin version; latest `~/.cache/ruvnet-brain/refresh-runs/*.json` is PASS |

Nothing else publishes. `scripts/release-authority.mjs` fails CI if any file other than
`scripts/release.mjs` / `scripts/release-transaction-provider.mjs` contains a publish operation, and
`prepublishOnly` refuses `npm publish` outside the protected workflow.

## Versioning

- The one hand-set number is `plugin/.claude-plugin/plugin.json` `version`; set it only with
  `npm run version:set -- X.Y.Z`, which also rewrites every generated surface (package.json, lockfile,
  manifest, kb/package.json, primer, explainer, README badge) and runs `version:check`.
- Only plain `X.Y.Z` versions can be published (`scripts/protected-release-invocation.mjs`).
- Why `main` never moves except by release: the Claude Code plugin installs from `./plugin` on the
  default branch (`.claude-plugin/marketplace.json`). Every commit on `main` must therefore be a
  released version, or plugin users receive changes with no version signal.

## Releasing code (step by step)

```bash
git switch -c release/X.Y.Z origin/main
npm run version:set -- X.Y.Z && npm run convergence:write      # commit these first
# …merge the reviewed work for this release onto the branch…
npm test && npx vitest run && npm run single-source:check    # both suites assert different things
git push origin release/X.Y.Z                                # triggers release-candidate-preflight
```

1. Wait for `release-candidate-preflight` to pass on the exact SHA. Any source change repeats it.
2. Open a PR `release/X.Y.Z → main` for review and required checks. **Never click Merge, Squash or
   Rebase** — each creates a new SHA the publisher will refuse.
3. Promote with a normal fast-forward: confirm `origin/main` is an ancestor, then
   `git push origin "$SHA:refs/heads/main"` and confirm the remote ref equals `$SHA`. Never force.
4. Dispatch: `gh workflow run protected-release.yml -f mode=code -f candidate_sha=$SHA -f version=X.Y.Z`.
5. The owner approves the `Production – ruvnet-brain` deployment in GitHub (required reviewer).
6. Done means the terminal `install-verified` receipt: all public OS × host combinations verified.
   Anything short of that is "published, not verified". Recovery/abandon rails:
   `recover-public-verification.yml`, `abandon-public-verification.yml` (manual `repository_dispatch`),
   `npm run release-abort-stale`.

`npm run release:qualify` is the one definition of "qualified"; CI and local checks both use it.

## The knowledge corpus

**Built in CI only.** `corpus-seed.yml` observes every public rUv repository (exclusions are
recorded in `data/source-coverage.json`), reconciles changed repos against the previous published
generation with `scripts/corpus-reconcile.mjs`, and seals a candidate. It cannot publish. Gists are
captured by `scripts/gist-receipts.mjs` (the single gist pipeline). The job needs the repository
secret `RUVNET_GISTS_TOKEN` (a GitHub token with no scopes) — without it, gist listing falls back
to anonymous API calls and is rate-limited.

**Published nightly.** `corpus-nightly-dispatch.yml` (07:17 UTC) dispatches
`protected-release.yml mode=corpus`, which signs and promotes a `corpus-sha256-*` release. It is armed
unless the repository variable `CORPUS_NIGHTLY` is exactly `off` (the owner's kill switch; flipping it
needs no code release) and it stands down (green, not failed) until an approved runtime resolves. A
night whose upstream inputs are unchanged since the newest generation ends `no-change` and publishes
nothing. `corpus-watchdog.yml` (17:17 UTC) turns red, and pages through `ntfy-alerts`, when no night has
ended `published` or `no-change` in 48 hours, so a silent stand-down cannot go unnoticed.
The approved runtime is never committed: `node scripts/approved-runtime.mjs --resolve` takes the newest
`vX.Y.Z` release only, requires its signed `public-verification-aggregate.json` to verify against
`keys/ruvnet-brain-signing.pub.pem`, and rebuilds the runtime pin from that release's own zip
(ADR-0091 D3). It never falls back to an older release: promoting an older runtime over the live code
release breaks fresh installs. No aggregate yet = the nightly stands down (exit 3); an aggregate that
does not verify = a loud failure. The corpus is built at that release's source commit (`main` may be ahead of it), its
executables are the install-verified ones byte for byte, and if a newer code release appears before the
corpus publishes, the night ends `superseded` (a warning, not a failure). Never commit `data/approved-runtime.json`; `single-source:check`
C1 fails if one appears.
**Releasing code that carries the newest corpus (ADR-0091 D6) — three rules learned the hard way (4.3.37).**
1. *Stamp the census before you push.* `release-qe` requires the committed claim surfaces (README, `explainer/*`)
   to state the candidate KB's exact chunk and public-store counts. Assemble the candidate the way `release-qe`
   does (`scripts/corpus-next-seed.mjs --require-coverage`, then `scripts/code-release-corpus.mjs assemble`, ~1
   minute locally), run `RUVNET_BRAIN_KB=<dist/ruvnet-brain> node scripts/sync-census.mjs`, commit the four files.
   Set the repository variable `CORPUS_NIGHTLY=off` for the release window: a nightly that publishes generation
   G+1 mid-release invalidates the stamp (and `release.mjs` refuses to ship after G+1); turn it back on once the
   release is install-verified.
2. *The fixture is frozen; identity is by content.* `data/retrieval-query-evidence.json` pins each expected
   passage by `digest(row)` including the row's build-dependent `id`; its digest is what `corpus-next-seed`
   judges a generation's recall report against, so editing it orphans every published generation. Content
   identity comes from `data/retrieval-passage-content-digests.json` (`scripts/retrieval-passage-identity.mjs`),
   derived mechanically by `scripts/derive-passage-content-map.mjs` from a corpus built with ordinal ids and bound
   to the fixture bytes by a test. Re-derive it if the fixture ever changes.
3. *The release canary proves integrity, not corpus quality.* It samples ~10% of the fixture stores and asks the
   real installed search for them (recall@10 ≥ 0.98 of the sample). With the generation's own repo-recall report
   (`--baseline-recall`, bound to the exact archive and fixture) it samples only stores that report retrieved, so
   it detects a packaging, index, model or runtime break; stores the generation missed, and stores whose sealed
   passage upstream has since rewritten, are named in the log and never hidden. Whole-corpus quality is the recall
   report's number (Hit@5 was 162/182 = 89.0% on 2026-09-29 against the owner's ≥98% target) and belongs to
   retrieval work, not to a gate edit.

**Local ingestion is for development.** `node scripts/ingest-repo.mjs --name <repo> [--org <org>]`
makes a repo searchable on *this* machine immediately. It never reaches users; a repo reaches users
by being in scope of the CI build above. `ingest-repo.mjs` itself now stamps
`updateManaged:false` + `origin:'local-ingest'` into the store's own `SOURCE.json` entry, via
`scripts/private-overlay.mjs`'s writer (`--from` pointed at the same root the bytes already landed
in, which degenerates the writer to registry-stamping only) — so a repo pulled in this way survives
the updater exactly like a genuinely private store, instead of reading as an ordinary public store
that the next `--apply` silently deletes because it is absent from the incoming bundle. It also adds
the store to `kb/PRIVATE-STORES.json`'s fence (required for that stamp — see below) and, in the same
pass, retroactively re-stamps any OTHER name `kb/local-ingests.json`'s own recipe ledger already
recorded but that predates this fix. Private stores that arrive as pre-built sidecars are still
installed the same way: `npm run private-overlay -- --root <kbDir> --from <dir> --store <name>`.
`scripts/self-update.mjs` / `scripts/nightly-wrapper.sh` are manual author diagnostics in a clean
linked worktree; they never publish.

**How a user's machine updates.** `npx ruvnet-brain --update` runs the signed updater
(`kb/forge-update.mjs --apply`): it verifies the bundle signature and preserves private/local-ingest
stores through `restorePrivateFilesIntoCandidate` — the ONE place production code copies a private
overlay onto a candidate tree, shared by the normal update path and the authenticated staged-recovery
rail (`applyVerifiedStagedRelease`, `--staged-release`) a failed normal update falls back to for a
private-overlay install rather than the unconditional fresh reinstall that used to refuse outright on
one. Currency is ONE recorded verdict (`kb/forge-update.mjs`'s `currencyVerdict()`): CURRENT (nothing
to do), UPDATE_AVAILABLE (a genuinely newer code or corpus release), UNKNOWN (no verifiable ordering
key — apply is allowed, never blocked, never claimed current; today's pre-generation-stamp installs
read this way), or REFUSED (rollback protection — the offered corpus generation is strictly OLDER
than the one installed; no download, live untouched, clean exit). `--check`, `--apply`,
`bin/install.mjs`'s update path, and the SessionStart banner's install-alarm all read this SAME
recorded verdict rather than each re-deriving their own comparison. Schedule it with
`npx ruvnet-brain --enable-nightly` (launchd, cron or Task Scheduler — the same command on every OS).
Machines managed by agentic-kit are updated by `ak sync` instead, which disables the Brain's own
scheduler on purpose; do not run both. `--host-sync-only` repairs host wiring and **never** updates
knowledge — do not use it as an update command.

**Provenance (one ledger, one projection).** `kb/RVF-GENERATIONS.json` is the one per-store
provenance record; `kb/SOURCE.json` is generated as a projection of it, never written
independently. Before this, two incompatible "schemaVersion 2" ledger shapes existed side by
side: **Schema A** (`scripts/rvf-generation.mjs`'s own pre-existing shape — no `kind`, no
`sourceSnapshot`) and **Schema B** (`scripts/build-bundle.mjs`'s release-time `projectStoreViews`
shape — `kind` + `sourceSnapshot`, already required by `plugin/scripts/coverage-integrity.mjs`'s
release validation). Schema B was picked as canonical (it was already load-bearing for release
validation); `scripts/rvf-generation.mjs` now emits it directly
(`RUNTIME_LEDGER_KIND = 'ruvnet-brain-runtime-generation-ledger'`, `sourceSnapshot` carried
forward or `null` until a release stamps it for real). `scripts/rvf-generation.mjs`'s
`projectSourceStore(name, generation, updater)` is the one place identity fields
(`sourceRepo`/`sourceCommit`/`sourceDescribe`/`builtUtc`) are read FROM the ledger; all four
SOURCE.json writers (`kb/forge-build.mjs`, `kb/forge-refresh.mjs`, `scripts/corpus-reconcile.mjs`,
`scripts/private-overlay.mjs`) call it rather than restating those facts as their own object
literals. `tests/unit/one-source-projection.test.mjs` enforces this by census (grep) and by an
exact ledger-to-SOURCE.json equality proof. The old one-shot migration
`scripts/stamp-existing-rvf-generations.mjs` went dead as a result and was deleted.

## Hooks (what runs automatically)

Project-level hooks are empty. The installed plugin registers exactly the hooks in
`plugin/hooks/hooks.json` (Codex: `plugin/hooks/codex-hooks.json`), all dispatched through
`plugin/scripts/hook-shim.mjs`: SessionStart restore; UserPromptSubmit grounding + advisories;
PreToolUse `decision-gate` on file writes (the only hook that may refuse, for rUv-product code
without a fresh `search_ruvnet`, or — in this checkout — a new code file or large new export that
duplicates existing code: refused once per path per session, allowed by a header line
`// DISTINCT-FROM: <path> — <reason>`, `RUVNET_DUPLICATE_GATE=off` disables it); PostToolUse grounding stamp; Stop continuation and grounding
check; snapshot capture on Stop/PreCompact/SessionEnd. The Stop grounding check (`grounding-turn-gate`)
also asks for ONE correction when the prompt asked what a tool or platform can do (or for an
architecture) and the final answer asserts a capability without a relevant source read this turn —
a file, command, `search_ruvnet` hit or raw page, read after any small-model WebFetch summary about the
same subject (`node scripts/grounding-turn-replay.mjs` measures it on real transcripts; ADR-0030 gates #2/#3
are shadow-logged only). The Stop continuation body also asks for ONE
correction when a final answer claims work is done without a check run after the last change this
turn, a named check, and a NOT-verified disclosure, and it records first-person promises ("I'll do X
next") in the project's work ledger until a later evidenced completion claim closes them (Claude
only; `npm run completion-claim:replay` measures both on real transcripts). SessionStart prints one
`[RuvNet Brain — KNOWLEDGE …]` line when the installed knowledge cannot be proven current (older than
48h, or the latest refresh receipt FAILED) and names the fix. The same snapshot capture records each
turn's outcome at Stop (final assistant text, files changed, command descriptions — never user
text) to AgentDB namespace `turns` — the project's `.swarm/memory.db` if it exists, otherwise
`~/.claude/global-memory/.swarm/memory.db`; `.swarm` is never created in a repository — and at
SessionEnd/PreCompact runs `ruflo memory distill run` on that db so the records become patterns.
Writes run in a detached worker; `RUVNET_TURN_CAPTURE=off` disables it. `npm run hooks:check` and
`npm run wired:check` fail on any hook or module that is registered-but-missing or present-but-unwired.

## Tests

```bash
npm test                        # plugin battery over real JSON-RPC
npx vitest run                  # unit + integration
npm run qa:release              # release-scope checks
npm run single-source:check     # one version of every rule and fact
npm run wired:check             # every module has a caller or a stated reason
```

## The fail-closed private fence

`kb/PRIVATE-STORES.json` names stores built from private source; `scripts/build-bundle.mjs` drops
them and **aborts** if the file is missing (unless `ALLOW_NO_PRIVATE_FENCE=1`), unparseable, or lacks
a `privateStores` array. When you ingest a private repo, add its store name in the same change.

## Principles

Every design decision is governed by [`docs/PRINCIPLES.md`](docs/PRINCIPLES.md). A change that
contradicts a principle is wrong, and the contradiction is the finding.
