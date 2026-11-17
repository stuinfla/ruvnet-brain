Updated: 2026-11-17 00:50:00 EST | Version 1.0.0
Created: 2026-11-17 00:45:00 EST

# Roadmap: building RuvNet Brain 5 and replacing 4.7.28

Read `TARGET-ARCHITECTURE.md` first; this file is how to build it. Part A is the version 5 build plan
(walking skeleton, work packages, who can build what). Part B is the cutover: how version 5 replaces 4.7.28
for people who already have it. Part C is the parity checklist: every user-visible capability of 4.7.28 and
what happens to it. Part D is the short list of things to do to 4.7.28 itself while it keeps serving.

Effort is in builder-agent working days, not calendar days: S = up to 1, M = 2 to 4, L = 5 to 10.
Builder level: **Sonnet** = mechanical, fully specified. **Opus** = shipped code with design choices inside a
fixed contract. **Fable** = judgement: contracts, what to keep or drop, gates, reviews, cutover decisions.
Every package of shipped code gets an independent review by a different agent than its builder.

---

## Part A. Version 5 build plan

### A0. Ground rules

1. **One repository, one folder.** Version 5 is branch `v5/rewrite` of `/Users/stuartkerr/Code/ruvnet-brain`.
   Its layout (`TARGET-ARCHITECTURE.md` section 6) is the repository root on that branch. There is no second
   repository and no second project folder.
2. **Builders work in hidden worktrees** under `.claude/worktrees/`, one per work package, each branched from
   `v5/rewrite`, each owning the folders named for it below and nothing else. One integration owner merges
   work packages back into `v5/rewrite` and is the only one who edits shared files (root `package.json`,
   workflow files, `packages/contract/`).
3. **The contract is frozen at the end of the walking skeleton.** After that, a change to
   `packages/contract/` is a reviewed change by the integration owner, announced to every builder.
4. **A test must be able to fail.** Every acceptance test below is stated with the break that must turn it
   red. A builder shows both runs (green on the code, red on the break) before a package is accepted. Tests
   go through public entry points (the real command, the real server over its real protocol). A test that
   reads product source as text is not accepted.
5. **Three operating systems from the first day.** The acceptance suite runs on Linux, macOS and Windows on
   every push to a work-package branch.
6. **Line budgets are enforced** by a check in CI (section 6 of the architecture). Going over budget fails
   the build; the budget file is changed only by the integration owner.
7. **rUv first.** Before hand-writing a capability, the builder checks what rUv already ships for it and
   records the source path it found. This applies most to the engine lanes, the analyser and any tuning loop.
8. **4.7.28 is not edited** by any version 5 work package. Reused ideas are re-implemented or copied from
   tag `v4.7.28` into version 5 folders; nothing imports from the old tree.

### A1. Step 0: prepare the branch (before any builder starts)

Owner: lead (Fable). Effort: S. Nothing else can start until this is done.

| # | Action | Why (observed 2026-11-17) |
|---|---|---|
| 0.1 | Bring `v5/rewrite` up to the released code: it sits at `320b778b` (version 4.7.20). The released 4.7.28 is `0e7b9cfa` on `origin/main`, 183 commits ahead, and `320b778b` is its ancestor, so this is a plain fast-forward | The project rule is that `main` only moves by fast-forward. A 5.0.0 release branch has to descend from `origin/main`, or it can never land |
| 0.2 | Decide the five uncommitted edits in the project folder (`bin/developer-update.mjs`, `docs/RUV-GISTS.md`, `kb/ruv-gists.sources.json`, `scripts/nightly-gists.sh`, one gist test): commit them to a 4.7 branch or set them aside. They are 4.7 work and will otherwise ride along into version 5 | They show as modified in `git status` on `v5/rewrite` today |
| 0.3 | Create a hidden worktree `.claude/worktrees/maint-4.7` at tag `v4.7.28`. Point the owner's scheduled jobs that run scripts from the project folder at it, or switch them off for the rewrite | Four job files in `deploy/` run `/Users/stuartkerr/Code/ruvnet-brain/scripts/...` directly (issue watch, issue fix, issue autofix, routing flywheel). The moment the version 5 tree replaces the old tree in that folder, those scripts no longer exist and the jobs fail every hour |
| 0.4 | First commit on `v5/rewrite` after the fast-forward: remove the 4.7 tree and add the empty version 5 skeleton (folders, root `package.json`, CI workflow, line-budget check, `LICENSE`, the public signing key). The old code stays reachable at tag `v4.7.28` and in the `maint-4.7` worktree | Builders must not be able to import old code by accident |
| 0.5 | Write the first three entries of `docs/DECISIONS.md` (the decision log that replaces 102 ADRs): Node 22.13 minimum; in-process search with safe mode; pointer-file updates | So later builders do not re-argue them |

