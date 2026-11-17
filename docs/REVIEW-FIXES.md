Updated: 2026-11-17 15:20:57 EST | Version 1.0.0
Created: 2026-11-17 15:20:57 EST

# Fixes for the independent Codex review of version 5

Source: `evals/runs/2026-11-16-knowledge-architecture/review/V5-REVIEW-CODEX.md`. It reviewed commit
`1be0c8dc` and reported 4 BLOCKER, 16 MAJOR and 4 MINOR findings. All fixes are on branch
`v5/review-fixes`, which starts from `origin/v5/rewrite` at that same commit.

Ownership during this pass:
- **This branch:** release, cli, health, guard, `contract/verdict.mjs`, migrate, the v5 workflows and the
  test tooling.
- **The recipe-port builder:** builder, server, plugin and the shared contract files. For findings in
  those packages, this file states the exact change the integration owner needs to make.

Each fix has an acceptance test and at least one break in `tests/acceptance/v5/breaks-review.mjs`.
`run-breaks.mjs` confirms that every break turns its test red.

For the blockers and for most majors, the "red on old" column records what happened when the new test
was run against `1be0c8dc`. That run used a separate worktree with the test copied in and no product
code changed.

## Verdicts

| ID | Sev | Verdict | Test (red on old code / break) | Commit |
|---|---|---|---|---|
| F01 | BLOCKER | **Fixed.** Promotion recomputes the gate decision and requires one complete receipt per OS. In GitHub Actions each receipt must also carry this run's id and its own runner OS. Remainder for the owner: receipts are integrity-checked but not signed, so someone with write access to the workflow could still forge one. | `wp6-11-evidence`. Old code printed `published: brain5-…-r1` for `{hit:0, of:1, passed:true}`. Breaks: `wp6-11-trust-passed`, `-trust-ok`, `-no-ci`. | `01af850d` |
| F02 | BLOCKER | **Fixed in cli** (`node-pick.mjs`). The rb5 and helper parts are handed over (see below). | `wp7-09-node-pick-project`. Old code ran `<project>/tools/node`. Breaks: `wp7-09-no-check`, `-lexical`. | `93f75bad` |
| F03 | BLOCKER | **Reproduced; builder-owned; handed over** with a diff that has been checked to work. | `wp5-split-secret` (todo). On current code, 50 of 50 lines of the generated key are in the history rows. With the diff below applied, this test and every other wp5 test pass. | `94c87594` |
| F04 | BLOCKER | **Confirmed. Not fixed here.** It is a set of release and cutover deliverables that need owner decisions; the list is below. | n/a | n/a |
| F05 | MAJOR | **Release probe: fixed.** It now starts the server through the installed `rb5` (`rb5.cmd server` via cmd.exe on Windows), and the receipt names the launcher. **`rb5.cmd` loop: disputed and not reproduced.** Under documented cmd parsing, the `& goto next` after an `if` belongs to the `if`. It has not been run on Windows. The defensive rewrite is handed over. | `wp6-06` with the new launcher assertion. Break `wp6-06-launcher-broken`: a launcher that cannot start the server now fails the probe. | `fe1bc9d3` |
| F06 | MAJOR | **Fixed:** installer staging and migration host reads. **Handed over:** `plugin/install.mjs` nested links. | `wp4-15-staging-links`. Old code: a staging folder that was a link had the folder it points at changed; the sweep deleted the user's files. `wp9-05-host-guard`. Old code read a protected host folder. | `33b542c4` |
| F07 | MAJOR | **Fixed:** a version 5 home that is, contains or sits inside the 4.7 home is refused, compared by real path. **Open:** the brake still checks 4.7 structurally rather than running a real 4.7 search. | `wp9-04-home-overlap`. Old code installed v5 into the 4.7 home and then printed "4.7 home … unchanged". | `2386d0df` |
| F08 | MAJOR | **Confirmed; server-owned; handed over.** | n/a | n/a |
| F09 | MAJOR | **Confirmed; server-owned; handed over.** | n/a | n/a |
| F10 | MAJOR | **Fixed:** the installer plans again after taking the lock. The update address is recorded in the journal, and recovery of a committed install writes it. | `wp4-13-plan-under-lock`. Old code put release 2 over the newer release 3, which is a downgrade. Breaks: `wp4-13-stale-plan`, `-no-config`. | `10fcecd2` |
| F11 | MAJOR | **Fixed:** prune keeps any generation a live server reports, and an automatic update refreshes the shim. **Handed over:** the server's handover of its static modules. **Open:** the rule to keep the old generation until the new one has served real searches for a day. | `wp4-16-retention-shim`. Old code pruned the generation a live session was reading. | `e3f09956` |
| F12 | MAJOR | **Fixed:** the lock is taken first, then host entries and files are removed. A server that is still running no longer recreates the home. | `wp4-14-uninstall-live`. On old code, `state/status/<pid>.json` came back after uninstall reported "nothing listed remains". | `67693b04` |
| F13 | MAJOR | **Confirmed; plugin-owned; handed over.** | n/a | n/a |
| F14 | MAJOR | **Fixed** in assess, verdict and status loading. | `wp3-07-malformed-evidence`. Old code reported OK for the review's `{"probe":{"ok":true,"results":[{}]}}`. | `91f7ce93` |
| F15 | MAJOR | **Confirmed; builder-owned; handed over.** | n/a | n/a |
| F16 | MAJOR | **Partly fixed:** calibration is recomputed, group assignments are checked against the frozen set, and the judge is given the reference text. **Owner items:** proof that the judge is an independent model; the polarity of the substring false-claim cap. | `wp8-07-answer-integrity`. Old code passed a forged calibration. Break `wp8-07-groups`: moving failing questions into a group with no threshold made the old gate pass. | `3cd653c9` |
| F17 | MAJOR | **Confirmed; server-owned; handed over.** | n/a | n/a |
| F18 | MAJOR | **Confirmed; builder- and server-owned; handed over.** | n/a | n/a |
| F19 | MAJOR | **Fixed:** every v5 artifact upload now sets `include-hidden-files: true`. | `wp6-08` assertion. Break `wp6-08-hidden`. | `db955dc8` |
| F20 | MAJOR | **Fixed:** a break counts as red only if its expected failure appears in the test's own failure report. Breaks of skipped tests are named, and `--strict` fails on them. Recovery now compares app and pack bytes and `config.json`. | The whole break run uses the stricter matching (results below). | `946b4f8c` |
| F21 | MINOR | **Fixed:** override reasons and update addresses are redacted, and the override log is created 0600. | `wp10-06-redaction`. Old code printed the address password and query token. | `e62c8097` |
| F22 | MINOR | **Confirmed; server-owned; handed over.** | n/a | n/a |
| F23 | MINOR | **Not attempted** (minor; generated-document claims). | n/a | n/a |
| F24 | MINOR | **Confirmed; contract-owned; handed over.** | n/a | n/a |

