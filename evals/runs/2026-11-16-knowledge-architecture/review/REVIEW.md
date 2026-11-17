Updated: 2026-11-16 23:31:00 EST | Version 1.0.0
Created: 2026-11-16 23:31:00 EST

# RuvNet Brain 4.7.28: review of everything that is not the retrieval-quality question

Reviewer: Fable 5.2, independent, read-only. Run from 11:17 p.m. to 11:31 p.m. Eastern, 2026-11-16.

**What was reviewed.** The code at commit `0e7b9cfa` (version 4.7.28, equal to `origin/main`), read in the
worktree `.claude/worktrees/agent-a605de6750254d5d5`. The main checkout at `/Users/stuartkerr/Code/ruvnet-brain`
is **not** 4.7.28: it sits at commit `320b778b`, version 4.7.20, with five uncommitted edits to the gist
pipeline. Every path below is relative to the worktree root.

**How.** Five Sonnet readers took one area each. I then opened the cited lines myself. Each item is marked
**V** (I read the line or ran the count) or **A** (a reader reported it and I did not re-open it). Nothing was
edited, built, tested or published. `search_ruvnet` was down in this session ("brain worker exited", the
defect in B1), so every statement about rUv's tools comes from reading this repository, not from the Brain.
Retrieval quality was not re-measured; those numbers are the lead's (`DECISIONS.md`).

Plain-word glosses: a **hook** is a small program the plugin runs automatically at moments in your AI session
(when you type, when the AI writes a file, when it stops). A **gate** is a check that can stop something.
A **chunk** or **passage** is one piece of a source file stored for search. A **store** is the searchable
copy of one repository.

---

## 1. Verdict (one page)

**The delivery machinery is good. The thing it delivers was never measured honestly, and the product's own
code hid that.**

1. **Ready to carry a new retrieval brain.** The signed download, the install and update swap with rollback,
   the nightly corpus build with its "one bad source never stops the night" rule, the private-store fence at
   build time, the three-operating-system install check, and the publish path (no way round the gates found).
   This is real engineering and most of it does not care how search works.

2. **Why every light was green while search found the right file about 4% of the time.** Three findings:
   - The serving code contains hand-written recognisers for individual test questions. Seven of them match
     questions that appear word for word in the "frozen held-out" exam (`kb/forge-ask-all.mjs:309-483`
     against `evals/held-out.json`). An exam whose questions are special-cased in the product cannot measure
     the product. (V, by running those patterns over the question files.)
   - The exam only asks "did the answer come from the right repository", never "the right file", and accepts
     a catch-all store as correct (`scripts/eval-brain.mjs:84-105`). No release workflow runs it, and its
     100% baseline is from 2026-09-09. (V)
   - The one file-level recall check on the corpus was switched from "blocks a release" to "records only",
     with the floor set to 0, after it measured 59.0% (`scripts/oracle/repo-recall.mjs:8, :61-63`). The
     release check that remains asks 182 questions that each begin "In the X repository" and mostly expect
     that repository's README. (V)

   ADR-099, dated 2026-10-01, already recorded that the reranker abstained on 202 of 206 newcomer questions.
   The problem was known for six weeks and shipped through 4.7.28.

3. **The product has grown far past its purpose.** The search path is about 7,200 lines. Around it sit 44,000
   lines of hooks, 73,000 lines of scripts (16,000 of them release rails), and 150,000 lines of tests. Of the
   last 200 commits, 3 touched the core search files (A). Much of the surrounding material enforces the
   owner's personal working rules or is switched off for ordinary users and still runs on every keystroke.

4. **Five defects to fix now, whatever happens to retrieval:** search dies after a Homebrew Node upgrade (B1);
   the write gate then blocks code writes with no way out the AI can use (B2); opening a session runs a script
   from whatever project you are in (B3); declining auto-update does not stop auto-update (B4); uninstall
   deletes private stores without asking and then says "Verified clean" when it is not (B5).

5. **For an amateur today:** install is clear when it fails for a plain reason. The first question is the
   problem: about one in eight is refused with "NO SEARCH WAS RUN ... NAME A REPO", which an amateur cannot
   do, and most of the rest return one file.

**Scores** (my judgment from reading code, not from runs; deductions in section 7):

| Area | Score /100 |
|---|---|
| (a) Installer and updater | 55 |
| (b) MCP server, plugin, hooks | 45 |
| (c) Ingestion and build pipeline | 50 |
| (d) Serving path and answer format | 35 |
| (e) Release rails, CI, tests | 55 |
| (f) Eval tooling | 20 |
| (g) Dead code, duplication, stale docs | 45 |
| (h) Security and privacy | 50 |
| (i) Amateur experience | 40 |

The brief asked for eight scores; the scope lists nine areas (a to i), so all nine are scored.

---

## 2. GOOD: keep, ready to go on a new retrieval brain