Acceptance: `git merge-base --is-ancestor origin/main v5/rewrite` succeeds; the four owner jobs report a
successful run from their new location (or are listed as switched off); CI is green on the empty skeleton on
three operating systems.

### A2. The walking skeleton (one thin slice through every part)

Owner: one Opus builder, reviewed by Fable. Effort: M. Depends on: A1.

The skeleton is the whole product, as thin as possible, on a tiny made-up corpus (three small repositories
committed as test fixtures). It exists to prove the shape and to freeze the contract before parallel work.

What it contains:

1. `recipe/RECIPE.json` (keyword lane only) and the four schemas with the `verdict` function.
2. Builder: turns the three fixture repositories into a pack with a manifest and probes.
3. Release: signs the pack and a `release.json` with a test key; verifies them.
4. Installer: `install --from <folder>` verifies, runs probes, writes `current.json`; `doctor`; `uninstall`.
5. Engine: `open`, `search` (keyword lane on Node's built-in SQLite), `selfTest`.
6. Server: the MCP process with `search_ruvnet`, the worker thread, the deadline, safe mode, the capped
   formatter, its own status file and heartbeat.
7. Shim: launcher entry and the one prompt hook printing the health line, for Claude Code.

Acceptance tests (each named with the break that must turn it red):

| Test | Passes when | Must fail when |
|---|---|---|
| S1 end to end | build, sign, install from a folder, start the server, ask a question over the real protocol, get the expected fixture file with a citation, all on three operating systems | the keyword query is made to return nothing; the citation path is altered |
| S2 Node replaced | the server is started with a private copy of the Node program, that copy is deleted while the server runs, and the next search still answers | a child-process spawn is introduced on the search path |
| S3 worker killed | the worker thread is ended from outside during a search; that search answers in safe mode and says so; the next search is normal | safe mode is removed |
| S4 deadline | a lane is made to sleep past the deadline; the answer arrives within deadline plus one second, marked safe mode | the deadline is removed |
| S5 size cap | a fixture with very large files is searched; the result is at or under the cap and no text appears twice | the trim step is removed |
| S6 health is honest | with a working install the line says OK; after the pack's index file is damaged the line says DOWN within one probe interval; with the server stopped it says NOT RUNNING; with a stale heartbeat it says unknown, never OK | the verdict function is made to return ok for a failed probe |
| S7 hook fallback | with `node` replaced by a program that exits with an error, the hook command still prints the DOWN line (Linux, macOS, Windows) | the fallback is removed from the hook command |
| S8 bad update is refused | an update whose pack fails its probes leaves `current.json` unchanged and the old pack answering | the probe step is skipped |
| S9 rollback | an update that passes before the switch and fails after it puts the pointer back by itself, and the line reports it | the post-switch check is removed |
| S10 unsigned refused | a pack with one byte changed, or a manifest signed with another key, is not installed | signature checking is bypassed |
| S11 doctor is the same verdict | `doctor` exits non-zero in every state where S6 says anything but OK | doctor is given its own separate check |
| S12 nothing from the project runs | a script planted in the current project folder under every name the shim knows is never executed at session start or prompt time | the shim is made to run a project file |
| S13 off-switch | with auto-update off, a recorded network stub receives zero requests over a simulated day | the updater's switch check is removed |
| S14 hot swap | while the server runs, a new pack is installed; the next search answers from it without a restart | generation checking is removed |

Exit: all fourteen green on three operating systems, each shown red on its break. The contract package is
tagged `contract-v1`. Only then do the parallel packages start.

### A3. Work packages (parallel after the skeleton)

Each row owns its folders exclusively. "Needs" lists what must be merged first.

| WP | What | Owns | Needs | Builder | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | **Engine**: full keyword lane and history lane to the retrieval run's recipe; lane plug-in interface; section assembler; private-pack scope check; determinism across processes | `packages/engine/` | skeleton; the retrieval run's recipe for FILES + HISTORY | Opus; lane design reviewed by the retrieval lead (Fable) | M | Medium: the analyser must match the retrieval run's measured lane |
| 2 | **Server**: full protocol handling, `read_ruvnet`, helper-process support for native lanes with a Node chosen at start time, hot swap, formatter with fence | `packages/server/` | skeleton | Opus | M | Medium |
| 3 | **Health**: status files, readers, doctor table, owner paging with damping, the hook program | `packages/health/` | skeleton | Sonnet, reviewed by Opus | S | Low |
| 4 | **Installer**: download with resume and stream hashing, disk-space check, storage transaction, update from inside the server, rollback, uninstall with re-check, `install --plan`, config | `packages/cli/` | skeleton | Opus | L | High: this is where 4.7.28 has the most history; crash-safety needs fault-injection tests |
| 5 | **Builder**: discovery, fetch, the one chunker, extractors per unit kind, secret and hostile-text screen, index builders, probes, incremental rebuild, carry rule for unreadable sources | `packages/builder/`, `recipe/` | skeleton; the retrieval run's chunker and history extractor (their branch `worktree-agent-a00e59ae16c567ff6` is the starting point for the chunker) | Opus; Fable for what the recipe file must contain | L | Medium |
| 6 | **Release rail**: one workflow for app and pack; seal, sign, pre-release, install-and-probe on three operating systems, promote, restore; nightly dispatcher, retry, kill switch, watchdog | `packages/release/`, `.github/workflows/` | skeleton | Opus for the code; **Fable** for which 4.7 rail pieces carry over | M to L | Medium: must not be able to pass without the answer gate |
| 7 | **Host shims**: Claude Code and Codex launcher and hook entries, the short skill, the `/brain` command, host registration used by the installer | `packages/plugin/` | skeleton | Sonnet | S | Low |
| 8 | **Answer gate**: wire the retrieval run's blind question set and pass rule into the rail; side-by-side run against 4.7.28 on the same questions | `packages/release/gate/` (new folder, agreed with WP 6) | WP 1, 5, 6; the retrieval run's instrument | **Fable** | M | High: this is the check whose absence let 4.7.28 ship green at about 4% |
| 9 | **Migration**: detect a 4.7 installation, carry private stores into `private/`, carry the opt-outs, remove 4.7 host registrations and scheduled jobs, keep the old knowledge folder for rollback | `packages/migrate/` | WP 4, 7 | Opus | M | High: touches existing users' machines |
| 10 | **Guard** (optional write check): advisory when health is not ok, in-file override, off by default | `packages/guard/` | WP 3, 7 | Sonnet, reviewed by Opus | S | Low |
| 11 | **Generated documents**: `docs/RECIPE.md`, the "what runs, what is written, what is sent" tables in `SECURITY.md`, `README.md` with the gate's number | `docs/`, generators inside each package's own folder | all code packages | Sonnet | S | Low |
| 12 | **Independent review and security pass** of the whole branch | none (read-only) | all | **Fable**, a different agent from every builder | M | none |
| 13 | **Soak and cutover** (Part B) | none | all | **Fable** lead | M | High |

Later, each admitted by the retrieval run's own rule, each a lane plus pack files and nothing else:
cue layer with its small model (WP 14), re-ranker (WP 15), graph walk and typed abstention (WP 16),
learning from use on a private branch (WP 17).

Parallelism after the skeleton: WP 1, 2, 3, 4, 5, 6, 7 can all run at once (seven worktrees; the machine's
own guidance says five agents by default, three when it is loaded, so run them in two waves: 1, 4, 5 first,
then 2, 3, 6, 7). WP 8, 9, 10, 11 follow. WP 12 and 13 last.

### A4. Acceptance tests per work package

All run on three operating systems unless stated. "Break" is what must turn the test red.

**WP 1 Engine**
- The retrieval run's development questions for the day-one recipe score, through `engine.search`, within
  one question of that run's own measured number for the same lane on the same corpus slice. Break: change
  the analyser.
- The same question returns the same first five files in three separate processes for at least 99% of a
  200-question sample. Break: introduce an unordered iteration into ranking.
- A pack whose recipe version is unknown is refused with one plain sentence. Break: remove the check.
- A private pack is not searched from a project that is not on its list, and is searched from one that is.
  Break: remove the scope check.
- No string from the question sets appears in `packages/engine/`. Break: add a recogniser for one question.
- With the optional lane's files removed from a pack, search still answers and reports the lane unavailable.

**WP 2 Server**
- Fifty searches fired at once all answer; none is lost; memory returns to its idle level. Break: drop the
  queue.
- A helper process for a native lane is started with a Node that is tested at start time; when the first
  candidate is a broken program, the second is used; when none works, the lane is reported unavailable and
  search answers. Break: start the helper with a remembered path.
- `read_ruvnet` returns the requested lines of a file in the pack, capped; a path outside the pack is
  refused. Break: remove the path check.
- A passage that contains the fence's marker text cannot close the fence. Break: use a fixed marker.

**WP 3 Health**
- Table-driven: every combination of evidence maps to exactly one state, and `ok` is reachable only with a
  live process, a fresh heartbeat and a passed probe.
- Two servers, one healthy and one failing: the hook shows the failing one. Break: show the newest writer.
- A page is sent after two failures five minutes apart, once per six hours, and a recovery note once.
  Break: page on the first failure.
- The hook finishes in under 150 ms at the 95th percentile over 200 runs on the CI machines and starts no
  other program.

**WP 4 Installer**
- Fault injection: the process is killed at every step of install and of update (a loop over step numbers);
  after each kill, the next run either completes or returns to the previous working state, and a search
  answers in both cases. Break: remove the journal.
- A download cut off at a random byte resumes and completes with the right hash.
- A file larger than 2 GiB installs (a sparse test file is enough). Break: read the file whole.
- With less free disk than needed, nothing is written and the message names the shortfall.
- `install --plan` output equals the set of paths actually written (compared by watching the folder).
  Break: write a file outside the plan.
- Uninstall leaves `private/` intact, removes everything else in the plan, and its final report lists
  anything left. Break: delete `private/`; or print "clean" without checking.
- Install then two updates leaves exactly one earlier generation on disk.
- No `npm`, `npx` or package-manager program is started during install or update (process watch).

**WP 5 Builder**
- Building the same sources at the same commits twice gives packs with identical file hashes.
- Changing one file in one repository rebuilds only that repository's files.
- Changing the recipe hash rebuilds everything.
- A planted fake secret in a fixture never appears in the pack. A planted prompt-injection fixture is flagged
  and never returned by search.
- One fixture source made unreadable: the pack is built, that source is carried at its last good bytes and
  named in the manifest. Four of four made unreadable: the build fails.
- Every probe the builder writes passes against the pack it was written for, and fails when the file it
  expects is removed from the pack.
- A model name, revision or chunk size outside `recipe/RECIPE.json` fails the build.

**WP 6 Release rail**
- A dry-run release on a fork-like test repository goes pre-release, install-and-probe on three operating
  systems, promote.
- Promotion is refused when any one operating system's probe fails. Break: mark one as optional.
- A failure injected between "packages promoted" and "release promoted" restores the previous release.
- The workflow has no step that can continue on error and no switch that skips the gate; a test parses the
  workflow file for this and, separately, a release with the gate's result missing is refused.
- A pull request from a fork cannot read a secret (checked by the workflow's triggers and permissions, and
  by a test run from a fork).
- The published package contains exactly the files on a reviewed list (4.7.28 ships 377 maintainer scripts).
  Break: add a file outside the list.
- The publishing job installs nothing from the network that it does not use, and every action and tool it
  does use is fixed to an exact version.

**WP 8 Answer gate**
- The gate, run on 4.7.28 through its real server, reproduces the retrieval run's baseline (4 of 113 on the
  development set) within one question. This proves the instrument before it judges version 5.