Updating the F01 fixtures changed some existing tests:
- `wp6-02`, `wp6-03`, `wp6-05`, `wp6-07`, `wp8-01` and `wp8-02` now build complete evidence through
  `wp6-helpers.mjs` (`gateFor`, `receiptsFor`, `writeReceipts`, `pinFixtureSet`).
- `wp6-06` still relabels the one real receipt as the other two operating systems. That stands in for
  the matrix legs. In CI the new run and runner binding refuses a relabelled receipt.

## Changes the integration owner must make (builder, server, plugin, contract)

**F02. `plugin/claude/bin/rb5` and `server/helper.mjs`**
- `rb5` `usable()`: also resolve the final target of the candidate and check it, not just its folder.
  POSIX sh has no realpath, so follow the link chain with `ls -l` parsing, or use `cd -P` on
  `${target%/*}` for each hop. Refuse the candidate if any hop's real folder is `within` a project
  root.
- `server/helper.mjs` `chooseNode()`: import `outsideProject` from `../cli/node-pick.mjs`, or move that
  function into `contract/`. Skip any candidate for which
  `!outsideProject(c, env, cwd ?? process.cwd())` holds, before calling `version(c)`.

**F03. `builder/history.mjs` and `builder/extract.mjs`**

The diff below was checked: `wp5-split-secret` passes, and all eight wp5 tests pass. Also bump
the cache key in `builder/cache.mjs`, which is currently recipe hash plus content hash, so that units
cached before the fix are rebuilt. Then remove the `todo` flag from the test.

