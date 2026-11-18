Updated: 2026-11-17 21:30:00 EST | Version 1.0.0
Created: 2026-11-17 21:30:00 EST

# Version 5 integration: the L+ port and the review fixes

**Branch.** `v5/integration`, in the worktree `.claude/worktrees/v5-integration`. It started from
`v5/lplus-port` at `96d29076`. It has not been pushed, and no other branch was changed. Main and the
release branches were not touched.

**Ownership.** The integration owner merged the two branches and applied the builder, contract,
workflow and budget fixes. Two writers, each in its own worktree with its own files, did the rest:
- the server writer: `v5/integ-server`, findings F02 (helper), F08, F09, F11, F17, F18 (server half) and
  F22;
- the plugin writer: `v5/integ-plugin`, findings F02 (`rb5`), F05, F06 and F13.

Their branches were merged here.

## 1. What merged

| Commit | What |
|---|---|
| `e27dc812` | `v5/review-fixes` (20 commits, up to `950f1826`) merged into `v5/lplus-port` (`96d29076`). |
| `61920ebd` | `v5/lplus-port` up to `7365d9f9`: the third-job notes, with two break anchors re-pointed. |
| `1485173a` | Builder and contract fixes: F03, F15, F18 (builder half), F24, the cache key, and the probe-receipt schema. |
| `48b59bdd` | The pinned corpus fetch and the `v5-pack-build.yml` changes from `PORT-NOTES.md`. |
| `b6ab25a6` | `docs/F04-DECISIONS.md`. |
| `bcd26fe4` | `v5/integ-plugin` (`908de26d`). |
| `21eb25bb` | `v5/integ-server` (8 commits, `21790116` to `0d521bc7`), the test changes it handed over, and `packages/BUDGETS.json`. |
| `306f8f0c` | Reconciliation: the F15 fallback probe, the F18 server fixture, and the F09 safe-mode worker. |

## 2. Conflicts and how they were resolved

- **`tests/acceptance/v5/breaks.mjs`** (first merge). Both sides added one import and one registration
  line, so both were kept. The plugin, server and integration break files were wired in the same way
  later.
- **`tests/acceptance/v5/run-breaks.mjs`** (first merge). Both sides replaced the load-average pause:
  - the port: CPU idle on macOS, with load average 60 elsewhere;
  - the review side: CPU idle only, plus the F20 stricter matching and `--strict`.

  The review side was taken whole, following the owner's ruling on 2026-11-17 that load average is not
  used. Later `run-breaks.mjs` also scans `integ-*` test files, and single-source check V1 accepts that
  group.
- **`data/convergence-manifest.json`** (every merge). This file is written by the pre-commit hook.
  Each time it was regenerated against the merged tree (`node scripts/convergence-manifest.mjs
  --write`) instead of picking a side.
- `packages/docs/generate.mjs` and `packages/release/shipped-files.json` merged without conflict.
  `generate.mjs --check` reports the 3 documents current.
- **Overlaps between fixes, found by the full suite after merging:**
  1. **F15 against existing fixtures.** The refusal-only version stopped three builds: wave2-end-to-end's
     dense repository, and the server's F17 and F18 fixtures. F15 now uses the review's other option
     as well. A repository with no word of its own gets a fallback probe from its rarest words, marked
     `fallback: true`, and the pack's own self-test must still find it. A repository with no searchable
     word still stops the build.
  2. **F18 builder against F18 server.** The builder now skips a file name with a control character, so
     the server test could no longer build its fixture. The server test now builds with that skip
     patched out, standing in for an older producer, and tests what it is about: the server's own
     encoding.
  3. **F09 against WP4-01.** The server writer ran safe mode in a worker of the search worker's own
     script. WP4-01's broken app breaks exactly that script, so safe mode stopped answering. Safe mode
     now runs in `server/safe-worker.mjs`, which loads the engine only. It is never on the main thread
     (F09), and a broken search worker still answers, as WP4-01 requires. The file is on
     `shipped-files.json`. Break: `wp4-01-safe-in-search-worker`.

## 3. Fixes applied, with proof

"Red on old" is the new test run against the code before the fix, with no product change:
`v5-integ-base` at `e27dc812`, the server and plugin writers' old trees at `61920ebd`, and `1be0c8dc`
for F03. Every break listed below was run with `run-breaks.mjs` on `v5/integration` and went RED with
its expected failure; the full run is in section 4.

### F03: history secrets screened before the split
- The port's implementation (`history.mjs` screens each whole item; `b15290ad`) is the only one kept.
  The review hand-over's diff was not applied on top of it.