- The gate fails a deliberately damaged version 5 pack (half the passages removed).
- The first version 5 release clears the pass rule fixed in the retrieval run's pre-registration.

**WP 9 Migration**
- On a machine image with a real 4.7.28 installation including a private store and a recorded "no" to
  auto-update: after migration, version 5 answers; the private store's text is searchable only in its listed
  projects; auto-update is off; no 4.7 scheduled job remains; the old knowledge folder is untouched.
- `ruvnet-brain rollback-to-4` restores a working 4.7.28 search from the kept folder.
- Migration interrupted at each step leaves either a working 4.7.28 or a working version 5.

**WP 10 Guard**
- With health not ok, a write that would be refused is allowed with one advisory line. Break: refuse anyway.
- The in-file override line lets the write through and is recorded.
- A fresh install has the guard off.

### A5. Where Fable judgement is needed, and where it is not

| Needs Fable | Why |
|---|---|
| The contract package and any later change to it | every other package is built against it |
| The recipe file's contents and the answer gate (with the retrieval lead) | these decide whether the product is right, not whether it runs |
| Which 4.7 release-rail pieces carry over | the rail is 16,000 lines; most is bookkeeping, some is hard-won safety |
| The parity checklist decisions marked "owner" in Part C | product scope |
| The independent review, the security pass, the cutover go or no-go | builder and grader must be different |