```diff
--- a/packages/builder/extract.mjs
+++ b/packages/builder/extract.mjs
-    const { units, dropped } = historyUnits(snapshot.history.raw, { repo: meta.repo, owner: snapshot.history.owner, cfg: s.history });
+    const redact = (t) => redactSecrets(t, s.screen.secrets, s.screen.redaction);
+    const { units, dropped } = historyUnits(snapshot.history.raw, { repo: meta.repo, owner: snapshot.history.owner, cfg: s.history, redact });
@@
-      for (const h of hits) screened.secrets.push({ repo: meta.repo, path: u.path, line: h.line, rule: h.rule });
+      for (const h of [...u.hits, ...hits]) screened.secrets.push({ repo: meta.repo, path: u.path, line: h.line, rule: h.rule });
--- a/packages/builder/history.mjs
+++ b/packages/builder/history.mjs
-export function historyUnits(raw, { repo, owner, cfg }) {
+export function historyUnits(raw, { repo, owner, cfg, redact = null }) {
@@
-  const emit = (kind, ref0, date, title, text) => {
+  const emit = (kind, ref0, date, title0, text0) => {
+    // Secrets are redacted in the whole field before it is split (review F03).
+    const r = redact ? redact(String(text0)) : { text: text0, hits: [] };
+    const title = redact ? redact(String(title0 ?? '')).text : title0;
+    const text = r.text;
@@
-    splitText(text, cfg.splitChars).forEach((t, piece) => units.push({ kind, ref, date: day(date), title, header, path: `history/${kind}/${ref}`, piece, text: t }));
+    splitText(text, cfg.splitChars).forEach((t, piece) => units.push({ kind, ref, date: day(date), title, header, path: `history/${kind}/${ref}`, piece, text: t, hits: piece === 0 ? r.hits : [] }));
```

**F05. `plugin/claude/bin/rb5.cmd` line 30**

Use the unambiguous form `if "%RB5_REST:~0,1%"==";" (set "RB5_REST=%RB5_REST:~1%" & goto next)`.
Apply the same grouping to every `if … & …` line. Then run the launcher natively on Windows through the
registered command, including the case where the recorded runtime is missing.

The release probe now starts `rb5.cmd server` through cmd.exe. It has not been run on Windows. The
first `windows-latest` candidate leg is that test.

**F06. `plugin/install.mjs`**

Immediately before reading or writing each final file (`own()`, and `json()` targets):
- `lstat` every component from the host folder down to the file.
- Refuse any component that is a symbolic link.
- Apply `refuseProtected` to the realpath of each existing ancestor, not only to the named roots.

**F08. `server/main.mjs` and `server/widen.mjs`**

In `main.mjs`:
- Start with `project = null` when the client declares `roots`, and send no private query while the
  roots request is still pending.
- `onRoots`: set `project = null` unless the response holds a `file:` root, so an empty list revokes
  access.

In `widen.mjs` `openPrivates`: stop caching `privates.list` for the life of the worker. Either reopen
when the manifest's mtime or hash changes, or re-read `PACK.json` `projects` on every query.

**F09. `server/runner.mjs` and `server/main.mjs`**

- Pass an absolute `expiresAt` from `search()` into `runner.call`.
- The queue wait and the dispatch both use `expiresAt - Date.now()`.
- Startup `probe()` and `fillHelpers` take the time they use from the same budget.
- `safeMode` runs in a fresh worker with the remaining budget, never `engine.search` on the main
  thread. When no budget is left, return the DOWN result.

**F11. `server/main.mjs`**

When the pointer's app changes:
- Re-import `server/format.mjs`, `server/wire.mjs`, `server/tools.mjs` and `health/*` from the new
  `appDir` through `importFrom`, as the runner already does.
- Or exit cleanly so the host restarts the server from the refreshed shim.

Record the app version only after that handover.

**F13. `plugin/install.mjs` and `plugin/host-backup.mjs`**
- `setHooks`: within a group, remove only the hooks whose command starts with the launcher. Keep the
  group if anything else remains in it.
- `codexBlock`: when `e < 0` (an opening marker with no closing marker), throw `HostRefused` instead of
  dropping everything up to EOF.
- Every replace and restore keeps the existing mode: take `fs.statSync(file).mode & 0o777` before
  writing, and write the temporary file with `{ mode }` and `chmodSync` before the rename.

**F15. `builder/probes.mjs` and `builder/build.mjs`**

After `makeProbes`, refuse the build when an included repository has no probe:
`for (const repo of repos) if (!probes.some((p) => p.repo === repo)) throw new Error(...)`. The other
option is a defined fallback probe, such as the file's path words, recorded as `fallback: true`.

**F17. `server/widen.mjs`, `server/read.mjs` and `server/format.mjs`**
- `addPrivate`: merge under the section's `maxItems` and its one-item-per-file rule.
- Cite private items with their pack name, for example `private:<name>/<repo>/<path>`. `read_ruvnet`
  resolves that prefix first.
- Deduplicate after trimming, on the displayed excerpt's hash.

**F18. `builder/discover.mjs` and `server/format.mjs`**
- Refuse repo or commit values that do not match `^[A-Za-z0-9._/-]+$` and `^[0-9a-f]{7,64}$`.
- Encode paths in citations with `JSON.stringify`, or refuse control characters in paths at discovery.
- Run the hostile screen over each whole document and history field before chunking, and copy the flag
  to every unit that overlaps the matched span.