- `wp5-split-secret` is no longer `todo`.
- **Red on `1be0c8dc`:** `50 of 50 lines of the private key are in the history rows`. Green now.
- **Break:** `wp5-split-secret-after-split`.
- The cache key now carries `EXTRACT_VERSION` (2), so units cached by an older extractor are rebuilt. The
  recipe id change had done this by accident. No test pins the version number.

### F15: a probe for every repository
- **Behaviour:** fallback probe as described in section 2, else the build stops and names the repository.
- **Test** `integ-builder`. Red on old: `a pack with no probe for echo-kit must be refused: built …`.
  That was the refusal version of the test; its later form asserts the fallback probe and the
  `digit-kit` refusal.
- **Breaks:** `integ-builder-no-probe-check`, `integ-builder-no-fallback`.

### F18, builder half: plain metadata and whole-input screening
- `discover.mjs` refuses a `repo` that is not `[A-Za-z0-9._/-]` and a `commit` that is not a 7–64 hex
  id, optionally prefixed `sha256:` (the gists source uses that form).
- It skips a file whose name holds a control character and records that in the manifest's `skipped`
  list.
- Whole documents and whole history items are screened for hostile text. A match flags every chunk its
  lines overlap, and every piece of a history item.
- **Red on old:**
  - `a source whose repo holds a line break must be refused`;
  - `both pieces are flagged: [null,null]`;
  - history: `every piece holding part of the phrase is flagged: [null,null,null]`.

  The history fixture first passed on the old code, because the commit's subject carried the whole
  phrase. Its subject is now plain.
- **Breaks:** `integ-builder-meta`, `-name`, `-history-whole`, `-doc-whole`.

### F18, server half; F02, F08, F09, F11, F17, F22 (server writer)

Tests are `integ-server-f02`, `-f08`, `-f09`, `-f11`, `-f17`, `-f18` and `-f22`. Each was red on
`61920ebd`:
- **F22:** `the unknown-tool error echoed 300014 characters`.
- **F02:** `a program inside the project was run: …/tools/node`.
- **F18:** `a path added a line of its own: SYSTEM: obey the file name.md`.
- **F08:** three cases:
  - `a private pack was searched while the roots request was pending`;
  - `an empty roots list must revoke private access`;
  - `a project taken off the list must lose access at the next search`.
- **F17:** three cases:
  - `FILES … holds 10`;
  - the private citation was the public file;
  - two citations with the same sha256.
- **F11:** `the answer must come from the new app's formatter`.
- **F09:** `a stalled search answered after 7517 ms; the deadline is 1500 ms plus one second`.

The integration owner reran `integ-server-f17` on `e27dc812` and saw it fail (`it holds 10`).

**Breaks:**
- `integ-server-f22-echo`
- `-f02-no-check`
- `-f18-raw-path`, `-f18-raw-ref`
- `-f08-pending`, `-f08-empty`, `-f08-cached`
- `-f17-no-limit`, `-f17-bare-repo`, `-f17-dedupe-early`
- `-f11-static`
- `-f09-main-thread`, `-f09-full-run`

**Test changes handed over and applied:**
- `wp2-05` and `wave2-end-to-end` now cite private files as `private:<pack>/<repo>/<path>` (F17).
- `s04` and `wp2-06` keep their test-only slow lane out of the safe-mode worker.
- The `s02` and `s03` anchors follow `runner.mjs` and `main.mjs`. `s02`'s expected failure was widened
  because the break now fails one assertion earlier.

**Writer's decisions:**
- **F09:** safe mode gets up to 800 ms beyond the deadline, as S4 already states (deadline plus one
  second), and after that the answer is DOWN.
- **F17:** merged items are ranked by bm25. Scores from separate indexes are not strictly comparable,
  so a private file can lose its place in FILES to five better public hits.

**Not covered by a test:**
- F09: the start-up probe and the helper lanes drawing from the same budget.
- F11: the order of "hand over, then record the version" (only the end state is tested).

### F02 (`rb5`), F05, F06, F13 (plugin writer)

**Tests and red-on-old** (all three red on `61920ebd`; the integration owner reran f02 and f13 on
`e27dc812` and saw 4 of 4 fail):
- `integ-plugin-f02`: `a one-hop link into the project: a node linked into the project ran`.
- `integ-plugin-f06`: `Missing expected exception: a nested link into a protected home must be refused`.
- `integ-plugin-f13`, three cases:
  - `a hook the user added to the registered group must stay after uninstall`;
  - `an unterminated managed block must be refused`;
  - `each host file keeps its mode`.