| # | What | Evidence | Notes |
|---|---|---|---|
| G1 | Update is a recorded state machine with crash recovery; install swaps by rename with rollback | `kb/update-storage-transaction.mjs:6-20, 332, 460-593`; `bin/install.mjs:700-840` (A) | Needs new file types registered (section 6) |
| G2 | Bundle signature is required and fails closed; only a public key is in the repo | `bin/install.mjs:7221` `SIGNING_REQUIRED = true` (V); `keys/` holds one public key (V) | |
| G3 | Plain one-line errors for offline, bad signature, old Node, unplugged disk | `bin/install.mjs:~390, ~7248, 7088`; `plugin/scripts/brain-location.mjs:40` (A) | |
| G4 | Refresh builds a candidate folder and promotes it atomically; ledger of what changed; lock with owner identity | `kb/incremental-refresh.mjs:~187-245`; `kb/refresh-run.mjs` (A) | The seam for a new chunker is one function (section 6) |
| G5 | Private fence at build time aborts when the fence file is missing or malformed | `scripts/build-bundle.mjs:121-142` (V), `:154-204` (A) | Query time is a different story (B17) |
| G6 | Nightly corpus: three fault classes, bounded retries, carried stores named | `CONTRIBUTING.md:151-190`; `scripts/corpus-reconcile.mjs:640-763` (A) | |
| G7 | Publish path has no skip switch: no `continue-on-error`, promotion needs the canary to succeed | `.github/workflows/protected-release.yml:8-30, 1119` (A) | The gates are sound in wiring, weak in what they measure |
| G8 | The MCP shell design: one stable process, a replaceable worker, honest "down" recording on timeout | `plugin/mcp/server.mjs:207-298, 310-323` (V) | After B1 is fixed |
| G9 | Hook shim: watchdog kills a slow hook before the host does, fails open, one failure ledger | `plugin/scripts/hook-shim.mjs:337-372`; `decision-gate.mjs:15-17` (V) | |
| G10 | Retrieval-agnostic serving modules: result schema, citation check, outcome wording, deadline helper, injection wrapper, built/shipped evidence labels | `kb/retrieval-result.mjs`, `verify-citation.mjs`, `search-outcome.mjs`, `query-deadline.mjs`, `forge-guard-injection.mjs`, `implementation-evidence.mjs` (A; I read `search-outcome.mjs` in full) | Reusable as they are if the result shape stays `{repo, path, title, evidenceClass, text}` |
| G11 | Usage ping sends only `{event, version, count}`, only with consent on file | `kb/telemetry-ping.mjs:93-109` (A) | Consent default is the issue (B13) |
| G12 | Strong tests exist: real install of the packed package, fault injection on the release transaction, real JSON-RPC search, mutation tests | `tests/qe/release/packed-clean-install.test.mjs`, `release-transaction-faults.test.mjs`, `tests/qe/gpt56/live-brain-search.test.mjs:68-110`, `tests/mutation/` (A) | |
| G13 | The unattended issue fixer is layered: kill switch, no shell or network for the model, protected paths, sandboxed tests | `scripts/issue-autofix-*.mjs` (A) | Residual risk in B19 |

---

## 3. BAD: fix

Severity: Critical / High / Medium / Low. Effort: S (hours), M (days), L (a week or more).

### Fix now, independent of the retrieval redesign

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B1 | **Search dies when Homebrew replaces Node.** The worker is started with the exact Node path the server was started under. If that binary breaks, every search fails until the session restarts. If the binary is *deleted*, only an `error` event fires, the handler does not reject the waiting call, and each search hangs for the 60 s start-up limit. The message says "temporarily unavailable" and names no fix. A shared `health.json` then read "ok" 18 seconds after my search failed, because another session wrote it. | `plugin/mcp/server.mjs:224` (`spawn(process.execPath, ...)`), `:256`, `:159`, `:375` (V). The missing-binary behaviour is measured: a spawn of a non-existent Node path gave `error ENOENT` and no `exit`. My search failed at about 11:18:35 p.m.; `health.json` said `status: ok` at 11:18:53 p.m. (V) | Critical | S |
| B2 | **The write gate cannot be satisfied when search is down, and the AI cannot use the override it is told to use.** It refuses code files that mention `agentdb`, `rvf`, `ruflo` and six others until a search succeeds. It never checks whether search is alive. The stated override is an environment variable that only a relaunch can set. Meanwhile a shell command writes the same file unchecked, so the gate stops honest work and not determined work. It is "opt-in" by comment but the installer creates the file that arms it. | `plugin/scripts/ground-before-write.sh:86-87, 140-151, 205-223` (V); matcher covers file-write tools only, `plugin/hooks/hooks.json:45` (V); `bin/install.mjs:5834` writes `profile.json` (V); seen live today, `DECISIONS.md` D5 | Critical | M |
| B3 | **Opening a session runs a file from the current project.** SessionStart runs `<project>/scripts/ascii-drift.mjs` with Node if it exists. A cloned repository can plant that file. | `plugin/scripts/session-start-core.mjs:366-372`; `session-start-fsutil.mjs:40-43` (V) | High | S |
| B4 | **Declining auto-update does not stop it.** The install screen says declining "makes updates manual forever". The installer never writes the opt-out file the session hook looks for, so sessions still launch a background update. The nightly job, when accepted, also upgrades the user's other global tools, which the plan text does not say. | `bin/install.mjs:6115` (V); `plugin/scripts/session-start-health.mjs:133-143` (V); no `auto-update-pref` anywhere in `bin/install.mjs` (V); nightly scope `plugin/scripts/nightly-scheduler.mjs:194`, `developer-update.mjs:443` (A) | High | M |
| B5 | **Uninstall deletes the whole knowledge folder, private stores included, with no question, then prints "Verified clean — nothing from RuvNet Brain remains"** while models, receipts, launchers and settings are left. | `bin/install.mjs:5602, 5634` (V); what the check omits (A) | High | S |
| B6 | **The spend-watchdog job hard-codes the Node path** (the same defect as B1, in a launchd job). The nightly job already has the fix (`stableNode`). | `bin/install.mjs:5189`; `plugin/scripts/automatic-update.mjs:56-66` (V) | High | S |
| B7 | **SECURITY.md describes a product that no longer exists.** Its table of what runs automatically names scripts that are not registered. It says knowledge updates are "detect-and-notify only ... never run automatically" and that "the unattended code-overwrite path remains disabled"; sessions and a 15-minute timer launch the updater. It says a missing signature "warns and proceeds"; the code requires it. | `SECURITY.md:38-55, 108-110, 126-129` against `plugin/hooks/hooks.json`, `plugin/mcp/server.mjs:409-420`, `CONTRIBUTING.md:320-327`, `bin/install.mjs:7221` (V) | High | S |

