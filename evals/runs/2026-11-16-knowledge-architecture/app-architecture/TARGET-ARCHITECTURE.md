Updated: 2026-11-17 00:50:00 EST | Version 1.0.0
Created: 2026-11-17 00:40:00 EST

# RuvNet Brain 5: target architecture

Status: a design. Nothing here is built. It is the design of version 5 as a rewrite on branch `v5/rewrite`,
made to replace 4.7.28, which stays untouched and keeps serving until version 5 is proven. Facts about 4.7.28
cited here are in `APP-ARCHITECTURE-REVIEW.md` and `DEFECTS.md` (same folder). The build order is in
`ROADMAP.md`. The retrieval recipe itself (what is stored, how it is ranked) belongs to the retrieval run
(`../REPLAN.md`, `../architecture/ARCHITECTURE.md`, `../ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md`); this
document defines the socket it plugs into and does not choose it.

Plain-word glosses: a **pack** is one complete, signed copy of the knowledge (text, indexes, model files).
The **engine** is the code that answers a question from a pack. The **shim** is the few files the AI host
(Claude Code, Codex) loads. A **probe** is a question whose right answer is known in advance. A **lane** is
one way of finding candidates (keywords, history, meaning).

---

## 1. The design in one page

**The job.** A person describes a problem. The Brain returns correct, cited knowledge about what rUv has
built: fast, on their own machine, every time. Everything in version 5 is either on that path or it is not in
the product.

**Seven decisions that make it dependable.**

1. **Five parts, one direction.** Builder (in CI) makes a pack. Release rail signs and publishes it.
   Installer puts it on the machine. Engine answers from it. Shim connects the engine to the AI host. Each
   part talks to the next through one written contract (four small JSON formats, section 4). Nothing else.
2. **The search path starts no programs.** 4.7.28 lost search for a day because a long-running server
   remembered the path of a Node program that Homebrew later replaced (`plugin/mcp/server.mjs:224`). In
   version 5 the server answers inside its own process (a worker thread), so there is no remembered path to go
   stale. Nothing in the product writes a Node path into a file, a scheduled job or a setting. There are no
   scheduled jobs on a customer's machine at all.
3. **A safe mode that needs nothing but Node itself.** The keyword lane and the history lane use the SQLite
   that is built into Node. If the model-based lanes cannot load, or the worker dies or runs out of time, the
   server answers from the keyword lane in its main thread and says so in the result. Search degrades; it
   does not go dark.
4. **One honest health signal, read by everyone.** One function decides "ok, degraded or down" from one fact:
   did a real search, through the real entry point, just return the known right answer. The same verdict is
   shown to the AI on every prompt (one short line), printed by `doctor`, checked by the installer before it
   says "installed", checked by the updater before it switches packs, and checked by the release rail on
   three operating systems before a release is promoted. There is no second definition of healthy.
5. **An update that cannot silently break.** Download, verify the signature, verify every file, run the
   probes against the new pack, and only then switch one pointer file. The previous pack is kept until the
   new one has served. If the probes fail after the switch, the pointer goes back by itself and the health
   line says what happened. No `npm install` ever runs on the user's machine.
6. **A recipe of record.** One file, `recipe/RECIPE.json`, is the only place that says how knowledge is cut,
   indexed and embedded. The builder and the engine both load it; neither contains a model name or a chunk
   size of its own. It is copied into every pack, the engine refuses a pack whose recipe it does not
   understand, and the human-readable `docs/RECIPE.md` is generated from it. The recipe cannot be lost again
   because nothing works without it.
7. **A size budget, enforced.** The product is capped at about 13,000 lines of code outside tests (4.7.28:
   about 157,000, of which the search path is 7,700). A result is capped at a fixed number of characters and never sends the same text twice.
   Both caps are checked by tests that fail when they are exceeded.

**What version 5 deliberately is not.** It is not a working-rules enforcer, a memory recorder, a model
router, a console, a telemetry client or an issue-fixing robot. Those exist in 4.7.28; the parity checklist in
`ROADMAP.md` says, one by one, which are kept, which move to a separate owner-only toolkit, and which stop.

---

