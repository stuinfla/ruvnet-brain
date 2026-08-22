---
id: ADR-057
title: 95 on both graders — closing a 38/53 against a self-reported 83, dimension by dimension
status: Proposed
date: 2026-07-27
updated: 2026-08-22
impl: verification-expired
verified: 2026-07-30
verified_digest: 1c276a7dfbc5
verified_by: governed-source claim ledger in this ADR plus node scripts/doc-currency.mjs --json
governs:
  - scripts/behavioral-l1-l4.mjs
  - scripts/no-silent-substitution.mjs
  - tests/mesh/*.mjs
  - bin/install.mjs
  - plugin/hooks/hooks.json
authors: [Stuart Kerr, Claude Code]
tags: [qa, gen2-qe, proactivity, learning, substitution, latency, honesty, grading]
supersedes: []
relates: [ADR-028, ADR-052, ADR-053, ADR-055, ADR-056]
---

# ADR-057: 95 on both graders

**Status**: Proposed
**Date**: 2026-07-27 · **Last updated**: 2026-08-01 · **Why**: governed-source reconciliation after
the installed What's New and MCP readiness boundaries moved; external grades and open proof limits
preserved
**Implementation**: source-wired, but the stored source verification is expired and is not a release
verdict. The last digest-backed re-read remains historical evidence only. Neither external grader
awarded 95, the candidate package has not been proved on every promised host, and every build-order
item is not done.


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `bin/install.mjs` now exits non-zero when `--update` lands nothing (issue #106), `kb/forge-update.mjs` releases its rollback on the no-op path and keeps it on the damaged path (#108), and `scripts/health-repair.mjs` no longer reports a hollow "fed 0" (#104). Checked against this decision: these changes implement its honesty requirement — no clause here is contradicted or superseded.


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `bin/install.mjs` (runUpdate now converges the managed router catalog, #87), `console/app.js` + `console/style.css` (a third not-checked provider state so an unloadable catalog is never rendered as a finding about the user credentials, #86), and `scripts/model-router-catalog.mjs`. Checked against this decision: the host wiring, the grader contract and the 95 thresholds are unchanged — these make an existing claim honest and reach an existing merge from the update path. Console re-graded 96/100 at 1440 and 1920 under the design wall. No clause contradicted or superseded.

## Context — the owner's sentence, which is the whole problem

> *"You've been working for three weeks, four weeks, and you said this thing is perfect. Now you look
> at it from the real view, and you get a 38 out of 100 and a 53 out of 100, both horribly failing
> scores. Now I need the ADR plan for what it takes to get both of these up to 95s on all levels."*

On 2026-07-27 two independent graders ran the owner's own 8-dimension rubric against this product's
**QE apparatus** — the tests, not the product. **Fable 5: 53/100. GPT-5.6-Sol: 38/100.**

**A precision the owner caught in v1 of this ADR, corrected here.** v1 framed this as "83/100 versus
38/100". That comparison is not sound and must not be repeated: README:263/298's **83** is a
**self-score of the PRODUCT** across 8 dimensions from the 2.0 era ("55 → 83 in two days"), while
53/38 are **independent grades of the TEST SUITE** on 2026-07-27. Different subject, different date,
and one side is marking its own homework. Citing them as one number-versus-number is the flattery
this ADR exists to end.

**The real contradiction is narrower and worse**, because it is a direct falsification rather than a
comparison. README:484 and README:526 state *"L1–L4 behavioral harness — **all pass** … the hook
drives the full pipeline."* Verified today: L4 asserts only that the hook's own injected prose
contains certain WORDS, and the harness printed `OVERALL: PASS` on a run of ZERO checks. "Behavioral,
all pass" was never evidence of behaviour, on either count.

| Dim | | Fable | GPT | worst |
|---|---|---|
| 2026-08-10 | Re-read after #128/#129; this plan stays Proposed and no score is promoted. | The governed `bin/install.mjs` changes are scheduling convergence (#129) and stale-generation pruning (#128). Neither adds, removes or relaxes a grader, a dimension or an observable, and neither is offered as evidence toward 95. `impl: verification-expired` is unchanged — two independent graders at or above 95 remain outstanding. |---|---|
| D1 | Works well under real conditions | 50 | 60 | 50 |
| D2 | Works as the user expects | 55 | 42 | 42 |
| D3 | Proactive and measured | 69 | 53 | 53 |
| D4 | Demonstrates learning end-to-end | 58 | 36 | 36 |
| D5 | Coexists with the user's system | 57 | 35 | 35 |
| D6 | Experience feels positive | 46 | 28 | 28 |
| D7 | Proper / clean / effective | 47 | 32 | 32 |
| D8 | Works on a stranger's machine | 40 | 18 | **18** |

### Why nobody noticed for weeks — three mechanisms, all verified first-hand 2026-07-27

1. **The harness certified empty runs.** `behavioral-l1-l4.mjs --levels L5` selected zero checks and
   printed `OVERALL: PASS`, exit 0. `allPass` initialised to `true` and the loop `continue`d over
   every empty level. *Fixed in this ADR's first commit; an unknown level and a zero-check run now
   both exit 2.* **This is the load-bearing mechanism**: nothing could contradict the repo's own
   "all pass" claim, because the thing meant to contradict it passed by running nothing.
2. **L4 "behavioral" matches strings, never behaviour.** Its assertion is literally
   `must: ['take the wheel','SPARC','DDD','ADR','swarm','QA gate','98',…]` against the hook's own
   injected prose. It proves the brain SPOKE. It cannot observe whether Claude LISTENED.
3. **The substitution audit points at the wrong repository.** `no-silent-substitution.mjs` runs
   `audit(root = ROOT)` over this repo's own `SCAN_DIRS`. The hand-rolling it exists to catch happens
   in the USER's project — WhitSentry — which it never opens.

Together: the product could speak correctly, be ignored completely, and report green.

## Decision

**One law, from which every dimension target below follows:**

> **A test may only claim what it can observe. "The brain emitted the right instruction" is not
> evidence that the agent obeyed it, and no quantity of the former sums to the latter.**

Gen-2 measures the agent's ARTIFACT and the ORDER of its actions, not the brain's output. Both
graders converged on this independently and it is the only route from 38 to 95 — every deduction
below is an instance of it.

### The five converged classes

Fable proposed 8 classes, GPT 7. They agree on five, and the five form one chain — **each is
worthless without its predecessor**, which is why the order is not negotiable:

> `installed everywhere → consulted in time → changes the decision → uses accumulated intelligence → status tells the truth`

| # | Class | Fable | GPT | Failed on the 2026-07-27 graded artifact |
|---|---|---|---|---|
| 1 | **Causal substitution prevention** | T1/T4 | 1 | YES — WhitSentry is the observed failure |
| 2 | **Latency consultation survival** | T2 | 2 | YES — 19.6s warm is 19.6× the ceiling |
| 3 | **Clean-machine / org hook integrity** | T5 | 3 | YES — the blocking gate is absent from plugin `hooks.json` |
| 4 | **Proactive + learning outcome** | T7 | 4/6 | YES — ADR-028 L5 explicitly unbuilt |
| 5 | **Claim-to-behaviour integrity** | T6 | 5 | YES — README:484 says "all pass" while L4 greps prose |

### What 95 requires, per dimension

Each row states the **observable** that must exist. Anything short of it caps the score no matter how
much else works (Rule 9: known architectural flaws cap at ≤70).

**D8 — stranger's machine · 18 → 95. The worst score and the first work.**
GPT's two largest deductions anywhere both live here: *"verification failures do not stop
installation"* (`bin/install.mjs:691`) and *"the grounding smoke is explicitly 'best-effort, never
fatal'"* (`:735`). Required: install into virgin macOS / Linux / Windows-GitBash / Windows-PowerShell
/ WSL images; fire real lifecycle envelopes through the INSTALLED plugin; a failed verification
**blocks the install** instead of warning. Matrix states: no `jq`, no API keys, network denied, paths
with spaces, read-only project, Brain OFF, managed org policy. **No author-local `settings.json` may
be required for any promised behaviour.**

**D7 — proper/clean · 32 → 95.** GPT: *"the interface gate still parses shell semantics with regex…
the same defect class has now recurred across issues #12, #13, #41, #44."* Required: a real parser or
a constrained command model for `verify-interface`, plus a seeded incident corpus (heredocs,
`bash -lc`, backticks, `$()`) with false-positive AND false-negative mutants. Five recurrences of one
defect class is a design verdict, not a run of bad luck.

**D6 — experience · 28 → 95.** GPT: *"latency breaches only warn… timing regressions do not block
shipping."* Required: the fast capability-selection lane at **p95 ≤ 250ms**, absolute max **1,000ms**,
and at 1,001ms the correctness test FAILS. Justification is the product's declared envelope: fast
pre-tool hooks retain 5s while the two UserPromptSubmit hooks have 10s host deadlines around an
internal 4s runtime bound, and those hooks instruct the model to consult `search_ruvnet` before
writing — a product may not order a tool whose cost consumes the intervention envelope.
*The card lane merged 2026-07-27 measures 0.1158ms warm (verified first-hand), so the budget is met
on the selection path; the heavy path must be removed from the decision, not merely sped up.*

**D5 — coexistence · 35 → 95.** GPT: *"the merged-registry lint found 63 findings across 42
registrations. The previous suite saw only 15."* Required: a coexistence test with sentinel foreign
hooks proving zero mutation of third-party or user-owned registrations, and honest reporting of what
we do not own.

**D4 — learning end-to-end · 36 → 95.** At grading time, GPT found: *"L5 is explicitly unbuilt. The required proof is
project A outcome changing behavior in project B and surviving refresh"* (ADR-028:50). Required: a
counterfactual replay — record a correction, present a **semantically equivalent, differently-worded**
task in a fresh session/project, require recall BEFORE the decision and a **different artifact** than
the brain-off control. Rows in a learning database are not learning.

**D3 — proactive · 53 → 95.** Required: four strata, each ending in an INVOKED capability, not a
mention — vague need → advocacy; prior lesson → changed decision; hook request → current mechanism
selected and verified; routing request → real router invocation with a receipt.

**D2 — expectation · 42 → 95.** GPT: *"the required mental-model scenario list is specified but
absent"* (ADR-053:44). Required: the ~20 hand-written coherent scenarios ADR-053 §1 already
specifies, checked in.

**D1 — real conditions · 50 → 95.** At grading time, Fable found that the product guarantee *"skips on every CI runner;
`REQUIRE_BRAIN=1` is set nowhere in the repo (grep confirmed)"*, and *"coverage floor of 14% while
the badge says 26%."* Required: the guarantee runs, unskipped, on at least one runner per OS.

### The gate that makes the contradiction structurally unshippable (D-cross-cutting)

**Health is a critical-invariant vector, never an average.** Substitution, latency, hook portability
and proactive outcome must ALL be green on the exact candidate package SHA. Any red or inconclusive
critical class forces README/status/release metadata to `DEGRADED` and blocks the words "healthy",
"proven", "all pass", and any composite score. *An average is how 18/100 on a stranger's machine coexists on the
same page with "all pass" — no single claim was false enough to trip anything, and the composite
absorbed the worst one.*

### Deleted from the release verdict — by name

Both graders independently demanded these stop counting as proof: total pass counts ("1,832 tests
passing"), keyword snapshots of injected hook prose, `tools/list` / HTTP 200 / manifest-present
checks, retrieval scores as a proxy for consultation, composite 0–100 health scores that average away
a failed invariant, tests that expect a zero-check run to succeed, regex audits confined to this repo
when the danger is downstream, and coverage percentage as product health. They remain useful as
component diagnostics; they stop being evidence that the brain changes Claude's behaviour.

## Build order (red-first; each item ships with the mutant that must fail)

1. **Vacuous-pass guard.** DONE 2026-07-27 — `--levels L5` now exits 2. *Prerequisite for trusting
   any number below it.*
2. **Cold clean-room WhitSentry replay** (the single test that would have caught it). Virgin HOME,
   released plugin only, the original prompt with NO trigger words. Oracle: no substitutable write
   before a successful fast-lane receipt; the artifact invokes the selected capability; no local
   duplicate; **and a brain-disabled mutant must produce the hand-roll and go red.**
3. **D8 install-blocks-on-failure** + the five-image matrix.
4. **Latency budget as a correctness gate** (p95 ≤250ms, hard fail >1,000ms).
5. **Substitution audit re-pointed at the USER's project**, with the anonymous hand-roll shapes
   (hand-rolled cosine, ad-hoc embedding calls, agent-memory glue) — not vendor names.
6. **D4 counterfactual learning replay.**
7. **Claim-to-behaviour release gate** (the vector, not the average).
8. **`verify-interface` parser** replacing the regex.

> **STATUS 2026-07-28 (source re-verification, not a rescore) — most of the mechanism has since
> shipped, mostly via ADR-058, which extends this ADR's build order explicitly.** Checked each item
> against the current source and named artifacts. “Source-wired” below does not imply that the
> published package or the exact current SHA passed the external environment:
>
> | # | Item | State | Checked |
> |---|---|---|---|
> | 1 | Vacuous-pass guard | **DONE in source** | `scripts/behavioral-l1-l4.mjs` rejects unknown levels and zero executed checks with exit 2; `tests/integration/behavioral-l1-l4-levels.test.mjs` holds both cases |
> | 2 | Cold clean-room WhitSentry replay | **OPEN** | no WhitSentry-named or equivalent downstream clean-room substitution fixture exists under `tests/`; the generic D4 replay does not prove this incident |
> | 3 | D8 install-blocks-on-failure + 5-image matrix | **SOURCE-WIRED; external run still required** | `987590a` added `.github/workflows/stranger-matrix.yml` with Ubuntu, macOS, Windows Git Bash, Windows PowerShell, and hostile cells; `bin/install.mjs` consumes the self-check exit and persists unproven grounding. Subsequent installer commits `2f420e7`, `7eb11fb`, and `e089074` changed the governed install path. No exact-current-SHA or published-artifact matrix result was used here |
> | 4 | Latency budget as a correctness gate | **DONE in source for the recommendation lane** | `kb/card-lane-budget.json` (p95≤250ms, absoluteFail>1000ms) is a `hardFailures` input through `scripts/qe/card-lane-gate.mjs`; factual capability answers were deliberately removed from the fast lane after the truth-gate correction, so this is not general retrieval-latency proof |
> | 5 | Substitution audit re-pointed at the user's project | **OPEN** | `scripts/no-silent-substitution.mjs` still exports `audit(root = ROOT)` and its CLI calls `audit()` with no `--project` argument |
> | 6 | D4 counterfactual learning replay | **IMPLEMENTED; promotion proof OPEN** | `bbf6db0` wired the Codex-backed replay and `2b39f68` committed one exact-source result: treated 3/3, control 0/3 at source SHA `63e5e67`, with delete-lesson and brain-off-treated mutants failing. That is one source artifact, not ADR-029 win-twice, a Fable rerun, or published-package proof |
> | 7 | Claim-to-behaviour release gate (vector, not average) | **SOURCE-WIRED; current release verdict not established here** | `scripts/release-vector.mjs` now emits `PASS\|FAIL\|UNKNOWN`, takes the vector minimum, and is invoked by release checking; `dc27f41` repaired its Windows runner boundary. This re-read did not convert workflow/source presence into an exact-SHA PASS |
> | 8 | Replace regex authorization at the CLI boundary | **DONE in source; packed-host proof remains** | `e089074` added the structured `ruvnet_cli_help`/`ruvnet_cli_run` boundary and made the installer persist its module; `4ad464e` made raw `verify-interface` advisory and retained a non-blocking historical shell corpus. The published host remains part of D8 proof, not something this source read can award |
>
> Net: 5 of 8 items are source-complete (1, 3, 4, 7, 8), item 6 has one committed causal run but
> remains below its promotion bar, and items 2 and 5 are open. That is why the artifact mechanically
> derives at least `wired`; it is **not a score** and it is not permission to say 95. The last
> independent grade remains 15/100 at `879b928`; neither grader has re-run this recovery candidate.

## Governed-source claim ledger

This ledger supports the currency stamp only. It maps the ADR’s current implementation statements
to the five governed paths; it does not adjudicate the product or substitute for external graders.

| Governed path | Claim checked in this re-read | Exact referent and limit |
|---|---|---|
| `scripts/behavioral-l1-l4.mjs` | The vacuous-pass guard is implemented; L4 still observes injected prose rather than downstream obedience | Unknown levels and zero checks exit 2 in the final runner block; the L4 `must` arrays and union-of-hook-output logic remain speech checks |
| `scripts/no-silent-substitution.mjs` | The downstream-project audit remains open | `audit(root = ROOT)` scans fixed directories under its argument, while `main()` invokes `audit()` without a project CLI option |
| `tests/mesh/coexistence.test.mjs` | D5 has a source-level coexistence fixture with mutants | Commit `314be33`; sentinel ordering, config byte preservation, foreign-hook non-charging, and own-hook failure are exercised in scratch homes only |
| `bin/install.mjs` | The installer consumes self-check state, persists structured Codex support, and has changed since the prior review | Commits `2f420e7`, `7eb11fb`, and `e089074`; these are source facts and do not prove the published tarball or five-host matrix ran green |
| `plugin/hooks/hooks.json` | Routing outcomes are observed and raw shell reconstruction is advisory | `27cca88` adds `routing-outcome`; `4ad464e` adds `|| true` to `verify-interface`. Outcome rows are not artifact-quality labels, and source registration is not installed-host proof |

## Consequences

- **The score will get worse before it gets better**, and that is the intended signal: Gen-2 classes
  are designed to fail on today's product, so early runs should read far below 38. A Gen-2 suite that
  came up green against today's product would be the self-congratulation it exists to kill.
- Class 1 needs real headless agent runs — minutes and real tokens per trap. Run nightly, N=3,
  pass ≥2/3, archive every failing transcript. That is a **rate**, never a verdict.
- **What cannot be automated, stated plainly:** whether an offer was *welcome* (precision needs a
  human numerator), whether a substitution choice was *right* in an open-world architecture, and
  answer *quality* — a grader model may be a second opinion, never the sole gate.
- 95 on both graders is only claimable when **both** re-run the same rubric and agree. One grader at
  95 and the other at 60 is a 60.
- No grader has re-run this recovery candidate. The exact-SHA 15/100 result at `879b928` remains the
  last independent score recorded here; source reconciliation cannot revise it.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-22 | Re-read the moved installer surface; this plan remains Proposed, verification remains expired, and no score is promoted. | `4e68453` changes stale plugin generation cleanup to retain live/ambiguous PID-incarnation leases; `6336c52` adds non-pinned launchd paths for the supported host executables. Both changes are bounded installer correctness work in `bin/install.mjs`; neither changes `scripts/behavioral-l1-l4.mjs`, `scripts/no-silent-substitution.mjs`, `tests/mesh/coexistence.test.mjs`, the grader rubric, or the two-independent-95 acceptance condition. |
| 2026-08-19 | **Re-read after the hooks.json timeout change; neither grader's contract is touched.** | `plugin/hooks/hooks.json` is the only governed path that moved: the two decision-gate PreToolUse entries returned from 10s to 5s (ADR-067, 2026-08-19). No hook was added, removed, or re-matched, so the behavioural L1-L4 surface both graders score is identical apart from that ceiling. `scripts/behavioral-l1-l4.mjs`, `scripts/no-silent-substitution.mjs`, `bin/install.mjs` and `tests/mesh/coexistence.test.mjs` are unchanged. |
| 2026-08-10 | Re-read after ADR-067; this plan stays Proposed and no score is promoted. | The governed installer change is the derived Codex dependency walk. It adds no grader, dimension or observable, and is not offered as evidence toward 95. `impl: verification-expired` unchanged — two independent graders at or above 95 remain outstanding. |
| 2026-08-02 | Re-read the governed 4.0.8 installer and hook changes; this plan remains Proposed and no score is promoted. | ADR-062 adds three-mode packed/public host proof and makes `--doctor --hooks` fail closed when selfcheck is unavailable. GPT-5.6 Sol Medium signed the release design and `claude-fable-5` Medium signed with applied changes, but neither result is represented as a new 95 product score. |
| 2026-08-02 | Re-read every final 4.0.7 governed change and kept this plan Proposed with `impl: verification-expired`; no external grade is promoted. | Commits `281df57`, `28baa9c`, `3668b1b`, `67b283e`, and `78e897b` change installer recovery, hook timing, packaged provenance, swarm recycling, and protected publication. These changes preserve the two-independent-grader requirement and do not satisfy it by source inspection. Exact-SHA CI, candidate receipts, published bytes, and post-publication clean installs remain authoritative. |
| 2026-08-01 | Re-read the governed installer after the four-state Claude/Codex transaction matrix. The plan remains Proposed and `impl: verification-expired`; focused host proof does not promote either external grader or the overall score. | `bin/install.mjs` now exposes the minimum injected seams needed to prove Claude-only, Codex-only, both, neither, disabled-host preservation, and rollback on either host failure. The integrated focused suite passed 70/70, while the full unit run recorded 2,726 passes and two version-fixture failures that were corrected and rerun 43/43. Exact-SHA CI, public-artifact clean installs, and two independent scores at or above 95 remain outstanding. |
| 2026-08-01 | Re-read the governed installer changes and deliberately downgraded `impl:` from `verified` to `verification-expired`. The 95 plan remains Proposed and every external score/proof limitation remains open. | `bin/install.mjs` now delegates What's New to the installed plugin payload and, in #78 integration commit `b606900`, declares a 30-second Codex MCP startup deadline and reports worker readiness separately from registration. Those changes do not alter the five governed claims in the source ledger below. Nevertheless `verified_digest: 1c276a7dfbc5` no longer recomputes, and a source read plus #78's 138/138 focused tests cannot mint a new verification checkpoint. No broad/packed/exact-SHA/public artifact was proved, no external grader reran, and the downstream substitution/clean-room gaps remain open. |
| 2026-07-30 | Re-read the governed 4.0.2 source and kept this decision Proposed: local packed/focused evidence is not external release proof or a 95 score. | `bin/install.mjs` now persists Console runtime and validates controls; `plugin/hooks/hooks.json` removed parser-invalid metadata and retains valid description/hooks fields. Still OPEN: external exact-SHA matrix, published clean install, both independent graders, WhitSentry clean-room replay, downstream substitution audit, and D4 N=3 promotion threshold. |
| 2026-07-29 | Re-verified every governed source surface after the 4.0.0 Agentic-QE and release-hardening commit and refreshed the machine-derived digest. This does not promote an external grader score; it proves only governed-source currency. | Commit `e20cdf2`; `scripts/behavioral-l1-l4.mjs`, `scripts/no-silent-substitution.mjs`, `tests/mesh/*.mjs`, `bin/install.mjs`, and `plugin/hooks/hooks.json` were re-read against the stored QE evidence in `docs/qe/AGENTIC-QE-4.0-MASTER-PLAN.md`; computed digest `1f3d77fee84c`. |
| 2026-07-29 | Re-read all five governed surfaces after the UserPromptSubmit timeout repair; the architecture and open score/proof limits remain unchanged, while the D6 envelope wording now matches the actual split deadlines. | PR #65 / commit `6734597` changes only the two UserPromptSubmit declarations in `plugin/hooks/hooks.json` from 5s to 10s; pre-tool declarations remain 5s and the inner unprompted runtime remains bounded at 4s. The exact candidate passed the GitHub macOS/Ubuntu/Windows stranger matrix, full Windows units, UX/QE, and warm-brain battery; neither external grader re-ran, so no score is promoted. |
| 2026-07-29 | Reviewed the complete governed-path history since `8325510` and re-read the only changed governed path; the architecture and open proof limits are unchanged. | Commit `c2d5ef0` makes `bin/install.mjs` count canonical `*.big.rvf` stores; commit `ebe51a5` makes Codex status honor `CODEX_HOME` and decode Windows TOML paths. Focused installer smoke passed 22 tests (1 skipped, 3 todo), and Codex wiring passed 42/42. Neither commit proves a published candidate or both external grades. |
| 2026-07-28 | Re-read the full ADR and all five governed paths after five post-document commits; changed `impl:` from stale `unbuilt` to source-currency `verified`, replaced the obsolete build-order table, and added a governed-source claim ledger. No score or release verdict was promoted. | `doc-currency` reported drift after `2f420e7`, `27cca88`, `7eb11fb`, `e089074`, and `4ad464e`. The re-read confirms source wiring in `bin/install.mjs` and `plugin/hooks/hooks.json`, while `scripts/no-silent-substitution.mjs` still lacks downstream `--project` routing. `2b39f68` is one D4 causal artifact, not win-twice; `/private/tmp/qe-grade-gpt56-879b928.out` remains the last external grade at 15/100 and explicitly leaves exact-SHA matrix, published artifact, and both-grader proof untested. |
| 2026-07-28 | Re-read all governed paths after the exact-SHA adversarial grade; the document's build-order claims remain accurate, and the current measured score is recorded as 15/100 rather than promoted. | `/private/tmp/qe-grade-gpt56-879b928.out` found D4 15, D1 30, and an overall vector minimum of 15 at SHA `879b928`. This repair closes Codex transport, cache-verifier, portable wiring, and Ruflo-memory-init defects, but does not claim the still-missing N=3 causal replay or stranger matrix. |
| 2026-07-27 | v2 — corrected the 83-vs-38 framing after the owner caught it: different subject (product self-score vs independent grade of the test suite), different date. Replaced with the falsifiable claim, README:484/526 "L1–L4 behavioral all pass" |
| 2026-07-27 | Initial draft | Owner's demand for a 95 plan after Fable 53/100 and GPT-5.6-Sol 38/100 (2026-07-27, `qe-grade-gpt.out:18503-18676`; `02567c43-….jsonl:2672`). Three concealment mechanisms verified first-hand: the vacuous `--levels L5` PASS (fixed here), L4's string-matching `must:` list, and `no-silent-substitution.mjs`'s `audit(root = ROOT)` scanning this repo instead of the user's |
| 2026-07-27 | **Re-read against the governed code; build-order status table added — no prose claim was wrong, but 3-4 of 8 build items had shipped since this ADR was written and the document didn't say so.** | Flagged `presumed-stale`: 5 commits (0d) after this document's last commit (`0cefecc`), across `scripts/behavioral-l1-l4.mjs`, `scripts/no-silent-substitution.mjs`, `bin/install.mjs`, `plugin/hooks/hooks.json`. Checked each governed path and cross-referenced ADR-058 (which explicitly "extends ADR-057's build order" and ships the same day): `.github/workflows/stranger-matrix.yml` now exists (item 3), `kb/card-lane-budget.json`/`scripts/qe/card-lane-gate.mjs` wire a real hard latency gate (item 4), `verify-interface.sh:173` confirms `MATCH_RE` replaced by `commandNodes()` (item 8's parser half); `no-silent-substitution.mjs:121` still reads `audit(root = ROOT)` with no `--project` flag (item 5 still open), no WhitSentry/clean-room fixture exists (item 2 still open), `scripts/claims-verify.mjs` has no vector-minimum gate yet (item 7 still open, ADR-058 itself still `impl: unbuilt`) |
| 2026-07-27 | `governs:` changed: `tests/mesh/` → `tests/mesh/*.mjs` | `doc-currency.mjs` flagged `governs-directory` once `tests/mesh/coexistence.test.mjs` (`314be33`, ADR-058 D5) was committed, flipping the directory from untracked-on-disk to a real git tree. Re-checked `behavioral-l1-l4.mjs`/`no-silent-substitution.mjs` against the fuller post-D5/D8 commit range — still unchanged, build-order table above still accurate |
