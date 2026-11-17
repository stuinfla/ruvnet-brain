Updated: 2026-11-17 01:30:00 EST | Version 1.0.0
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
9. **Probes.** The builder writes one probe per repository: the first file (sorted) that has at least
   three words found in no other file; the question is those words; the expected file is that file.
   Every probe is run against the pack at build time and the build fails if one misses. `selfTest`
   passes when every probe's file is in FILES.
10. **Probe interval.** Each periodic probe starts a fresh worker, so the index is opened again and
    damage on disk is seen. Default 30 minutes.
11. **Timings.** In `state/config.json` with defaults in `contract/constants.mjs`: `heartbeatMs` 60 s,
    `staleAfterMs` 180 s, `probeIntervalMs` 30 min, `updateIntervalMs` 4 h, `rollbackNoticeMs` 24 h,
    `autoUpdate` true, `updateUrl` null. The search deadline is the recipe's `deadlineMs` (10 s).
12. **Result text.** Line 1 is the header (knowledge date, recipe id, pack generation, lanes). Line 2 is
    always either `MODE · normal` or `SAFE MODE · keyword only · <reason>`, so safe mode is
    machine-checkable. Each item: `N. repo/path · lines A-B · commit C · standing S · date D · sha256 H`,
    then the excerpt inside `<<<passage-<random>` and `passage-<random>>>`. An empty section prints
    `FILES (0) · no match: <reason>`. One text block, no `structuredContent`. Each recipe section has
    its own character budget (`budgetChars`, FILES: brief 22,000, full 56,000) and the whole result a
    cap (`result.capChars`: brief 24,000, full 60,000). The one trim step cuts excerpts evenly at a line
    break, first until each section is within its budget, then until the whole text is within the cap.
    The same content hash is never sent twice. `k` is accepted and answered with a note.
13. **Standing.** Docs (`.md`, `.txt`, from the recipe) are `claimed`; everything else `implemented`.
    Date is the source's date from its `.source.json`.
14. **Chunker.** `lines` v1: up to `maxLines` lines and `maxChars` characters; a single longer line is
    split. The indexed body is the repository name and path words, then the text (the path header).
    Ranking: bm25, then repository, path, first line, so equal scores order the same in every process.
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
4. **Builder** has no discover, fetch, secret or hostile-text screen, or incremental rebuild.
5. **Release** seals and signs only; no publish, promote, or three-system canary (WP 6).
6. **Engine** has no history lane, no `read_ruvnet` tool (so no MORE section), no private-pack scope
   check (WP 1, WP 2).
7. **No generated `docs/RECIPE.md`, no line-budget check, no CI workflow.** Workflows and budgets belong
   to ROADMAP A1 and the integration owner. Measured lines of `.mjs` per package: contract 262, engine
   156, server 339, health 70, cli 297, builder 199, release 59, plugin 49 (all under budget).
8. **A second version number.** `packages/plugin/claude/.claude-plugin/plugin.json` carries
   `5.0.0-skeleton.1` beside `packages/version.json`, because the host reads the plugin's own file. It
   should be generated from `version.json` when the shim is packaged (WP 7).
9. **`minShim` is signed but not enforced** by the launcher or the installer yet (WP 4, WP 7).
10. **rUv-first check (ROADMAP A0.7) not run.** The skeleton's keyword lane is `node:sqlite` FTS5 as the
   architecture decides; the analyser check against rUv's Lucene-style analyser is WP 1's first step.

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
- Determinism is checked on one question across three processes, not WP 1's 200-question sample.
- A test that each contract file with an unknown version is refused with one sentence (the code does
  it: `validate.check`, the engine's recipe-version check); no acceptance test covers it yet.
- Everything in "Deviations" above.

## Running

```
node --test --test-concurrency=1 'tests/acceptance/v5/*.test.mjs'   # all fourteen, one file at a time
node tests/acceptance/v5/run-breaks.mjs                         # each green, then red on each break
node tests/acceptance/v5/run-breaks.mjs s02 s09                 # selected tests
V5_BREAK=s05 node --test tests/acceptance/v5/s05-size-cap.test.mjs   # one break by hand
```