## 2. The parts

```
                 CI (GitHub Actions)                         |            the user's machine
                                                             |
 rUv's public repos, gists, history                          |
        |                                                    |
        v                                                    |
 +-------------+   pack    +--------------+  signed release  |  +-------------+   pointer   +-----------+
 |  BUILDER    | --------> | RELEASE RAIL | ---------------> |  |  INSTALLER  | ----------> |  ENGINE   |
 | recipe-driven|          | sign, verify,|  (app + pack +   |  | install,    |  current.json| open pack,|
 | chunk, index,|          | probe on 3 OS|   manifest)      |  | update,     |             | search,   |
 | make probes  |          | promote/roll |                  |  | doctor,     |             | self-test |
 +-------------+           +--------------+                  |  | uninstall   |             +-----+-----+
        ^                         ^                          |  +------+------+                   |
        |                         |                          |         |                          v
   recipe/RECIPE.json       answer gate (blind               |         |  status files     +-----------+
   (one source)             questions, real entry point)     |         +------------------>|   SHIM    |
                                                             |                             | MCP server|
                                                             |                             | + 1 hook  |
                                                             |                             +-----+-----+
                                                             |                                   |
                                                             |                        Claude Code / Codex
```

### 2.1 Engine (the core)

One library with three calls:

- `open(packDir)` checks the pack manifest and recipe, opens the files, and reports which lanes are usable.
- `search(query, options)` returns a result object (section 4.2). It always finishes inside a hard deadline.
- `selfTest()` runs the pack's own probes and returns the health verdict (section 3).

Rules:

- The engine is a pure function of (pack, query, options). It reads no environment variables, no settings
  files and no other folder. It writes nothing. This is what makes it testable and what makes
  "the same question returns the same answer" checkable across processes.
- Lanes are plug-ins named by the recipe. Day one: `lexical` and `history`, both on Node's built-in SQLite
  (measured on this machine: Node 24.22.3 opens an FTS5 full-text table and ranks with `bm25` using only
  `node:sqlite`, no installed package). Later, as the retrieval run admits them: `cues` (short vectors on
  capability and need sentences), `rerank`, `graph`. A lane that needs native code is optional by
  construction: if it fails to load, `open` reports it unavailable, search continues without it, and the
  result and the health line both say "degraded: lane X unavailable".