Everything else is Opus work inside a fixed contract with the acceptance tests above, or Sonnet work where
the table says so. Sonnet is right for: the host shims, the health readers, the generated documents, the
guard, test fixtures, and mechanical ports (coverage lists, exclusion data).

### A6. Order and rough size

| Stage | Contents | Builder days |
|---|---|---|
| 0 | Prepare the branch | 1 |
| 1 | Walking skeleton, contract frozen | 3 to 4 |
| 2 | Wave one: engine, installer, builder | 5 to 10 each, in parallel |
| 3 | Wave two: server, health, release rail, shims | 1 to 8 each, in parallel |
| 4 | Answer gate, migration, guard, documents | 2 to 4 each |
| 5 | Independent review and fixes | 3 to 4 |
| 6 | Soak on the owner's machine beside 4.7.28, then cutover | 7 days of real use, then Part B |

These are estimates, not measurements. The stage with the least certainty is the installer (stage 2) and
the answer gate (stage 4), because the first carries the most accumulated edge cases and the second depends
on the retrieval run's final recipe and instrument.

---

## Part B. Cutover: how version 5 replaces 4.7.28

Principle: version 5 becomes the release line of the same repository (`release/5.0.0` then `main`). One
release switches people over. A person who does nothing ends up on version 5 with their private stores and
their choices intact, or stays on a working 4.7.28. There is a way back for 14 days.

