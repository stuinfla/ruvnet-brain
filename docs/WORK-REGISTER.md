# Work register — the ONE status source

Updated: 2026-09-26 (single-source consolidation)
Created: 2026-07-27

This is the only place status lives. A row's State may only be `LIVE` or `STAGED` if every check it
names passes — `npm run single-source:check -- --machine` enforces that (check R1), so this file
cannot claim more than the evidence shows. "Done" is written before the work starts and means the
OUTCOME holds across the full scope, not that an edit exists.

States: `LIVE` (in effect on the machine/users, verified) · `LIVE-PARTIAL` (in effect, known gap named)
· `STAGED` (on branch consolidation/single-source, verified, not yet merged/released) · `IN-PROGRESS`
· `REOPENED` (a change was reverted after an audit) · `NOT-STARTED` · `NEEDS-OWNER` (blocked on Stuart)

## 2026-09-26 consolidation — critical path first

| # | Family | Done means (outcome, full scope) | State | Checks |
|---|---|---|---|---|
| 21 | Release blocker: public verification fails since v4.3.21 (search quality / MCP timeout) | Root cause named with offending commit; fix merged; a release reaches `install-verified` on 3 OSes | IN-PROGRESS | |
| 6 | Knowledge currency, apply and provenance (one apply path, one verdict, one provenance record, explicit local ownership) | This Mac converges to the published corpus generation; `--check`/`--apply`/banner agree; private + local stores survive; independent Opus audit passes | LIVE-PARTIAL (S1-S5 code complete and merged: one apply path, one currency verdict, explicit local ownership, one provenance projection, 106+ tests green; NOT yet proven on a real corpus release — see #27, the retrieval-accuracy gate that blocked the first real run through this path) | D2, D3 |
| 18 | Corpus gist job credential | Secret present; token lists gists (HTTP 200) | LIVE | C4 |
| 22 | 16 failing tests on main | Full `npx vitest run` green on the integration branch, no weakened assertions | LIVE-PARTIAL (all 16 original targets fixed and merged; a full sharded run now shows 12 unrelated pre-existing failures, none touching the fixed files, none introduced by this pass) | |
| 3 | Only the owner can publish | npm trusted publishing bound to protected-release.yml + env; no local publish-capable npm token; corpus-publish policy stated | NEEDS-OWNER | C3 |
| 1 | One code line (laptop vs GitHub) | main == origin/main; every laptop-only commit has a keep/drop verdict with evidence; every KEEP merged with its tests | LIVE (43/43 verdicts done; all 8 KEEP port branches merged into consolidation/single-source, 77 commits ahead of main, 0 conflicts unresolved; not yet pushed/PR'd) | G1 |
| 2 | One operating rulebook | Every statement in CONTRIBUTING.md verified by a fresh Opus audit; B-checks pass; checker runs in CI | REOPENED | B1, B2, B3, B4, B5, B6, B12 |
| 4 | One definition of "qualified"; one receipt contract | release.mjs check mode = release-qualification (staged); single receipt contract per the GPT-reviewed decision | IN-PROGRESS | |
| 5 | One machine updater | ak-sync green two consecutive nights; nothing the retired job did is lost (audited) | REOPENED | |
| 7 | One session-start continuity restorer | One restorer, measured restoring state in every project that has state | REOPENED | |
| 8 | One session-snapshot writer | One writer that keeps summaries + WAL maintenance, measured landing rows in every `.swarm` project | REOPENED | |
| 9 | One lesson store | All lessons in one store, zero lost (row-by-row mapping), one injector | LIVE | E3 |
| 10 | False "no search_ruvnet" Stop block (#316) | One vocabulary; regression test fails on old code, passes on new | LIVE (H1, tests/unit/grounding-stamp-terms.test.mjs, 6/6; merged) | |
| 11 | Hooks firing on notifications / false "AUTONOMOUS MODE" / unclosable objective | Each root-caused with regression tests | LIVE (H2-H7, 7 fixes merged, each with a regression test; 121/121 on the 9 hook test files) | E1 |
| 12 | One rule for verifying memory (`ruflo memory retrieve`) | No instruction anywhere (incl. ~/.codex/AGENTS.md) says to use sqlite3 | LIVE-PARTIAL | |
| 14 | Updater label defined once | One owner + one checked standalone copy | STAGED | D1 |
| 15 | Dead hook code | Unregistered global hooks archived; dead plugin bash route removed | IN-PROGRESS | |
| 16 | Plaintext API key (Kling) | Key only in the SOPS vault + derived copies; every consumer still gets it (audited) | LIVE-PARTIAL | F1 |
| 17 | One Node for scheduled jobs | All jobs on Node 24 and each job's entry point verified compatible (audited) | LIVE-PARTIAL | F3 |
| 19 | Scheduled workflows page on failure | Every scheduled workflow in ntfy-alerts | STAGED | C2 |
| 20 | One model-facts catalog | One catalog; others generated or deleted; one refresh owner | NOT-STARTED | |
| 23 | Scoreboard strength | Every check has a sabotage test proving it can fail; checker runs in CI | NOT-STARTED | |
| 24 | ADR status hygiene | Every ADR's header and body agree; index matches | IN-PROGRESS | B8, B11 |
| 25 | wired-check over-counts hook routes | `scripts/wired-check.mjs` marks a hook script live when only the hook-shim dispatch table names it; 11 shim ids (hijack-ruvnet, route-dispatch, ground-before-write, verify-interface, design-wall, protect-state, learn-capture, learn-flush, md-stamp, signal-watch, routing-outcome, swarm-slot-recycler) have no hooks.json / codex-hooks.json / settings.json registration. Done when wired-check traces from registered ids (and decision-gate sub-routes it actually calls), with a sabotage test | NOT-STARTED | A1 |
| 26 | CI never runs the full unit suite | Only curated file lists run in CI (`release-qualification.mjs` plans, `integration-linux.yml`, `ci.yml` qe configs); `developer-qa.yml` (full `vitest run`) is manual-only. Done when every PR to main runs the full `npx vitest run` and blocks on red, and a sabotage test (a deliberately failing unit test) is shown to block | IN-PROGRESS (branch testgates-4.4: canonical-qa `full-suite` job runs `scripts/full-suite-gate.mjs` against the reviewed `tests/known-red.json`; local macOS full run judged, gate sabotage-tested in `tests/unit/full-suite-gate.test.mjs`; NOT yet run on a GitHub Linux runner, not yet shown blocking a real PR) | |
| 27 | Corpus release fails the retrieval-accuracy gate (58% pass, 679/1164) | The gate passes on a real full-corpus release with genuine per-repo/per-query evidence, or the real cause (stale oracle pins vs. real quality regression) is named and fixed at its source | LIVE-PARTIAL (root cause was neither: the check was retired as a blocker on 09-15 (a20727b7) but one caller, corpus-reconcile.mjs, never stopped treating its exit code as fatal. Fixed, sabotage-tested (36/36), merged. NOT yet proven end-to-end on a live corpus run — that's the remaining unknown) | |
| 28 | Silent scheduled-job failures never paged | Every launchd job failure produces a real ntfy push | LIVE (root cause: ~/.cache/ruvnet-brain/ntfy-topic was missing on this Mac, so every job-heartbeat.sh alert silently no-op'd; fixed, proven with a real injected-failure push, regression test 3/3. issue-watch was never actually broken (transient network, self-healed). npm-token-renew remains blocked on npm's own 2FA/UI policy change — needs Stuart, token has 11 days left) | |

## Prior register (2026-07-27) — NOT re-verified since; each row must be re-checked before it is trusted

| # | The ask (his words, compressed) | State | What closes it |
|---|---|---|---|
| 1 | **Fix open issues before publish** — open means unfinished, close professionally, no shortcuts | #44 core fix BUILT (recursive shell parser in hook-input.mjs, 648 insertions, `/tmp/wt-44`), plumbing unfinished; #46 partial (`/tmp/wt-46`) | Both merged with red-first proof, CI green both OSes, closed with evidence + personal thanks |
| 2 | **Fix the contributor PRs** | DONE — #45 + #47 cherry-picked with authorship intact, landed `30505a9`, both closed with credit + reproduction evidence | — |
| 3 | **Architectural issue-triage program** — every issue reviewed for larger architectural signal, both models | Fable delivered: 33 issues → 7 classes, C1 (regex-not-structure) OPEN across #12/#13/#41/#44, C7 (ceremony-not-substance) the generator class. **GPT side unread.** | Read GPT, converge, ship `scripts/issue-arch-review.mjs` + class registry + the #12-replay canary |
| 4 | **Grade the QE suite on experience, not pass counts** | DONE — 53/100, D8=40 the floor. One-line diagnosis: world-class at not lying about itself, weak at leaving the author's machine. **GPT side unread.** | Converge both graders; re-grade after the fixes land |
| 5 | **Per-feature QE gate** — new functionality auto-covered, run for completeness, subscription seats only, never metered | Designed (Fable Task C): coverage markers + bidirectional lint inside wired-check; `seat-exec` fence that strips metered keys and refuses without explicit consent | Built, with the fixture that proves an uncovered capability blocks the ship |
| 6 | **MetaHarness deep review, gradations not on/off** | Fable delivered + corrected me: Darwin is a devDep (never shipped); the entire FREE read layer runs on no schedule; **rUv already built subscription-seat TDR** (`tdd-repair.mjs`, headless `claude -p`) so the hero capability needs no metered inference. **GPT side unread.** | Converge, then wire the free security read layer first (B1) |
| 7 | **Proactive intake — never check GitHub again** | Gap PROVEN: `issue-watch.mjs:135` queries issues only; PRs get one ntfy ping at creation then silence forever — which is why #45/#47 sat. Duel launched; **GPT side unread.** | Intake architecture shipped: PRs watched, daily guarantee with positive confirmation, auto-acknowledge, escalate only when a human is genuinely needed |
| 8 | **Check GitHub + Vercel CLIs on every deploy — protocol, not habit** | DONE — gate D+ shipped `afe5a56`: non-ci workflow failures, dependabot advisories, production-deployment readiness | — |
| 9 | **QE improvement cycle — any grade <95 → gap analysis → clean elegant fix; next grade in the 90s** | Plan delivered and accepted in principle: Move 1 wire six existing-but-unwired instruments (advisory→blocking ladder), Move 2 the user-machine battery, Move 3 four targeted tests. Deficit is ~40% unwired instruments, not missing tests. | Moves executed; rubric made ~70% mechanically derivable so the grade cannot be argued upward |
| 10 | **Fix the two lying surfaces + the D8 post-install check** | Both specified; both builders died to the API throttling. Root cause found and it is worse than the symptom: the honesty gate grades against a coverage artifact that was 9 days stale and then vanished — it can emit a false PASS. | Freshness as a precondition (stale/absent ⇒ loud UNVERIFIABLE, never a number), regenerate-never-hand-type, and `--doctor --hooks` that exits non-zero on a stranger's broken machine |

## Discipline debt, named
**Six GPT-5.6 verdicts (9.7 MB) are on disk unread** — items 3, 4, 6, 7 and the fourth-wall design have
been reported from Fable's side alone. A duel consumed on one side is not a duel. Reading and
converging them is the next action, ahead of new builds.

## Standing rules these all inherit
Subscription seats, never metered API (verified: no metered key exists in the environment — the fence
is an absence, not a policy). Red-first proof or it did not happen. A test that cannot fail on broken
code is not a test. The product can never lie — including about itself.
