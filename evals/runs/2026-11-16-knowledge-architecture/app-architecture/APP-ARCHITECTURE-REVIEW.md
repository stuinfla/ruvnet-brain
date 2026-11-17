Updated: 2026-11-17 00:50:00 EST | Version 1.0.0
Created: 2026-11-17 00:48:00 EST

# RuvNet Brain 4.7.28: review of the whole application

Reviewer: Fable 5.2 as lead, read-only, with nine readers (four Opus, five Sonnet) each given one disjoint
part of the code. Retrieval design (chunking, embedding, ranking) is excluded: another run owns it. This
review covers everything else.

Defects are in `DEFECTS.md` and are cited here by ID (C = critical, H = high, M = medium, L = low). The
design that replaces all this is `TARGET-ARCHITECTURE.md`; the build plan is `ROADMAP.md`.

---

## 1. The result

**The product's job is to answer questions about rUv's work. About 5% of its code does that, and the other
95% has grown to the point where it hides when the 5% is broken.**

Measured on the 4.7.28 source:

| | Lines | Share of non-test code |
|---|---|---|
| The search path (question in, cited answer out) | 7,671 | 5% |
| Everything else in the knowledge folder (build, update, guards) | 10,800 | 7% |
| Plugin: hooks, gates, session start, memory capture, lessons | 36,200 | 23% |
| Installer | 7,850 | 5% |
| Scripts (release rail, issue robot, model routing, console server, tools) | 79,300 | 50% |
| Console pages | 10,000 | 6% |
| CI workflows | 4,700 | 3% |
| **Total outside tests** | **about 157,000** | |
| Tests | about 150,000 | |

Of the last 300 commits (12 to 30 October), 2 touched the five core search files, 49 the release rail, 117
the plugin and 189 the tests.

**Five findings that matter most.**

1. **Nothing in the product can tell that search is down, in the way search actually goes down.** There are
   at least eight health and status records. None is true exactly when a real search through the real server
   has just succeeded. The doctor tests a different program from the one that serves search, so it passed
   during the Homebrew outage and its success erased the outage record (C9). One shared health file is
   overwritten by whichever session wrote last (H6). The only warning a person gets is at the start of their
   next session, and that session has a fresh, working server, so the broken window is never told.
2. **The outage itself is still live.** The server starts its search worker with a remembered file path
   (C1), hangs for 60 seconds when the file is gone and reports "temporarily unavailable" (C2). While that
   lasts, the write gate refuses code edits and offers an override the AI cannot use (C3), and the gate is
   switched on for everyone by an installer step that is not described as doing so (C4).
3. **No release check measures answers, and two release paths reach users before they are checked.** The
   recall floor is zero (C5). The nightly knowledge update is promoted to every machine without one search
   being run (C6). A code release becomes "latest" before the three-system verification, and a failed
   verification does not undo it (C7). Machines then fetch "latest" by themselves at the next session start,
   whether or not the owner declined automatic updates (C8).
4. **The product does many things its user did not ask for.** A session start can run a script from the
   current project (H1). The 03:30 job upgrades other global tools (H5). The installer writes a
   model-routing system into the user's Claude folder unannounced (H13). Every finished turn's answer text is
   stored in the project's memory where one exists (H11). Thirteen hooks run; about 13 programs start for
   every file the AI writes (M1). The npm package ships 377 maintainer scripts, including an issue-fixing
   robot (H14). SECURITY.md describes a different product (H12).
5. **The project has three definitions of itself**, and the code follows the two that are not "answer
   questions": `docs/PRINCIPLES.md` says the product is "proactive at maximum" and "learning at maximum";
   `docs/VISION.md` says an autonomous engineering system (M22). That is where the 95% came from.

**What is good, and is carried into version 5:** the signed, sealed, exact-commit release; the nightly
corpus rule that one unreadable source never stops the night, with its retry, kill switch and watchdog; the
update as a recorded state machine with crash recovery; the fail-closed private fence at build time; the
stable server shell that swaps its worker only between calls; the paging rules that stop a flapping failure
from flooding a phone; plain one-line install errors. Roughly four in five tests in a 40-file sample
exercise real behaviour rather than pinning text.

**Scores** (out of 100; every deduction is listed with its evidence in section 4; an area with a known
serious structural flaw cannot score above 70):