**F22. `server/main.mjs`**

Truncate echoed request values in errors to 200 characters (`unknown tool ${name}`, `method not
found`). Send protocol errors through the same limiter as `toolResult`.

**F24. `contract/signature.mjs` `verify()`**

Add `if (signature.keyId !== keyId(publicKeyPem)) return false;`.

**Schema proposals (contract owner)**
- `gate-result`: make `questionSet`, `layers`, `reasons` and `resultSha256` required.
- `probe-receipt`: add the optional `launcher` and `ci {runId, runnerOs}`, which the rail now writes
  and checks.
- `release`: add a signed `migrate` field (on or off), needed for F04 step 3a.

## F04: what a user release still needs (owner decisions, not code on this branch)
1. Provision the production signing key pair.
   - The public key goes in `packages/contract/keys/release-public.pem`.
   - The private key goes in the `v5-release` environment secret.
   - No key was generated or committed here.
2. Switch the root package to version 5.
   - `bin` points to `packages/cli/ruvnet-brain.mjs`, keeping the old command names as entries.
   - `files` covers only the v5 app.
   - The publisher is named in `scripts/release-authority.mjs`.
   - This retires the v4.7 `prepublishOnly` and `version:set` rails on this branch, so it is a release
     decision.
3. A production default update address and the signed `migrate` field, with the compatibility
   `--update` entry reading them.
   - Today, `--update` with no source prints that nothing was changed and exits 0. That leaves v4.7
     exactly as it is, which is the brake-off behaviour.
4. Migration steps that are still missing:
   - converting private stores into v5 private packs;
   - unregistering the 03:30 job, which is a launchd, cron or schtasks mutation and needs approval;
   - the brake running a real v4.7 search before it unregisters v5 (F07 remainder).
5. Rehearsals on three real machine images, the seven-day soak, and keeping the v4.7 line releasable,
   as listed in `ROADMAP.md` Part B.

## Budget note

The release package's `.mjs` code is now 1,415 lines against its 1,200-line budget (it was 1,297 at
review). Most of the growth is `release/evidence.mjs` (F01). No single file is over 500 lines. No
check enforces the package budget yet.

## Follow-up commits

| Commit | Change |
|---|---|
| `060dd8e4` | F14's generation rule had flagged every idle session as UNKNOWN right after an update. It now accepts the installed generation and the one kept before it (`wp4-16` runs doctor right after an update). `startLauncher` now quotes the cmd.exe command the way `/s` expects. |
| `1a5d63dc` | The break runner pauses only while CPU idle is below 10% (`top -l 1 -n 0`, checked every 30 s). It no longer uses the load average (owner's ruling). |
| `a9f32a94`, `ec69a64b` | The full break run found that five older breaks needed to follow these fixes. wp3-01a and wp4-04 had stale anchors. wp4-09b and wp9-01-unguarded stayed green because the new F02/F06 guards are second guards, so those breaks now remove them too. The F03 todo test had inherited wp5-history's breaks by name prefix and is renamed `wp5-split-secret`. All of these rerun RED as expected. |

## Suite results (head `ec69a64b`)

- `npm test`:
  - Plugin battery: 58/58.
  - v5 acceptance: 125 tests; 120 pass, 3 skipped, 1 todo, 1 fail.
    - The 3 skipped are wp1 T1, T2 and T5. They need the external corpus and question sets, which are
      not on this machine.
    - The todo is F03, which is builder-owned.
    - The failure was WP3-04's p95 hook time: 151.0 ms against a 150 ms budget. Two reruns gave
      147.3 ms (pass) and 154.4 ms (bare Node p95 104.6 ms, so the absolute budget was not judged).
      The hook's own cost (median paired difference) was 21–27 ms across these runs and 21.8 ms on
      the untouched baseline. The swing follows bare Node start-up under machine load, not these
      changes.
- `npm run single-source:check`: 20/20.
- `run-breaks.mjs`: the full run on `1a5d63dc` had 230 breaks RED as expected and 6 problems. The 6
  problems are fixed in `a9f32a94` and `ec69a64b`, and each was rerun RED as expected. Two wp1 breaks
  were not run because their tests skip on this machine. With `--strict` those count as problems.
- Baseline before any change (`1be0c8dc`): `test:v5` 113 tests, 110 pass, 3 skipped. Plugin 58/58.
  `single-source:check` 20/20.
- Not run: Windows and Linux. The CI workflows were not dispatched.