- There is no router that can decline to search, no card that answers in place of a search, and no code that
  recognises the wording of a particular question. A test fails if any string from the question sets appears
  in engine code (the retrieval run's rule 9).
- "A store" is whatever the pack manifest lists. No part of the product recognises knowledge files by their
  suffix. (4.7.28 defines a store by `*.rvf` in at least nine places; a new file type has to be registered in
  each or it is dropped, deleted or refused.)
- Private knowledge (the owner's meetings, client material) lives in separate private packs and is searched
  only in projects the owner has listed for it. The check is made at question time, in the engine's caller,
  and is tested. (4.7.28 fences private stores when it builds a bundle and not when it answers.)

### 2.2 Shim (what the AI host loads)

The plugin shrinks to: a server launcher, one hook, one skill, one command.

- **MCP server.** One stable process per session, started by the host with `node` from PATH. It owns the
  protocol and two tools: `search_ruvnet` (name kept, so existing habits and instructions keep working) and
  `read_ruvnet` (fetch a named file span from the pack, so a result can stay small and the AI can ask for
  more). It loads the engine from the installed app folder named by the pointer file, in a **worker thread**.
  - No child process is started on the search path. A worker thread uses the Node already in memory.
  - Every search has one deadline (proposed 10 seconds). At the deadline the worker is ended, a new one is
    started for the next call, and the main thread answers from the keyword lane ("safe mode").
  - When the pointer file changes (an update), the server starts a new worker on the new app and pack between
    calls. A call in flight finishes on the old one. No restart of the AI host is needed for a knowledge or
    engine update. Only a change to the shim itself needs a new session, and the shim is small and changes
    rarely.
  - Lanes that run native code (when admitted) run in a separate helper process, started with a Node that is
    chosen and tested at the moment of starting (first the current program, then `node` on PATH, then the
    usual install locations), never one remembered from earlier. If no helper can start, that lane is
    reported unavailable. This keeps a crash in native code from taking the server down.
- **One hook, at prompt time.** It prints the health line (section 3) and nothing else. It is one Node
  process, reads one small file, starts nothing, and has a time budget of 150 ms. The hook command carries
  its own fallback, so a Node that cannot start still produces a line:
  `node "<shim>/health-line.mjs" || echo "[RuvNet Brain] DOWN: Node could not run. Search is unavailable. Fix: run 'node -v' in a terminal; reinstall Node if it fails."`
- **One skill, short.** When to use `search_ruvnet`, how to read a result, how to ask for more. Under 4 KB,
  triggered by rUv topics, not by "any request to build".
- **One command.** `/brain` prints status and the three things a person can do (search, update, doctor).
- **Optional guard (off unless switched on).** The "do not hand-write what rUv already ships" write check is
  the owner's original reason for the product, so it stays available, rebuilt so it cannot trap a session:
  it reads the health verdict first and turns itself into a one-line advisory whenever search is not ok; its
  override is a line the AI can put in the file it is writing (no relaunch); it is never armed by the
  installer. It is a separate small package (section 6), not part of the core.

### 2.3 Installer (one small command)

`ruvnet-brain install | update | doctor | status | uninstall | config`.

Layout on disk (one folder, movable to another disk by a symlink as today):

```
<brain home>/
  current.json              one pointer: { app: "5.0.3", pack: "g-2026-11-17-ab12…" }  (replaced by rename)
  app/<version>/            engine + server code for that version, never edited after install
  packs/<generation>/       PACK.json, RECIPE.json, PROBES.json, the index and text files, model files
  private/<name>/           the user's own packs; update and uninstall never touch them without --purge-private
  state/                    status/<pid>.json, update.json, config.json, one bounded log
```

- **Install** = download the signed release manifest, download the app and the pack with resume, check
  signature and every file's hash while streaming (no whole-file reads, so no 2 GiB limit), run the probes,
  write the pointer, register the shim with each host found, run the probes again through the real server,
  and only then print "installed". It says how much it will download and how much disk it needs before it
  starts, and asks once.
- **Everything it writes is inside the brain home, plus the host's own plugin registration.** No model-router
  folder, no shell profile edits, no scheduled jobs, no settings beyond the plugin entry. The list of what it
  writes is generated from the code and printed by `install --plan`.
- **Update** is the same code path as install with a different starting point. It runs: by hand
  (`ruvnet-brain update`); and automatically from inside the running server (a timer, at most once every few
  hours, in a worker, never during a search). There is no launchd agent, cron entry or Windows task. A
  machine with no AI session open does not update, and does not need to: the check runs when the next session
  starts, in the background, while the old pack keeps answering.
- **One off-switch.** `ruvnet-brain config auto-update off` writes one field in `state/config.json`. The
  updater has one entry point and reads that field there. A test proves that with the switch off no network
  request is made.
- **Rollback is built in.** The previous app and the previous pack stay on disk until the new ones have
  passed the probes after activation and have answered real searches for a day. If the post-switch probes
  fail, the pointer is put back and the failure is recorded for the health line. Exactly one earlier
  generation is kept; older ones are removed by the same command that activates a new one. That is the whole
  footprint rule.
- **Uninstall** lists what it will remove, leaves `private/` unless told otherwise, removes the host
  registrations, and then checks the list again and prints what, if anything, remains. It never prints
  "clean" from memory.
- **No package installation on the user's machine.** The app folder is shipped complete. Day one it has no
  third-party code at all (Node built-ins only). When a lane needs a library (the embedding runtime, the
  RVF reader), that library is built into the app in CI, once per operating system and processor, and
  verified there. (4.7.28 runs `npm ci` inside the knowledge folder and has lost search to a wiped
  `node_modules` and to npm skipping native build steps.)

### 2.4 Builder (CI only)

One program, driven entirely by `recipe/RECIPE.json`:

1. **Discover** rUv's public sources (the existing coverage list and exclusions carry over).
2. **Fetch** each at a recorded commit.
3. **Extract** units as the recipe says (passages with a path header, history items, later cues and tags).
   One extractor per kind of unit, one chunker. (4.7.28 has four chunkers and three embedder set-ups.)
4. **Screen** every unit: a secret scanner, and a hostile-text flag for known prompt-injection fixtures.
   Flagged units are not served.
5. **Index** into the pack's files.
6. **Make probes**: for each lane, a small set of questions with the file that must come back, checked at
   build time against the pack just built. Probes test "the machinery works on this machine"; they are not
   the quality measure.
7. **Assemble** `PACK.json` (every file with size and hash, the recipe's hash, counts, the source commits).
8. **Answer gate** (section 5) on the assembled pack.

The "one bad source never stops the night" rule from 4.7.28 carries over as it is: a source that cannot be
read is carried at its last good bytes and named in the manifest, up to a bound. It is one of the best ideas
in the current system.

Incremental builds: a unit is rebuilt only when its source commit or the recipe hash changes. Changing the
recipe hash rebuilds everything, by design.

### 2.5 Release rail (CI only)

One workflow, used for both app releases and nightly packs:

1. Build the exact commit once. Seal the payload (app archive, pack, release manifest). Sign once. Nothing is
   rebuilt after signing.
2. Publish as a pre-release that no installed machine will pick up.
3. **Install and probe** the staged bytes on Linux, macOS and Windows, through the real installer and the
   real server, for each supported host. This is the same health verdict as section 3. It happens before
   promotion. (In 4.7.28 a code release is already "latest" when this check starts, and the nightly
   knowledge is promoted after a check that never searches.)
4. **Answer gate** (section 5).
5. Promote. If promotion fails part-way, put the previous release back.
6. A watchdog workflow pages the owner when no night has ended "published" or "no change" in 48 hours.

Kept from 4.7.28 because they are sound: the sealed and signed payload, the exact-commit rule, stage then
promote with restore, install verification on three operating systems, the nightly dispatcher with its retry
and kill switch, the watchdog. Not carried over: stamping counts and version numbers into many files and then
checking they agree; review-row bookkeeping; scanners that compare prose across documents. Version 5 has one
version number in one file and everything else reads it.

---

## 3. The health signal

**One fact.** "A real search through the real entry point returned the known right answer just now."

**One function.** `verdict(evidence) -> { state: ok | degraded | down | not-installed | unknown, since,
reason, fix }`. It lives in one small module with no dependencies and is the only code allowed to produce
those words.

**Evidence, in order of strength.**

| Evidence | Produced by | When |
|---|---|---|
| Probe result | the engine's `selfTest()` run by the server | at server start, after every pack or app switch, and every 30 minutes while idle |
| Real search outcome | the server, after every `search_ruvnet` call | on each call: finished inside the deadline, at least one lane answered, no internal error |
| Heartbeat | the server | every 60 seconds, a timestamp in its own status file |

Each server writes only its own file, `state/status/<pid>.json`, by write-then-rename. Nothing is shared and
overwritten. (In 4.7.28 one `health.json` is written by every session; during the earlier review it read
"ok" 18 seconds after a search had failed, because another session wrote it.)

**Readers. All call the same function.**

| Reader | What it shows | When |
|---|---|---|
| Prompt hook | one line, at most 160 characters | every prompt |
| `ruvnet-brain doctor` | the verdict and the probe table; exit code 0 only for `ok` | on demand |
| Installer and updater | refuse to say "installed" or to keep a new pack unless `ok` | every install and update |
| Release rail | refuses to promote unless `ok` on every operating system | every release |
| Owner page (opt-in) | a phone notification when the state has been `down` for five minutes; one when it recovers | only where a notification topic is configured |

**The line the AI sees on every prompt.**

```
[RuvNet Brain OK · knowledge of 16 Nov · search_ruvnet ready]
[RuvNet Brain DEGRADED since 3:31 a.m. ET · keyword search only (meaning lane failed to load) · fix: ruvnet-brain doctor]
[RuvNet Brain DOWN since 3:31 a.m. ET · pack failed its self-test after update; previous pack restored failed too · fix: ruvnet-brain install --repair]
[RuvNet Brain NOT RUNNING · the search server did not start in this session · fix: run 'node -v'; then restart the session]
```

Rules that keep it honest:

- The line is printed on every prompt, healthy or not, so a missing line means the hook is not running, not
  that all is well. It costs about 25 tokens.
- "OK" requires a live server (its process exists and its heartbeat is under three minutes old) whose last
  probe passed. A stale heartbeat is `unknown`, never `ok`.
- When several sessions are open the hook shows the worst state among live servers.
- When the state is not `ok`, the optional guard is advisory, and the line says so. A health problem can
  never block the user's work.
- The line never contains more than the state, since-time, one reason and one command. No history, no
  instructions to the model beyond that.

**What it does not claim.** `ok` means the machinery works and answers its probes. It does not mean answers
are 98% right; that is the answer gate's number (section 5), printed by `ruvnet-brain status` as
"this pack scored N of M on the blind set" with the date, and never rounded up into the health line.

---

## 4. The four contracts

Every boundary between parts is one of these files. Each has a JSON Schema in `packages/contract/`, a version
number, and a test that a part rejects a file it does not understand with a plain message.

### 4.1 `RECIPE.json`: the recipe of record

Everything that decides what a pack contains and how a question is matched: unit kinds; the chunker's name,
version and limits; which folders and file types are read; the text analyser for the keyword lane; for each
model, its name, exact revision, precision, pooling, prefixes and input limit; the lanes and their order; the
result sections and their budgets; the deadline. Loaded by the builder and by the engine. A test fails if a
model name, a revision hash or a chunk size appears in code outside this file. `docs/RECIPE.md` is generated
from it; the release fails if regenerating it changes the committed copy. The pack carries a copy and its
hash; `doctor` and `status` print the hash.

### 4.2 The result: sections, capped, never duplicated

```
search_ruvnet({ query, detail?: "brief" | "full" })

RuvNet Brain · knowledge of 2026-11-16 · recipe r7 · lanes: lexical, history   (or: SAFE MODE, keyword only)

CAPABILITIES   (when the cue lane exists) what the problem maps to, each with standing and package
FILES          up to 5: repo, path, lines, commit, standing, date, then an excerpt
HISTORY        up to 3: commit / issue / release, date, one-paragraph excerpt
MORE           one line per item: read_ruvnet({ ref: "repo/path#L120-260" })
NOTE           the authority order; what was not searched; "no match" with the nearest capabilities when weak
```

- Hard cap on the whole result: 24,000 characters for `brief` (the default), 60,000 for `full`. One
  formatter enforces it and trims excerpts evenly; a test feeds it oversized input and fails if the output
  exceeds the cap. (4.7.28 returned 51,000 to 65,000 characters and the host delivered nothing.)
- Text is sent once. There is no second structured copy of the same documents.
- Every excerpt from the corpus is inside a fence whose marker is random per response, so text inside a
  passage cannot close the fence.
- Every item cites a path and commit that exist in the pack; the formatter refuses an item that does not.
- "No match" is a normal, typed answer with its own wording. There is no threshold that hides results.
- The default of `k` means what it says. (4.7.28 advertises "default 6" and treats an ordinary call as a
  request for one.)

### 4.3 `PACK.json`: what a pack is

Generation id, build time, recipe hash, source commits, and a list of every file with role, size and hash.
Roles are an open list (`lexical-db`, `history-db`, `cue-vectors`, `graph`, `model`, `probes`, ...). The
installer, the engine, the footprint check and the uninstaller read this list and nothing else. Adding a new
kind of file is one new row.

### 4.4 `release.json`: what a release is

App version and archive (per operating system when needed), pack generation and files, a release number that
only goes up, the smallest shim version that can run them, and one signature over the whole file. Because the
version and generation are inside what is signed, an older signed release cannot be replayed as new. (In
4.7.28 the signature covers only the archive's hash; "is this older?" is read from an unsigned description.) The public key ships in the shim and the
installer. Signature checking has no off-switch in shipped code.

---

## 5. The answer gate

4.7.28 shipped green for six weeks while finding the right file for about 4% of blind questions, because no
release check measured answers: the recall floor was set to zero, the exam script was called by no workflow,
and 37 of the exam's questions were also fixtures in the product's own tests. Version 5
has one gate on answers, and it is the retrieval run's instrument, not a new one:

- **What it asks.** The blind, file-level question set the retrieval run is building (amateur and expert
  questions reported separately; gold confirmed by a second author). The questions are kept outside the
  product repository so product code cannot be written against them.
- **How.** Through the real `search_ruvnet` entry point of the packed, signed release on a clean machine.
- **The rule.** Fixed before the run, in the retrieval run's pre-registration. A release whose score falls
  below the last promoted release by more than the stated margin is not promoted. The first version 5 release
  must beat 4.7.28 on the same questions by the margin the retrieval run sets.
- **The number is published.** `status` prints it. The README states it with its date and question count.

This document does not set the thresholds. It requires that exactly one exists, that it is file-level or
answer-level, that it runs on the shipped bytes, and that nothing in the release can pass without it.

---

## 6. Repository layout and size budget

This is the repository root on branch `v5/rewrite` of the one project folder
(`/Users/stuartkerr/Code/ruvnet-brain`). There is no second repository or folder. The 4.7 tree is not on
this branch; it stays reachable at tag `v4.7.28`. Builders work in hidden worktrees under
`.claude/worktrees/` and merge back into `v5/rewrite`.

```
recipe/              RECIPE.json, its schema, the generator for docs/RECIPE.md
packages/
  contract/          the four schemas, the verdict function, shared constants        (budget   600 lines)
  engine/            open, search, selfTest; lanes/lexical, lanes/history, ...       (budget 2,500)
  server/            MCP shell, worker, safe mode, deadline, formatter, read tool    (budget 1,200)
  health/            status writer, readers, doctor table, owner page                (budget   500)
  cli/               install, update, uninstall, config, storage transaction         (budget 2,500)
  builder/           discover, fetch, extract, screen, index, probes, assemble       (budget 3,000)
  release/           seal, sign, verify, publish, promote, canary driver             (budget 1,200)
  plugin/            host shims for Claude Code and Codex: launcher, hook, skill     (budget   400)
  guard/             optional write guard                                            (budget   400)
  migrate/           one-time import from a 4.7 installation                         (budget   500)
tests/acceptance/    behaviour tests per package, run on three operating systems
docs/                ARCHITECTURE.md, RECIPE.md (generated), SECURITY.md (tables generated from code)
.github/workflows/   ci.yml, release.yml, nightly.yml, watchdog.yml
```

- Total budget about 12,800 lines outside tests. A check in CI counts lines per package and fails over
  budget; raising a budget is a reviewed change to one file.
- Each package has one owner while it is being built and imports only `contract` and the packages below it.
- Tests exercise behaviour through public entry points. A test that reads product source as text and asserts
  on a string is not accepted (in 4.7.28, 50 test files assert on source text without ever running the code).
- Documentation that states a fact about behaviour (what runs automatically, what is written where, what is
  sent over the network) is a table generated from the code that does it, so it cannot drift.
  (4.7.28's SECURITY.md describes scripts that are not registered and an update policy the code does not
  follow.)

---

## 7. How the retrieval recipe plugs in

The retrieval run decides the recipe. Version 5 gives it four fixed sockets and nothing else to touch:

| The retrieval run supplies | Where it goes | What the rest of the product does with it |
|---|---|---|
| The recipe (units, chunker, analyser, models, lanes, budgets) | `recipe/RECIPE.json` | builder and engine obey it; packs carry it |
| Extractors and index builders for each unit kind | `packages/builder/extract/*`, `index/*` | run in CI; output files are listed in `PACK.json` |
| Lanes (`search(query) -> candidates`) and the section assembler | `packages/engine/lanes/*`, `assemble.mjs` | called inside the worker, under the deadline; the formatter caps the output |
| The blind question set and the pass rule | outside the repository; the gate reads it in CI | the release rail will not promote without it |

Stages, matching the retrieval run's own build order:

1. **Day one: FILES + HISTORY.** Rebuilt passages with a path header, a keyword index over all passages, a
   history index. No vectors, no model, no native code. This is the part the retrieval run has already
   admitted on three blind question sets, and it is exactly the part that needs nothing but Node.
2. **Cue layer** (short need and capability sentences with small vectors, links to files): added as a lane
   and extra pack files when it passes its rule. The embedding model ships inside the pack, so there is no
   download on first use and no network at question time.
3. **Re-ranker, graph walk, abstention model, learned shortcuts**: each is one more lane or one more step in
   the assembler, admitted by its own rule. Learning from use, if admitted, is written to a branch in
   `private/`, never into the signed pack.

### Build, update and footprint on a normal machine

| Question | Version 5 answer | Measured or projected |
|---|---|---|
| How big is the download? | Text and keyword index for the whole corpus | projected about 2.3 GB on disk by the retrieval run; 4.7.28 is 0.9 GB zipped, 1.5 GB unpacked |
| How big with the cue layer? | plus about 0.3 GB of vectors and a 34 to 133 MB model | projected by the retrieval run |
| How much disk during an update? | new pack beside the old one, then the old one is removed after a day: about twice the pack at peak | by design; 4.7.28 needs about four times |
| Does a nightly update download everything? | No. Pack files are split by source repository and named by their hash; an update fetches only files whose hash changed and reuses the rest | by design; to be measured in work package 6 |
| How is one keyword index kept over files split by repository? | The global index is built on the machine from the per-repository text files at install, and adjusted for changed repositories at update. It is derived data: if it is damaged, `doctor --repair` rebuilds it from the verified files | **decision to measure before committing**: time to index the full corpus on a small CI Mac. If it is over ten minutes, ship the prebuilt index instead and accept larger updates |
| Memory while idle | no model in memory on day one; a few tens of MB | 4.7.28's worker holds 3 to 15 GB by its own comment |
| Time for a search | keyword lane measured by the retrieval run at 1.8 s on rebuilt passages; target under 2 s, deadline 10 s | 4.7.28: 5 to 34 s under load |
| First search after install | no model warm-up on day one | 4.7.28: 20 to 150 s cold |
| Works offline? | yes, always; the pack is complete | 4.7.28 downloads models on first use |

rUv-first rule for this layer: before any lane is written by hand, the builder of that lane checks what rUv
already ships for it (the RVF reader, the graph packages, the Lucene analyser, the darwin tuning loop) and
uses it where it exists. This document names none of them as settled because the Brain's own search was not
usable for checking during this review (it writes to the live installation, which this review was told not
to touch); the checks are listed as first steps in the relevant work packages.

---

## 8. Security and privacy, by construction

| Rule | How it is made true |
|---|---|
| Nothing runs from the user's project folder | the shim and hook never execute or import a path under the current project; a test plants a script and proves it is not run (4.7.28 runs `<project>/scripts/ascii-drift.mjs` at session start) |
| Nothing unsigned is activated | signature and hashes are checked before any byte is unpacked into a live folder; archive paths are checked for escapes |
| Corpus text is data, not instructions | random-marker fence; hostile fixtures flagged at build and not served |
| Private packs stay private | separate folder, never in a public build, searched only in listed projects, checked at question time |
| Nothing leaves the machine by default | no telemetry in 5.0. Network calls are the update check and download, to one host, listed in generated SECURITY.md. Questions and answers are not logged unless the user turns a local log on |
| No surprise writes | everything under the brain home plus the host's plugin entry; `install --plan` prints the list |
| No unattended code changes to the product | the issue-fixing job is not part of the product; if the owner keeps it, it runs from the owner toolkit and cannot publish |
| Updates come only from the signed release | the updater downloads a signed manifest and files from one host. It never runs `npx <package>@latest` (4.7.28 does, unattended, at session start) |
| Dependencies are fixed | no unpinned `npx` at run time; third-party code is built into the app in CI and listed in the software bill of materials |

---

## 9. Operating systems and hosts

- All shipped code is Node. No bash scripts in hooks (4.7.28's write gate and grounding hook are bash, which
  ties them to a Unix shell).
- Node 22.13 or later is required (built-in SQLite without a flag). The installer checks and says so in one
  line. (4.7.28 declares Node 18.)
- The acceptance suite runs on Linux, macOS and Windows for every change, not only at release.
- Hosts: Claude Code and Codex at 5.0. A host adapter is a launcher entry and a hook entry; the engine and
  server do not know which host is calling. Grok and others are added the same way when wanted.
- Moving the brain to another disk keeps working as today (a symlink at the default location; a plain
  "disk not mounted" line when it is unplugged).

---

## 10. What is reused from 4.7.28, what is rewritten, what is left behind

| From 4.7.28 | In version 5 |
|---|---|
| Sealed, signed payload; exact-commit publish; stage, promote, restore | reused, as one workflow |
| Install verification on three operating systems through a real host | reused; it becomes the health verdict run in CI |
| Nightly corpus dispatch, retry slot, kill switch, 48-hour watchdog, "one bad source never stops the night" | reused |
| Update as a recorded state machine with crash recovery | idea reused, rewritten smaller around one pointer file |
| Source coverage list, exclusions, external sources, gist capture | data and rules reused; code folded into the one builder |
| The stable server shell with a replaceable worker | idea reused; worker thread instead of a child program |
| Outage damping for phone pages (two failures five minutes apart, at most one page per six hours) | reused in `health/` |
| Plain one-line install errors; move-to-another-disk | reused |
| Retrieval helper modules (result schema, citation check, deadline) | ideas reused inside the engine; rewritten against the new result format |
| Router, cards that answer, per-question recognisers, reranker threshold, 384-number build, single-store server | left behind |
| 13 registered hooks, turn capture, lessons, completion and promise checks, duplicate gate, model routing, savings, console, advocacy, telemetry, issue robot | left behind in the core; see the parity checklist for each |
| 944 test files | not carried; a small behaviour suite is written with the code. The few real end-to-end tests (packed install, release transaction faults, live JSON-RPC search) are the models to copy |
| 102 ADRs, root proof files | archived with 4.7. Version 5 starts with this document, the recipe and a short decision log |

---

## 11. Risks in this design, stated plainly

1. **In-process search means a crash in the engine can end the server.** Day one has no native code, so the
   exposure is JavaScript errors, which a worker thread contains. When native lanes arrive they run in a
   helper process for this reason. If measurement shows worker threads are not enough, the fallback is a
   child process started with a Node chosen and tested at start time.
2. **Building the keyword index on the user's machine may be too slow.** Marked as a decision to measure; the
   fallback (ship the index) is already described.
3. **The health line costs a process start on every prompt.** Budgeted at 150 ms and tested; if a host makes
   it slower, the line can be moved to session start plus on-failure, at the price of the "missing line"
   property.
4. **Automatic updates run only while a session is open.** A machine left closed for a month starts on an old
   pack and updates in the background. The health line shows the knowledge date so this is visible.
5. **Node 22.13 or later** excludes users on older Node. The installer says so plainly; Node 20 reached end
   of life in April 2026.
6. **A rewrite can lose hard-won behaviour.** The parity checklist in `ROADMAP.md` exists so that every
   user-visible capability of 4.7.28 is either kept, moved or dropped on purpose, and none by accident.
7. **The retrieval recipe is not final.** This design depends only on its shape (packs of files, lanes that
   return candidates, sections in the result). If the final recipe needs something outside that shape, the
   contract package is where it shows up first.

## 12. What this design was not able to check

- No version 5 code exists; every "by design" above is a requirement with a test named in `ROADMAP.md`, not
  an observation.
- That Node's built-in SQLite full-text search behaves the same on Windows and Linux as on this Mac (checked
  here only on macOS, Node 24.22.3, SQLite 3.54.1).
- The keyword lane's analyser: the retrieval run used rUv's Lucene-style analyser; whether it can be applied
  as plain text processing before indexing (so no native tokenizer is needed) is a question for that run.
- How Claude Code and Codex behave when an MCP server's worker thread is replaced mid-session (expected to be
  invisible; to be proven in the walking skeleton).
- Whether a hook's `||` fallback line is delivered on Windows hosts.