| Area | Score |
|---|---|
| 1. MCP server and worker lifecycle | 45 |
| 2. Hooks, grounding and the write gate | 40 |
| 3. Session start, health and doctor | 42 |
| 4. Installer, updater, uninstall | 33 |
| 5. Release rail and CI | 37 |
| 6. Scheduler, nightly, watchdog, alerting | 50 |
| 7. Knowledge-build pipeline (plumbing only) | 44 |
| 8. Console | 68 (least certain: read least) |
| 9. Telemetry and counters | 53 |
| 10. Model routing, lessons, memory capture and other additions | 36 |
| 11. Test strategy | 51 |
| 12. Security and privacy | 32 |
| 13. Operating systems and hosts | 70 (capped; nothing was run on Windows or Linux) |
| 14. Footprint and install experience | 53 |
| 15. Documents and ADRs | 41 |

The plain mean is 46. These are judgements from reading code, with deductions shown; they are not
measurements of running behaviour.

---

## 2. How this review was done

- Code: a clean export of commit `0e7b9cfa` (4.7.28). The project folder itself was at 4.7.20 and then moved
  to branch `v5/rewrite` during the run; it was not used as the source.
- Nine readers each returned a report with file and line for every claim. The lead then opened the lines
  behind every critical and most high findings (marked V in `DEFECTS.md`); the rest are marked R.
- The lead read in full: `plugin/mcp/server.mjs`, `plugin/hooks/hooks.json`,
  `plugin/scripts/ground-before-write.sh`, `CONTRIBUTING.md`, the earlier review, and the retrieval run's
  architecture, re-plan, embedding-recipe and history-implications documents.
- Nothing was built, installed, searched or tested. Two tiny checks were run: Node's built-in SQLite
  full-text search works on this machine (for the version 5 design), and commit counts per area.
- The Brain's own search tool was not used to ground statements about rUv's tools, because calling it writes
  to the live installation, which this review was told not to touch.

---

## 3. What each part is for, and how well it does it

### 3.1 MCP server and worker lifecycle: 45

**For:** keeping `search_ruvnet` available to the AI host for the whole session, and swapping in new
knowledge without a restart.

**How it works:** the host starts one small server with `node`. The server starts a separate worker program
that loads two models and the stores, and forwards each search to it. The worker retires when idle and is
started again on demand.

**Keep:** one stable process owns the host connection; the tool list never waits for the worker; concurrent
start-ups share one attempt; a worker is swapped only when no call is in flight; a stuck worker is killed
and the timeout recorded (`server.mjs:207-213`, `:310-323`, `:360-361`).

**Deductions:** worker started from a remembered path, C1 (−15). Missing-file case hangs 60 s with a message
that names no cause, C2 (−8). No size limit and duplicated text, H7 (−8). No deadline but 240 s, H8 (−6).
Shared health file and an unlocked, non-paging start-up path, H6 (−6). Optional feature imported at load,
M7 (−3). Timeout alarm loaded from a path an installed plugin probably lacks, M8 (−3). Readiness stays
"ready" after a timeout, M9 (−3). Three unrelated tools that run rUv command-line programs, one marked
destructive, live in the search server (`plugin/mcp/managed-cli-interface.mjs:99-103`) (−3).

**Repair or rip:** replaced in version 5 by in-process search with a safe mode.

### 3.2 Hooks, grounding and the write gate: 40

**For:** steering the AI to consult the Brain before writing code that uses rUv's products, and (in
practice) enforcing a set of working rules at the end of each turn.

**How it works:** 13 registered hooks, all through one launcher. On each prompt, four run; on each file
write, one "decision gate" runs seven policies; after every tool call, one runs; at the end of a turn, three
run (`plugin/hooks/hooks.json`).

**Keep:** the launcher's watchdog that stops a slow hook before the host does, fails open and records the
failure (`hook-shim.mjs:337-372`); stamps are made only from a parsed, genuine answer
(`grounding-stamp.sh:66-68`); bounded input reads.