**Breaks:**
- `integ-plugin-f02-no-hops`, `-f02-first-hop`, `-f02-no-links`
- `-f06-links`, `-f06-ancestors`, `-f06-strict-base`
- `-f13-whole-group`, `-f13-to-eof`, `-f13-mode`, `-f13-restore-mode`

**Behaviour notes:**
- **`rb5`:** follows a linked Node for up to 16 hops, reading links with `/usr/bin/readlink` or
  `/bin/ls`, never through PATH. A system with neither refuses a linked Node.
- **A linked `~/.claude` (dotfiles) still registers.** The walk starts below the folder's real path.
- **A host file that is itself a link** (a stowed `settings.json` or `~/.claude.json`) is now refused
  with `HostRefused`. Before, it was replaced by a regular file. This is a behaviour change the lead
  may want to confirm.
- **An unterminated Codex block** refuses registration and uninstall alike.

**F05 (`rb5.cmd`): static only.** Every `if … &` line is grouped. It cannot run here. The first
`windows-latest` leg must run the registered `rb5.cmd hook` through cmd.exe with no recorded runtime,
on a PATH with a leading `;`, a `;;` and a `C:\Program Files (x86)\…` entry, under a timeout. It must
also run `wp7-01` to `wp7-04` and `wp6-06`.

### F24: the signature's key id
- `verify()` now returns false when `signature.keyId` is not the trusted key's.
- **Test** `integ-contract`. Red on old: `a release with a foreign key id must not install: installed: app 5.0.0-skeleton.1`.
- **Break:** `integ-contract-keyid`.

### Schema proposals
- **Applied (additive):** `probe-receipt` gains the optional `launcher` and `ci { runId, runnerOs }`,
  which the rail already writes and `evidence.mjs` already checks.
- **Already present:** `release.migrate` (an optional boolean, covered by the signature). Its use is
  F04 Q3.
- **Not applied:** making `gate-result`'s `questionSet`, `layers`, `reasons` and `resultSha256`
  required. It is a tightening, not an additive change. The one producer writes all four and
  `evidence.mjs` already refuses a result without them, so it is safe whenever the lead wants it
  (`F04-DECISIONS.md`, last section). The lead has since decided to apply it; see section 5.

### The pinned corpus and `v5-pack-build.yml` (`PORT-NOTES.md`, third job)
- `recipe/CORPUS.json` holds the 22 repositories at the measured run's submodule pins. `RuVector` is
  listed under its GitHub name.
- `packages/builder/fetch-corpus.mjs` fetches exactly the pinned commit (a shallow fetch), writes
  `.source.json` with the commit's own date, and writes the builder's `--sources` list. A missing gists
  file stops it unless `--no-gists` is given.
- **The workflow:**
  - `corpus: pinned` is the default; `fixtures` remains;
  - `gists: required | omit`;
  - a free-disk check (8 GB) and a pack-size check before upload (5 GB);
  - a 90-minute limit;
  - Node stays pinned at 24.22.3.
- **Test** `integ-corpus` uses local `file://` origins, with breaks `integ-corpus-tip` and
  `integ-corpus-gists`.
- **The gists source is F04 G1, now decided as a pinned release asset (D-G1; not built yet, see
  section 5).** Until that is built, a pinned build stops at the fetch step unless it
  is run with `gists: omit`.
- **Real-corpus check on this Mac.** `fetch-corpus.mjs` was pointed at the local checkouts of the 22
  pinned repositories, plus the gists, then the integration builder ran (on `1485173a`, before the
  fallback probe):
  - 22 sources fetched at their pins;
  - 783,670 passages from 56,530 files, the same as the port's numbers;
  - all 23 repositories (including `_gists`) have a probe;
  - 350 s, peak RSS 1.58 GB, pack 1.9 GB on disk;
  - 346 hostile flags, and no file skipped for its name.

  It was not run against GitHub: no network was used.

### Line budgets (`packages/BUDGETS.json`, test `integ-budget`, break `integ-budget-over`)

No budget file or check existed before; ROADMAP A1 step 0.4 had never been built. The file now holds
every package, and the test fails when a package goes over its budget or a package folder has no
budget.