### Hooks and session cost

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B8 | **About 14 processes start for every file the AI writes**, and 2 for every other tool call (the PostToolUse matcher is `*`). Their own measurement was about 415 ms per write before three more policies were added; under today's load it will be more. | `plugin/scripts/decision-gate.mjs:76-78, 163-186` (V); `plugin/hooks/hooks.json:57-65` (V); count of children (A) | Medium | M |
| B9 | **Hooks that run and do nothing.** Two registered hooks exit at once unless a variable is set; a third writes a marker for a gate that is off; the Stop hook does its full analysis and discards the result. The test suite sets that variable, so tests exercise behaviour users do not get. | `plugin/scripts/hook-shim.mjs:221-223`; `continuation-gate.mjs:781-783`; `grounding-turn-gate.mjs:212`; `vitest.config.mjs` env `RUVNET_STOP_NUDGES: 'full'` (V) | Medium | S |
| B10 | **CONTRIBUTING.md states as current several behaviours that are off by default** (completion-claim correction, promise ledger, no-deferral, the Stop grounding check). The switch is not named anywhere in that file. ADR-106 says 17 hooks; 13 are registered. | `CONTRIBUTING.md:487-513` against B9 lines (V); ADR-106 count (A) | Medium | S |
| B11 | **Injected text tells the AI to run scripts that an installed plugin does not have** (`node scripts/ingest-repo.mjs`, `node scripts/loop-checkpoint.mjs`). | `plugin/scripts/ground-ruvnet.sh:516` (V), `:577-585` (A); neither file is in `plugin/scripts/` (V) | Medium | S |
| B12 | **The main skill is 45 KB and its description says to use it "for ANY request to build, add, implement ... whether or not rUv is mentioned".** A user who is not building on rUv's tools pays for it on ordinary work. The gate's refusal text also carries the owner's own incident history. | `plugin/skills/ruvnet-brain/SKILL.md` 45,069 bytes (V); `ground-before-write.sh:207-209` (V) | Medium | M |

### Installer

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B13 | **Telemetry defaults to yes**: the prompt is `[Y/n]` and `--yes` accepts it. SECURITY.md says "default is OFF" (true only without a terminal). The ping address in the code was found dead in July and left as the default. | `bin/install.mjs:6017, 6024`; `kb/telemetry-ping.mjs:29-36` (V) | Medium | S |
| B14 | **The installer writes a model-routing subsystem into `~/.claude/model-router`** (tools, catalogue, a profile) without listing it in the plan, and there is no "proceed?" question for the core install. | `bin/install.mjs:5802-5865` (V); plan screen `:6096-6176` (A) | Medium | S |
| B15 | **Large-file limits that the redesign will hit.** The installer reads the whole bundle into memory to hash it; the updater reads every file whole. Node refuses a single read above 2 GiB. A disk-full error during download is reported as "Check your connection". No size is shown before a download of roughly 745 MB. | `bin/install.mjs:116, 483-487`; `kb/update-storage-transaction.mjs:117` (V); size `kb/forge-update.mjs:127` (A) | Medium | M |
| B16 | **One 7,441-line installer doing seven jobs, five different lock files, and the signing key and verify function copied in two places that already differ.** A plain install takes no lock an update respects. | `bin/install.mjs` (line count V); locks and duplicates (A) | Medium | L |