**Deductions:** gate cannot be satisfied when search is down, C3 (−15). Armed for everyone under an "opt-in"
label, C4 (−10). Walked round by shell commands and forgeable, H20 (−6). Process cost per write and per tool
call, M1 (−6). About 4,900 lines enforce the owner's own working rules (completion claims, promises,
no-deferral, decision records, duplicate code) and are not search (−6). Hooks that do nothing by default
while tests switch them on, M2 (−5). Instructions to run scripts that are not installed, M3 (−4). Text
injected per prompt has uncapped parts (`hook-context-budget.mjs:40`) (−3). A project-supplied command
string can be executed, M4 (−3). Dead hook files, L1 (−2).

**Rip out (risk):** everything except a health line and an optional guard. Risk: the owner loses the
end-of-turn checks he relies on in his own work; they move to an owner toolkit, they are not deleted.

### 3.3 Session start, health and doctor: 42

**For:** telling the person, at the start of a session and on demand, whether the Brain is working.

**How it works:** session start runs 16 stages inside an 8-second limit, starts up to about seven background
jobs, and prints banners. The doctor runs a list of checks and one live query.

**Keep:** one function decides the doctor's verdict (`brain-confirmation.mjs:239-244`); per-process
readiness records with dead ones pruned (`mcp-readiness.mjs:66-81`); the alarm's lock and page-claim logic
(`kb/brain-alarm.mjs:67-172`).

**Deductions:** doctor tests the wrong path and clears the alarm, C9 (−15). Runs a project script, H1 (−12).
No record is true exactly when a real search just succeeded (eight records listed in the lifecycle reader's
report; each can say "ok" while search is down) (−10). A project file can inject an urgent instruction, H2
(−6). The open, broken session is never told; only the next session's banner shows it (−5). Sixteen stages
and about seven background launches for a start-up hook (−5). Fix advice is always "npm i", M10 (−3). If the
launcher's limit fires, the start-up output, alarm included, is lost (suspected, not confirmed) (−2).

### 3.4 Installer, updater, uninstall: 33

**For:** putting the Brain on a machine, keeping it current, and removing it.