| Package | Lines | Budget | Note |
|---|---|---|---|
| release (rail, excluding `gate/`) | 653 | 1,200 | The architecture's number, kept. |
| release/gate | 762 | 800 | **New entry, with a written reason.** The answer gate (wave 3) is not in section 6's release scope, so it is counted on its own. The release package as a whole is 1,415 lines. |
| server | 1,280 | 1,300 | **Raised from 1,200, with a written reason** (F08, F09, F11, F17, F18, F22, and the safe-mode worker). |
| plugin | 480 | 500 | **Raised from 400, with a written reason** (F06 and F13 guard the user's host files). |
| docs | 225 | 300 | **New, with a reason.** Not in section 6. |
| builder | 2,643 | 3,000 | |
| Every other package | under budget | the architecture's | contract 600, engine 2,500, health 500, cli 2,500, guard 400, migrate 500. |

## 4. Suites and the break run

### `npm test` on `306f8f0c`
- Plugin battery: 58/58.
- v5 acceptance: **152 tests, 149 pass, 0 fail, 3 skipped, 0 todo.**
  - The 3 skips are WP1 T1, T2 and T5. They need the retrieval corpus and the question sets, which are
    not on this machine.
  - WP3-04 passed: p95 72.3 ms against the 150 ms budget, with a 1-minute load of 17.2.
- The merge alone (`e27dc812`) had 133 tests: 129 pass, 3 skipped, 1 todo.
- The first full run after merging the writers had 4 real failures. All four were integration
  conflicts, not machine load, and section 2 describes them.

### Other checks
- `npm run single-source:check`: 20/20.
- `node packages/docs/generate.mjs --check`: 3 documents current.
- Break anchors: every `find` string matches exactly once (284 breaks, 325 anchors). Checked with a
  script that imports `BREAKS`.

### Full break runner (`node tests/acceptance/v5/run-breaks.mjs`)

This is the run on `306f8f0c`, the tree that is committed here. The runner pauses only while CPU idle is
below 10%.

**Result: 285 breaks.**
- **283 RED as expected,** each with its own expected failure in the failing test's report.
- **0 still green** and **0 red for another reason**.
- **2 NOT RUN:** `wp1-dev-score` and `wp1-no-question-strings`. Their tests skip entirely on this
  machine because the corpus and question sets are not here. They are named, not counted as red.
  `--strict` would count them as problems.

**One problem, from machine load, not the code.** The plain (unbroken) run of `wp3-04-hook-speed`
failed: `the hook's own work adds 115.2 ms (median) over a bare Node start, over 50 ms`. Its break
still went RED as expected. Rerun once the machine was quieter (1-minute load 25):
- green PASS, then the break RED as expected;
- a standalone run gave median 63.4 ms, p95 78.8 ms, own cost 21.5 ms, budget judged.

Earlier runs on this branch measured the hook's own cost at 20.1 ms and 21.5 ms. The review-fix
record measured 21–27 ms. The 115 ms reading came while the break run's other work was loading the
machine.

## 5. The lead's F04 decisions and the code each one needs (not built here)

`docs/F04-DECISIONS.md` now carries the programme lead's decisions (commit `b4c50bd5`). As instructed,
none was implemented on this branch. Each item below needs its own test and break.

| Decision | Code it needs | Where |
|---|---|---|
| **D-Q1: two trusted keys** | `trustedPublicKey()` becomes `trustedPublicKeys()`, reading `release-public.pem` and `recovery-public.pem`. `verify()` passes when either key verifies, and with F24 the named `keyId` must be that key's. The release record says which key signed. A recovery-signed release may replace the release key. Tests: a recovery-signed release installs; a third key is refused. The re-key procedure goes in CONTRIBUTING.md. | `packages/contract/signature.mjs`, `cli/install.mjs`, `release/checks.mjs`, `release/seal.mjs`, `shipped-files.json` (the second `.pem`), the shim |
| **D-Q1: the keys themselves** | **OWNER ACT.** No code can stand in for it. | none |
| **D-Q2: one publisher per line** | `release-authority.mjs`: exactly one canonical publisher per line. 4.7 is `scripts/release.mjs` (versions below 5, from `main` or `maint-4.7`). v5 is `packages/release/promote.mjs` (versions 5 and above, from `release/5.*`). Unit test and break. `promote.mjs` publishes the app-only tarball as `ruvnet-brain@5.x` under `next` with npm trusted publishing (OIDC, no token). The later move of `latest` is a named, gated operation of the same publisher. | `scripts/release-authority.mjs`, `packages/release/promote.mjs`, `v5-release-candidate.yml` (an `id-token: write` permission on the publish job only) |
| **D-Q2: the v5 package** | The root `package.json` becomes v5 on `release/5.*`: `bin` is `packages/cli/ruvnet-brain.mjs` with the old command names, and `files` is the app list only. The 4.7 `prepublishOnly` and `version:set` stay on `main` and `maint-4.7`. | `package.json` on the release branch, `packages/version.json` |
| **D-Q3: default update address and `migrate`** | The v5 CLI's default update source is the GitHub Releases `brain5-` channel. The seal writes `migrate: false` until the soak passes. A **4.7 bridge release** (4.7 rail, after 4.7.30): `--update` reads the newest `brain5-` release, verifies it with the committed public keys, and migrates only when `migrate` is true. Otherwise it behaves as today. | `packages/cli/updater.mjs` and `source.mjs`, `packages/release/seal.mjs`, the 4.7 tree (`bin/install.mjs --update`) |
| **D-Q4.1: `private add`** | `ruvnet-brain private add <source folder> --project <folder>` builds an `access: "private"` pack with the builder's code into `<home>/private/<name>/`. Migration lists the 4.7 private stores by neutral label and location and never touches them. `doctor` says private knowledge is 4.7-only until a pack is added. | `packages/cli/ruvnet-brain.mjs` plus a new `cli/private.mjs`, `packages/migrate/`, `packages/health/` doctor table. The builder is not shipped (`APP_PACKAGES`), so the pieces `private add` needs must ship or be re-homed. **That is an open design point.** |
| **D-Q4.2: the 03:30 job** | The bridge release makes the 4.7 nightly exit at once, with one log line, when a v5 home is active. `migrate --apply --remove-4-job` and `cleanup-4` unregister only an entry byte-identical to what the 4.7 installer wrote. `rollback-to-4` re-registers it. | 4.7 `bin/nightly-refresh.mjs`, `packages/migrate/` |
| **D-Q4.3: the real-search brake** | `rollback-to-4` runs the structural check, then asks the installed 4.7 one probe question in a child process (180 s limit, read-only). It switches the hosts back only on a result; otherwise it refuses and v5 keeps serving. | `packages/migrate/migrate.mjs`, a test with a 4.7 fixture that cannot start |
| **D-Q5: rehearsals and the 4.7 line** | Create `maint-4.7` from the 4.7.30 tag before the first `release/5.*` push. The 4.7 preflight workflow must ignore `release/5.*`; today it matches `release/**`. | `.github/workflows/` (4.7 preflight), branch creation |
| **D-G1: gists as a pinned asset** | A maintainer command builds the gist passage file from the public gists API and drops any gist that is not public or not authored by the corpus owner, with a count. The file is published as an asset of `brain5-corpus-<date>`. `recipe/CORPUS.json` `gists` gets `{ url, sha256 }`. `fetch-corpus.mjs` downloads it and refuses a sha256 mismatch. `v5-pack-build.yml` drops the `gists: required` stop. Test with a local file server, and a break that skips the hash check. | `packages/builder/fetch-corpus.mjs`, `recipe/CORPUS.json`, `v5-pack-build.yml`, a new maintainer script, `rail.json forbiddenTags` (keep `corpus-sha256-*` forbidden, allow `brain5-corpus-`) |
| **Also: the `gate-result` tightening** | Make `questionSet`, `layers`, `reasons` and `resultSha256` required. `wave2-contract`'s minimal gate fixture must then carry them. | `packages/contract/schemas/gate-result.schema.json`, `tests/acceptance/v5/wave2-contract.test.mjs` |
| **Also: judge independence** | With the first frozen set, the answer and judge models must come from different vendors, both named in the result file. The judge must pass the seeded calibration. | `packages/release/gate/answer.mjs` and `verify.mjs`, `rail.json` |

## 6. What else remains before a release

1. **OWNER ACT: authority for key generation (D-Q1).** Without it nothing can be sealed or installed
   outside the tests.
2. **The code in section 5.** Then the 4.7 bridge release through the 4.7 rail.
3. **The answer gate cannot pass a real release yet.** The frozen question set is not pinned
   (`rail.json`). The bar for 5.0.0 is an owner decision (`F04-DECISIONS.md`, "What remains", item 5).
4. **The F01 remainder:** receipts are integrity-checked but not signed.
5. **The F11 remainder:** the rule to keep the old generation until the new one has served a day.
6. **F23** (generated-document claims) was not attempted.
7. **Linux and Windows have not run any of this.** The CI workflows were not dispatched. F05 is
   static-only. The F06 link walk and the F02 `rb5` hop loop have only run on macOS.
8. **The L+ score has not been re-measured through v5** (port notes, open item 2). The pack is ×1.8
   the size without the layered store, and the shrink options in the port notes are not implemented.
9. **Commit trailers.** The 20 commits from `v5/review-fixes` carry a `Claude-Session:` trailer (no
   `Co-Authored-By`). They were merged as they are, since rewriting them would rewrite that branch's
   history. The integration and writer commits carry no trailer.
