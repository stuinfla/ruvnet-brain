# Contributing to RuvNet Brain — the one rulebook

Updated: 2026-10-01
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
| Release code | Preflight → fast-forward `main` → dispatch `protected-release.yml mode=code` → the workflow's machine gates carry it across `Production – ruvnet-brain` (no human approval step) | Terminal receipt `install-verified` on Linux, macOS, Windows; npm `latest` = GitHub `releases/latest` = `main` |
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
5. There is no approval step. The `Production – ruvnet-brain` environment has no reviewer; it is a scoping
   boundary (it alone holds `NPM_TOKEN`, deployable from protected branches only, admins cannot bypass). The
   `publish` job starts by itself once the machine gates below pass, and the dispatching agent watches the run
   to its terminal conclusion (every job, not just the first green one). Nobody is asked to open GitHub.
6. Done means the terminal `install-verified` receipt: all public OS × host combinations verified.
   Anything short of that is "published, not verified". Recovery/abandon rails:
   `recover-public-verification.yml`, `abandon-public-verification.yml` (manual `repository_dispatch`),
   `npm run release-abort-stale`.

`npm run release:qualify` is the one definition of "qualified"; CI and local checks both use it.

### What replaces a human approval (the machine gates)

Publishing is allowed only when every one of these holds, each enforced in code, none waived by a person:

- **Exact candidate.** `protected-release.yml` `identity`: `GITHUB_SHA` = `origin/main` = the dispatched
  `candidate_sha`, `package.json` version = the dispatched version, clean tree. `publish` re-asserts
  `HEAD` = `origin/main` = the verified SHA before it touches anything.
- **Preflight green on that exact SHA.** `verified-candidate` accepts only a successful
  `release-candidate-preflight` push run for that SHA on a `release/*` branch of this repository, with exactly
  one authentic artifact, then verifies the receipt, payload members and aggregate verdict `PASS`.
- **Zero open `release-blocker` issues.**
- **One sealed payload.** Signed once, never rebuilt; the sole publisher (`scripts/release.mjs --publish`)
  stages npm under a candidate tag and GitHub as non-latest, then promotes both, and
  restores the prior npm `latest` if promotion fails (`scripts/release-transaction-provider.mjs`).
- **Install verification.** Linux, macOS and Windows install the public bytes; only then is
  `install-verified` signed. Anything short of it is "published, not verified" and goes to the recovery rails.
  The corpus nightly refuses to run on a release that is not `install-verified`.