**How it works:** one 7,441-line file with 24 distinct responsibilities (list with line ranges in the
installer reader's report). It downloads a signed archive, swaps it in by rename with rollback, runs
`npm ci` inside the knowledge folder, wires the hosts, then makes a series of optional offers. Updates run a
recorded state machine.

**Keep:** the update state machine with sealed receipts and recovery
(`kb/update-storage-transaction.mjs:332-578`); identity-checked rollback on activation
(`bin/install.mjs:771-811`); signature required on downloads (`:7221-7240`); streaming archive extraction;
ownership proof before deleting on uninstall (`:5594-5600`); plain messages for offline, old Node, unplugged
disk.

**Deductions:** automatic update that ignores a decline and runs unpinned code, C8 (−12). Uninstall deletes
private stores unasked, H3 (−8), and says "clean" when it is not, H4 (−4). Nightly upgrades other tools, H5
(−8). Model router written unannounced, H13 (−5). Plain install takes no lock, H21 (−5). Old copy deleted
before the step that can fail, H22 (−5). Signature covers only the archive hash; unsigned local archive and
`--no-verify`, H19 (−4). One file, 24 jobs, six different locks (−4). Whole-file reads, M11 (−3). Telemetry
default, M5 (−3). Smaller installer faults, M27 (−3). Frozen Node paths in the spend job and launchers,
H18 (−3).

### 3.5 Release rail and CI: 37

**For:** making sure a broken release does not reach users.

**How it works:** a release branch push runs about 24 jobs; a second workflow re-checks identity, signs the
payload once, publishes, then verifies on three operating systems. A nightly path rebuilds and promotes the
knowledge. About 35 hosted jobs and 10 local checks per release; 4,570 lines of workflow and between 15,700
and 26,000 lines of scripts depending on what is counted.

**Keep:** exact-commit identity (`protected-release.yml:102-109`); payload signed once and re-verified
(`:278-289`); npm staged under a candidate tag before promotion; a skipped test is fatal in qualification
(`release-qualification.mjs:39-44`); real installed-host searches on Linux and macOS before publishing; the
corpus chain cannot reach npm.

**Deductions:** no gate on answers, C5 (−20, structural). Nightly knowledge promoted with no search, C6
(−12). Release is "latest" before verification, no rollback, C7 (−12). The rail fails for its own reasons
more than for the product's: its comments record a period when a release attempt "succeeded about ONE TIME
IN FIVE ... almost none of its failures were real findings" (`stranger-matrix.yml:72-75`), 8 of 20 preflight
failures were a review-bookkeeping check (`canonical-qa.yml:33`), and the five most recent commits are all
rail fixes (−6). Windows searched only after promotion, H17 (−4). Newest host tools installed beside the
publishing secrets and never used, H15 (−4). Unit suite not required, M21 (−3). Rulebook wording, M26 (−2).

### 3.6 Scheduler, nightly, watchdog, alerting: 50

**For:** telling the owner when something that should have run did not, and when the nightly knowledge
build failed.

**How it works:** on the owner's Mac, 14 scheduled jobs wrapped by a heartbeat script and judged daily by a
watchdog; on GitHub, a corpus watchdog twice a day that pages through a notification workflow; on a
customer's machine, one 03:30 job.

**Keep:** the heartbeat wrapper is plain shell plus `curl`, so it can page even when Node is broken
(`scripts/job-heartbeat.sh`); "no evidence means failed" in the watchdog (`scripts/nightly-watchdog.mjs:117-190`);
the corpus watchdog asks for an outcome, not a green run; pages are sent on change of state with damping;
the inbox reader cannot start an agent (`scripts/ntfy-inbox.mjs:374`).

**Deductions:** nothing in 4.7.28 probes whether search works, on any machine (−15). Customer's job fails
silently when its Node is gone, M19 (−6). The issue fixer accepts any author, H16 (−6). About 86% of this
area (10,500 of 12,200 lines) is owner tooling that does not serve search, and it ships to customers, H14
(−6). No signal from off the machine: if the Mac is off, nothing pages (−5). Missing secret passes green,
M18 (−4). Owner job files and registry disagree, M20 (−4). Latency: a job that silently stops is noticed
after 29 to 53 hours by the reader's estimate (−4).

### 3.7 Knowledge-build pipeline (plumbing only): 44

**For:** turning rUv's public repositories and gists into one signed archive, and keeping private material
out of it.

**Keep:** per-source carry-or-fail isolation (`scripts/corpus-reconcile.mjs:606`, `:796`); build in a
candidate folder, promote with rollback (`kb/incremental-refresh.mjs:237-297`); the build-time private fence
aborts on a missing or malformed list (`scripts/build-bundle.mjs:122-142`); id-level reconciliation that
deletes a store it cannot prove (`kb/forge-big.mjs:393-425`).

**Deductions:** no fence at question time, H9 (−10). Reader accepts a store built to a different recipe, H23
(−8). Recipe spread over at least 17 files, M12 (−8). Symbol index never rebuilt, H24 (−6). The same job
implemented many times: four chunkers, at least six writers of the provenance file where the rulebook says
four, 18 copies of a file-hash helper, nine of a sleep helper (−5). Private names shipped and a client
overlay in the public repository, M16 (−4). No secret scan, M17 (−4). Gist file-type rule, M13 (−3). Two
gist build paths, M14 (−3). Lock with no expiry, M15 (−3). Dead code, L3 (−2).

### 3.8 Console: 68

**For:** a local web page showing the user's whole rUv set-up with one-click fixes.

**Size:** 18,400 lines of product, 10,400 of tests. Opened only by a command; it does not run by itself.

**Keep:** binds to the local machine only; host-header check; random token per launch; undo journal before a
change (`scripts/onboarding-console.mjs:3357-3361`, `:2655-2735`).

**Deductions:** it is a second product inside the first; nothing in search depends on it (−10). Token given
to any local program, M6 (−8). A click can install global packages (−4). Six commands and three skills for
one page, L2 (−3). The host-header guard has no test (−3). Developer documents ship inside it (−2). Origin
checked on one endpoint only (−2). This area was read least; the score is the least certain.

### 3.9 Telemetry and counters: 53

**For:** anonymous counts of installs and searches.

**Keep:** the payload is only event name, version and count (`kb/telemetry-ping.mjs:83-125`).

**Deductions:** default yes, and `--yes` accepts it with no terminal, M5 (−15). The default address was found
dead in July and left in place, so opted-in counts go nowhere (−15). SECURITY.md says the default is off
(−8). The undo flag does nothing once an answer is on file (−5). Open counter endpoint, L4 (−4).

### 3.10 Model routing, lessons, memory capture and other additions: 36

**For:** routing work to cheaper models; recording and replaying lessons; storing turn outcomes; suggesting
rUv packages; savings reports.

**Size:** about 47,800 lines of product and 38,100 of tests by filename (some overlap with other areas).

**Deductions:** none of it is needed to return an answer (−25). Turn text stored by default where a memory
database exists, H11 (−10). At least eight programs per prompt and two per tool call (−8). Installed
unannounced, H13 (−8). Launchers freeze a Node path, H18 (−5). Floating dependency and an owner-only
dependency in the customer package, H15 (−4). Owner-only skills shipped (−4).

**Rip out (risk):** all of it from the product. Risk: these are features the owner uses daily. They are
moved to an owner toolkit, not deleted; the risk is the work of moving them, and that some depend on
session-start and prompt hooks the product will no longer have.

### 3.11 Test strategy: 51

**Measured:** 804 test files. In a 40-file sample (every 20th file by sorted path) 32 exercised real
behaviour: 80%, with a plausible range of 65% to 90%. By search across all files: 50 (6%) assert on source
text and never run the code; 13 replace the module they test with a mock; 19 contain placeholder cases and
about 10 are placeholders only. 224 files (28%) gate a release.

**Keep:** the habit of testing through real programs with stand-in neighbours; the "break it and watch it
fail" cases (84 files carry one); the packed-install tests.

**Deductions:** no test for any of the failures that actually happened: a missing Node program, the write
gate during an outage, total result size, a project script at session start (−15). The "held-out" exam is
not held out: 37 of its 116 longer questions appear word for word in four test files that pin routing
(`tests/unit/card-lane.test.mjs:228-266` and three others), and nothing gates on answers (−10). 72% of test
files gate nothing and the full suite is not a required check, M21 (−6). The suite switches on behaviour
users do not get, M2 (−5). The install check tolerates a doctor failure when the cause is "grounding
unproven" (`scripts/ci/stranger-scenario.mjs:192-193`) (−3). Text-pin files (−3). Placeholder files (−3).
The whole-suite gate script is called by nothing (−2). Serial only, total run time not recorded (−2).

### 3.12 Security and privacy: 32

**Keep:** signatures required on downloads; no shell commands built from user input in shipped paths; no
committed credentials found by pattern search; pull requests from forks cannot reach secrets; the installer
scrubs the environment before running a downloaded package (`host-update.mjs:174-179`).

**Deductions:** unattended, unpinned code from npm at session start, C8 (−10). Project script at session
start, H1 (−10). No question-time private fence, H9 (−8). Questions, paths and answer text on disk in clear,
H10 and H11 (−8). Security document wrong, H12 (−6). Unpinned fetches, H15 (−5). Issue fixer open to any
author, H16 (−5). Signature covers no version, H19 (−4). Project-supplied command string, M4 (−3). Console
token, M6 (−3). Private names and a client overlay public, M16 (−3). No secret scan, M17 (−3).

### 3.13 Operating systems and hosts: 70 (capped)

**Read from code, not run.** macOS, Linux and Windows have a nightly scheduler each. Two hooks are bash and
are skipped on Windows without Git Bash; the write gate is bash too. Deductions: Windows' first real search
is after promotion, H17 (−10). Bash-only grounding on Windows (−6). Node 18 is declared supported and no CI
job runs it (−5). The spend-guard option throws on Windows, M27 (−3). Grok hooks are shipped with no CI
coverage (−3). macOS-only features are offered without saying so (−2). That arithmetic gives 71; the cap for
a known structural flaw (H17) makes it 70.

### 3.14 Footprint and install experience: 53

**Keep:** proof-gated removal of old copies; one-line errors; moving the Brain to another disk.

**Deductions:** thirteen hooks, ten skills, nine commands and a model router arrive with a search tool (−10).
First search takes 20 to 150 seconds and the worker holds 3 to 15 GB by the code's own comments (−10). About
one question in eight was refused with "name a repo" in the retrieval run's measurement (−8). The main skill
is 45 KB and triggers on "ANY request to build" (−6). No overall "proceed?" question and no download size
shown (−5, reported by the earlier review and the installer reader). An update needs about four times the
corpus in free disk (−3). The footprint checker can fail the doctor for disk-tidiness reasons alone (−3).
`npm ci` runs on the user's machine and has broken search before (−2).

### 3.15 Documents and ADRs: 41

**Deductions:** SECURITY.md wrong on what runs, updates and is verified, H12 (−15). Three definitions of the
product, M22 (−8). The search recipe is written down nowhere as one current reference; it was reconstructed
by reading code (−8). Stale documents presented as current, M24 (−8). ADRs cite files that no longer exist,
a missing ADR is cited as authority, a "Proposed" ADR is the live standard, M25 (−8). The rulebook describes
end-of-turn checks as active that are off by default (−5). `docs/ARCHITECTURE-MAP.md` describes the retired
hook set (−4). Code comments are incident diaries, often longer than the code under them (−3).

---

## 4. Keep, repair, rip out, build

Because the owner has decided on a rewrite, "repair" here means "rebuild correctly in version 5", and each
item points to where the architecture handles it.

### KEEP (carried into version 5)

| What | Evidence it is sound | Where it lands |
|---|---|---|
| Sealed, signed, exact-commit release; stage, promote, restore | `protected-release.yml:102-109`, `:278-289`; `release-transaction-provider.mjs:550`, `:599-604` | release rail, with verification moved before promotion |
| Nightly corpus: carry rule, bounded retry, kill switch, 48-hour watchdog | `corpus-reconcile.mjs:606-763`; `corpus-watchdog.yml` | builder and rail |
| Update as a recorded state machine with crash recovery | `update-storage-transaction.mjs:5-19`, `:332-578` | installer, smaller, around one pointer file |
| Build-time private fence | `build-bundle.mjs:122-142` | builder, plus a question-time check |
| Stable server shell, swap only between calls | `server.mjs:207-213` | server, with a worker thread |
| Page damping and page-claim under a lock | `brain-alarm.mjs:28-83` | health package |
| Heartbeat wrapper in plain shell | `scripts/job-heartbeat.sh` | owner toolkit; the idea (a fallback that does not need Node) is in the prompt hook |
| Real install plus real search through a real host | `host-install-matrix.mjs:485-489` | the health verdict, run in CI |
| Source coverage list, exclusions, gist capture with receipts | `data/source-coverage.json`, `gist-receipts.mjs` | builder data |
| Plain install errors; move-to-another-disk | `brain-location.mjs:40`; `--move-brain` | installer |

### REPAIR (rebuilt correctly)

| What is wrong today | Defects | In version 5 |
|---|---|---|
| Search depends on a remembered Node path | C1, C2, H18, M19 | no program is started on the search path; no Node path is written anywhere |
| Health is many records, none honest | C9, H6, M9, M10 | one verdict function, one fact, five readers |
| Update can break silently and cannot be declined | C8, H21, H22, M11 | probe-gated pointer switch, one off-switch, no package manager |
| Releases reach users unchecked | C5, C6, C7, H17 | verify on three systems before promotion; one answer gate |
| Result too large, sent twice, no deadline | H7, H8 | capped formatter; 10-second deadline; safe mode |
| Recipe scattered and unenforced | M12, H23, H24 | one recipe file, obeyed by builder and engine, carried in every pack |
| Uninstall destroys and misreports | H3, H4 | private packs kept; final report from a real re-check |
| Security document drifts from code | H12 | tables generated from code |

### RIP OUT (with the risk of removal)

| What | Size | Risk of removing it |
|---|---|---|
| Router, answer cards, per-question recognisers, reranker threshold | within the 7,671-line search path | none to users (the retrieval run measured them as harmful); about 25 test files and the grounding-stamp pattern depend on them |
| Twelve of thirteen hooks; the end-of-turn checks; decision and duplicate gates | about 13,900 lines | the owner's own working rules stop being enforced unless moved to an owner toolkit first |
| Turn capture, lessons, learning, recall, advocacy, recommender | about 15,600 lines | loss of features the owner uses; they belong to Ruflo memory and can be a separate plugin |
| Model routing, launchers, proxy, flywheel, savings | about 10,000 lines | machines that installed the launchers have `claude` and `codex` wrapped; removal must restore the originals |
| Console | 18,400 lines | users who rely on the page lose it; `status` covers the Brain itself |
| Issue watch, issue fix, issue autofix, notification inbox | about 4,000 lines plus tests | none to customers; the owner loses unattended triage unless kept in the toolkit |
| Version and census stamping, single-source and claims scanners, review-row checks | several thousand lines of scripts | the guarantee they protect (plugin users never get an unversioned change) is kept by three small checks |
| 03:30 scheduled job on customers' machines | about 1,200 lines | machines with no open session stop updating; they update at the next session instead |
| Telemetry | about 570 lines | install and search counts are lost; they currently go to a dead address |
| 102 ADRs and the stale root documents | about 49,000 lines of documents | history is kept at tag `v4.7.28` |

### BUILD (does not exist today)

| What | Why | Where |
|---|---|---|
| An honest health signal the AI sees on every prompt | the day-long silent outage | architecture section 3 |
| A safe mode that needs only Node itself | search should degrade, not go dark | architecture section 2.2 |
| A probe-gated update with automatic rollback | an update that cannot silently break | architecture section 2.3 |
| A recipe of record, checked against code | the recipe had to be reconstructed by archaeology | architecture section 4.1 |
| A size-capped, sectioned result with a follow-up read tool | oversized results were delivered as nothing | architecture section 4.2 |
| One answer gate on shipped bytes | 4.7.28 shipped green at about 4% | architecture section 5 |
| A question-time private fence | private text can reach any project today | architecture section 2.1 |
| A pack manifest that is the only definition of a store | a new file type must be registered in about eight lists today | architecture section 4.3 |
| Line budgets enforced in CI | the 5% and 95% | architecture section 6 |

---

## 5. Where this review corrects the earlier one

- "The delivery machinery is good" needs a qualifier. The earlier review said promotion requires the canary
  to pass. It does; the canary never searches (C6). And a code release is public before the three-system
  check (C7).
- "247 test files read product source as text" overstates the problem. By this run's census 149 files read
  product source on some line, 50 assert on source text without ever running code, and four in five sampled
  files test real behaviour. The real gap is which behaviours have no test at all.
- "About 290,000 lines" was product plus tests. Outside tests the figure is about 157,000.
- `scripts/eval-brain.mjs` does run real retrieval; it is unwired and scores by repository, as the earlier
  review said.
- Confirmed as stated: the Node path defect, the write-gate trap, the project script at session start, the
  ignored decline of automatic updates, uninstall's deletion and "Verified clean", the stale SECURITY.md,
  the zero recall floor, and the commit-share observation (2 of the last 300 commits touched core search).

---

## 6. What I did NOT test or read

- **Nothing was run.** No suite, build, install, update, search or workflow. Process counts per hook are
  counted from code, not timed. Every statement about behaviour is from reading.
- **Not opened by instruction:** the live installation under `~/.cache/ruvnet-brain`, the installed plugin
  folder, the owner's scheduled-job files outside the repository. So: whether the timeout alarm loads on a
  real install (M8), which Node paths the owner's jobs actually use, and what the installed registration
  holds are unknown.
- **Not checked live on GitHub:** whether the issue fixer is switched on; where the signing key is stored;
  which checks are required on `main`; whether the telemetry address is still dead.
- **Read only in part** (each reader listed exactly what): `kb/forge-update.mjs` (about 120 of 2,143 lines),
  most of the console (`console/app.js`, the page server outside its request handler), the bodies of the
  model-routing, lessons, advocacy and issue-autofix scripts, `corpus-seed.yml`, most of
  `protected-release.yml` lines 670 to 1186, the release transaction provider, 764 of the 804 test files.
- **Rows marked R in `DEFECTS.md`** rest on a reader's quoted line that the lead did not re-open.
- **Windows and Linux:** no behaviour observed on either.
- **Retrieval quality:** not measured here; all such numbers are the retrieval run's.
- **rUv's own equivalents** for hand-written pieces (the archive extractor, retry helpers, locks) were not
  looked up, for the reason given in section 2.

---

## 7. Decisions only the owner can make

1. Whether to ship the one waiting fix for the Homebrew defect as 4.7.29 before version 5 is ready
   (`ROADMAP.md` Part D). Recommended if version 5 is more than a few weeks away.
2. Which of the additions marked "owner" in the parity checklist (`ROADMAP.md` Part C) move to an owner
   toolkit and which simply stop. The build does not wait on this.
3. Whether the public repository should keep a named client's overlay and the list of private repository
   names (M16).