### B1. Before cutover (4.7.28 still serving everyone)

1. **Soak beside 4.7.28 on the owner's machine.** Version 5 is installed from a pre-release into its own
   home folder (`~/.cache/ruvnet-brain-5`) and registered with the hosts under a second plugin name, so both
   answer side by side for at least seven days. Its health line and the gate's number are watched daily.
   4.7.28's folders are not touched.
2. **Side-by-side numbers.** The answer gate is run on both through their real servers. Version 5 must clear
   the pre-registered rule; the table is published in the release notes.
3. **Dress rehearsal of migration** on three machine images (Linux, macOS, Windows) that hold a real 4.7.28
   installation, one of them with a private store. The rehearsal uses 4.7.28's own automatic path: a local
   package registry serves 5.0.0 as `latest`, a 4.7.28 session is started, and the machine is left alone.
   Pass: within the hour version 5 answers, or 4.7.28 still does. **To verify in this rehearsal:** whether
   4.7.28's updater refuses or mishandles a major-version jump (its update code was read only in part).
4. **The 4.7 line is frozen and kept releasable**: branch `maint/4.7` at tag `v4.7.28` (the hidden
   `maint-4.7` worktree). It receives only fixes that Part D lists.

### B2. The cutover release

| Step | What happens | Why this way |
|---|---|---|
| 1 | `release/5.0.0` is cut from `v5/rewrite` (which descends from `origin/main`), passes the version 5 rail including the answer gate, and `main` is fast-forwarded to it | same rule as every release: `main` only moves forward, by fast-forward |
| 2 | The npm package `ruvnet-brain@5.0.0` is published under a `next` tag first and installed by hand on the rehearsal images; then `latest` is moved | `latest` is what existing machines pick up |
| 3 | The 5.0.0 package keeps the old command names as thin entries: `ruvnet-brain --update --no-nightly-prompt`, `--doctor`, `--uninstall` and `bin/install.mjs` still exist and call the new verbs. Run with those old arguments and no terminal, the package performs the migration silently and safely | **This is how most machines will arrive, and it is automatic.** Every 4.7.28 session start, and a 15-minute timer in every open session, runs `npx --yes ruvnet-brain@latest --update --no-nightly-prompt` (`plugin/scripts/host-update.mjs:138`, `automatic-update.mjs:140-141`); the 03:30 job runs the installed package's `bin/install.mjs --update`. So within about an hour of npm `latest` moving to 5.0.0, every machine with a session open runs version 5's code unattended. That entry must therefore never ask a question, never leave 4.7 broken, and do nothing irreversible until version 5 has passed its probes on that machine |
| 3a | The signed release manifest carries a `migrate` field (on or off). The compatibility entry reads it before doing anything | npm `latest` cannot be rolled out to a few machines first. This field is the owner's brake: with it off, 5.0.0's compatibility entry leaves a 4.7 installation exactly as it is. Turn it on for the owner's machines first (by a local override), then for everyone |
| 4 | On first run on a machine that has 4.7, version 5 runs the migration (WP 9): install version 5 beside the old knowledge folder, verify by probes, switch the host registrations, remove 4.7's scheduled job, carry private stores and opt-outs, keep the old folder | nothing is removed until version 5 has answered its probes on that machine |
| 5 | The plugin on `main` is now the version 5 shim. A person who gets the new plugin from the host's marketplace before the migration has run sees the health line `NOT INSTALLED · run: npx ruvnet-brain install` and the same sentence from `search_ruvnet` | a shim without its engine must say exactly what to do, in one line. This is the one case where a working 4.7 search is replaced by a message: a machine that has automatic updates off and updates the plugin by hand. It costs that person one command |
| 6 | The 4.7 nightly corpus keeps publishing from `maint/4.7` for 30 days for machines that have not migrated. The version 5 pack is published under its own release names and is never marked as the repository's latest release in the old corpus format | 4.7.28 clients read "latest release" to find their corpus; a version 5 pack must never be offered to them. **To verify in WP 6 before cutover:** the 4.7 nightly resolves "the newest vX.Y.Z release" as its runtime (CONTRIBUTING.md, "Published nightly"); a v5.0.0 release would be picked up by that rule. Either the 4.7 nightly is pinned to v4.7.28 on `maint/4.7` first, or it is switched off at cutover with the kill switch that already exists (`CORPUS_NIGHTLY=off`) |