What this gives up, stated once: anyone with write access who can dispatch on protected `main` (today the
release agent and the owner's account) can publish to npm without a second person confirming it. The control is
that only an already-preflighted head of `main` can be published, and `main` moves only by fast-forward through
required checks that admins cannot bypass. Strengthening a gate is a code change to the workflow, never a person
in the loop.

The same holds for the two recovery rails. `recover-public-verification.yml` and `abandon-public-verification.yml`
are started by `repository_dispatch`, which any token with write access can send, and both bind
`Production – ruvnet-brain` (the environment holding `RUVNET_SIGNING_KEY` and `NPM_TOKEN`) with no human pause.
Recover re-runs public verification on an already-published release and, if all three OS lanes pass, signs its
`install-verified` aggregate — the receipt that arms the corpus nightly. Abandon records a published release as
not verified. Neither can publish new bytes: both act only on a release `protected-release.yml` already sealed
and published from a preflighted head of `main`.

**Search deadlines in host verification.** The retrieval canaries each lane runs take a per-OS first-pass
bound, `canarySearchDeadlineMs()` in `scripts/host-install-matrix.mjs`: the worst measured first-pass query on
that OS's GitHub runner (`CANARY_WORST_FIRST_PASS_MS`, with its run IDs beside it) times 1.5, never below
`RELEASE_SEARCH_DEADLINE_MS`. Today only macOS rises above the floor. Changing a bound means changing that
evidence. This bounds a small CI runner's cold search so the gate fails on a broken search, not on a slow VM; it
is **not** a product latency target. How long a customer's first answer takes on a small Mac is a separate,
open 4.5 improvement, measured on its own and never loosened through this constant. Lanes keep one warm search
worker; a case that times out fails alone and the next case gets a fresh, re-warmed worker
(`createRestartingMcpSession`), and the three installed doctors run one at a time (`runHostDoctors`).

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
scheduler on purpose; do not run both. That ownership (`kit.json` `ruvnetBrain:true`) is honoured only
while an update is proven within 36h (a successful refresh receipt or a CURRENT `--check` verdict); past
that, the SessionStart self-heal runs the Brain's own update anyway, so no machine exceeds 48h. `--host-sync-only` repairs host wiring and **never** updates
knowledge — do not use it as an update command.

**Putting the Brain on another disk.** `npx ruvnet-brain --move-brain <dir>` (for example
`/Volumes/SanDisk/ruvnet-brain`) checks the target has room, copies the whole Brain there, proves the copy
byte-identical, and leaves `~/.cache/ruvnet-brain` as a symlink to it; `--move-brain --back` brings it home, and
moving again to a new directory works the same way. That symlink is the one supported layout: every reader, hook,
the MCP server and the nightly keep using the default path, so nothing else is configured (an environment
variable would not reach GUI-launched hosts or launchd). If that disk is unplugged, install, `--update`,
`--doctor`, SessionStart and `search_ruvnet` each say in one line that the Brain's disk is not mounted, and
nothing re-creates a brain in `~/.cache` over the link. The knowledge root is always
`realpath(~/.cache/ruvnet-brain/kb)`. Every install and update also measures free space first and refuses,
naming the exact shortfall, rather than running out half-way.

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

## Footprint guarantees (what a user's machine holds — ADR-098)

**One knowledge base, current, in use, nothing building up.** `plugin/scripts/brain-footprint.mjs` is the
one classifier of everything the Brain owns: the brain home (`RUVNET_BRAIN_HOME`, symlinks resolved), KB
siblings (`kb.bak-*`, `kb.install-preserved-*`, `kb.install-prior-*`, `kb.pre-update-*`, `kb.next-/rollback-/
failed-*`, `*-quarantine-*`), the Claude (`CLAUDE_CONFIG_DIR`) and Codex (`CODEX_HOME`) plugin caches, npm
`_npx` copies of `ruvnet-brain`, ruflo scratch, logs and lifecycle receipts. Each is **must-exist**,
**may-exist (bounded)**, **must-not-exist**, or **unowned** (reported, never removed). Add a new on-disk
artifact only together with its classification there, or `--doctor` will report it as cruft.

- **Removal is proof-gated.** A KB copy is deleted only when `plugin/scripts/kb-copy-proof.mjs` shows nothing
  in it is unique: every private-store file (fence of live AND copy, plus `updateManaged:false`) byte-identical
  in live; every other file a public release file or installer-written. Anything else keeps the copy and is
  named. Links are never followed; trees of an in-progress storage transaction, a foreign refresh lock, an
  install that is activating (`.kb.install-activation.lock` with a live pid), and live leases are kept; plugin generations go only through `prunePluginGenerations` (lease-aware).
- **Enforced automatically**: after install/forced reinstall (the installer releases its own preserved
  generation once the new one validates), before and after every `--update` (incl. the SessionStart
  knowledge self-heal), and by a detached SessionStart sweep at most every 6h when the name-only scan
  finds cruft. By hand: `npx ruvnet-brain --clean`.
- **Bounds**: ledgers in `LOG_FILES` rotate to `<name>.1` past 2 MiB; `.last-*.log` files are truncated to
  their tail past 512 KiB; one npx installer copy, never older than the current version; lifecycle receipts
  by lifecycle-evidence-v1 (16 MiB). Budget = live KB + models + 512 MiB.
- **Positive confirmation** after every install/update and in `npx ruvnet-brain --doctor`: Software = npm
  latest, Hosts = runtime, Knowledge = exactly one copy, built < 48h, signature verified (bound to the live
  COVERAGE.json), corpus tag; In use = the search worker opened that copy, last answer; Footprint vs budget;
  No cruft. `--doctor` text, `--doctor --json` (the same doctor; JSON on stdout) and the exit code are ONE
  verdict (`doctorVerdict` in `plugin/scripts/brain-confirmation.mjs`): exit 0 iff no ✗ line, counting the
  doctor's own checks too. Structural problems are ✗ (a second KB copy, a signature record that is unreadable
  or does not match the live COVERAGE.json, a worker on another copy, footprint, cruft, install, identity,
  grounding, Codex, nightly, host sync, ruflo); currency is `!` and advisory (Software behind npm latest, a
  host plugin ≠ runtime, Knowledge built ≥ 48h), so a correctly installed older build still passes install
  verification. A MISSING signature record is provenance unknown, not provably broken (an install from a
  local sealed artifact, as the release's install verification does, and older installs never wrote one): it
  is `!` and advisory too (4.5.1). Every ✗ and ! names one command; a missing signature record is written by a
  verified install or update, and `--update` restores it from this machine's receipt of a verified apply of
  the same bytes. SessionStart prints one `[RuvNet Brain — FOOTPRINT …]` line only
  when the footprint is wrong.
- **Proof it holds**: `tests/integration/footprint-three-updates.test.mjs` (real install, forced reinstall,
  three updates, planted cruft, all lines green, and the same run with the sweep cut out goes red);
  `tests/unit/brain-footprint.test.mjs` (classification, safety, BREAK-IT mutants). The corpus canary's
  three-update footprint check is opt-in: `scripts/corpus-canary.mjs --footprint-updates`.

## Hooks (what runs automatically)

Project-level hooks are empty. The installed plugin registers exactly the hooks in
`plugin/hooks/hooks.json` (Codex: `plugin/hooks/codex-hooks.json`), all dispatched through
`plugin/scripts/hook-shim.mjs`: SessionStart restore; UserPromptSubmit grounding + advisories;
PreToolUse `decision-gate` on file writes (the only hook that may refuse, for rUv-product code
without a fresh `search_ruvnet`, or — in this checkout — a new code file or large new export that
duplicates existing code: refused once per path per session, allowed by a header line
`// DISTINCT-FROM: <path> — <reason>`, `RUVNET_DUPLICATE_GATE=off` disables it); PostToolUse grounding stamp; Stop continuation and grounding
check; snapshot capture on Stop/PreCompact/SessionEnd. The Stop grounding check (`grounding-turn-gate`)
asks for a `search_ruvnet` call only when the final answer asserts what a rUv product does, can, cannot,
requires or says (`ruvCapabilityClaims` in `grounding-turn-evidence.mjs`) — a status report, git/CI check
or memory write on a rUv-named prompt is never corrected; when the transcript tail cannot see the turn's
start it falls back to the grounding stamps, never to a silent pass. It
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
Writes run in a detached worker; `RUVNET_TURN_CAPTURE=off` disables it. Where the owner's user-level
`~/.claude/hooks/agentdb-turn-capture.mjs` is registered in `~/.claude/settings.json`, the product defers
Claude turn records to it (one writer per turn; `RUVNET_TURN_CAPTURE=force` keeps both). The same
boundaries also record MATERIAL EVENTS (ADR-100, `continuity-events.mjs` / `continuity-journal.mjs`):
commits and tags from git, test/check/release gate outcomes, agent findings, decisions and lessons
(explicit, or detected and marked non-authoritative), each fsynced to `.swarm/continuity-events-outbox.jsonl`
before a detached drainer stores it (`ruflo memory store --no-upsert --path`, namespace `continuity-events`)
and reads it back by exact key; a refused write (WAL contention) stays pending and is retried at every
boundary, and a stuck one is shown (`AgentDB: recording stuck …`, an advisory `!`) at Stop (Claude, once per
session per condition), at SessionStart and in `--doctor`. No initialized store or no ruflo reads `recording n/a`,
and launches no drainer; a quarantined key or corrupt line is reported for 7 days or until
`continuity-brief.mjs --clear`; failures are one record per event and the outbox is compacted (committed
events leave after 7 days, hard cap 2000 events). SessionStart prints a bounded `[RuvNet Brain — COME UP TO SPEED …]` brief before the progression
restore; everything it quotes from the repository (commit subjects, `.swarm` rows) sits inside a fenced
`PROJECT RECORD` marked as untrusted data, and only lessons recorded with `--record` on this machine (an
ownership ledger outside the repo) are shown as standing rules; `/ruvnet-brain:rnb-brief` (`continuity-brief.mjs --full | --record`) pulls history or records
explicitly. `RUVNET_CONTINUITY_CAPTURE=off` disables event capture. `npm run hooks:check` and
`npm run wired:check` fail on any hook or module that is registered-but-missing or present-but-unwired.

## Tests

```bash
npm test                        # plugin battery over real JSON-RPC
npx vitest run                  # unit + integration
node scripts/full-suite-gate.mjs  # the same run, judged against tests/known-red.json (canonical-qa blocks on it)
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