### Privacy and safety

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B17 | **The private fence does not exist at question time.** Search uses every store file in the folder. On a machine that holds private stores (the owner's: meetings, client stores), any project's AI session can be handed their text, and quotes are also written to a cleartext log. Public installs are safe only because the files are absent. | `kb/forge-ask-all.mjs:2440-2450` (V); `kb/forge-evidence.mjs:185` logs the query (V) | High on the owner's machine | M |
| B18 | **The injection wrapper can be closed from inside.** Flagged text is inserted unescaped before a fixed end marker; a passage that contains the marker ends the fence early. The detector is English-only patterns and treats its own errors as "clean". The card answers are not wrapped. Not tested, read only. | `kb/forge-guard-injection.mjs:225-229` (V); `:131-133`, card path (A) | Medium | S |
| B19 | **The unattended issue fixer may edit the shipped search code and the injection guard**, from an issue written by any non-bot account, with no person reading the diff. Whether it is armed (`ISSUE_AUTOFIX`) was not checked. | `scripts/issue-autofix-security.mjs:10-43`; `scripts/issue-watch.mjs:56` (A) | Medium | M |
| B20 | **No secret scan before source text is stored and shipped** in a signed bundle. The sources are public, so this republishes rather than leaks. | no pattern or redaction in `kb/forge-corpus.mjs`, `forge-refresh.mjs`, `forge-big.mjs`, `scripts/build-bundle.mjs`, `corpus-reconcile.mjs` (V, by search) | Medium | M |
| B21 | **A named client's private overlay is in the public repository** (company, product names, server paths). Manifests only, no stores. Owner to decide whether it belongs there. | `overlays/client A/rvf-families/README.md:1-22` (V) | Low | S |

### Build pipeline

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B22 | **Four separate chunkers and three embedder set-ups**, none tied to the embedder's 512-token window. Full rebuilds and incremental refreshes of the same store go through different code. | `kb/forge-corpus.mjs:11-12`; `scripts/gist-receipts.mjs:333`; `scripts/corpus-aggregates.mjs:23`; `scripts/ingest-meeting.mjs:73`; `kb/forge-big.mjs:104-124`; `kb/forge-refresh.mjs:30-35, 188-197` (A; I read `forge-corpus.mjs:5-24` and `forge-refresh.mjs:30-35`) | Medium | M |
| B23 | **Why 84 gists have no passages: gists are indexed only if a file ends in `.md`, `.markdown`, `.txt` or `.rst`.** Notebook, Python, TOML and JSON gists are dropped. The committed receipt shows 501 gists, 84 with no included file; 517 minus 433 is also 84. This answers the lead's open defect 5. | `scripts/gist-receipts.mjs:40, 433-437`; count from `kb/ruv-gists.sources.json` (V) | Medium | S |
| B24 | **A store is deleted and then rebuilt in place** on the older gist path, so a kill mid-way leaves a partial store. `CONTRIBUTING.md` calls `gist-receipts.mjs` "the single gist pipeline" but `npm run gists:sync` and `scripts/nightly-gists.sh` still use the other one, and the stale main checkout has uncommitted edits to it. | `kb/forge-big.mjs:381` (V); `package.json` `gists:sync` (V) | Medium | S |
| B25 | Source files are read with no size cap; any path containing "adr" is labelled an ADR; Python docstrings never count as documentation, while `#include` lines do. | `kb/forge-corpus.mjs:30-40, 136, 173` (A; I read `:28-41`) | Low | S |

### Serving path (code, not quality)

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B26 | **The router is built to refuse.** The live tool calls search with `allowFullCorpus: false`; any question the card router cannot place returns "too ambiguous" and nothing is searched. The message then tells the user to name a repository. | `kb/forge-mcp-all.mjs:432`; `kb/forge-ask-all.mjs:3610-3640`; `kb/search-outcome.mjs:49-58` (V) | High | S to switch off |
| B27 | **The tool advertises "default 6" results and treats an ordinary call as a request for one.** Results scoring below zero on the reranker are then withheld, although the project's own files say that reranker scores the correct passage below zero in 32 of 35 cases. This is the mechanism behind "one file returned". | `plugin/mcp/server.mjs:61`; `kb/forge-mcp-all.mjs:336, 381`; `kb/forge-ask-all.mjs:3077`; `kb/judge-rank.mjs:5-6` (V) | High | S |
| B28 | **No time limit on a live search except a 240-second kill.** The 20-second deadline helper is used by the command-line tool only. | `kb/forge-mcp-all.mjs:427-433`; `plugin/mcp/server.mjs:329` (V) | Medium | S |
| B29 | **Error text an amateur cannot act on.** "Diagnose the active installation and KB path before choosing a repair" names no command. Output mixes emoji banners and "INSTRUCTION TO THE MODEL" lines; the same documents are sent twice (text and structured copy). | `plugin/mcp/server.mjs:383`; `kb/forge-mcp-all.mjs:441-448, 463-470` (V); duplicate payload (A) | Medium | S |

### Release rails, tests, evals

| # | Finding | Evidence | Sev | Effort |
|---|---|---|---|---|
| B30 | **No release gate measures whether the right file comes back.** The canary's 182 questions all begin "In the X repository"; 92 use one template; about half expect a README; the sample is drawn only from stores that already passed. | `data/retrieval-query-evidence.json` (counts V); `scripts/retrieval-canary.mjs:492-510, 650` (V) | Critical | M |
| B31 | **The exam is repository-level, special-cased in the product, unwired and stale** (verdict point 2). | `scripts/eval-brain.mjs:84-105`; `evals/baseline.json` (2026-09-09, all four metrics k = n); no workflow mentions `eval-brain` or `eval:gate`; `kb/forge-ask-all.mjs:309-483` (V) | Critical | M |
| B32 | **A file whose header says "the BLOCKING retrieval gate" sets its floor to 0 and "never REFUSES".** A companion data file still shows a floor of 176. | `scripts/oracle/repo-recall.mjs:3, 61-63` (V); `data/repo-recall-floor.json` (A) | High | S |
| B33 | **The code that decides what search returns runs under no test.** 11 test files replace the search engine with a mock; the routing test file is 19 placeholders and 7 real cases. | `tests/unit/forge-ask-routing.test.mjs:1-14` (V, counts V); mock count (A) | High | M |
| B34 | **`npm test` is a 9-question battery, not the suite; 224 of 804 test files (28%) gate a release; the full unit suite runs on pull requests but is "deliberately NOT a required check", with a promise to change that in 4.7.22.** | `package.json` `test`; `scripts/release-qualification-contract.mjs` (224 unique files, V); `.github/workflows/unit-suite.yml:1-5` (V) | Medium | S |
| B35 | **247 test files read product source as text.** Many pin that a string exists rather than that behaviour works. | count by search (V); examples `tests/unit/release-canary-integrity-sample.test.mjs:77-89`, `tests/unit/source-card-adversarial-qe.test.mjs:154-159` (A) | Medium | L |

---

## 4. RIP OUT: remove, with what depends on it and the safe order

| # | Remove | Depends on it | Safe order | Sev / Effort |
|---|---|---|---|---|
| R1 | **The per-question recognisers and the "source-backed card lane"** (`kb/forge-ask-all.mjs` roughly lines 285 to 2438), **the card "fast lane" that answers before search** (`kb/forge-mcp-all.mjs:367-416`), **the "source-bounded discovery" early return** (`:343-366`), `kb/card-lane.mjs`, `kb/capability-families.mjs` (pins exact passage hashes) | Grounding stamps recognise the card header (`plugin/scripts/grounding-answer.mjs:29`); about 25 test files mention the card lane; `evals/baseline.json`; the README's "capability cards" sentence | 1. Put the new file-level gate in place (section 6 step 1). 2. Serve the new lexical lane. 3. Remove the early returns. 4. Delete the recognisers. 5. Update the stamp pattern and tests. Do not delete first: the old exam would drop and look like a regression when it is the exam that was wrong. | Critical / L |
| R2 | **The 384-dimension build**: `kb/forge-build.mjs`, the `<name>.rvf` fallback probes (`kb/forge-ask-all.mjs:1564`, `kb/forge-guard.mjs:170`), the MiniLM fallback that triggers a model download when no sidecar exists (`kb/model-requirements.mjs:91`) | Tests and the `rvf-kb-forge` skill text; `forge-big.mjs:443` message | Remove the probes and fallback with the store-discovery change in section 6; then the file | Medium / M |
| R3 | `kb/forge-mcp.mjs` and `kb/mcp.snippet.json` (single-store server; the plugin starts `forge-mcp-all.mjs`), `kb/build-big-all.sh` (no caller found) | `scripts/build-bundle.mjs` and `bin/install.mjs` mention `forge-mcp.mjs` by name (uninstall's "looks like a brain" test) | Change those two references, then delete | Low / S |
| R4 | **Unwired hook code shipped to every user**: `plugin/scripts/kling-preflight.sh` (the owner's video-billing check), nine dispatch entries registered in no manifest (`hook-shim.mjs:96-142`), `identifier-preflight`, `spend-guard`, `degradation-watch`, `design-wall`, two `if false` blocks in `ground-ruvnet.sh:538-550, 706-718` | `scripts/wired-check.mjs:262, 818` exempts them by name; their own tests | Remove the exemptions and tests in the same change | Low / S |
| R5 | **The do-nothing registrations** (`capacity-aware-parallel-work`, `grounding-turn-gate`, `grounding-turn-mark`) or else turn them on. Running them switched off is the worst of both. | `plugin/hooks/hooks.json:30-39, 92-95`; Codex and Grok manifests; `hook-contracts.json` | Owner decision first: are the Stop nudges a product feature or the owner's own rules | Medium / S |
| R6 | **Five duplicate console commands and two duplicate skills** (`rnb`, `rvbc`, `rvcb`, `brain-console`, `configure` differ from `rnbc.md` by 2 to 6 lines) | README says `/rnbc` and `/rnb` | Keep those two | Low / S |
| R7 | **Stale proof at the repository root**: `PROOF.md` ("47/48 questions resolved to an expected repo", 2026-06-30, 19 repositories), `DESCRIBED-PROOF.md`, `MORNING-REPORT.md`, `HELIX-DEMO.md`, `HELIX-DEMO-NOHELIX.md`, `SPEC.md` (a June draft) | Links from docs | Move to an archive folder or delete; a visitor reads these as current | Medium / S |
| R8 | **Misleading eval artefacts**: `evals/baseline.json` (100% repository-level), `data/repo-recall-floor.json` (a floor that is not enforced), `scripts/top100-benchmark.mjs` (80 of its 100 questions are the same held-out set, graded by keyword presence) | `tests/unit/eval-brain-gate.test.mjs` pins the question hash; `scripts/claims-verify.mjs:47-60`; `dream.config.json` | Replace with the new instrument, then delete | High / M |
| R9 | **Owner-only material in the customer package**: the `release-proof` skill (this repository's release rules, triggers on any publish), maintainer job names in `plugin/scripts/brain-footprint.mjs:74-80` | none found | Move to the repository's own `.claude/` | Low / S |

**Owner decisions, not removals:** whether the model-routing subsystem (34 scripts, about 5,900 lines, plus
`~/.claude/model-router`) and the lessons/learning machinery (26 scripts, about 6,000 lines) belong in a
product whose job is to be an expert guide to rUv's work; and R5.

---

## 5. READY-BUT-WAITING: works today, value depends on the new retrieval layer

| # | What | Why it waits | Evidence |
|---|---|---|---|
| W1 | Grounding stamps and the write gate | A stamp is minted by a card answer as readily as by a real source read, and a card is what the evaluation rejected. The gate is only as good as the search behind it. | `kb/forge-mcp-all.mjs:405`; `plugin/scripts/grounding-answer.mjs:28-29` (V) |
| W2 | Evidence grades ("thin", "insufficient evidence") | The cut-offs 6.0, 4.0 and 0 are scores of the current reranker. A new ranking needs new cut-offs or none. | `kb/forge-ask-all.mjs:3055` (V) |
| W3 | Citation check and result schema | Sound, but they parse the printed result format (`#N repo= ... path: ... chars:`). | `kb/verify-citation.mjs`, `kb/retrieval-result.mjs` (A) |
| W4 | The keyword lane | A BM25 lane already exists in the product, off by default. Its header reports it lifted top-5 hits from 1 to 5 of 206: the right idea on the wrong chunks. | `kb/keyword-lane.mjs:1-8` (V) |
| W5 | The eval harness mechanics | Wilson intervals, frozen-question hash and fail-closed comparison are good. The metric and the questions are what must change. | `scripts/eval-brain.mjs:48-66, 117-150` (V) |
| W6 | The release canary | Real installed search through a real host on three systems. It needs honest questions. | `scripts/retrieval-canary.mjs` (V) |
| W7 | Corpus build, reconcile, bundle, census, signed update, footprint, doctor | All work; all hard-code today's file types (section 6). | section 6 |
| W8 | The warm worker and its idle exit | Exists to hold two models in memory (the code's own comment says 3 to 15 GB). If serving becomes lexical-first, most of this cost and the 20 to 73 second starts go away. | `plugin/mcp/server.mjs:236-246`; `kb/forge-mcp-all.mjs:369-370` (V) |
| W9 | The Console (`/rnbc`) and status surfaces | Not reviewed in depth; they report whatever the layers beneath report. | not reviewed |

---

## 6. What must change for the new retrieval design to ship

The target is the lead's: rebuilt passages with a path header, a lexical index as the backbone, a history
store, served as FILES + HISTORY with no router deciding whether to search.

### Order of work

**Step 0. Fix B1 to B7.** None depends on the design. B1 and B2 together are why this session and the lead's
had no search and a blocked write tool.

**Step 1. Make the measurement honest before changing the product.** Put a file-level, blind question set into
the release path (the lead's E and F sets are the pattern), replacing the repository-level exam (B31), the
"In the X repository" canary fixture (B30) and the recorded-only recall check (B32). Until this exists, any
change to serving will be judged by an instrument the old code was tuned to pass.

**Step 2. Build side.** One seam:
- `kb/forge-corpus.mjs:5-12`: `FORGE_CHUNKER_VERSION`, `FORGE_BUILD_FINGERPRINT`, chunk size. Changing the
  version forces a full rebuild through the existing ledger.
- `kb/forge-corpus.mjs:15-17`: the skip list containing `'v2'`.
- `kb/forge-corpus.mjs:251-266`: source bodies. Most files become "first 30 lines of comments" or are dropped.
- Fold the other three chunkers into it: `scripts/gist-receipts.mjs:333`, `scripts/corpus-aggregates.mjs:23`,
  `scripts/ingest-meeting.mjs:73`. Widen `gist-receipts.mjs:40` (B23).
- Embed with the header: only the unused `forge-build` path embeds `title — path` today (A).
- Model and dimension are written in at least ten places (`kb/forge-big.mjs:79-88`, `kb/forge-refresh.mjs:30-35`,
  `scripts/gist-receipts.mjs:41-42`, `scripts/corpus-aggregates.mjs:16-17`, `kb/package-cards-index.mjs:23-29`,
  `kb/model-requirements.mjs:4-8`, `kb/forge-ask.mjs:44, 355`, and others) (A). Make it one.

**Step 3. Register the new file types everywhere a store is defined.** A lexical index or a history store that
is not listed is dropped, deleted or refused:
- written: `kb/forge-refresh.mjs` artifact list (~:42-50) (A)
- reconciled: `scripts/corpus-reconcile.mjs:38, 42` (V that the lists exist)
- bundled: `scripts/build-bundle.mjs:807-813` copy list (V); `:197` finds a store only by `*.big.rvf` (V)
- private overlay: `scripts/private-overlay.mjs` required sidecars (A)
- searched: `kb/forge-ask-all.mjs:2440-2450` finds a store only by `.rvf` (V)
- installed: `bin/install.mjs:2901-2928` counts `*.rvf` and requires the transformer packages (A)
- updated: `kb/forge-update.mjs:595, 650, 1073, 1089, 1310, 1323, 1364` suffix rules (A)
- cleaned up: `plugin/scripts/kb-copy-proof.mjs:183` keeps every old copy unless the live folder holds a
  `*.rvf` (V); `:62-67` names the allowed sidecars (A). A lexical-only store would never release old copies.
- counted: the public chunk count is taken from idmap key counts (`scripts/claims-verify.mjs:414`) (A) and is
  printed in `README.md:258` and four explainer places via `scripts/sync-census.mjs:98-106` (V).

If vectors stop being the definition of a store, replace "a store is a `.rvf` file" with a manifest entry in
one change across these nine places.

**Step 4. Size and platform limits.** Projected corpus is about 2.3 GB of text and index.
- 2 GiB single-read limits: `bin/install.mjs:116`, `kb/update-storage-transaction.mjs:117`; archive limits
  `kb/zip-extract.mjs:50-57` (A). Hash by stream.
- The installer runs `npm ci` inside the knowledge folder (`bin/install.mjs:1159`) (A). A SQLite index needs
  either a compiled module there, or Node's built-in SQLite, which needs a newer Node than the declared
  `>=18` (`package.json` engines, V). Decide and test on Windows before building on it. Not checked live here.
- Disk headroom during update is already about four times the corpus (`kb/update-storage-transaction.mjs:29`) (A).

**Step 5. Serving side.** Keep the outer shell and the result shape; replace the inside.
- Entry point: `kb/forge-mcp-all.mjs:427-433` calls `searchAll`. Remove the two early returns above it (R1).
- Output: built inline at `kb/forge-mcp-all.mjs:459-472`. Move to a formatter with FILES and HISTORY sections.
- The success header must still match `plugin/scripts/grounding-answer.mjs:28` (`^Searched \d+ RuvNet repos \(`)
  or no stamp is minted and the write gate (B2) blocks every user. Change both together.
- Cut-offs: `kb/forge-ask-all.mjs:3055, 3077`; `scripts/eval-brain.mjs:46` (`ABSTAIN_CE`).
- The tool declaration lives in the long-running shell (`plugin/mcp/server.mjs:54-64`); changing its
  parameters needs a session restart and is flagged as such by the release classifier.
- Decide what "does not exist" looks like without a reranker score; the lead's answer test got 36 of 36.

**Step 6. Hooks and text.** `plugin/scripts/ground-ruvnet.sh` wording about how to search; the skill's census
numbers; `search-outcome.mjs` decline text (delete with the router).

**Step 7. Tests.** About 85 test files reference `kb/forge-*`; 83 mention `big.rvf`; 25 the card lane (A).
Rewrite the layout and reader tests; delete the mock-based ones that would keep passing while meaning nothing.

**Step 8. Then remove** R1, R2, R8 and close the old paths.

---

## 7. Scores with deductions

Each starts at 100. A known structural flaw caps the area at 70. Evidence is the item cited.

**(a) Installer and updater: 55.** Auto-update ignores the decline (B4) −10. Uninstall deletes private stores
and misreports (B5) −10. Node path in the spend job (B6) −5. Telemetry default (B13) −5. Undisclosed writes
outside its home, no proceed question (B14) −5. Size limits and misleading disk-full message (B15) −5.
Monolith, five locks, duplicated verify (B16) −5.

**(b) MCP server, plugin, hooks: 45.** Node path defect and 60 s hang (B1) −12. Gate deadlock (B2) −12.
Process cost per write and per tool (B8) −8. Do-nothing hooks (B9) −5. Runs a project script (B3) −8.
Instructions to missing scripts (B11) −4. Catch-all 45 KB skill (B12) −4. Duplicate commands (R6) −2.

**(c) Ingestion and build: 50.** Source bodies not indexed and chunks twice the embedder window: structural,
capped at 70 (lead's finding, `kb/forge-corpus.mjs:11, 264`). Four chunkers, three embedder set-ups (B22) −7.
Non-atomic gist path (B24) −4. Code gists excluded (B23) −4. No secret scan (B20) −3. Dead 384 path (R2) −2.

**(d) Serving path: 35.** Per-question special cases matching exam questions (R1) −20. Router refuses by design
(B26) −10. Default-six-means-one and the negative-score prune (B27) −10. No search deadline (B28) −5.
Messages an amateur cannot act on (B29) −5. A 4,043-line file with routing, lanes and grading entangled −5.
Separable helper modules (G10) keep it from lower. Capped at 70 in any case.

**(e) Release rails, CI, tests: 55.** No gate on answer quality: structural, capped at 70 (B30). The deciding
code is untested (B33) −7. 28% of tests gate; unit suite not required (B34) −4. Text-pinned tests (B35) −4.

**(f) Eval tooling: 20.** Repository-level metric −25. Exam questions special-cased in the product −25.
Unwired and 68 days stale −15. Recall floor set to 0 under a "BLOCKING" header (B32) −10. Canary questions
name the repository (B30) −5.

**(g) Dead code, duplication, stale docs: 45.** SECURITY.md wrong about what runs (B7) −12. CONTRIBUTING and
ADR-106 describe behaviour that is off or absent (B10) −7. Stale root proof files (R7) −5. README header says
4.6.2 and quotes a 206-store baseline under a 4.7.28 badge (`README.md:1, 258`, V) −3. Dead code (R2 to R5) −8.
Duplicated implementations (B16, B22) −7. Scope: search is about 7,200 of roughly 290,000 lines −10. Comments
that are incident diaries longer than the code they sit on (`decision-gate.mjs:44-86`, V) −3.

**(h) Security and privacy: 50.** Project script at session start (B3) −12. No query-time private fence (B17)
−8. Telemetry default and dead endpoint (B13) −6. Injection wrapper (B18) −6. Unattended fixer on shipped
search code (B19) −6. Inaccurate security document (B7) −5. Queries and project paths logged in clear
(`kb/forge-evidence.mjs:185`) −3. Tools run unpinned from the network on each launch
(`bin/install.mjs:6385, 6454`, A) −2. Client names in a public repo (B21) −2.

**(i) Amateur experience: 40.** First question is refused or returns one file, and the advice is "name a
repo" (B26, B27) −20. Search stops after a routine Node upgrade with no usable message (B1) −8. Median 5 to
12.5 s per search under load (lead's D3, D7) −8. Errors with no command (B29) −6. Download size and disk need
not stated; no proceed question (B14, B15) −6. A README that is honest but written as a list of disclaimers,
with stale numbers −6. Six names for one console (R6) −2. Clear failure messages at install (G3) are the
credit already counted.

---

## 8. What I did NOT review or test

- **Nothing was run**: no tests, builds, installs, searches or workflows. Latency figures are the lead's or the
  code's own comments. The one thing executed was a 10-line Node check of what a spawn of a missing binary
  emits, and a script that ran the recogniser patterns over the question files.
- **Not read**: the Console (`scripts/onboarding-console.mjs`, 3,811 lines, and `console/`); the model-routing
  scripts; the lessons and learning scripts; Codex and Grok adapters; `kb/forge-update.mjs` beyond about a
  third; `bin/install.mjs` lines 1240-1485, 1655-2540, 3150-3930, 4010-4573, 4860-5054, 6580-6985; most of
  `kb/forge-ask-all.mjs` 530-2440 beyond its outline; the explainer site; 15 of the 20 workflows in detail.
- **Not verified by me** (reader-reported, marked A): the install/update race; the terminal launchers'
  Node path; the nightly job's upgrade scope; the ntfy alert path; the thread-cap explanation for the worker's
  seven cores; the last-200-commits ratio; the `meta.entries` key mismatch in
  `scripts/refresh-capability-only-store.mjs:70`; most test-census examples; the issue-fixer guards.
- **Not checked live**: GitHub branch protection (whether `unit-suite` is required); whether `ISSUE_AUTOFIX`
  and `CORPUS_NIGHTLY` are on; whether the telemetry endpoint is still dead; anything on Windows or Linux.
- **rUv equivalents**: I could not ground which hand-rolled pieces rUv already ships (own zip extractor
  `kb/zip-extract.mjs`, three retry helpers, own lock, the BM25 port in `kb/forge-hybrid.mjs`) because
  `search_ruvnet` was down. They are listed as candidates only.
- **The injection-wrapper escape** (B18) and the 2 GiB limits (B15) are read from code, not demonstrated.
- I read `~/.cache/ruvnet-brain/health.json` once (a text file, no store was opened) for B1.
