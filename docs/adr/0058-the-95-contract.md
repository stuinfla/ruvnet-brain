---
id: ADR-058
title: The 95 contract — one observable per dimension, one mutant per observable, and the external-signal watch plane
status: Proposed
date: 2026-07-27
updated: 2026-07-31
impl: wired
authors: [Stuart Kerr, Claude Fable 5, GPT-5.6-Sol (codex)]
tags: [qa, gen2-qe, grading, external-signals, ci-watch, release-gate, mutation]
supersedes: []
relates: [ADR-028, ADR-050, ADR-052, ADR-053, ADR-055, ADR-056, ADR-057]
governs:
  - bin/install.mjs
  - plugin/hooks/hooks.json
  - plugin/hooks/codex-hooks.json
  - plugin/scripts/codex-hook-adapter.mjs
  - plugin/scripts/codex-hook-wrapper.mjs
  - plugin/scripts/hook-shim.mjs
  - plugin/scripts/verify-interface.sh
  - plugin/scripts/hijack-ruvnet.sh
  - plugin/scripts/session-start-core.mjs
  - plugin/scripts/session-start.sh
  - scripts/behavioral-l1-l4.mjs
  - scripts/learning-replay.mjs
  - scripts/ci/learning-replay-recorder.mjs
  - scripts/ci/learning-replay-codex-adapter.mjs
  - scripts/no-silent-substitution.mjs
  - scripts/qe/ux-suite.mjs
  - scripts/claims-verify.mjs
  - kb/card-lane-budget.json
  - scripts/qe/card-lane-gate.mjs
  - scripts/release-vector.mjs
  - scripts/release-proof.mjs
  - plugin/skills/release-proof/SKILL.md
  - plugin/skills/release-proof/scripts/release-proof.mjs
  - tests/qe/gpt56/live-brain-search.test.mjs
---

# ADR-058: The 95 contract

**Status**: Proposed
**Date**: 2026-07-27 · **Last updated**: 2026-07-31 · **Why**: the public 4.0.1 artifact exposed
that QE-BRN-001 existed in the written master plan but was absent from the executable critical-risk
map and release vector; the live `search_ruvnet` worker consequently timed out without blocking
publication.
**Implementation**: partial candidate repair, not an accepted release verdict. QE-BRN-001 now starts
the real MCP worker, requires cited `ruvnet-brain` source, exercises concurrent calls, and is invoked
fail-closed by `scripts/release-vector.mjs`. Its 2026-07-30 candidate run passed at 5.138s cold and
1.331s for two concurrent substantive searches after exact-name RVF routing was repaired. A later
broad release-process query exposed a second defect: thin evidence from the exact Brain scope still
fell back to the entire corpus and timed out at 30.004s. Product-primary routing now retains honest
scoped evidence instead of widening; the same query passes in 0.671s, with 118/118 focused tests and
3/3 live MCP cases. The new `release-proof` skill and executable authority fail closed on dirty
lineage, zero/skipped/todo work, open issues, exact-SHA GitHub failures, artifact/host/grader binding
splits, missing self-RVF, deadline-margin breaches, and public-byte drift. GitHub now enforces required
checks for admins and protects `Production – ruvnet-brain` with required review and no admin bypass.
D4 has a current Codex-backed
3/3 treated versus 0/3 control artifact on source SHA `63e5e67`, plus committed delete-lesson and
brain-off-treated causal failures in `2b39f68`. D3 now executes its real signal lifecycle from the
release vector (`2984783`). The packed installer, Top-100 harness, routing outcomes, retrieval
receipts, and structured CLI boundary are committed (`7eb11fb`, `b48fb3b`, `27cca88`, `859a16d`,
`e089074`, `4ad464e`). This is still not a release verdict: the worktree is dirty and split from
remote main, five issues remain open, remote CI/Windows UX are red, the installed 4.0.1 registry
lacks the Brain self-store, WSL2 and the published artifact remain unproven, Agentic QE currently
reports a vacuous 0-test pass through its CLI, and both external graders have not re-run on one clean
published candidate.

The post-merge run of PR #70 then caught another oracle defect before publication: the Windows
PowerShell stranger path measured a real cold SessionStart at 4597ms, but D6's dedicated gate only
rejected the cold sample at the full five-second watchdog. Commit `cd28e28` makes the checked-in
4000ms absolute limit apply to the cold sample too, defers the redundant heartbeat when the same
first session already dispatched Stable-Spine seeding, preserves stage traces in stranger receipts,
and makes bundle assembly refuse zero RVFs, missing required files, or a stale ZIP. This is still a
candidate repair—not a release verdict—until exact-SHA cross-platform CI, rebuilt artifact,
clean-install, installed-MCP latency, and publication checks pass.

The first PR #71 core run then rejected the initial implementation because it deferred maintenance
on a Brain-OFF machine. Commit `0f68737` preserves both contracts without restoring the latency
race: one detached first-session worker seeds the Stable Spine and then performs the heartbeat
sequentially. A seed failure prevents the check; a network-check failure cannot undo a successful
seed and the normal 15-minute retry remains armed.

Extends ADR-057's build order. ADR-057's diagnosis — the three concealment mechanisms, the five
converged classes — is the incident record and is not restated.

## The law, restated once, because every row below is an instance of it

> A test may only claim what it can observe. A grader awards 95 only to an observable a machine
> checked on the candidate SHA, **plus the named mutant that proves the check is load-bearing.**
> Partial work earns zero credit: an observable without its mutant is an intention, and intentions
> scored 38/100.

**95 means 95 on BOTH graders.** Design target throughout is the harsher reading (GPT-5.6-Sol, who
gave the 18 and the 28). One grader at 95 and the other at 60 is a 60.

## Duel record

Two independent designs, produced from the same brief. **Both converged on the same core**: a
tri-state per-invariant verdict bound to the candidate SHA, a release gate that is a **vector
minimum and never an average**, and a mandatory known-bad mutant per observable. Fable named the
states `green|red|inconclusive`; GPT named them `PASS|FAIL|UNKNOWN`. **GPT's naming is adopted** —
`UNKNOWN` says out loud that the detector could not tell, which is the exact distinction the
`--levels L5` vacuous pass erased.

