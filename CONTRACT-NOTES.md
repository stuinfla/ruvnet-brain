Updated: 2026-11-17 15:20:53 EST | Version 1.3.1
Created: 2026-11-17 01:30:00 EST

# Version 5 walking skeleton: contract notes

This is the walking skeleton of ROADMAP.md A2, built against TARGET-ARCHITECTURE.md (both in
`evals/runs/2026-11-16-knowledge-architecture/app-architecture/` on the architect's branch). This
file records every choice those two documents left open, every deviation from them, and what is not
done. The contract package (`packages/contract/`) is ready to be tagged `contract-v1`; it has not
been tagged.

## Where things are

| Path | What |
|---|---|
| `recipe/RECIPE.json` | the recipe of record, keyword lane only |
| `packages/contract/` | the four schemas (`schemas/*.schema.json`), `validate.mjs`, `verdict.mjs`, `signature.mjs`, `home.mjs`, `constants.mjs` |
| `packages/engine/` | `open`, `search`, `selfTest`, `close`; `lanes/lexical.mjs`; `analyse.mjs` |
| `packages/server/` | `main.mjs` (MCP over stdio), `runner.mjs` (worker thread + deadline), `worker.mjs`, `format.mjs` |
| `packages/health/` | per-process status files, the evidence reader, the line renderer |
| `packages/cli/` | `ruvnet-brain.mjs` (install, update, doctor, status, uninstall, config), `install.mjs`, `updater.mjs`, `mcp-client.mjs` |
| `packages/builder/` | `build.mjs`, `assemble.mjs` |
| `packages/release/` | `release.mjs` (seal and sign) |
| `packages/plugin/claude/` | `.mcp.json`, `launch.mjs`, `hooks/hooks.json`, `health-line.mjs`, `.claude-plugin/plugin.json` |
| `packages/version.json` | the one app version number |
| `tests/acceptance/v5/` | S1 to S14, the harness, the breaks, the fixture repositories, the break runner |

The 4.7 tree is untouched. ROADMAP A1 (remove the 4.7 tree on `v5/rewrite`) has not happened in this
worktree, so the v5 folders sit beside it. Two consequences: the tests live in `tests/acceptance/v5/`
(4.7's `vitest.config.mjs` includes `tests/acceptance/*.test.mjs`, which does not match a subfolder) and
should move up to `tests/acceptance/` once the 4.7 tree is gone; and the root `package.json` is still
4.7's, so the skeleton has no npm scripts (it needs none: Node built-ins only, run with `node`).

## Choices made where the documents are silent

1. **Brain home.** Default `~/.cache/ruvnet-brain-5` (the soak location in ROADMAP B1), overridden by
   `RUVNET_BRAIN5_HOME`. Not `RUVNET_BRAIN_HOME`, which 4.7 reads, so a v5 test can never write into a
   live 4.7 home.
2. **`current.json`.** `{ schema, version, app, pack, releaseNumber, previous: { app, pack, releaseNumber } | null, switchedAt }`.
   The release number is in the pointer so an older release can be refused without reading anything else.
3. **What an installed app holds.** `app/<version>/` contains `contract`, `engine`, `server`, `health`,
   `cli` and `plugin`: the server needs the updater's one entry point (in `cli`), and the installer's
   post-switch check starts the app's own launcher.
4. **`release.json`.** Lists every app file and every pack file with size and SHA-256, plus the pack
   generation, release number and smallest shim version. Ed25519 over canonical JSON (keys sorted,
   `signature` removed). `keyId` = first 16 hex characters of SHA-256 of the public key (SPKI DER).
   The installer copies only listed files and rejects a listed path that escapes the folder.
5. **Trusted key.** `packages/contract/keys/release-public.pem`. None is committed: ROADMAP A1 step 0.4
   adds the real public key. Without it the installer refuses everything with one sentence. Tests
   generate an Ed25519 pair at test time and write the public half into their scratch copy. There is
   no environment variable or flag that replaces the key or skips the check.
6. **Status file** (`state/status/<pid>.json`, write-then-rename): `{ pid, startedAt, heartbeatAt, app, pack, knowledgeDate, lanes, probe: { ok, at, failingSince, error, results } | null, lastSearch: { ok, at, safeMode, reason } | null }`.
   The server removes its own file when stdin closes.
7. **Verdict rules** (`packages/contract/verdict.mjs`), worst state over live servers:
   no `current.json` is `not-installed`; no live server is `down` labelled NOT RUNNING; heartbeat older
   than 180 s, or self-test not yet finished, is `unknown`; failed probe is `down`; a lane unavailable
   or the last search answered in safe mode is `degraded`; otherwise `ok`. A rollback recorded in the
   last 24 hours turns `ok` into `degraded` with the reason "update to X failed its check after the
   switch and was rolled back".
8. **Doctor** reads the same evidence and calls the same function; exit 0 only for `ok`. It does not
   start a server of its own (that would be a second definition of healthy, defect C9), so with no
   session open it reports NOT RUNNING and exits 1. The installer is what starts the real server and
   probes through it.
9. **Probes.** The builder writes one probe per repository: the first file (sorted) with at least three
   words whose analysed token (the engine's analyser) is found in no other file; the question is those
   words as written, lower-cased (not their stems: stemming a stem again can change it); the expected
   file is that file. Every probe is run against the pack at build time and the build fails if one
   misses. `selfTest` passes when every probe's file is in its answer.
10. **Probe interval.** Each periodic probe starts a fresh worker, so the index is opened again and
    damage on disk is seen. Default 30 minutes.
11. **Timings.** In `state/config.json` with defaults in `contract/constants.mjs`: `heartbeatMs` 60 s,
    `staleAfterMs` 180 s, `probeIntervalMs` 30 min, `updateIntervalMs` 4 h, `rollbackNoticeMs` 24 h,
    `autoUpdate` true, `updateUrl` null. The search deadline is the recipe's `deadlineMs` (10 s).
12. **Result text.** Line 1 is the header (knowledge date, recipe id, pack generation, lanes). Line 2 is
    always either `MODE · normal` or `SAFE MODE · keyword only · <reason>`, so safe mode is
    machine-checkable. Each item: `N. repo/path · lines A-B · commit C · standing S · date D · sha256 H`,
    then, for a flagged item only, `FLAGGED · hostile · ...`, then the excerpt inside
    `<<<passage-<random>` and `passage-<random>>>`. An empty section prints `NAME (0) · no match: <reason>`.
    After the sections: the fence note, then `NOTE · <result.closing>` (the authority order). One text
    block, no `structuredContent`. The engine builds each section (first `maxItems` distinct files, each
    excerpt a window of that file's passages up to the section's `itemChars`, the section within
    `budgetChars`, all excerpts within `result.capChars`); the formatter then holds the rendered text to
    the same budgets and cap (trimming excerpts evenly at a line break) and marks every cut excerpt
    `… [trimmed N characters]`, whether the engine or the formatter cut it. The same content hash is
    never sent twice. `k` is accepted and answered with a note.
13. **Standing.** Written per row by the builder: a passage by `standing.byKind[kind]` (an ADR is
    `decided`), else docs (`standing.docExtensions`) `claimed` and code `implemented`; a history item by
    `units.history.standing[kind]`. The engine uses the row's standing and falls back to the same rules.
    Date and commit are the source's, from its `.source.json`.
14. **Chunker.** The symbol chunker (`units.passage.symbolChunker`, a port of the measured one): structural
    units grouped while small, at most `maxTokens` estimated tokens per passage, inside the outer bounds
    `units.passage.chunker` (`lines` v1: `maxLines`, `maxChars`, which every passage also respects). The
    stored text is the cited source lines only; header, label line and repeated signature rows go to the
    indexed subject. Blank lines between passages belong to no passage; an excerpt window spanning two
    passages gives them back as empty lines, so the excerpt is exactly its cited line range (a
    whitespace-only line comes back empty). Ranking: bm25, then repository, path, first line, row id.
15. **Engine `close`.** Added as a fourth call so file handles are released (Windows cannot delete an
    open file). `open` checks every listed file's size, not its hash: hashes are checked once, at
    install, by streaming.
16. **Search calls are serialized** in the server (one at a time). WP 2 adds concurrency.
17. **Rollback** writes back the previous `current.json` byte for byte and removes the newly staged app
    and pack. `state/update.json` records `installed`, `refused` (stage `pre-switch-probes`) or
    `rolled-back` (stage `post-switch`). After a good install exactly one earlier generation is kept.
18. **Uninstall** removes `current.json`, `app/`, `packs/`, `state/`; keeps `private/` unless
    `--purge-private`; then lists the home folder again and prints anything left (exit 1 if so).
19. **Fixture sources** are plain folders with `.source.json` `{ repo, commit, date }`, because nested
    git repositories cannot be committed as fixtures.

## Deviations from the documents, and why

1. **The automatic update only checks.** Architecture 2.3 says the server updates itself in a worker.
   Here the timer runs in the main thread (skipped while a search runs), fetches `release.json` from
   `updateUrl`, and records `state/update-check.json`; applying is `ruvnet-brain update --from`. Enough
   for S13 (the off-switch); downloading and applying is WP 4.
2. **Install is from a folder only.** No download, resume, disk-space check, install lock, `--plan` or
   host registration (nothing is written to `~/.claude`). The shim's files exist; registering them with
   a host is WP 7. Tests run the exact hook command string and the launcher the host would run.
3. **The plugin folder imports `../../contract` and `../../health`.** Packaging the shim as a standalone
   plugin (with its own copy of those modules and the public key) is WP 7.
4. **Builder** fetches nothing over the network (history pages are read from a recorded folder; CI supplies
   the fetch), and code is cut by a line/brace heuristic, not the tree-sitter grammars the measured run used.
5. **Release** seals and signs only; no publish, promote, or three-system canary (WP 6).
6. **Engine** has no `read_ruvnet` tool (so no MORE section), and no semantic lane. The private-pack scope
   check is in the engine (`options.project`); the server does not pass a project yet (WP 2).
7. **No generated `docs/RECIPE.md`, no line-budget check, no CI workflow.** Workflows and budgets belong
   to ROADMAP A1 and the integration owner. Measured lines of `.mjs` per package: contract 262, engine
   156, server 339, health 70, cli 297, builder 199, release 59, plugin 49 (all under budget).
8. **A second version number.** `packages/plugin/claude/.claude-plugin/plugin.json` carries
   `5.0.0-skeleton.1` beside `packages/version.json`, because the host reads the plugin's own file. It
   should be generated from `version.json` when the shim is packaged (WP 7).
9. **`minShim` is signed but not enforced** by the launcher or the installer yet (WP 4, WP 7).
10. **rUv-first check (ROADMAP A0.7).** The keyword lane is `node:sqlite` FTS5 as the architecture
   decides; WP 1 ported the measured Lucene-style analyser (Porter stems, identifier split) and the
   development-score test reproduces the measured 40 of 76 through `engine.search`.

## Wave 1 integration (work packages 1 and 5)

**One pack format.** The builder's unit store (`packages/builder/store.mjs`): `lexical.db` (role
`lexical-db`) and, when any source has a history export, `history.db` (role `history-db`), each a table
`units` and a contentless `fts5(subject, body)` holding the tokens of the engine's `analyse()`, plus
`manifest.json` (role `build-manifest`). The engine's keyword lane reads exactly this. The skeleton's
raw-text `units` + `fts(body)` shape is gone. One alias stays: the retrieval run's measured index has the
same columns under table `p` (row id `rid`); the lane reads it through the same query because the
development-score test (40 of 76, reproduced here) opens that 1.4 GB index in place and cannot be
rebuilt per test run. Nothing records in the store which analyser filled it: the pack's own
`RECIPE.json` (bound by `recipeHash`) is that record.

**One analyser.** `lucene-porter-ident` in `packages/engine/analyse.mjs` (the skeleton's `unicode61-lower`
is removed). The builder's store writer, its probes and its settings check all import it; the builder's
own identifier splitter is removed (`analyser.splitIdentifiers` replaces the builder's
`analyser.identifierSplit`). `fts5Tokenizer` is `unicode61`, as the measured index used.

**History.** The history lane is optional. A pack that does not list a `history-db` file has no history:
the lane is not opened and not reported (so health stays OK) and HISTORY says `this pack has no history`.
A pack that lists the file but has lost it reports the lane unavailable (DEGRADED; the installer refuses
it after the switch). An item with no line range (a history item) is quoted with its header first.

**Hostile text: a `flag` field, not a standing.** The builder flags a passage matching a recipe hostile
pattern (`flag = 'hostile'`); the engine carries `flag` on the result item (set when any passage in the
excerpt is flagged) and the server prints a `FLAGGED` line before it. Standing stays what the source is.

**Contract changes** (each the smallest that makes the reconciled system valid; all additive, no
version bump, `validate.mjs` unchanged):

| Schema | Change | Why |
|---|---|---|
| recipe | `lanes[]`: `role`, `weights.{subject,body}`, `depth`, `unit` | the engine reads them; a typo must be refused, not ignored |
| recipe | `sections[]`: `itemChars` (integer) | the engine's excerpt window size |
| recipe | `analyser`: `name` typed, `minNumberLength`, `splitIdentifiers`, `stemmer` (`porter`/`none`) | the shared analyser's settings |
| recipe | `standing.byKind` (object) | per-kind standing (`adr` is `decided`) |
| pack | `access` (`public`/`private`), `projects` (list) | the engine's private-pack scope; an unknown `access` value would have been read as public |
| pack | `counts.history` | the builder counts history units |
| result | `closing` (string), `meta` (object) | the authority line the server prints; lanes run and time |
| result | item `flag` (`hostile` or null), item `trimmed` | hostile text carried to the caller; an engine-cut excerpt is marked |

Requests not applied, and why: the chunker name enum stays `lines` (the outer bounds keep that name; the
symbol chunker has its own block); `symbolChunker`, `units.history`, `screen` and `carry` get no schema
(the builder's `settings.mjs` validates every one of them and refuses a build with one sentence; the
engine never reads them); no history-probe key in `PROBES.json` (it has no schema; probes stay one per
repository over passages); `hostile` is not a standing value (see above).

**Recipe** `r2-wave1`: the builder's settings, the measured analyser, two lanes (lexical required,
history optional; weights 1/1, depth 100), FILES 5 items × 8,000 characters (budget 20,000 / 44,000),
HISTORY 3 × 2,000 (4,000 / 6,000), result cap 24,000 / 60,000.

**Tests.** `wave1-end-to-end.test.mjs` (builder pack → engine in separate processes → installed server)
with six `// wave1` breaks. `wp1-helpers.writePack` now writes fixture packs with the builder's own
`writeStore`, and the pilot pack uses the shipped recipe's analyser, lane and FILES section, so wp1 tests
exercise the shipped format and recipe. `wp1-optional-lane` now expects `this pack has no history` for a
pack that does not list the file. `wp5-history` looks words up as the analyser cuts them. One break
runner: `run-breaks.mjs` runs `s*`, `wp<N>-*` and `wave<N>-*` tests (`wp5-run-breaks.mjs` is folded in).
Known limit seen in the cap test: the lane's depth of 100 candidate passages can be filled by fewer than
five files when one file has very many matching passages. The S5 break now removes the engine's trimming
as well as the formatter's (both hold the budgets since wave 1).

**Installer (work package 4), merged after wave 1** unchanged: `packages/cli/*`, `wp4-*` tests, the
`// wp4` breaks. Its tests run in the same break-runner loop (a break whose `test` is `wp4-01` covers
`wp4-01-*.test.mjs`). No contract change. Carried open from that package: `wp4-12` is a todo (a bare
`node` in the hook command can run a planted `node` when PATH has an empty entry; an absolute launcher
is the host-shim package's fix); downloads refuse redirects; no tests yet for the minShim refusal,
https-only, clean, or two installs at once.

## Wave 2 integration (work packages 2, 3, 6 and 7)

Merged on `v5/wave2-integration` from `3dff2bc7` (`contract-v1`): the server (WP 2: worker pool and
queue, helper lanes, `read_ruvnet`, the fence, private packs by project, extra terms, the delivery
ceiling), health (WP 3: one `assess()` for the hook, `status`, `doctor` and the owner page), the release
rail (WP 6: seal, verify, stage, probe, promote, nightly, four inert workflows) and the host shims
(WP 7: the absolute launcher `bin/rb5`/`rb5.cmd`, `plugin/install.mjs`).

**Contract 1.1** (`CONTRACT_VERSION` `1` → `'1.1'`). Every change is additive; a pack or release built
at `contract-v1` still opens, passes its probes, searches and formats (`wave2-contract`, against the
committed fixture `fixtures/contract-v1-pack`, built by the contract-v1 builder and recipe).

| Where | Change | Why |
|---|---|---|
| recipe | `query.extraTerms` (`append`/`off`; absent = off) | WP 2: the extra-terms merge is a recipe switch; a typo is refused, not read as off |
| recipe | `lanes[].process` (`inline`/`helper`) | WP 2: a lane may run in a helper process |
| recipe | `result.delivery` `{ maxChars ≤ 44000, maxTokens ≤ 20000 }`, both optional | WP 2 + item 1: the engine holds a result to the recipe's own delivery numbers; above the host's numbers is refused |
| new | `schemas/gate-result.schema.json` | WP 6: what promote accepts from the answer gate (checked in `checkGate` after its specific refusals) |
| new | `schemas/probe-receipt.schema.json` | WP 6: what the install-and-probe step writes (checked by `probe.mjs`; a receipt that fails it is never `ok`) |
| new | `contract/delivery.mjs`: `DELIVERY`, `ceilingOf`, `estimateTokens` | one definition of the host's ceiling, used by the engine and the server (`format.mjs` re-exports them) |
| `current.json` | `minShim` (the release's) | WP 7: the shim can see what the active app needs; no schema file exists for `current.json` |
| `DEFAULTS` | `pageTopic: null` | WP 3: the owner page is off unless `state/config.json` names a topic |

**Superseded:** architecture section 2.2 (host starts `node` from PATH, no Node path written anywhere)
is superseded by the absolute launcher; the recorded path is re-validated on every start. The host
runs `<home>/shim/plugin/claude/bin/rb5` by absolute path; it reads the Node recorded at install
(`shim/node-runtime`), checks it again (absolute, executable, outside the current project, at least
the minimum version), then falls back to `node` in absolute PATH folders only.

**Engine requests applied.** `engine.read(h, repo, file)` returns a file's passages (the server's
`read_ruvnet` no longer reaches into lane handles); the private-pack project check compares real paths
(links resolved; only the link is read, never a project file).

**Delivery cap.** Recipe `r3-wave2`: result cap 24,000 / 44,000, FILES full budget 36,000 (was 44,000),
`delivery` 44,000 characters / 20,000 tokens. The engine trims to `result.delivery` when the recipe names
it (`holdToDelivery`); the server's guard stays the last step for every result (a contract-v1 recipe
names none, so wp2-08 tests the guard with such a recipe). S5 and the wave 1 cap test assert 44,000;
their breaks now also remove the engine's delivery trim and the server's guard.

**Trimmed citations.** A trimmed excerpt cites the sha256 of the text shown (the trim note excluded),
ends with ` · trimmed N characters`, and when the server shortened an excerpt that maps line for line
onto the file, cites the lines shown and adds `(passage lines S-E)`. An excerpt that does not map line
for line keeps its range and says how much was trimmed (`wave2-delivery`).

**Host registration is opt-in until cutover.** `install` and `update` refresh the shim (`<home>/shim`)
after every committed install, and register hosts only with `--register-hosts`; the files registered are
recorded in `state/hosts.json`, and `uninstall` removes exactly those entries, then the shim. `--plan`
lists `shim/**` (and `state/hosts.json` plus each host file when the flag is given). The automatic
update inside the server refreshes the shim too (review F11, `cli/update-worker.mjs`); a shim that cannot be
refreshed then leaves the previous one in place and says so in `state/update-check.json`.

**Test guard.** Every harness imports `test-env.mjs` first: HOME, CLAUDE_CONFIG_DIR, CODEX_HOME,
RUVNET_BRAIN5_HOME and the XDG folders point at a temporary folder, and `RUVNET_BRAIN5_TEST=1`. Under
that marker `refuseProtected` in `plugin/install.mjs` refuses, before reading or writing anything, a host
file or brain home under the real user's home (from the account database, not `$HOME`) or under an extra
root named in `RUVNET_BRAIN5_PROTECTED_HOME` (it can only add roots; `wp7-08` aims its checks there, so
its breaks write only to a temporary folder).

**Reconciled between builders.** The hook file runs `runtime.mjs` then `health/hook.mjs`; S12's break
moved with it, and S11's break targets `health/doctor.mjs` (wp3-05a/c remain). The rail accepted only a
shim `plugin.json` carrying the app version; WP 7 ships none (the installer stamps it), so the rail now
refuses only a different number. `wp4-05` treats a `**` plan entry as a folder replaced whole. The server
heartbeat timer (not every status save) calls `pageCheck`. `shipped-files.json` regenerated with
`rail.mjs shipped-files --write`. The breaks are split into `breaks.mjs`, `breaks-wp.mjs` (WP 2, 3, 6, 7)
and `breaks-wave2.mjs`.

**Tests added.** `wp7-08-test-guard` (guard, opt-in, uninstall restores host files), `wave2-delivery`,
`wave2-contract`, `wave2-end-to-end` (build → seal → install with hosts → registered launcher → search →
one verdict in three states with the owner page → update → rollback → uninstall), each break-tested.

## Wave 3 integration (work packages 8, 9, 10, 11 and the repo-gate repair)

Merged on `v5/wave3-integration` from `e529627e`: the answer gate (WP 8: `packages/release/gate/`), the
migration and the brake (WP 9: `packages/migrate/`), the optional write guard (WP 10: `packages/guard/`),
the generated documents (WP 11: `packages/docs/`, `docs/RECIPE.md`, `docs/v5/REFERENCE.md`,
`docs/v5/PARITY.md`) and the repair of two repository unit tests (the contract-v1 fixture's
`lexical.db` is committed as `lexical.db.fixture`; `tests/known-red.json` registers the v5 acceptance
suite by its glob, so every `tests/acceptance/v5/*.test.mjs`, the wave 3 ones included, is accounted for).

**Contract 1.2** (`CONTRACT_VERSION` `'1.1'` → `'1.2'`). Every change is additive; the contract-v1
fixture pack still opens, passes its probes, searches and formats (`wave2-contract`).

| Where | Change | Why |
|---|---|---|
| `schemas/gate-result.schema.json` | optional `questionSet`, `layers`, `reasons`, `resultSha256` | WP 8 writes them; listed so a typo in them is refused, while a wave 2 gate result without them stays valid |
| new | `schemas/answer-gate-result.schema.json` | WP 8: the layer 2 result the maintainer produces; `verify.mjs` checks its shape after its own binding checks |
| `DEFAULTS` | `guard: false` | WP 10: the write guard is off unless the user's configuration turns it on |
| (none) | no `migrate` field | the migration keeps its record in `state/migration.json` and needs no contract field now |

**Fixes found by the builders, each with its test and breaks.**
- (a) `APP_PACKAGES` now holds `guard` and `migrate` (and `shipped-files.json` was regenerated with
  `rail.mjs shipped-files --write`), so both commands run from an installed app (`wave3-01-app-commands`).
- (b) Version 5's search server is registered as **`ruvnet-brain-5`** in every host for the side-by-side
  period (4.7 keeps `ruvnet-brain`; cutover renames it). A host whose server entry is refused (another
  program holds `ruvnet-brain-5`) gets no hook, skill or command, is listed under `unserved` in
  `state/hosts.json`, and the one verdict is DEGRADED (cause `host-unserved`, fix `ruvnet-brain doctor`,
  the reason naming the host and the file) while it is, never OK (`wave3-02-side-by-side`; `wp7-05` and
  `wp9-02` updated to the new name).
- (c) Uninstall is byte-exact. Registration keeps a pre-registration copy of each shared host file
  (settings.json, .claude.json, config.toml, hooks.json) with its sha256 and the sha256 of what it
  wrote, in `state/host-backup/` (mode 0600). Uninstall puts the copy back (or removes a file that did
  not exist) only while the file is still exactly what registration wrote; a file changed since keeps
  the change and loses only version 5's entries. Four starting states tested (`wave3-03-byte-exact`).
- (d) The launcher has a `guard` mode (`rb5 guard`, `rb5.cmd guard`: stdin and the exit code pass
  through, so exit 2 refuses; no usable Node allows the write with the DOWN line), and the plug-in's
  `hooks.json` has a `PreToolUse` entry (matcher `Write|Edit|MultiEdit|NotebookEdit`, no `||` fallback).
  `plugin/claude/guard-hook.mjs` reads the config first and does nothing while `guard` is not `true`;
  when on it runs the installed app's guard. Registered for Claude Code only: the guard reads Claude
  Code's tool input, and Codex's pre-tool event and input were not verified (`wave3-04-guard-hook`).

**Delivery guard counts everything on the wire** (item 4). `server/wire.mjs`: every tool result leaves
through `toolResult`, which counts the text of every content block plus any `structuredContent`,
serialized, against 44,000 characters and 20,000 estimated tokens (or a recipe's lower numbers). A
structured copy that repeats the text is dropped; structured content that pushes a result over is
dropped; text still over is cut at a line end with a closing `CUT ·` line. The server sent no
`structuredContent` before this wave (choice 12 above) and sends none now, so there was no duplicate to
stop; the guard makes the rule hold if one is ever added (`wave3-05-wire`). JSON escaping on the wire is
not counted: the measured host limit was in delivered text characters.

**Migration test guard.** Under `RUVNET_BRAIN5_TEST=1`, `migrate --apply` reads a 4.7 home only from a
path given explicitly in `RUVNET_BRAIN_HOME` and refuses the real user's default 4.7 home before reading
anything (`refuseRealHome47`, `wave3-06-migrate-guard`); the WP 9 helper names its synthetic home.

**Release candidate.** The gate job first runs a placeholder that fails closed, naming what the owner
must provide (a private source holding the frozen question set and a secret granting access to it), then
`gate.mjs --release <staged> --questions "$RUNNER_TEMP/question-set" --out <file>`. With
`answerGate.questionSetSha256` empty in `rail.json`, the gate cannot pass a real release. Job time limit
left at 60 minutes: the builder gave no estimate, and the synthetic set's layer 1 takes about 2 s.
The four v5 workflows stay inert (`wave3-07-workflows`, `wp6-08`).

**Line budget.** The release package (`packages/release/**/*.mjs`) is 1,297 lines against the
architecture's 1,200; no line-budget check exists in this tree yet (ROADMAP A1 step 0.4 adds it), so
nothing was split; recorded here for that check.

**Tests added.** `wave3-01` to `wave3-07` and `wave3-end-to-end` (migrate --plan and --apply from a
synthetic 4.7 home, search through the registered server, the whole synthetic home hashed, brake and
undo, the guard off and failing open, the retrieval gate passing and failing, the documents current);
their breaks are in `breaks-wave3.mjs`.

## How each break is applied

Breaks are never switches in product code. `tests/acceptance/v5/breaks.mjs` holds, per test, an exact
text replacement that must match once in a scratch copy of the tree; `V5_BREAK=<name>` applies it.
Test conditions that need a fault (S3 worker death, S4 slow lane, S9 broken app) are applied the same
way, always, to the scratch copy only:

- S3: the worker thread calls `process.exit` in the middle of its first search (ended abruptly; the
  server sees exactly what a killed thread looks like).
- S4: the keyword lane spins for 60 s inside the worker thread when the question contains `slowlane`.
- S9: the second release's worker answers every call with an error, while its engine is unchanged, so
  the in-process check before the switch passes and the real-server check after it fails.
- S2: the program copied is the Node binary plus its `../lib/libnode.*` (Homebrew's Node loads it); on
  Windows the copy is renamed away instead of deleted. The break replaces the worker thread with a
  child process started from `process.execPath` captured at server start; its red run shows
  `spawn .../bin/node ENOENT`, the 4.7 failure.
- S13: a "day" is the update timer compressed to 50 ms for 1.5 s (30 checks; the default is 6 a day).
- S1 break a (query returns nothing): the first red is the installer's own real-server probe, which is
  part of S1's install step, before S1's own search assertion is reached.

## Not done

- Linux and Windows runs: the tests are written to run there (paths, `node.cmd`, `cmd` shell, rename
  instead of delete) and were run only on macOS (Darwin 27.2, Node 24.22.3).
- **S12 is expected to fail on Windows (not run there).** `cmd.exe` looks for a program in the current
  folder before PATH unless `NoDefaultCurrentDirectoryInExePath` is set, so the bare `node` in the hook
  command would run a `node.cmd` planted in the project. Fixing it without writing a Node path anywhere
  (architecture rule) is an open item for WP 7 or the owner. S12 also starts the server with an
  absolute Node path, so how the host resolves `node` in `.mcp.json` is not exercised.
- S6 asserts DOWN within one probe interval plus 3 s of slack (measured 542 ms with a 500 ms
  interval), not strictly within one interval.
- Determinism: 200 questions in three processes on a tied fixture (wp1-determinism); the same run on
  the retrieval corpus slice is opt-in (`WP1_SLICE_DETERMINISM=1`, about 500 s).
- Refusal of an unknown version: covered for the recipe (wp1-refusals, version 2); not yet for the
  pack, release or result files (the code does it: `validate.check`).
- Everything in "Deviations" above.

## Running

```
npm run test:v5                                                  # every v5 test, one file at a time
node tests/acceptance/v5/run-breaks.mjs                         # each green, then red on each break
node tests/acceptance/v5/run-breaks.mjs s02 s09                 # selected tests
node tests/acceptance/v5/run-breaks.mjs wp1 wp5 wave1 wp4       # a whole group (or wp4-01, wp1-sections)
V5_BREAK=s05 node --test tests/acceptance/v5/s05-size-cap.test.mjs   # one break by hand
```