### B3. The way back

- **Per machine, 14 days:** `ruvnet-brain rollback-to-4` re-registers the 4.7.28 plugin from the kept folder
  and switches version 5 off. The old folder is removed only after 14 days of version 5 health `ok`, and
  only by the updater's normal one-earlier-generation rule.
- **For everyone:** npm `latest` can be moved back to 4.7.28 and `main` can be moved forward to a commit
  that restores the 4.7 tree (a new release, 4.7.29, from `maint/4.7`). This is why `maint/4.7` stays
  releasable until the 30 days are over.
- **Trigger for going back:** the answer gate's number on shipped bytes below the rule; or more than a
  stated share of migrated machines reporting `down` (only measurable for people who file issues, since
  version 5 sends no telemetry; the owner's own machines are the canary).

### B4. What carries over to a user's version 5 installation

| From 4.7.28 | Carried? | How |
|---|---|---|
| Private and locally ingested stores | Yes | their passage text is read from the old store's text file and indexed into `private/<name>/`; the old files are kept untouched |
| "No" to automatic updates; brain switched off | Yes | read once by migration, written to `state/config.json` |
| Brain moved to another disk | Yes | version 5's home is created next to the old one on the same disk, behind the same link |
| Public knowledge | No, replaced | the version 5 pack is a different format; it is downloaded |
| Downloaded models | No | day one uses none; later lanes ship their model in the pack |
| The 03:30 scheduled job | Removed | version 5 has no scheduled jobs; migration unregisters it |
| Model-router folder, lessons, turn history in project memory, console settings | Left in place, no longer used by the Brain | they belong to other tools or to the owner toolkit; migration does not delete user data it does not own, and lists what it left |
| Grounding stamps, receipts, logs | No | not needed |

---

## Part C. Parity checklist: every user-visible capability of 4.7.28

Decision: **KEEP** (in version 5 core), **CHANGE** (kept, different shape), **MOVE** (out of the product,
into an owner-only toolkit that is not shipped to customers), **DROP**. "Owner" marks decisions that are
product scope and should be confirmed by the owner; the recommendation is given and the build does not wait.

### Search and answers

| 4.7.28 capability | Decision | In version 5 |
|---|---|---|
| `search_ruvnet` tool, same name | KEEP | same name; sections; capped |
| Answers cite repository and path | KEEP | plus commit, lines, standing, date |
| `k` parameter | CHANGE | replaced by `detail: brief or full`; `k` accepted and ignored with a note for one release |
| Cards that answer without searching; router that may decline; "name a repo" refusals | DROP | no router, no card answers |
| Evidence grade ("strong, ok, thin, insufficient") from reranker cut-offs | CHANGE | typed "no match" with nearest capabilities; no hidden threshold |
| Injection fence around corpus text | KEEP | random marker per response |
| Search of the owner's private stores | CHANGE | only in listed projects |
| 20 to 150 second first search, multi-GB warm worker | DROP | no model warm-up on day one |
| `ruvnet_cli_help`, `ruvnet_cli_run`, `ruvnet_registry_latest` tools (run rUv command-line tools from the AI) | MOVE (owner) | not search; one of them can run destructive commands. Recommend the owner toolkit |

### Install, update, health

| 4.7.28 capability | Decision | In version 5 |
|---|---|---|
| `npx ruvnet-brain` install; signed bundle required | KEEP | `ruvnet-brain install` |
| `--update`, `--doctor`, `--uninstall`, `--clean`, `--move-brain` | KEEP | as verbs; old spellings accepted |
| Doctor with one verdict and one command per problem | KEEP | and it now tests the real search path |
| Automatic knowledge updates | CHANGE | from inside the running server; no scheduled job; one off-switch that works |
| 03:30 nightly job that can also update other global tools (ruflo and others) | DROP from the product; MOVE the "keep all my tools updated" coordinator (owner) | updating other people's tools is not the Brain's job |
| Session-start banners (health, knowledge age, footprint, hook failures, issue counts, restart notices) | CHANGE | one health line per prompt |
| Phone page when search is down | KEEP | opt-in topic, same damping |
| Footprint guarantee (one copy, bounded) | KEEP | by construction: pointer file plus one earlier generation |
| Rollback protection (never install an older corpus) | KEEP | |
| Telemetry ping | DROP | none in 5.0 |
| Works on Linux, macOS, Windows; Claude Code and Codex | KEEP | |
| Grok host | DROP at 5.0 (owner) | add later as one adapter if wanted |

### Hooks and behaviour shaping

| 4.7.28 capability | Decision | In version 5 |
|---|---|---|
| Write gate: no rUv-product code without a fresh search | CHANGE (owner) | optional guard, off by default, cannot block when search is not ok |
| Prompt-time grounding injection (long guidance text, package recommendations, memory recall) | DROP in core; CHANGE to one short skill | the skill says when to search; no text injected per prompt except the health line |
| Grounding stamps and receipts | DROP | the guard checks the session's own search record |
| Stop-time checks: completion claims, promise ledger, no-deferral, capability-claim grounding | MOVE (owner) | these enforce the owner's working rules; they are not search |
| Decision-record and ADR gates, duplicate-code gate | MOVE | this repository's own development rules |
| Turn capture, project checkpoints, lessons, learning observations, memory recall at session start | MOVE (owner) | Ruflo memory features; a separate plugin if the owner wants them |
| Capacity-aware parallel-work hint, unprompted-speech, advocacy and package recommender | MOVE or DROP (owner) | not search |
| Main skill (45 KB, triggers on "any request to build") | CHANGE | one short skill, rUv topics only |
| Skills: brain-score, brain-build, brain-prompt, savings, release-proof, whats-new | MOVE (owner); `whats-new` DROP | owner toolkit |
| Commands: `/rnbc`, `/rnb`, `/rvbc`, `/rvcb`, `/brain-console`, `/configure`, `/checkpoint`, `/rnb-brief`, `/whats-new` | CHANGE | one `/brain` status command; old names print one line pointing to it for one release |

### Bolted-on systems

| 4.7.28 capability | Decision | In version 5 |
|---|---|---|
| Console (`/rnbc`): a local page showing the stack with one-click fixes | MOVE (owner) | owner toolkit; `ruvnet-brain status` covers the Brain itself |
| Model routing (launchers, `~/.claude/model-router`, catalog, flywheel, proxy) | MOVE (owner) | a separate product if kept |
| Savings and token ledgers | MOVE | |
| Issue watch, issue fix, unattended issue autofix, ntfy inbox | MOVE | maintainer tools; never shipped to customers |
| Local ingestion of a repository (`ingest-repo`) and private overlays | KEEP, later | `ruvnet-brain add <path or repo> --private` builds a private pack with the same builder |
| Meeting transcript ingestion | KEEP, later (owner's machine) | same command with a transcript extractor |

### Maintainer side

| 4.7.28 capability | Decision | In version 5 |
|---|---|---|
| Nightly corpus in CI, "one bad source never stops the night", retry, kill switch, watchdog page | KEEP | |
| Signed, sealed, exact-commit release with three-system install verification | KEEP | |
| Version and census stamping across files; single-source and claims scanners; review-row bookkeeping | DROP | one version file; documents generated |
| `eval-brain`, repo-recall, the "In the X repository" canary questions | DROP | replaced by the answer gate |
| 944 test files | DROP | new behaviour suite |
| 102 ADRs, root proof and briefing files | ARCHIVE | kept at tag `v4.7.28`; version 5 has a short decision log |

---

## Part D. 4.7.28 while it keeps serving

The owner's decision is that 4.7.28 stays untouched. Two things are worth knowing, stated once each:

1. **The Homebrew defect is still live for every 4.7.28 user.** Any upgrade that replaces the Node program
   takes search down in every open session until the session is restarted, with a message that does not name
   the cause (`plugin/mcp/server.mjs:224`, `:256`). An uncommitted fix exists in the worktree
   `.claude/worktrees/agent-a6c1c5d90aaa85198` (a Node chosen at start time with fallbacks, a search canary,
   a "search is down" notice; about 1,000 lines with tests, not reviewed by this run). If version 5 is more
   than a few weeks away, shipping that one fix as 4.7.29 from `maint/4.7` is the single exception worth
   making. This is the owner's call.
2. **Everything else in `DEFECTS.md` is fixed by replacement, not by patching.** The defect list is the
   acceptance checklist for version 5: each defect names the version 5 test that makes it impossible.

No other work on 4.7.28 is recommended.