GPT's honest critical-path estimate: **8–12 engineer-weeks for one engineer.** Recorded here rather
than softened; the per-item costs below sum to roughly that.

**One GPT claim was checked and is FALSE.** It reported *"live `gh auth status` is degraded: the
active `stuinfla` token is invalid"* and built a watch-plane justification on it. Verified
first-hand: `gh auth status` reports `✓ Logged in to github.com account stuinfla`, token valid,
scopes `admin:public_key, gist, read:org, repo, workflow`. The watch-plane requirement stands on its
own evidence (the owner had to report a red pipeline); it does not need and must not cite this.
GPT also could not write its documents — the session was launched `--sandbox read-only`, which was
the operator's configuration error, not a failure of the design.

## Scoreboard of what has ALREADY moved since the graders ran — no credit claimed

Verified first-hand at file:line, not relayed:

| Deduction | State on main today | What still gates the points |
|---|---|---|
| D8 −35 "verification failures do not stop installation" | **Narrowed.** `bin/install.mjs:3240-3248` consumes `runSelfCheck()` and sets `process.exitCode` | No stranger-machine matrix exercises it; no mutant proves the line is load-bearing |
| D8 −20 "grounding smoke never fatal" | Still true **by design** | §D8 decides it explicitly rather than dodging |
| D7 −30 "regex parses shell semantics" | **Closed at the authorization boundary.** `e089074` enforces managed CLI help/run through structured schemas and literal argv; `4ad464e` makes raw-shell `verify-interface.sh` advisory-only. `tests/regression/interface-gate-corpus.test.mjs` proves every historical shell shape exits 0, and `tests/unit/verify-interface.test.mjs` ratchets out blocking dependencies on shell-structure reconstruction. | Packed/published-host proof is still required under D8; the raw hook is migration guidance, never authority. |
| D1 −4 coverage floor vs badge | **Closed** (floor 26/28, badge 28%, re-derived by claims-verify) | Nothing — but it was only 4 points |
| D1 −8 `REQUIRE_BRAIN` | **Open** — grep confirms **0** workflow files set it | §D1 |
| Vacuous-pass guard | **Closed** — `--levels L5` exits 2 | Nothing |
| Fast lane | **Safety-corrected, performance proof reopened.** Reuven Cohen's 2026-07-28 report exposed that curated capability cards were being treated as built-state proof. The truth gate now forces factual capability/implementation claims to source search (0/19 capability assertions use cards); recommendation-only routing remains fast. | Generate and verify source anchors for cards before restoring fast factual answers; until then correctness wins and D6 gets no capability-latency credit. |
| D6 −22 "latency breaches only warn" | **Closed.** `kb/card-lane-budget.json` (checked-in manifest) + `scripts/qe/card-lane-gate.mjs` (in-process p50/p95/max over 100 firings) wired into `scripts/qe/ux-suite.mjs` as a genuine hard gate; env-sensitive timings unchanged (still advisory) | Nothing — both mutants proven (1,100ms sleep → real FAIL; silent manifest raise → `doc-currency` `presumed-stale` BLOCK once drift accumulates, see build report) |

Everything else in both graders' lists is fully open.

## What 95 requires, per dimension

### D8 — stranger's machine · 18 → 95 · FIRST, because it caps everything

**Observable**: a required `stranger-matrix.yml` that, on the **packed tarball of the candidate
SHA**, in five images (ubuntu, windows Git-Bash, windows PowerShell, macos, and a hostile container:
no `jq`, no `gh`, `sh`-only, HOME containing a space, network denied), installs into a **virgin
HOME** and asserts: (a) healthy → exit 0 **and ≥1 hook fired through the INSTALLED registration**;
(b) seeded-broken (`forge-mcp-all.mjs` removed from the tarball) → exit **non-zero**; (c) **no
author-local `~/.claude/settings.json` exists in any image**, so any README-promised behaviour that
only fires from the owner's layer is caught here as a lie.

**The grounding-smoke decision, made rather than dodged**: a failed smoke stays **non-fatal on a
default install** — a first-run model download or an air-gapped machine is not a broken install, and
blocking there fails every offline user. What changes is that the verdict stops **evaporating**: it
persists as `install-state.json: grounding: unproven`, `--doctor` exits 1 on it, session-start
surfaces it once, and the first real `search_ruvnet` clears or confirms it. The hostile cell runs
`RUVNET_STRICT_INSTALL=1` where smoke failure **is** fatal, so the strict path is tested even though
it is not the default.

**Mutants** — M-D8a delete `forge-mcp-all.mjs` from the tarball → matrix red · M-D8b revert
`process.exitCode = selfcheck.exitCode` to a bare statement → seeded-broken lane exits 0 → red ·
M-D8c register a hook that sleeps past its declared timeout → battery cell red.

**Cost** 3.5 days + Windows CI minutes, no tokens. **Skip cap**: D8 ≤40 and Rule 9 holds OVERALL ≤70.

### D3 — proactive · 53 → 95 · includes the EXTERNAL-SIGNAL WATCH PLANE

The owner's addition, and the purest instance of the rubric row: **CI was failing and the owner told
the brain.** A product whose pitch is "proactive" that must be told about a red pipeline by its user
has failed D3 in the way that matters most.

**Two sources, split by physics — never conflated.**

**W1 OBSERVED (free, no polling).** The model already runs `gh`, `vercel`, `netlify`,
`npm publish`, `git push`. One new shim entry `signal-watch` on **PostToolUse, matcher anchored
`^Bash$`** (GPT's anchoring — an unanchored matcher is F3/F4). It classifies the executed command
with `commandNodes()` in **executable position** — never a grep, so "vercel" inside a commit message
cannot fire — and reads the outcome from `tool_response`.

> **VERIFY-FIRST CLAUSE, MANDATORY.** The exact Bash `tool_response` field shape must be captured
> from **three real recorded envelopes, checked in as fixtures, BEFORE any parsing code is written.**
> Guessing a field name here is the interface-guessing sin `verify-interface.sh` exists to block, and
> a watcher that silently parses nothing is this project's signature severed-pipe failure.

A non-zero managed outcome emits `additionalContext` (advisory, never blocking — malfunction is never
a decision) and appends a `SignalDebt` to `pending.jsonl` (**single writer**). A successful
`git push` opens a **pending CI verdict** keyed (repo, SHA).

**W2 POLLED (deferred verdicts).** No new daemon — extends the proven `issue-watch` pattern.
`scripts/signal-watch.mjs` runs `gh run list --commit <sha> --json status,conclusion,workflowName`
(**read-only verbs only**), reuses `ci-verdict.mjs`'s unknown-is-red law rather than reimplementing
it, and polls at bounded moments: session-start when debt is pending and cache >10min stale; Stop
(inside the existing continuation-gate — ADR-055 §3.4 forbids a second Stop hook) when debt pending
and last poll >2min. **Never per-prompt.**

**The anti-nag law** (this is where watch planes die, so it is a hard rule with its own red test):
speak on **transitions only**. Green produces **zero bytes** unless it closes a previously-surfaced
red. A turn that pushed cannot end silently with the verdict unknown — one advisory line, never
holding the turn hostage to GitHub's queue.

**Degradation ladder**: no `gh` → W1 still fully works (exit codes need no gh), W2 records
`unverifiable: gh not installed`, surfaced **once per debt**; unauthenticated → same with
`gh auth login required`; API error/offline → verdict **UNKNOWN**, debt stays open. **Never fakes
green, never silently disables** — silent-off is scored equal to crashing.

**Mutants** — **M-W1 (the headline)**: seed a push-debt, inject a canned `gh run list` fixture
(`SIGNAL_WATCH_GH_FIXTURE`, so CI needs no network) resolving to `failure`, run the **literal**
session-start registration, assert the CI-red line appears **with zero user input in the
transcript**. Delete the consumer block → red. *This is 2026-07-27 replayed with the human removed.*
· **M-W2**: an all-green fixture must emit **zero bytes**; break transition-dedupe so green speaks →
red. · **M-W3**: treat an API error as green → rate-limit fixture red. · **M-W4**: remove
`tool_response` parsing → recorded `vercel deploy` exit-1 envelope → red.

**Cost** 2–3 days, no tokens, no new infrastructure. **Skip cap**: D3 ≤65 — this is the dimension
where trust is personally lost when the human is the alarm system.

Also in D3: `hijack-ruvnet.sh` gains **anonymous-shape** categories (hand-rolled cosine, ad-hoc
embedding loops, agent-memory glue) because `:44-57` only knows brand names; and
`no-silent-substitution.mjs` gains `--project <dir>` so `audit()` can finally open the **user's**
repo instead of only this one.

### D7 · 32 → 95
`tests/regression/interface-gate-corpus.test.mjs` — every case cites its incident (#12, #13, #41,
#44, plus the 2026-07-27 heredoc bite), runs the **literal registered command** via `hook-shim.mjs`,
and asserts an exact allow/block verdict. Must-BLOCK: the three #44 escapes. Must-ALLOW: `grep -E
"foo|ruflo init"` (#41), a commit message mentioning `ruflo` (#12), JSON-escaped quotes (#13), a
heredoc whose body opens with a tool name. The suite fails if any listed incident has zero cases.
Also: replace `hijack-ruvnet.sh:31`'s `command -v jq || exit 0` with the node path every other gate
uses. **Mutants** — FN: stop recursing into `bash -lc` → #44 cases sail → red. **FP (mandatory)**:
treat single-quoted `$( )` as live → #41 blocks → red. *Four of five incidents were false positives;
a corpus that only catches misses recreates the one-sided fix pattern.* **1.5 days. Cap ≤50.**

### D6 · 28 → 95
Two-tier `ux-suite.mjs`: environment-sensitive timings stay **advisory** (a flaky gate trains
overrides); the deterministic **decision lane** becomes a **hard gate** — card lane p95 ≤ **250ms**
over 100 firings, absolute fail >**1,000ms**. 1,000ms is ~8,600× the measured 0.1158ms, so a breach
is a correctness event, not jitter. Justification is the product's declared envelope: fast pre-tool
hooks retain 5s while the two UserPromptSubmit hooks use 10s host deadlines around an internal 4s
runtime bound, and those hooks *order* the model to consult the brain — a product may not order a
consultation it prices above its own budget. **Mutants** — insert a 1,100ms sleep → **fails**, not
warns · raise the threshold without a currency stamp → doc-currency red. **1 day. Cap ≤50.**

### D5 · 35 → 95
`tests/mesh/coexistence.test.mjs` with sentinel foreign hooks (slow, failing, garbage-printing;
registered before **and** after ours): every sentinel fires exactly once; the user's `settings.json`
and `~/.codex/config.toml` are **byte-equivalent** after install → update → uninstall; our lint
enumerates-but-never-charges foreign findings. **Mutants** — normalize/reorder the user's JSON keys →
byte-diff red · make one of our advisory hooks exit 2 → single-blocker invariant red. **1.5 days,
depends on D8's images. Cap ≤60.** *The 63-findings count is not the target — 52 are machine-local
and not ours; the points come from proving we never touch what we do not own.*

### D4 · 36 → 95
Counterfactual replay, nightly, N=3, pass ≥2/3, transcripts archived — **a rate, never a verdict.**
One trap specified concretely so it cannot dissolve into intention: record in fixture-project-A that
`ruflo memory search` takes `-q`, not a positional; open a fresh session in fixture-project-B with a
**differently-worded** task. PASS requires all three: the lesson loaded **before** the first tool
call; the produced command uses `-q` where the **brain-off control** uses the positional form; and
the trap still passes after a nightly refresh runs between record and replay. The oracle is a
**machine-checkable token**, not a similarity judgment.

> **A trap whose CONTROL run also produces `-q` is INVALID — the result is INCONCLUSIVE, never a
> pass.** This is the exact inversion of L4's defect: L4's `must:` list proved the brain spoke; this
> proves the agent's **artifact changed, against a control**.

**Mutants** — delete the lesson row → red · run the treated arm brain-disabled; it must produce the
control artifact → red. **2–3 days, REAL TOKENS nightly — the one standing spend, priced in the
open. Cap ≤55.**

### D2 · 42 → 95
`tests/experience/scenarios.json` — **verified absent today** (`tests/experience/` does not exist).
~20 hand-written coherent scenarios in ADR-053 §1's record shape, plus a report that fails on: any
coherent scenario unclassified, `manual` >20%, or any `ci`/`scheduled-live-probe` naming a job that
does not exist in `.github/workflows/` (a machine-checkable join, so a scenario cannot point at a
fictional runner). **Mutant** — delete a classification, or point one at a non-existent job → red.
**1 day; the list is human work by design. Cap ≤55.**

### D1 · 50 → 95
`REQUIRE_BRAIN=1` grep-findable in `.github/workflows/ci.yml` — a warm-brain lane (bundle cached by
SHA) where a **skipped battery FAILS**. The conversion already exists in `run-tests.mjs`; the lane
just has to exist and set the variable. **Mutant** — point the cache at an empty dir → the skip
converts to a failure → lane red; that single mutant proves both the lane and the env wire.
**1 day + cache storage. Cap ≤60.**

## Ranked build order (dependencies stated, red-first per item)

1. **D8 stranger matrix + install DEGRADED state** — nothing downstream is trustworthy on a machine
   where install cannot fail. No dependencies.
2. **Plane W (external-signal watch)** — the owner's named wound and the cheapest large win.
   Depends only on the shim.
3. **D1 `REQUIRE_BRAIN` lane** — depends on the bundle cache.
4. **D2 scenarios + report** — informs which matrix cells D8 grows next.
5. **D7 incident corpus + both mutant polarities** — classifier already landed.
6. **D6 two-tier ux-suite** — card lane already landed.
7. **D5 coexistence sentinels** — depends on D8's images.
8. **Distribute the walls** (ADR-055 item 8) — **after 5 and 7**, because shipping a blocking gate to
   strangers before its corpus and coexistence proof exist is how #12 happened the first time.
9. **D4 traps + D3 strata** — last; they burn tokens nightly and depend on fixtures from 1 and 4.
10. **Release-gate flip** — after 1–9 exist, the gate becomes required.

## The release gate — a critical-invariant VECTOR, never an average

`claims-verify.mjs` gains:

```
INSTALL-FAILS-LOUD | INTERFACE-CORPUS | LATENCY-DECISION-LANE | COEXIST-BYTE-EQUAL |
LEARNING-REPLAY | SIGNAL-WATCH-FIRES | SCENARIOS-CURRENT | GUARANTEE-RUNS
```

Each is `PASS | FAIL | UNKNOWN` **on the exact candidate SHA**. The verdict is the vector
**minimum**; `UNKNOWN` is not `PASS`. Any non-PASS forces README/status/release metadata to
`DEGRADED` and **mechanically bans** the strings "healthy", "proven", "all pass", and any composite
score — with its own mutant (write "all pass" into README with one invariant red → release refuses).
*An average is how 18/100 coexisted with "all pass" on one page; the vector makes that state
unrepresentable.*

## Where the score gets WORSE before it gets better — said out loud

The first full Gen-2 run should read **below 38**. The counterfactual replay fails today. The
signal-watch E2E fails today — the 2026-07-27 incident is the proof. The scenarios report fails today
because the file is absent. **A Gen-2 suite green against today's product would be the
self-congratulation it exists to kill.**

And README:484/526's *"L1–L4 behavioral harness — all pass … drives the full pipeline"* must be
downgraded **now**, before any build item, to what L4 actually proves: *the hook injects the full
directive set* — a speech test, not a behaviour test. The visible claim gets weaker today. That is
correct: **the strong claim was the defect.**

## What CANNOT be automated — named, with owners

1. Whether an offer was **welcome** (precision's numerator) — human adjudication, owner: Stuart.
2. Whether a substitution **choice** was right in an open-world architecture — human review of the
   nightly transcripts; a grader model may second-opinion, never sole-gate.
3. The ~20 scenario list's **coherence** — hand-written by design.
4. **The 95 itself** — awarded only when BOTH graders re-run the same rubric on the same SHA and both
   land ≥95. No self-score counts; the 83-vs-38 category error is not repeated.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-07-31 | Tightened the D6 candidate back under the existing 4,096-byte stdout contract without changing a threshold: redundant first-load prose was shortened in `session-start-core.mjs`, while every offered choice and action remains live. | The prior packed PR head failed honestly at 4,129 bytes on macOS and 4,118 bytes on Ubuntu. The corrected real packed macOS scenario passed 76/76 registered firings; focused tests passed 106/106, the plugin battery passed 60/60, and the registered wall-time gate passed at 208ms cold, 143ms p95, and 146ms max. Cross-platform CI is required again on the committed correction before release. |
| 2026-07-31 | D4 was refreshed after `plugin/scripts/hook-shim.mjs` became the single Node SessionStart route; both independent lessons and all four causal mutants were regenerated instead of carrying evidence across a load-bearing shim change. | Source SHA `535c6ec`: memory-search-query passed 3/3 treated versus 0/3 control, hooks-post-task-persistence passed 3/3 versus 0/3, and delete-lesson plus brain-off-treated each collapsed both traps to 0/1. Every treated success executed the real global Ruflo command and produced the required retrieval/persistence outcome; both `--check-portfolio` and `--check-mutants` return PASS. Updated artifacts are the six `data/learning-replay*-result.json` files; model `gpt-5.6-sol`, cost $0. |
| 2026-07-31 | D6 now measures a host-neutral native Node SessionStart authority; the checked-in p95 and absolute-fail budgets are unchanged. Governance follows the authority into `plugin/scripts/hook-shim.mjs` and `plugin/scripts/session-start-core.mjs` instead of treating the compatibility shell trampoline as the whole implementation. | The root-cause trace separated **4709ms of pre-body Git Bash variance** from an **879ms hook body**. The native core and shell compatibility surface passed **5/5 full-parity cases**, and the adjacent focused suite passed **141/141**. The real registered local gate measured cold **250ms**, p95 **205ms**, max **220ms**, with no threshold relaxation in `kb/card-lane-budget.json#sessionStart` or `scripts/qe/session-start-gate.mjs`. **Windows packed CI remains pending**; these local and parity results are candidate evidence, not an exact-SHA packed-Windows green verdict. |
| 2026-07-31 | Replaced the first cold-start fix's deferred heartbeat with one composite seed-then-heartbeat worker, and refreshed the self-knowledge RVF to the exact code commit. | PR #71 core job `91073195901` correctly failed `tests/unit/brain-off.test.mjs`: the heartbeat stamp stayed at `1`, violating ADR-054's rule that Brain OFF still receives fixes. Commit `0f68737` introduces `plugin/scripts/first-session-worker.mjs`, which serializes seed and heartbeat behind one detacher. Focused acceptance passed 70/70 and the real registered gate measured cold 249ms, p95 182ms, max 192ms. The refreshed `ruvnet-brain.big.rvf` contains 2157 passages, passed 3/3 round trips, and `kb/RVF-GENERATIONS.json` binds it to `0f68737`. |
| 2026-07-31 | Closed the cold-start oracle gap exposed by the exact post-merge Windows stranger run and made release bundle assembly fail closed. | Main run `30603476401`, Windows job `91070872621`, measured the valid SessionStart at 4597ms while `scripts/qe/session-start-gate.mjs` rejected only a full timeout. Commit `cd28e28` applies `absoluteFailMs=4000` to the cold sample, makes `plugin/scripts/session-start.sh` avoid launching both seed and heartbeat workers in one virgin session, emits `SESSION_TRACE` in the stranger path, and makes `scripts/build-bundle.mjs` refuse zero public RVFs or missing required files before creating a ZIP. Focused verification passed 141/141 tests; the real registered command measured cold 244ms, p95 190ms, max 242ms. |
| 2026-07-30 | Removed the isolated unit-test module from `governs:`; the executable release authority and its live-QE caller remain governed. | `tests/unit/release-proof.test.mjs` is an acceptance observer, not a production caller. Treating an intentionally test-only module as an unwired runtime surface capped the implemented authority at `built` and made D7 fail for the wrong reason. The runtime path remains `scripts/release-vector.mjs` → `tests/qe/gpt56/live-brain-search.test.mjs` plus `scripts/release-proof.mjs`. |
| 2026-07-29 | Re-read the complete governed set after the prompt-hook timeout repair; the vector-minimum contract is unchanged, and D6 now states the real 5s pre-tool / 10s prompt-host envelope rather than the obsolete uniform-5s claim. | PR #65 / commit `6734597` changes only the two UserPromptSubmit declarations in `plugin/hooks/hooks.json` and `plugin/hooks/codex-hooks.json`; their inner runtime remains bounded at 4s and the new regression caps the host declaration at 10s. The exact candidate's release vector and cross-platform CI passed before merge; this is release evidence, not a two-grader 95 claim. |
| 2026-07-29 | Reviewed the complete governed-path history since `7709c67` and re-read the only changed governed path; both post-document installer fixes strengthen D8 and leave the 95 contract unchanged. | Commit `c2d5ef0` makes `bin/install.mjs` count canonical `*.big.rvf` stores; commit `ebe51a5` makes Codex status honor `CODEX_HOME` and decode Windows TOML paths. Focused installer smoke passed 22 tests (1 skipped, 3 todo), and Codex wiring passed 42/42. Neither commit proves a published candidate or both external grades. |
| 2026-07-29 | The `cmd start /b` candidate also retained the inherited capture handle, so the launcher now uses PowerShell's native `Start-Process` boundary with arguments outside the command string. The unchanged cold hard gate remains the acceptance test. | PR #58 run `30424023167`, Windows job `90486434201`; governed source `plugin/scripts/detach.mjs`; acceptance `scripts/qe/session-start-gate.mjs`. |
| 2026-07-29 | The packed Windows PowerShell stranger run found an unrelated valid prompt timing out while cold maintenance was active. `ground-ruvnet.sh` now takes a conservative quiet-prompt fast path only when neither prompt intent nor project state can produce output; the stranger gate and 5s declaration remain unchanged. | PR #58 run `30424223276`, Windows PowerShell job `90487025753`; governed source `plugin/scripts/ground-ruvnet.sh`; acceptance `scripts/ci/stranger-scenario.mjs`. |
| 2026-07-29 | The shell-level quiet fast path still spent 4209ms starting Windows interpreters, so the already-running registered Node shim now bounds/classifies stdin first and avoids Git Bash only for prompts proven silent. Relevant/project-state prompts still execute the unchanged shell body with the captured input. | PR #58 run `30424458501`, Windows PowerShell job `90487744537`; governed source `plugin/scripts/hook-shim.mjs`; acceptance `scripts/ci/stranger-scenario.mjs`. |
| 2026-07-29 | Changing the load-bearing hook shim correctly invalidated D4 until every causal artifact was rerun. Both independent N=3 treated/control lessons and all four N=1 delete-lesson/brain-off mutants were regenerated with the live Codex host; the portfolio and mutant checks now pass again without carrying forward evidence from the old shim. | Source SHA `79573ff`; memory-search 3/3 treated versus 0/3 control, post-task persistence 3/3 versus 0/3, both mutants 0/1 for both traps, model `gpt-5.6-sol`, cost $0. Artifacts: `data/learning-replay-result.json`, `data/learning-replay-post-task-result.json`, and the four named mutant result files. |
| 2026-07-29 | `windowsHide` did not sever the inherited capture handle, so the launcher tried Windows' native `start /b` no-wait boundary with arguments outside the shell string. The unchanged cold hard gate remained the acceptance test; the next exact-SHA run disproved this candidate and the row above supersedes it. | PR #58 run `30423859369`; governed source `plugin/scripts/detach.mjs`; acceptance `scripts/qe/session-start-gate.mjs`. |
| 2026-07-29 | The cold trace localized the timeout after the hook body had finished, so the Windows detached launcher now uses hidden independent consoles with non-inherited stdio. The cold hard gate remains unchanged and is the acceptance test. | PR #58 run `30423673957`; governed source `plugin/scripts/detach.mjs`; acceptance path `scripts/qe/session-start-gate.mjs`. |
| 2026-07-29 | The first corrected Windows run remained red, so the contract stays red and now records the exact cold stage trace on failure. No threshold changed. | PR #58 run `30423370117`, Windows job `90484507774`; source `plugin/scripts/session-start.sh`, `scripts/qe/session-start-gate.mjs`, and `scripts/qe/ux-suite.mjs`. |
| 2026-07-29 | The exact-head audit found two gates that were falsely outside the release verdict: three blocking stale ADRs and a Windows cold SessionStart that exceeded its declared timeout while the suite labeled it an ungated warm-up. D7 now requires both the interface incident corpus and `doc-currency --check`; D6 now isolates `HOME`/`USERPROFILE`/Brain state to one fixture root and treats a cold timeout as a hard failure. This is a tightening of the 95 contract, not a score claim. | Independent Grader B on `989e19a` scored a 55 minimum at D7. Live `node scripts/doc-currency.mjs --check` found ADR-050/055/058 blocking. Main UX run `30422743294` measured cold fires of 8514ms and 7156ms across attempts; source paths `scripts/release-vector.mjs`, `scripts/qe/session-start-gate.mjs`, `scripts/qe/ux-suite.mjs`, and `tests/unit/session-start-gate.test.mjs`. |
| 2026-07-28 | **D4 portfolio closure is now mechanically PASS on two independent causal lessons, including four current real-model mutants.** | On the unchanged load-bearing harness from `bca229d`, memory-search refreshed to 3/3 treated versus 0/3 control: every treated command used `-q`, exited 0, and retrieved the seeded row; controls used the rejected positional form. The post-task persistence artifact remains current by substance and passed 3/3 versus 0/3 as recorded below. Both lessons were independently recorded in two source git projects before speaking in the third, both survived a Stable-Spine refresh, and every passing command produced its claimed meaningful outcome. Four current N=1 Codex mutants then went red for the expected causal reason: delete-lesson and brain-off-treated each collapsed memory-search to positional 0/1 and post-task to partial/non-persistent 0/1. `node scripts/learning-replay.mjs --check-mutants` and `--check-portfolio` both return PASS; the five committed artifacts are `data/learning-replay-result.json`, the two original mutant paths, and the two `learning-replay-post-task-*-result.json` paths. This closes D4's portfolio proof only; it does not claim published-package, WSL2, or two-external-grader closure for other dimensions. |
| 2026-07-28 | **A genuinely prior-sensitive second D4 lesson passed its single predeclared trial; portfolio closure still requires refreshed first-trap and mutant artifacts.** | On exact source SHA `bca229d`, the new `hooks-post-task-persistence` trap first verified the live #2785 contract: `--task`, `--agent`, and `--store-results` are all required to persist the reusable decision, while success/task-id alone exits 0 but creates neither persistence row. Its oracle does not trust stdout: it executes the first produced command in the fixture, then requires both a matching `.claude-flow/routing-outcomes.json` outcome and `routing-decision:<task-id>` memory row. One N=3 Codex trial passed 3/3 treated versus 0/3 brain-off control; all treated commands used the three-part contract and persisted both rows, while controls guessed `--persist-routing`, `--store-decisions`, or `--store-memory` and persisted nothing. Lesson delivery preceded the first tool 3/3, two independent source projects earned ADR-G008 scope, refresh survival was true, model `gpt-5.6-sol`, cost $0. The committed artifact is `data/learning-replay-post-task-result.json`. Deterministic focused tests use an injected CLI fixture rather than assuming the maintainer's global Ruflo path; the POSIX daemon-census test is explicitly skipped on Windows rather than claiming an unmeasured Windows process proof. |
| 2026-07-28 | **D4 now requires a two-lesson portfolio and the real ADR-G008 win-twice scope, but the portfolio remains UNKNOWN rather than being rounded up.** | Commits `722fddd`, `8137f17`, and `cfa10a9` make each trap record and read back the same correction in two independent source git projects; only `lesson-gate.mjs`'s existing `projects.length >= 2` universal predicate permits delivery in the third replay project. `checkPortfolio()` requires two distinct lessons/tasks, N>=3 treated/control evidence, meaningful command execution, refresh survival, and delete-lesson plus brain-off-treated mutants for each trap. The first replacement candidate (`hooks model-route -t`) was rejected because its brain-off control independently used `--task`; the final predeclared command-risk candidate was likewise **INCONCLUSIVE** on exact code SHA `cfa10a9`: treated 3/3 used `-c/--command` and returned a real risk/proceed decision, but control also carried the token 3/3 (and worked 2/3). No invalid second-win artifact was committed. The last memory-search 3/3 result became stale when the load-bearing portfolio harness changed, so D4 correctly remains UNKNOWN pending a genuinely prior-sensitive second lesson and fresh artifacts. The same work fixed a D7 leak found during replay: fixture Ruflo daemons are now reaped by exact `--workspace` containment on normal exit and interruption; focused D4 tests pass 57/57 and a post-run process census found zero matching fixture daemons. |
| 2026-07-28 | **Recovery candidate is now source-reconciled and wired through the final #48 boundary; release proof remains incomplete.** | `7eb11fb` makes `bin/install.mjs` replace local bundles and prune manifest-omitted stores with executable installer mutants. `b48fb3b` adds `scripts/top100-benchmark.mjs`, `scripts/top100-corpus.mjs`, semantic assertions, and the release gate; no generated Top-100 run is treated as published-artifact proof. `2984783` makes `scripts/release-vector.mjs` execute the D3 signal lifecycle and four mutants. `2b39f68` records D4 PASS at source SHA `63e5e67` plus delete-lesson and brain-off-treated FAIL artifacts. `27cca88` records dispatch outcomes as `verified:false`, not quality labels. `859a16d` routes exact evidence through `kb/forge-ask-all.mjs` to grounding receipts. `e089074` adds the structured managed-CLI MCP boundary; `4ad464e` makes raw Bash advisory-only. `63e5e67` requires confirmed router consent. These commits establish wiring, not release: D4 win-twice, WSL2, the installed published artifact, and both external ≥95 grades remain unproven. |
| 2026-07-28 | **D4 moved from quota-blocked UNKNOWN to a real Codex-backed PASS: 3/3 treated versus 0/3 control.** | `scripts/learning-replay.mjs` now supports `--host codex` without weakening the oracle. The installed Brain plugin's stable wrapper resolves an isolated fixture generation whose Codex adapter records monotonic lesson/tool receipts and blocks the first proposed command before CLI feedback can contaminate the arm. On code SHA `bbf6db0`, all three treated first commands used the real `ruflo memory search -q`, executed with exit 0, and retrieved the seeded note; all three brain-off controls used the rejected positional form, exited 1, retrieved nothing, and received zero lesson bytes. The artifact records host `codex`, model `gpt-5.6-sol`, 71.1s wall, and $0 API cost. The GitHub nightly remains explicitly `--host claude-code` because its non-interactive secret-backed environment is different. |
| 2026-07-28 | Recovery added executable candidate-lineage enforcement and corrected check-only release wording; implementation remains **partial**. | `scripts/release-vector.mjs` now records commit SHA, committed tree digest, and dirty state, and a dirty lineage forces the vector verdict to FAIL. `scripts/release.mjs` rejects a dirty tree in both check and publish modes and reserves `SHIPPED` for publish; check-only ends `PREFLIGHT PASS — NOT PUBLISHED`. GPT-5.6-Sol returned NO-GO until these gates, Windows CI, packed-candidate Top-100, and real WSL proof land. Fable 5 could not complete the required second review because the live subscription reported its weekly limit; no two-model convergence is claimed. |
| 2026-07-28 | **Recovery correction: the Top-100/install/routing row below described work that was not on `origin/main`.** The code and passing 100-question artifact were preserved in a dirty checkout whose branch is 18 commits behind and 3 ahead of current main. Recovery now proceeds in an isolated worktree rooted at `origin/main`; no result may be promoted until its artifact identifies that candidate SHA and a clean tree. | Live re-read on 2026-07-28: `origin/main` is `e9f7e7c` at `3.9.129-dev`; `scripts/top100-benchmark.mjs`, `evals/top-100.json`, `plugin/scripts/routing-outcome-capture.mjs`, `resolveRuntimeModelCache()` and `pruneUnlistedStores()` are absent there. The preserved artifact reports `dirty: true` and a different source SHA. This is precisely the candidate-binding invariant this ADR requires; the earlier row is retained as a record of the workstream, but it is not shipped state. |
| 2026-07-28 | Kept D5's real installer mutant executable after `bin/install.mjs` gained the shared model-cache sibling. | `tests/mesh/coexistence.test.mjs` now copies both legitimate installer siblings into its isolated mutant tree. Before this repair the mutant crashed on `../kb/model-requirements.mjs` and D5 failed without exercising byte preservation; `npm run test:mesh` is the real gate. |
| 2026-07-28 | **Codex SessionStart/Stop moved from configuration failure to direct real-path proof; the overall release vector remains UNKNOWN at D4.** | Commit `c466c2a`, issue #52. Before: a fresh Codex 0.145.0 session rejected both Brain hook sources on unsupported `_note`, so lifecycle coverage was zero. After: the same child-Codex probe has no Brain parse/clamp errors; the installed stable wrapper returned SessionStart developer context in 0.527s and translated a real open-ledger Stop into Codex `decision:"block"` in 1.172s. The new test executes the wrapper across a v1→v2 active-generation flip after v1 deletion, killing the stale-cache-path failure. Focused tests pass 52/52. This repairs a D5/D8 host-path defect but does not manufacture the blocked D4 replay, so the vector-minimum release law still says UNKNOWN. |
| 2026-07-28 | **Re-read the governed surfaces after the installer, retrieval, hook, and Top-100 validity repairs. The release verdict remains UNKNOWN, not PASS.** | `bin/install.mjs` now treats a local assembled bundle as the source of truth, prunes stale stores omitted by its manifest, and reports the installed manifest's real 60-repo count instead of the stale hard-coded “20+”. `plugin/hooks/hooks.json` anchors dispatch at `^(Task|Agent)$` and observes `PostToolUse` outcomes through `plugin/scripts/routing-outcome-capture.mjs`; these are outcome receipts, not automatic quality adjudication, so D3 is not overstated. `evals/runs/top-100-latest.json` passes all 12 gates (100/100 grounded and routed, 100 receipts, 8/8 enforceable implementation receipts, semantic 96/100, p95 3.675s). `scripts/release-vector.mjs` still exits 1 because D4 is **UNKNOWN**: live `scripts/learning-replay.mjs` transcripts show Claude Code initialized the treated/control sessions but every arm received HTTP 429 `seven_day` quota rejection before inference. The treated hook did deliver the learned lesson, but a blocked executor is not a behavioral replay. The harness now makes `--help` side-effect-free and records executor failures explicitly as UNKNOWN; focused D4/release/claims tests pass 86/86. The vector-minimum law therefore still bans a healthy/proven release claim. |
| 2026-07-27 | Initial draft, two-sided duel | Owner: *"get every single one of these numbers to be 95 or better… I want Fable 5 and GPT-5.6 to pull it together into an ADR and a DDD."* Both designs converged on tri-state per-invariant verdicts, vector-minimum release, and mandatory mutants; GPT's `PASS/FAIL/UNKNOWN` naming adopted. GPT's `gh auth` claim checked and found FALSE. Already-narrowed deductions verified first-hand at `install.mjs:3240-3248` and `verify-interface.sh:173` |
| 2026-07-27 | D6 built: `kb/card-lane-budget.json` + `scripts/qe/card-lane-gate.mjs`, wired into `scripts/qe/ux-suite.mjs` | Both `governs:`-listed files above; §D6 mutants proven (1,100ms sleep → real `ux-suite.mjs` FAIL, not warn; a silent, undocumented manifest-threshold raise across ≥2 commits shows as `presumed-stale` under `node scripts/doc-currency.mjs --check`, per this document's own drift rule). Measured on this machine: p50 0.0245ms / p95 0.0481ms / max 0.0768ms over 100 in-process firings — well inside the 250ms/1000ms budget in `kb/card-lane-budget.json` |
| 2026-07-27 | **Seven dimensions landed and the release gate itself was built.** D8 `.github/workflows/stranger-matrix.yml` (5 images, real `npm pack` tarball, virgin HOME) · D7 `tests/regression/interface-gate-corpus.test.mjs` · D5 `tests/mesh/coexistence.test.mjs` · D2 `tests/experience/scenarios.json` + `report.mjs` · D1 `REQUIRE_BRAIN` in `ci.yml` · D3 `scripts/signal-watch.mjs` · D6 as the row above. And item 10, `scripts/release-vector.mjs`, now emits the eight-invariant vector this document specified — first run reads **7 PASS, D4 UNKNOWN, verdict UNKNOWN, exit 1**, which is the design working: seven green cells do not average into a pass. | Every `governs:` path above moved. Verified by re-reading each against this document's §D1–§D8 rather than by date-stamping. **The score is expected to read BELOW 38 on the first Gen-2 run** — the stranger matrix went red on all five images and found a real, weeks-old defect this ADR had already recorded twice without anyone fixing it: `session-start.sh` emits 8,795–10,320 bytes against selfcheck's 4,096 cap, and leaves orphaned descendants after SIGTERM. A gate that goes red on its first run against a defect the docs already knew about is the gate doing its job, not the gate being wrong. |
| 2026-07-27 | **D4 landed — the vector reads PASS on all eight.** `scripts/learning-replay.mjs` measures 15/15 treated vs 3/15 control across five N=3 sets; the shipped artifact is 3/3 with the control at 0/3. Re-read §D4 against it: the trap matches the spec (lesson before first tool call, token vs a brain-off control, survives a real refresh, machine-checkable oracle). §"The release gate" re-read against `scripts/release-vector.mjs` after two corrections to MY code, not to this document: the D4 detector delegated to the trap's own `checkArtifact()` (a strict `sha === HEAD` rule can never be satisfied by its own commit), and it read `.verdict` where that function returns `.status`, which made a real PASS print as UNKNOWN. | Governed paths moved: `scripts/release-vector.mjs`, `scripts/claims-verify.mjs`. §D4's stated cap holds and is NOT closed — the win-twice promotion bar is unexercised, and the trap is conclusive only ≈51% of nights because Haiku reaches `--query` unaided in ~20% of control runs. Narrowing the token would credit the lesson for something the control demonstrably reaches without it, so the invalid rate stays. |
| 2026-07-28 | **D3 has its existence proof: one REAL debt, resolved end to end.** An independent grading scored D3 76/100 with this deduction: *"Never proven in anger: no evidence of a single real debt resolved end-to-end (push → red → surfaced → cleared)."* Correct — `tests/unit/signal-watch.test.mjs` proved each PART (conclusion mapping, debt opening, the degradation ladder), and `tests/mutation/signal-watch-mutation.test.mjs` proved the parts fail when broken, but no test had ever carried a whole debt from `git push` to "CI is green again" on data from a real pipeline. New `tests/fixtures/signal-watch/ci-lifecycle-learning-replay.json` captures a real incident on this repo's own `main`: `.github/workflows/learning-replay.yml` carried an unquoted colon in a step name, GitHub rejected the file, and it concluded `failure` on two SHAs 38 minutes apart before `68b1ce7` quoted the name and the next run went green 77 seconds later. Runs `30325577756` (failure, `2818207c`, 03:18:45Z) · `30327349291` (failure, `06bf252a`, 03:57:09Z) · `30327405302` (success, `68b1ce71`, 03:58:26Z), every field COPIED from `gh run list --workflow learning-replay.yml --repo stuinfla/ruvnet-brain --json databaseId,conclusion,status,headSha,createdAt,workflowName,event,url` and re-verifiable from the fixture's own provenance block. New `tests/unit/signal-lifecycle.test.mjs` drives the real poller (`scripts/signal-watch.mjs`, through its documented fixture port — no network, no auth) and the real surfacer (the `node -e` program lifted VERBATIM out of `plugin/scripts/session-start.sh` at test time, so an edit to the shipped block is what runs, not a copy that can drift) across DDD-0013 Context 2's named transitions: the red surfaces with the actionable minimum (inv. 5), the same still-red debt is never re-nagged (inv. 7), a second distinct SHA speaks because it is a new debt, the green closes the outstanding red with **exactly one line**, and every subsequent green emits **zero bytes** (inv. 2) | Both mutants run and killed, then reverted clean: making `resolveVerdict` return `success` for a red conclusion fails with `expected 'success' to be 'failure'`; dropping the closing `out.push` from `session-start.sh` fails with `expected [] to have a length of 1 but got +0`. No `governs:` path here changed on net — `session-start.sh` was mutated and reverted (`git diff --quiet` clean), and the two new files are test and fixture. Recorded here because §D3's claim of a working watch plane is what these artifacts now back |
| 2026-07-27 | **The session-start defect the row above recorded twice without fixing is now CLOSED, re-read against `plugin/scripts/session-start.sh`.** Commits `308a6c4`/`f8f0bc9` moved it: measured through the same door (`scripts/ci/stranger-scenario.mjs`, `npm pack` → virgin HOME → the installed `hook-shim.mjs session-start` command), all four stdin regimes × both sources, the flood is 10652 bytes (first firing) / 9127 bytes (the other seven) → **3675 bytes**, and `✗ Self-check FAILED — 8 contract violation(s)` → `✓ Self-check passed`. Nothing was truncated: THE PLAYBOOK's text relocated verbatim to `plugin/skills/ruvnet-brain/PLAYBOOK.md`; the three background spawns (spine seed, KB-freshness check, auto-update) moved out of the hook's process group through new `plugin/scripts/detach.mjs`, each with its own process group, an explicit TTL, and a receipt in `detached-jobs.jsonl` — closing the orphaned-descendants half of the same finding. Both guards proven by mutant: +5KB of stdout filler reproduces the flood (8× violations vs the 4096 cap); a bare `&` job outliving its parent reproduces the orphan (8× `survivors=true`). D8's own healthy-image assertion was re-verified after, in `4893819` (not a `governs:` path here — `scripts/ci/stranger-scenario.mjs` is outside this document's governed set). | Governed path moved: `plugin/scripts/session-start.sh` (commits `308a6c4`, `f8f0bc9`). Re-read the row above against the fix rather than editing it — the prior row's "recorded twice without anyone fixing it" stands as an accurate account of what was true when it was written; this row is what changed since. No other `governs:`-listed path moved in the same window (checked: `git log 07c53d5..HEAD` against the full governed set turns up only these two commits, both touching only `session-start.sh`). |
